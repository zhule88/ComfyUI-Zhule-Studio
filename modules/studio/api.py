"""Zhule Studio 后端：词库读写、参考图管理、图片代理、Studio 页面静态服务。

数据源（SQLite 单库 modules/studio/zhule.db，数据层见 db.py）：
  - 词库：表 prompt（父子层级树；entry 叶子为词条：en 英文提示词 / cn 中文 / sort_order 排序）
  - 图库：表 gallery_image / gallery_tag
  - 自定义标签：表 custom_tag

词条卡片结构（由 DB 树还原，前端 Wordbank.js 消费）：
  {name, number, rawName, relPath, chips, chipKeys, content, content_cn, images, mtime}
  - relPath：词条在词库树中的原始路径（含编号前缀）
  - mtime：取自 DB updated_at（按时间排序用）
  - images：参考图路径数组（相对 output/zhule_studio/），按优先级：
      1. 词条上传图  zhule_reference/<词条id>/<文件>（卡片详情页上传）
      2. 图库反查图  zhule_img/<文件>（按词条名匹配图库 tag，只读，不可删）

词库文本与 images.txt 均已不再落盘读写，词库目录仅作历史兼容保留。
"""
import json
import os
import re

from aiohttp import web

from ..common.paths import _get_output_dir
from . import db  # zhule.db 数据层（词库/图库读写统一走 SQLite）

STUDIO_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.abspath(os.path.join(STUDIO_DIR, "web"))

# 词库根：随代码走，位于 modules/studio/prompt/
_WB_ROOT = os.path.join(STUDIO_DIR, "prompt")


def wb_root():
    """返回词库根：modules/studio/prompt/。"""
    return _WB_ROOT


IMAGE_ROOT = _get_output_dir()
# output 下统一收纳目录：zhule_img / zhule_thumbs / zhule_link / zhule_reference
STUDIO_SUBDIR = "zhule_studio"
# 词条参考图目录：output/zhule_studio/zhule_reference/<词条id>/
REF_SUBDIR = "zhule_reference"
# 模块级初始值（兼容外部 from .api import wb_root()）；函数内部应优先调用 wb_root() 动态解析
WORD_BANK_ROOT = wb_root()

NUMBER_PREFIX = re.compile(r"^(\d+)[_ ]+(.+)$")
NUMBER_SEP = re.compile(r"^\d+([_ ])")
INVALID_NAME = re.compile(r'[\\/:*?"<>|]')

MAIN_FILE = "prompt.txt"
CN_FILE = "prompt_cn.txt"
IMAGES_FILE = "images.txt"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

_CONTENT_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
}


def _is_within(base, path):
    """path 是否位于 base 目录内（realpath + commonpath，防路径穿越）。"""
    try:
        base = os.path.realpath(base)
        return os.path.commonpath([base, os.path.realpath(path)]) == base
    except ValueError:
        return False


def parse_folder(name):
    """返回 (number, display_name)。无编号 number=0"""
    m = NUMBER_PREFIX.match(name)
    if m:
        return int(m.group(1)), m.group(2)
    return 0, name


def _seg_key(name):
    """层级深度优先排序的单段 key：有编号在前按数字升序，无编号排后按显示名。"""
    num, disp = parse_folder(name)
    return (0 if num > 0 else 1, num, disp.lower(), name)


def _path_sort_key(rel):
    """完整相对路径逐段比较的 key（层级深度优先：父级分出先后后，子级不再参与）。"""
    return [_seg_key(s) for s in rel.replace(os.sep, "/").split("/")]


def _chip_keys(parts, end=None):
    """chips 对应的唯一键数组：每级键 = 从词库根到该级的完整原始路径（含编号）。

    同名文件夹（如不同父级下各有「情景」）的完整路径不同，键即不同，前端据此
    独立展示、绝不合并。
    """
    end = len(parts) if end is None else end
    keys = []
    acc = parts[0]
    for p in parts[1:end]:
        acc = acc + "/" + p
        keys.append(acc)
    return keys


def _list_images(folder):
    """文件夹内直接存放的图片文件，稳定排序。"""
    try:
        return sorted(
            f for f in os.listdir(folder)
            if not f.startswith(".")
            and os.path.splitext(f)[1].lower() in IMAGE_EXTS
            and os.path.isfile(os.path.join(folder, f))
        )
    except OSError:
        return []


def _ref_dir(entry_id):
    """词条参考图目录：output/zhule_studio/zhule_reference/<词条id>/（不存在时由调用方创建）。"""
    return os.path.join(IMAGE_ROOT, STUDIO_SUBDIR, REF_SUBDIR, str(entry_id))


def _card_images(node):
    """词条卡片参考图数据源（按优先级），返回相对 output/zhule_studio/ 的路径数组。

    1. 词条上传图：zhule_reference/<词条id>/<文件>（卡片详情页上传，可删）；
    2. 图库反查图：zhule_img/<文件>（按词条名匹配图库 tag，数据源为内存 index，只读）。

    images.txt 与「词库目录内 / 父目录立绘图」机制均已停用，不再读取与生成。
    """
    nid = node.get("id")
    if nid:
        imgs = _list_images(_ref_dir(nid))
        if imgs:
            return [REF_SUBDIR + "/" + str(nid) + "/" + f for f in imgs]

    name = node.get("name") or ""
    if name:
        from .gallery import get_tag_ref_index  # 延迟导入避免循环依赖
        refs = get_tag_ref_index().get(name)
        if refs:
            return refs
    return []


def _node_raw_name(node):
    """还原节点原始目录名（与磁盘一致）。

    sortOrder 为整数时按两位补零还原 f"{sortOrder:02d}_{name}"（全库前缀统一 2 位）；
    旧缓存遗留字符串（含前导零）原样拼接；无 sortOrder 字段（无前缀节点）直接用 name。
    """
    so = node.get("sortOrder")
    nm = node.get("name") or ""
    if so is None:
        return nm
    if isinstance(so, int):
        return f"{so:02d}_{nm}"
    return f"{so}_{nm}" if so else nm


def _wb_tab_ids(tree):
    """顶层 tab 纯显示名 -> 节点 id 映射（前端切 tab 用 id 定位，展示/URL 用纯 name）。"""
    out = {}
    for node in tree:
        nm = node.get("name") or ""
        if nm:
            out[nm] = node.get("id") or ""
    return out


def _wb_tab_name_by_id(tree, tab):
    """tab 参数归一化：返回顶层 tab 纯显示名（name）。

    优先级：① 纯显示名已存在直接短路；② 8 位 hex id → 该节点纯 name；
    ③ 旧版带编号目录名（如 "01_角色"）→ 该节点纯 name（向后兼容旧存档/旧 URL）；
    未知 id 原样返回（切片得空，前端会回退目录名）。
    """
    if not tab:
        return tab
    for node in tree:
        if (node.get("name") or "") == tab:
            return tab
    for node in tree:
        if node.get("id") and node.get("id") == tab:
            return node.get("name") or tab
    for node in tree:
        if _node_raw_name(node) == tab:
            return node.get("name") or tab
    return tab

def _cards_from_tree(tree):
    """缓存树 → 与原扫描完全一致的 {tabs, data} 结构。

    每张卡片字段：id/name/number/rawName/relPath/chips/chipKeys/content/
    content_cn/images/mtime。id 为 DB 词条 id（提示词标签按 id 传递，词条改名/移动
    后不脱钩）；rawName/relPath/chips/chipKeys 由节点原始目录名还原（与磁盘一致）；
    images/mtime 实时读磁盘（参考图不参与缓存）。
    tabs 数组与 data 键统一用顶层 tab 纯显示名（name，无编号前缀），
    前端展示/定位不再出现 "01_角色" 拼接；卡片内部 rawName/relPath 仍为
    带编号的原始目录名（磁盘定位用）。

    节点格式兼容新旧两版：
    - 新格式：sortOrder + name（sortOrder 为数字前缀字符串，name 为去前缀显示名）
    - 旧格式：name 直接存原始目录名（含数字前缀），无 sortOrder/raw 字段
    统一用 _node_raw_name 还原原始目录名，显示名/编号由 parse_folder(raw)
    推导，保证两种缓存都能还原出一致卡片结构。
    """
    tabs = []
    data = {}

    def collect(node, parts, out):
        """按原 _folder_card/_txt_card 公式还原卡片字段。

        parts = 从 Tab 根到当前节点父级的原始目录名列表（不含当前节点）。
        chips/chipKeys 由 parts 位置直接推导，与磁盘扫描结果逐字段一致。
        """
        raw = _node_raw_name(node)
        children = node.get("children") or []
        if node.get("type") == "entry":
            rel = "/".join(parts + [raw]) if parts else raw
            if raw.lower().endswith(".txt"):
                # 散 txt 卡片：卡片层 = parts 中显示名与 txt stem 相同的层（原 _txt_card 逻辑）
                stem = os.path.splitext(raw)[0]
                stem_disp = parse_folder(stem)[1]
                entry_idx = -1
                for i in range(len(parts) - 1, 0, -1):
                    if parse_folder(parts[i])[1] == stem_disp:
                        entry_idx = i
                        break
                end = entry_idx if entry_idx > 0 else len(parts) - 1
                out.append({
                    "name": stem_disp,
                    "id": node.get("id") or "",
                    "number": parse_folder(stem)[0],
                    "rawName": raw,
                    "relPath": rel,
                    "chips": [parse_folder(p)[1] for p in parts[1:end]],
                    "chipKeys": _chip_keys(parts, end=end),
                    "content": node.get("en") or "",
                    "content_cn": "",
                    "images": _card_images(node),
                    "mtime": node.get("updatedAt") or 0,
                })
            else:
                # 文件夹卡片（DB 中统一为 entry 节点）
                # parts 不含卡片层，end=len(parts) 等价于原公式中的 len(parts)-1
                end = len(parts)
                out.append({
                    "name": parse_folder(raw)[1],
                    "id": node.get("id") or "",
                    "number": parse_folder(raw)[0],
                    "rawName": raw,
                    "relPath": rel,
                    "chips": [parse_folder(p)[1] for p in parts[1:end]],
                    "chipKeys": _chip_keys(parts, end=end),
                    "content": node.get("en") or "",
                    "content_cn": node.get("cn") or "",
                    "images": _card_images(node),
                    "mtime": node.get("updatedAt") or 0,
                })
            # entry 带 children（含 prompt.txt 仍下钻，如 01_嘴部）：继续递归
            if children:
                for child in children:
                    collect(child, parts + [raw], out)
            return
        for child in children:
            collect(child, parts + [raw], out)

    for tab_node in tree:
        cards = []
        collect(tab_node, [], cards)
        tab_disp = tab_node.get("name") or _node_raw_name(tab_node)
        tabs.append(tab_disp)
        data[tab_disp] = cards
    return {"tabs": tabs, "data": data}


# ============================================================
# HTTP handlers
# ============================================================
async def get_wordbank(request):
    """词库数据（DB 版）：数据源为 zhule.db（表 prompt），前端 Wordbank.js 零改动。

    每次请求直读 DB fetch_tree() 组装卡片（DB 数据恒为最新，无缓存/force 语义），
    不再扫描 prompt 文件夹、不再读写 wordbank_index.json。
    """
    tab = request.query.get("tab")
    try:
        tree = db.fetch_tree()
    except Exception:
        return web.json_response({"root": wb_root(), "tabs": [], "data": {},
                                  "error": "词库数据读取失败"})
    payload = _cards_from_tree(tree)
    result = {"root": wb_root(), "tabs": payload["tabs"], "data": {},
              "tab_ids": _wb_tab_ids(tree)}
    tab = _wb_tab_name_by_id(tree, tab)
    if tab is not None:
        result["data"][tab] = payload["data"].get(tab, [])
        return web.json_response(result)
    # 无指定 tab：返回全部 tab 数据。
    # 首屏场景前端 Wordbank.js 会自行裁剪只保留当前 tab（懒加载语义不变）；
    # 全量/强制刷新场景（如图库详情标签的 name->card 映射）依赖此全量返回，
    # 否则非第一个 tab 的词库词条匹配不到，左键点击详情标签会误报「不在词库中」。
    result["data"] = payload["data"]
    return web.json_response(result)

async def get_image(request):
    """卡片图片代理：zhule_img/ 与 zhule_reference/ 前缀按 output/zhule_studio/ 解析。

    zhule_img/ 为图库反查图，zhule_reference/ 为词条上传参考图。
    """
    path = request.query.get("path", "")
    roots = (IMAGE_ROOT, wb_root())
    if path.startswith("zhule_img/") or path.startswith(REF_SUBDIR + "/"):
        roots = (os.path.join(IMAGE_ROOT, STUDIO_SUBDIR), wb_root())
    for root in roots:
        full = os.path.abspath(os.path.join(root, path))
        if _is_within(root, full) and os.path.isfile(full):
            return web.FileResponse(full)
    return web.Response(status=404)


async def post_rename(request):
    """编辑词条（DB 版）：改名 name / 内容 en（content）/ 中文 cn（content_cn）写 zhule.db。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    rel_path = (body.get("path") or "").strip()
    name = (body.get("name") or "").strip()
    if not rel_path:
        return web.json_response({"error": "缺少 path"}, status=400)
    if not name:
        return web.json_response({"error": "名字不能为空"}, status=400)
    if INVALID_NAME.search(name) or name.startswith("."):
        return web.json_response({"error": "名字含非法字符"}, status=400)
    # 兼容旧散 txt 后缀（DB 中散 txt 已归一为 entry 节点，无 .txt 后缀）
    rel_path = rel_path[:-4] if rel_path.lower().endswith(".txt") else rel_path
    node = db.node_by_raw_path(rel_path)
    if node is None or node.get("type") != "entry":
        return web.json_response({"error": "词条不存在"}, status=404)
    nid = int(node["id"])
    dup = db.sibling_dup(db.get_parent_id(nid), name, exclude_id=nid)
    if dup is not None and dup != name:
        return web.json_response({"error": "词条已存在: " + dup}, status=409)
    content = body.get("content")
    content_cn = body.get("content_cn")
    ok = db.update_node(
        nid,
        name=name,
        en=(content if isinstance(content, str) else None),
        cn=(content_cn if isinstance(content_cn, str) else None),
    )
    if not ok:
        return web.json_response({"error": "更新失败"}, status=500)
    return web.json_response({"ok": True})

async def post_wordbank_delete(request):
    """删除词条（DB 版）：递归删除该节点及其子树（zhule.db）。禁止删除顶层 Tab。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    rel_path = (body.get("path") or "").strip()
    if not rel_path:
        return web.json_response({"error": "缺少 path"}, status=400)
    rel_path = rel_path[:-4] if rel_path.lower().endswith(".txt") else rel_path
    node, _, is_root = db.resolve_path(rel_path)
    if node is None:
        return web.json_response({"error": "词条不存在"}, status=404)
    if is_root:
        return web.json_response({"error": "不能删除 Tab 根目录"}, status=400)
    count = db.delete_subtree(int(node["id"]))
    return web.json_response({"ok": True, "deleted": count})

async def post_wordbank_tab_create(request):
    """新建 Tab 大类（DB 版）：INSERT 顶层 category 节点，sort_order 取同层 max+1。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    name = (body.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "分类名不能为空"}, status=400)
    if INVALID_NAME.search(name):
        return web.json_response({"error": "名字含非法字符"}, status=400)
    if name.startswith("."):
        return web.json_response({"error": "名字不能以点开头"}, status=400)
    dup = db.sibling_dup(None, name)
    if dup is not None:
        return web.json_response({"error": "分类已存在: " + dup}, status=400)
    nid, ok = db.insert_node(None, "category", name)
    if not ok:
        return web.json_response({"error": "创建失败"}, status=500)
    return web.json_response({"ok": True, "tab": name, "id": str(nid)})

async def post_wordbank_chip_create(request):
    """新建小类（DB 版）：body { tab, parent, name }，定位父节点后 INSERT category。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    tab = (body.get("tab") or "").strip().strip("/")
    parent = (body.get("parent") or "").strip().strip("/")
    name = (body.get("name") or "").strip()
    if not tab:
        return web.json_response({"error": "缺少 tab"}, status=400)
    if not name:
        return web.json_response({"error": "分类名不能为空"}, status=400)
    if INVALID_NAME.search(name) or name.startswith("."):
        return web.json_response({"error": "名字含非法字符"}, status=400)
    rel = "/".join([p for p in (tab + "/" + parent if parent else tab).split("/") if p])
    node, _, _ = db.resolve_path(rel)
    if node is None:
        return web.json_response({"error": "父分类不存在"}, status=404)
    nid = int(node["id"])
    dup = db.sibling_dup(nid, name)
    if dup is not None:
        return web.json_response({"error": "分类已存在: " + dup}, status=400)
    new_id, ok = db.insert_node(nid, "category", name)
    if not ok:
        return web.json_response({"error": "创建失败"}, status=500)
    return web.json_response({"ok": True, "id": str(new_id)})

async def post_wordbank_card_create(request):
    """新建词条（DB 版）：body { tab, parent, name, content, content_cn }。

    兼容旧散 txt 语义：name 以 .txt 结尾时去掉后缀（词库归一化为 entry 节点），
    散 txt 仍不支持中文（content_cn 非空则 400）。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    tab = (body.get("tab") or "").strip().strip("/")
    parent = (body.get("parent") or "").strip().strip("/")
    name = (body.get("name") or "").strip()
    content = body.get("content")
    content_cn = body.get("content_cn")
    if not tab:
        return web.json_response({"error": "缺少 tab"}, status=400)
    if not name:
        return web.json_response({"error": "名字不能为空"}, status=400)
    if INVALID_NAME.search(name) or name.startswith("."):
        return web.json_response({"error": "名字含非法字符"}, status=400)
    is_txt = name.lower().endswith(".txt")
    if is_txt:
        stem = os.path.splitext(name)[0]
        if not stem:
            return web.json_response({"error": "名字不能为空"}, status=400)
        if isinstance(content_cn, str) and content_cn.strip():
            return web.json_response({"error": "散 txt 卡片暂不支持中文提示词"}, status=400)
        name = stem
    rel = "/".join([p for p in (tab + "/" + parent if parent else tab).split("/") if p])
    node, _, _ = db.resolve_path(rel)
    if node is None:
        return web.json_response({"error": "父分类不存在"}, status=404)
    nid = int(node["id"])
    dup = db.sibling_dup(nid, name)
    if dup is not None:
        return web.json_response({"error": "词条已存在: " + dup}, status=400)
    new_id, ok = db.insert_node(
        nid, "entry", name,
        en=(content if isinstance(content, str) else ""),
        cn=(content_cn if isinstance(content_cn, str) else ""),
    )
    if not ok:
        return web.json_response({"error": "创建失败"}, status=500)
    return web.json_response({"ok": True, "id": str(new_id)})

async def post_wordbank_image(request):
    """删除词条参考图：物理删除 output/zhule_studio/zhule_reference/<词条id>/ 下的图片。

    仅支持 action=delete；images.txt 机制已移除，unref 不再支持。
    图库反查图（zhule_img/ 前缀）来源于图库本体，不允许在此删除。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    rel_path = (body.get("path") or "").strip()
    image = (body.get("image") or "").strip()
    action = (body.get("action") or "delete").strip()
    if not rel_path or not image:
        return web.json_response({"error": "缺少 path 或 image"}, status=400)
    if action != "delete":
        return web.json_response({"error": "images.txt 已移除，仅支持 action=delete"}, status=400)
    prefix = REF_SUBDIR + "/"
    if not image.startswith(prefix):
        return web.json_response({"error": "图库反查图不可删除，仅可删除词条上传的参考图"}, status=400)
    rel_path = rel_path[:-4] if rel_path.lower().endswith(".txt") else rel_path
    node, _, _ = db.resolve_path(rel_path)
    if node is None:
        return web.json_response({"error": "词条不存在"}, status=404)
    # 路径形如 zhule_reference/<词条id>/<文件>：校验 id 归属，防跨词条删除
    parts = image[len(prefix):].split("/")
    if len(parts) < 2 or parts[0] != str(node["id"]):
        return web.json_response({"error": "图片不属于该词条"}, status=403)
    folder = _ref_dir(node["id"])
    full = os.path.abspath(os.path.join(folder, *parts[1:]))
    if not _is_within(folder, full):
        return web.json_response({"error": "图片路径越界"}, status=403)
    if not os.path.isfile(full):
        return web.json_response({"error": "图片文件不存在"}, status=404)
    try:
        os.remove(full)
    except OSError as e:
        return web.json_response({"error": "删除文件失败: " + str(e)}, status=500)
    return web.json_response({"ok": True, "images": _card_images(node)})


async def post_wordbank_image_upload(request):
    """上传词条参考图：写入 output/zhule_studio/zhule_reference/<词条id>/（目录自动创建）。"""
    try:
        reader = await request.multipart()
    except Exception:
        return web.json_response({"error": "multipart 解析失败"}, status=400)
    rel_path = None
    file_field = None
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "path":
            rel_path = (await part.read()).decode("utf-8", "ignore").strip()
        elif part.name == "file":
            file_field = part
    if not rel_path or file_field is None:
        return web.json_response({"error": "缺少 path 或 file"}, status=400)
    rel_path = rel_path[:-4] if rel_path.lower().endswith(".txt") else rel_path
    node, _, _ = db.resolve_path(rel_path)
    if node is None:
        return web.json_response({"error": "词条不存在"}, status=404)
    filename = os.path.basename(file_field.filename or "")
    if not filename:
        return web.json_response({"error": "缺少文件名"}, status=400)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in IMAGE_EXTS:
        return web.json_response({"error": "仅支持图片文件: " + "/".join(sorted(IMAGE_EXTS))}, status=400)
    folder = _ref_dir(node["id"])
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as e:
        return web.json_response({"error": "创建参考图目录失败: " + str(e)}, status=500)
    target = os.path.abspath(os.path.join(folder, filename))
    if not _is_within(folder, target):
        return web.json_response({"error": "文件名非法"}, status=400)
    if os.path.exists(target):
        stem, _ = os.path.splitext(filename)
        i = 1
        while os.path.exists(os.path.join(folder, f"{stem}_{i}{ext}")):
            i += 1
        target = os.path.join(folder, f"{stem}_{i}{ext}")
    try:
        with open(target, "wb") as f:
            while True:
                chunk = await file_field.read_chunk()
                if not chunk:
                    break
                f.write(chunk)
    except Exception as e:
        return web.json_response({"error": "保存文件失败: " + str(e)}, status=500)
    return web.json_response({"ok": True, "images": _card_images(node)})


async def post_wordbank_sort_save(request):
    """排序保存（DB 版）：按 order 顺序给各层节点写连续 sort_order，不再重命名目录。

    body: { order: { 父相对路径(""=根): [子项原始名...], ... } }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    order = body.get("order")
    if not isinstance(order, dict):
        return web.json_response({"error": "order 必须为对象"}, status=400)
    total = 0
    layers = 0
    errors = []
    for parent, rels in order.items():
        parent = (parent or "").strip().replace("\\", "/")
        if not isinstance(rels, list):
            errors.append(f"层级「{parent or '(根)'}」顺序必须是数组")
            continue
        clean = []
        for r in rels:
            if not isinstance(r, str):
                continue
            r = r.strip()
            if not r or "/" in r or "\\" in r or r.startswith(".") \
                    or r in (MAIN_FILE, CN_FILE, IMAGES_FILE):
                continue
            if r not in clean:
                clean.append(r)
        if parent:
            node, _, _ = db.resolve_path(parent)
            if node is None:
                errors.append(f"层级「{parent}」不存在")
                continue
            n = db.reorder_layer(int(node["id"]), clean)
        else:
            n = db.reorder_top(clean)
        total += n
        layers += 1
    try:
        from . import gallery as _gal
        _gal._tree_cache.update({"ts": 0.0, "sig": None, "tree": None, "anc": None})
    except Exception:
        pass
    return web.json_response({"ok": True, "layers": layers, "renamed": total,
                              "errors": errors})

async def post_wordbank_clean_cn(request):
    """去中文清理（DB 版）：遍历 zhule.db 的 en 字段，移除中文字符与中文标点。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    updated, total = db.clean_en_cn()
    return web.json_response({"ok": True, "stats": {
        "scanned": total, "checked": total, "cleaned": updated,
        "skipped_unchanged": 0, "chinese_files": 0, "no_cn": 0, "errors": 0,
    }})

async def get_index(request):
    index = os.path.join(WEB_DIR, "index.html")
    if not os.path.isfile(index):
        return web.Response(status=404, text="Studio web 资源缺失: " + WEB_DIR)
    return web.FileResponse(index, headers={"Content-Type": "text/html"})


async def get_static(request):
    tail = request.match_info.get("tail", "")
    if not tail:
        return await get_index(request)
    full = os.path.abspath(os.path.join(WEB_DIR, tail))
    if not _is_within(WEB_DIR, full):
        return web.Response(status=403)
    if not os.path.isfile(full):
        return web.Response(status=404)
    ctype = _CONTENT_TYPES.get(os.path.splitext(full)[1].lower())
    if ctype:
        return web.FileResponse(full, headers={"Content-Type": ctype})
    return web.FileResponse(full)

