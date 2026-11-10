"""Zhule Studio 后端：词库读写、参考图管理、图片代理、Studio 页面静态服务。

数据源（SQLite 单库 modules/studio/zhule.db，数据层见 db.py）：
  - 词库：表 prompt（父子层级树；entry 叶子为词条：en 英文提示词 / cn 中文 / sort_order 排序）
  - 图库：表 gallery_image / gallery_tag
  - 自定义标签：表 custom_tag

词条卡片结构（由 DB 树还原，前端 Wordbank.js 消费）：
  {name, number, rawName, relPath, chips, chipKeys, content, content_cn, images, mtime}
  - relPath：词条在词库树中的原始路径（含编号前缀）
  - mtime：取自 DB updated_at（按时间排序用）
  - images：参考图路径数组（相对 output/zhule_studio/），两个来源合并展示：
      1. 词条上传图  zhule_reference/<词条id>/<文件>（卡片详情页上传，排在前）
      2. 图库反查图  zhule_img/<文件>（按词条名匹配图库 tag，接在后面；删除即删图库原图本体）

词库文本与 images.txt 均已不再落盘读写，词库目录仅作历史兼容保留。
"""
import datetime
import json
import os
import re
import shutil

from aiohttp import web

from ..common.paths import _get_output_dir
from . import db  # zhule.db 数据层（词库/图库读写统一走 SQLite）

STUDIO_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.abspath(os.path.join(STUDIO_DIR, "web"))

# 词库根：随代码走，位于 modules/studio/prompt/
_WB_ROOT = os.path.join(STUDIO_DIR, "prompt")

# 调试日志目录：ComfyUI-Zhule-Nodes/log
LOG_DIR = os.path.abspath(os.path.join(STUDIO_DIR, "..", "..", "log"))


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

def _vg_prefix_of(name):
    """版本组锚点（组头）的「组名」部分。

    卡片级锚点自己的名字也是「组名#版本名」两段（它既是组头、又是组里的一版），
    所以取前缀必须先拆 # 再回退：拆出前缀就用前缀，没 # 就整串当组名（分类级老形态）。
    直接拿锚点全名当前缀会把「组名#默认#新版本」这种套娃名字写进库。
    """
    head, _tail = db.split_vg_name(name)
    return (head or str(name or "")).strip()


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


def _purge_ref_dir(entry_id):
    """清理词条参考图目录 zhule_reference/<词条id>/，返回是否发生清理。

    为保留可回滚能力，目录整体移动到 zhule_reference/_trash/<词条id>-<时间戳>/，
    而非物理删除；只处理 REF 根目录下的一级子目录，防止越界。
    """
    root = os.path.abspath(os.path.join(IMAGE_ROOT, STUDIO_SUBDIR, REF_SUBDIR))
    target = os.path.abspath(_ref_dir(entry_id))
    if os.path.dirname(target) != root or not os.path.isdir(target):
        return False
    trash = os.path.join(root, "_trash")
    try:
        os.makedirs(trash, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(trash, str(entry_id) + "-" + stamp)
        seq = 1
        while os.path.exists(dest):
            dest = os.path.join(trash, str(entry_id) + "-" + stamp + "-" + str(seq))
            seq += 1
        shutil.move(target, dest)
        return True
    except (OSError, shutil.Error):
        return False


def _card_images(node):
    """词条卡片参考图数据源，返回相对 output/zhule_studio/ 的路径数组。

    两个来源合并展示（上传图在前，图库反查图接后，去重）：
    1. 词条上传图：zhule_reference/<词条id>/<文件>（卡片详情页上传，可删）；
    2. 图库反查图：zhule_img/<文件>（按词条名匹配图库 tag，数据源为内存 index）。

    「上传图优先」= 排序在前，不再整体屏蔽图库反查图。
    images.txt 与「词库目录内 / 父目录立绘图」机制均已停用，不再读取与生成。
    """
    out = []
    nid = node.get("id")
    if nid:
        imgs = _list_images(_ref_dir(nid))
        out = [REF_SUBDIR + "/" + str(nid) + "/" + f for f in imgs]

    name = node.get("name") or ""
    if name:
        from .gallery import get_tag_ref_index  # 延迟导入避免循环依赖
        for rel in (get_tag_ref_index().get(name) or []):
            if rel not in out:
                out.append(rel)
    return out


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
    content_cn/neg/override/images/mtime。neg=负面提示词，override=排除词。id 为 DB 词条 id（提示词标签按 id 传递，词条改名/移动
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

    def collect(node, parts, ids, out, anc=()):
        """按原 _folder_card/_txt_card 公式还原卡片字段。

        parts = 从 Tab 根到当前节点父级的原始目录名列表（不含当前节点）。
        ids   = 与 parts 同序的节点 DB id 列表（不含当前节点）。
        chips/chipKeys/chipIds 由 parts/ids 位置直接推导，与磁盘扫描结果逐字段一致。
        anc   = 从 Tab 根到当前节点父级的分类属性链（含 Tab 根，不含当前节点），
                每项 {id, name, en, cn, neg, override}。子类继承父类属性时前端直接用它拼接，
                不再二次请求（继承结果只在前端临时展开，不落库）。
        """
        raw = _node_raw_name(node)
        children = node.get("children") or []
        nid = str(node.get("id") or "")
        my_attr = {
            "id": nid,
            "name": node.get("name") or "",
            "en": node.get("en") or "",
            "cn": node.get("cn") or "",
            "neg": node.get("neg") or "",
            "override": node.get("override") or "",
            # provide=1 表示本节点的属性可以向下继承；关掉则断链，下级不再拿到这一层
            "provide": 1 if node.get("provide") else 0,
        }
        # 下钻时带下去的继承链：只有 provide 的节点才把自己的属性加进链里
        child_anc = tuple(anc) + ((my_attr,) if my_attr["provide"] else ())
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
                    "chipIds": ids[1:end],
                    "content": node.get("en") or "",
                    "content_cn": "",
                    "neg": node.get("neg") or "",
                    "override": node.get("override") or "",
                    "anc": list(anc),
                    "images": _card_images(node),
                    "mtime": node.get("updatedAt") or 0,
                    "mute": 1 if node.get("mute") else 0,
                    # 1 = 本卡片自己是「版本组锚点」（卡片级空壳）：卡面只挂组名、不出词，
                    # 其下子条目是平等版本，各自写完整提示词，互不继承
                    "vg": 1 if node.get("vg") else 0,
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
                    "chipIds": ids[1:end],
                    "content": node.get("en") or "",
                    "content_cn": node.get("cn") or "",
                    "neg": node.get("neg") or "",
                    "override": node.get("override") or "",
                    "anc": list(anc),
                    "images": _card_images(node),
                    "mtime": node.get("updatedAt") or 0,
                    "mute": 1 if node.get("mute") else 0,
                    # 1 = 本卡片自己是「版本组锚点」（卡片级空壳）：卡面只挂组名、不出词，
                    # 其下子条目是平等版本，各自写完整提示词，互不继承
                    "vg": 1 if node.get("vg") else 0,
                })
            # entry 带 children（含 prompt.txt 仍下钻，如 01_嘴部）：继续递归
            if children:
                for child in children:
                    collect(child, parts + [raw], ids + [nid], out, child_anc)
            return
        for child in children:
            collect(child, parts + [raw], ids + [nid], out, child_anc)

    for tab_node in tree:
        cards = []
        # Tab 根的属性由 collect 自己在进入时累积（避免出现两次），这里传空链起点
        collect(tab_node, [], [], cards, ())
        tab_disp = tab_node.get("name") or _node_raw_name(tab_node)
        tabs.append(tab_disp)
        # 卡片自带所属 tab：relPath 从 tab 根开始、不含 tab 名，跨 tab 可能同名同路径；
        # 前端选词/全库搜索要靠它判定归属，不能再拿 activeTab 去推
        for _c in cards:
            _c["tab"] = tab_disp
        data[tab_disp] = cards
    return {"tabs": tabs, "data": data}


def _nodes_index(tree):
    """全树节点属性索引：{id: {id, parentId, type, name, mute, en, cn, neg, override}}。

    供前端「编辑分类」弹层直接按 chipId / 分类 id 取当前属性（无需再发请求），
    也让继承展开可以在任意节点上按 parentId 向上递归。分类/词条一律返回，
    空值即空串，展示侧自然不显示。

    不再下发 path（旧版按「tab 目录名/一级/二级...」完整相对路径定位分类与迁移旧存档，
    现已全链路 id 化，前端静音继承也改为 id 祖先链判定）。
    """
    out = {}

    def walk(nodes):
        for n in nodes or []:
            nid = str(n.get("id") or "")
            if not nid:
                continue
            name = n.get("name") or ""
            out[nid] = {
                "id": nid,
                "parentId": str(n.get("parentId") or ""),
                "type": n.get("type") or "",
                "name": name,
                # 分类静音位：前端分类右键菜单据此显示「静音/恢复」，并按 id 链向下继承
                "mute": 1 if n.get("mute") else 0,
                "en": n.get("en") or "",
                "cn": n.get("cn") or "",
                "neg": n.get("neg") or "",
                "override": n.get("override") or "",
                # 1 = 本节点属性可向下继承（编辑分类弹层里的「向下继承」开关）
                "provide": 1 if n.get("provide") else 0,
                # 1 = 本分类是「版本组」：其下多条词条是同一提示词的多版本，前端合并成 1 张卡
                "vg": 1 if n.get("vg") else 0,
            }
            walk(n.get("children"))
    walk(tree)
    return out


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
              "tab_ids": _wb_tab_ids(tree), "nodes": _nodes_index(tree)}
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
    """编辑词条（DB 版）：按 DB id 定位，改名 name / 内容 en（content）/ 中文 cn（content_cn）写 zhule.db。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    raw_id = (body.get("id") or "").strip()
    name = (body.get("name") or "").strip()
    if not raw_id:
        return web.json_response({"error": "缺少 id"}, status=400)
    if not name:
        return web.json_response({"error": "名字不能为空"}, status=400)
    node = db.node_by_id(raw_id)
    if node is None:
        return web.json_response({"error": "节点不存在"}, status=404)
    nid = int(node["id"])
    # 版本条目（挂在版本组锚点下面）：「组名#版本名」的前半段由锚点强制管理，用户只能改 # 后面那段。
    # 前端可能带着全名提交（编辑弹层回填的就是全名），这里统一剥掉前缀、按锚点当前名字重拼，
    # 保证前缀永远等于锚点名，不会因为手改而和组名脱节。
    parent = db.node_by_id(node.get("parent_id")) if node.get("parent_id") else None
    is_vg_parent = bool(parent and parent.get("vg"))
    is_vg_anchor_parent = bool(is_vg_parent and str(parent.get("type") or "") == "entry")
    # 前缀只取锚点名的「组名」段：卡片级锚点自己的名字也是「组名#版本名」，
    # 直接拿全名当前缀会拼出「组名#默认#新版本」这种套娃名字。
    pre = _vg_prefix_of(parent.get("name")) if is_vg_parent else ""
    tail = ""
    if pre and (is_vg_anchor_parent or name.startswith(pre + db.VG_SEP)):
        _, tail = db.split_vg_name(name)
        tail = (tail or name.lstrip("#")).strip()
    # 锚点自身（卡片级）：它名字里也带「组名#版本名」，用户在这里输入的其实是新组名，
    # # 后面那段的版本名要原样保留，否则改一次组名，这颗卡的版本名就被吃掉了。
    self_tail = ""
    if bool(node.get("vg")) and str(node.get("type") or "") == "entry" and not pre:
        old_head, old_tail = db.split_vg_name(str(node.get("name") or ""))
        if old_head and old_tail and db.VG_SEP not in name:
            self_tail = old_tail
    # 非法字符校验同样只看用户输入的版本名那一段：锚点名自带的中文标点（如 /）不参与校验，
    # 否则编辑一个干净版本名也会被锚点前缀连累成「名字含非法字符」。
    check_name = tail if tail else name
    if INVALID_NAME.search(check_name) or check_name.startswith("."):
        return web.json_response(
            {"error": '名字含非法字符（不能包含 \\ / : * ? " < > |）'}, status=400)
    if pre and tail:
        name = pre + db.VG_SEP + tail
    elif self_tail:
        name = name.strip() + db.VG_SEP + self_tail
    dup = db.sibling_dup(db.get_parent_id(nid), name, exclude_id=nid)
    if dup is not None and dup != name:
        kind = "分类" if node.get("type") != "entry" else "词条"
        return web.json_response({"error": kind + "已存在: " + dup}, status=409)
    old_name = str(node.get("name") or "")
    content = body.get("content")
    content_cn = body.get("content_cn")
    neg = body.get("neg")
    override = body.get("override")
    provide = body.get("provide")
    ok = db.update_node(
        nid,
        name=name,
        en=(content if isinstance(content, str) else None),
        cn=(content_cn if isinstance(content_cn, str) else None),
        neg=(neg if isinstance(neg, str) else None),
        override=(override if isinstance(override, str) else None),
        provide=(None if provide is None else (1 if provide else 0)),
    )
    if not ok:
        return web.json_response({"error": "更新失败"}, status=500)
    # 锚点（版本组组长）改名 → 名下所有版本条目的「组名#」前缀整组刷新，
    # 组名就是前缀，二者必须永远同步，否则卡片标题、搜索、导出会各说各话。
    # 注意新旧前缀都只取「组名」段：卡片级锚点自己的名字是「组名#版本名」，
    # 拿整串去 LIKE 匹配「组名#%」一条都命中不了，级联就会静默失效。
    renamed = 0
    if bool(node.get("vg")) and name != old_name:
        renamed = db.cascade_vg_prefix(nid, _vg_prefix_of(old_name), _vg_prefix_of(name))
    return web.json_response({"ok": True, "name": name, "cascade": renamed})

async def post_wordbank_mute(request):
    """静音（mute）开关（DB 版）：按节点 id 写 prompt.mute，词条与分类通用。

    mute=1：该词条在遍历模式、随机模式、单次随机等所有「自动选词」流程中被跳过，
    但用户手动点选卡片照常可用；mute=0：恢复正常参与。
    分类节点（type=tab/chip，含空层占位）同样可静音：静音分类即其下全部词条等效静音，
    由前端按节点路径向下继承，库里只改该分类节点自身的 mute 位。
    与 isdel 硬删互不影响（硬删走 wordbank/delete，卡片不再返回）。
    入参 {id, mute?}：mute 缺省时按当前值取反（前端快捷开关用）。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    raw_id = str(body.get("id") or "").strip()
    if not raw_id:
        return web.json_response({"error": "缺少 id"}, status=400)
    node = db.node_by_id(raw_id)
    if node is None:
        return web.json_response({"error": "节点不存在"}, status=404)
    if "mute" in body:
        mute = bool(body.get("mute"))
    else:
        mute = not bool(node.get("mute"))
    if not db.set_mute(int(node["id"]), mute):
        return web.json_response({"error": "设置失败"}, status=500)
    return web.json_response({"ok": True, "id": node["id"], "mute": 1 if mute else 0})


async def post_wordbank_vg(request):
    """版本组（vg）开关（DB 版）：按节点 id 写 prompt.vg。

    vg=1：该节点下的多条词条视为同一提示词的不同版本，前端把整组合并成 1 张卡，
    卡片内翻页（默认）/ 右键呼出胶片条 / 已选标签切随机·遍历，三种用法同时可用。
    vg=0：拆回原样，每条词条各占一张卡（默认行为，老数据零影响）。

    两种承载层级都允许：
    - 分类节点（老形态）：整个分类的词条是同一提示词的多版本；
    - 卡片节点（新形态，推荐）：卡片自己是组头，卡面放共有描述，下面挂版本子项，
      共有描述沿 parent_id 强制下传给每个版本（关系固定，不做可关的 provide 开关）。
    顶层 Tab 不参与。

    入参 {id, vg?}：vg 缺省时按当前值取反（前端右键一键切换用）。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    raw_id = str(body.get("id") or "").strip()
    if not raw_id:
        return web.json_response({"error": "缺少 id"}, status=400)
    node = db.node_by_id(raw_id)
    if node is None:
        return web.json_response({"error": "节点不存在"}, status=404)
    if not node.get("parent_id"):
        return web.json_response({"error": "版本组不能标在顶层 Tab 上"}, status=400)
    # 分类级版本组只允许落在「末级分类」上：分类下若还有子分类，把它标成版本组等于把整棵
    # 子树的词条都压进一张卡，既不符合「一分类=同意图的多版本」语义，也会让子分类失去独立入口。
    if str(node.get("type") or "") == "category" and db.has_child_category(int(node["id"])):
        return web.json_response(
            {"error": "该分类下还有子分类，只有末级分类才能标为版本组"}, status=400)
    if "vg" in body:
        vg = bool(body.get("vg"))
    else:
        vg = not bool(node.get("vg"))
    if not db.set_vg(int(node["id"]), vg):
        return web.json_response({"error": "设置失败"}, status=500)
    return web.json_response({"ok": True, "id": node["id"], "vg": 1 if vg else 0})


async def post_wordbank_vg_join(request):
    """把若干提示词并入同一个版本组：body { ids:[...], name:"组名" }。

    这是「从提示词入手」建版本组的唯一入口（单个 / 多选共用）：
    - 组名由用户在弹框里现输，不沿用任何一张卡的现名；
    - 每张被并入的卡统一固化成「组名#版本名」，版本名取它自己的现名（已有 # 前缀的取 # 后那段，
      不然多选几张老版本卡会拼出「组名#旧组名#版本」的套娃名字）；
    - 组头（锚点）优先选已经是版本组头的那张，没有就用第一张（右键/主选的那张），
      其余卡 parent_id 改挂到组头下面，于是它们成为同一提示词的不同版本，一张卡翻页切换。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    raw_ids = body.get("ids")
    if isinstance(raw_ids, (str, int)):
        raw_ids = [raw_ids]
    ids = []
    for x in (raw_ids or []):
        s = str(x or "").strip()
        if s and s.isdigit() and s not in ids:
            ids.append(s)
    name = (body.get("name") or "").strip()
    if not ids:
        return web.json_response({"error": "没有选中任何提示词"}, status=400)
    if len(ids) > 200:
        return web.json_response({"error": "一次最多并入 200 条"}, status=400)
    if not name:
        return web.json_response({"error": "组名不能为空"}, status=400)
    if name.startswith("."):
        return web.json_response({"error": "组名不能以点开头"}, status=400)
    if INVALID_NAME.search(name) or db.VG_SEP in name:
        return web.json_response(
            {"error": '组名含非法字符（不能包含 \\ / : * ? " < > | #）'}, status=400)
    nodes = []
    for i in ids:
        n = db.node_by_id(i)
        if n is None:
            return web.json_response({"error": "有提示词已被删除，刷新后再试"}, status=404)
        if str(n.get("type") or "") != "entry":
            return web.json_response(
                {"error": "只有提示词卡片才能并入版本组；分类请用分类右键的「标为版本组」"}, status=400)
        nodes.append(n)
    anchors = [n for n in nodes if n.get("vg")]
    if len(anchors) > 1:
        return web.json_response(
            {"error": "选中的卡片里有多个版本组头，一次只能并入一个组，请拆开再试"}, status=400)
    anchor = anchors[0] if anchors else nodes[0]
    aid = int(anchor["id"])
    a_parent = db.get_parent_id(aid)
    # 环检测：被并入的卡若正好是组头的祖先，挂过去会把组头自己拖进自己的子树里
    up = a_parent
    hops = 0
    while up is not None and hops < 64:
        if str(up) in ids:
            return web.json_response({"error": "选中的卡片存在上下级关系，无法并入同一组"}, status=400)
        up = db.get_parent_id(up)
        hops += 1
    # 先整体算好新名字并查重，任一条冲突就整批不动，避免只改一半留下残局
    plan = []
    seen_new = set()
    for n in nodes:
        nid = int(n["id"])
        old_name = str(n.get("name") or "").strip()
        tail = db.split_vg_name(old_name)[1].strip() or old_name
        if not tail:
            return web.json_response({"error": "有提示词名字为空，无法并入"}, status=400)
        new_name = name + db.VG_SEP + tail
        # 批内自查：多选里有两条同名词条时，它们会拼出同一个「组名#版本名」，
        # 光靠 sibling_dup 查不出来（此刻还没改名），必须先在本次计划里排掉
        if new_name in seen_new:
            return web.json_response(
                {"error": "选中的提示词里有同名版本，会拼出重复的「" + new_name + "」，请先改名再并入"},
                status=400)
        seen_new.add(new_name)
        if nid != aid:
            dup = db.sibling_dup(a_parent, new_name, exclude_id=nid)
            if dup is not None and dup != new_name:
                return web.json_response(
                    {"error": "组里已有同名的版本: " + dup}, status=400)
        elif db.sibling_dup(a_parent, new_name, exclude_id=aid) is not None and new_name != old_name:
            return web.json_response({"error": "同一位置已有同名卡片: " + new_name}, status=400)
        plan.append((nid, old_name, new_name))
    old_group = _vg_prefix_of(anchor.get("name"))
    # 组头先立：改名为「组名#它自己的版本名」并置 vg=1；其余成员改名后改挂到它名下
    for nid, old_name, new_name in plan:
        if nid == aid:
            if not db.update_node(nid, name=new_name, vg=1):
                return web.json_response({"error": "设置组头失败"}, status=500)
        else:
            if not db.update_node(nid, name=new_name):
                return web.json_response({"error": "改名失败: " + old_name}, status=500)
            if not db.relocate(nid, aid):
                return web.json_response({"error": "并入失败: " + old_name}, status=500)
    # 组头若原本就带老组名，把它名下老版本的前缀一起刷成新组名
    cascaded = 0
    if old_group and old_group != name:
        cascaded = db.cascade_vg_prefix(aid, old_group, name)
    return web.json_response({
        "ok": True,
        "anchorId": str(aid),
        "count": len(plan),
        "cascade": cascaded,
    })


async def post_wordbank_delete(request):
    """删除词条（DB 版）：按 DB id 递归删除该节点及其子树（zhule.db）。禁止删除顶层 Tab。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    raw_id = (body.get("id") or "").strip()
    if not raw_id:
        return web.json_response({"error": "缺少 id"}, status=400)
    node = db.node_by_id(raw_id)
    if node is None:
        return web.json_response({"error": "词条不存在"}, status=404)
    if node.get("type") == "category" and node.get("parent_id") is None:
        return web.json_response({"error": "不能删除 Tab 根目录"}, status=400)
    ids = db.subtree_ids(int(node["id"]))
    count = db.delete_subtree(int(node["id"]))
    if not count:
        return web.json_response({"error": "删除失败"}, status=500)
    purged = sum(1 for i in ids if _purge_ref_dir(i))
    return web.json_response({"ok": True, "deleted": count, "refDirsPurged": purged})

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
        return web.json_response(
            {"error": '名字含非法字符（不能包含 \\ / : * ? " < > |）'}, status=400)
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
    """新建小类（DB 版）：body { parentId, name }，在父分类下 INSERT category。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    parent_id = (body.get("parentId") or "").strip()
    name = (body.get("name") or "").strip()
    if not parent_id:
        return web.json_response({"error": "缺少 parentId"}, status=400)
    if not name:
        return web.json_response({"error": "分类名不能为空"}, status=400)
    if INVALID_NAME.search(name) or name.startswith("."):
        return web.json_response(
            {"error": '名字含非法字符（不能包含 \\ / : * ? " < > |）'}, status=400)
    pnode = db.node_by_id(parent_id)
    if pnode is None or pnode.get("type") != "category":
        return web.json_response({"error": "父分类不存在"}, status=404)
    pid = int(pnode["id"])
    dup = db.sibling_dup(pid, name)
    if dup is not None:
        return web.json_response({"error": "分类已存在: " + dup}, status=400)
    new_id, ok = db.insert_node(pid, "category", name)
    if not ok:
        return web.json_response({"error": "创建失败"}, status=500)
    return web.json_response({"ok": True, "id": str(new_id)})

async def post_wordbank_card_create(request):
    """新建词条（DB 版）：body { parentId, name, content, content_cn }。

    name 以 .txt 结尾时去掉后缀（散 txt 语义），散 txt 仍不支持中文（content_cn 非空则 400）。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    parent_id = (body.get("parentId") or "").strip()
    name = (body.get("name") or "").strip()
    content = body.get("content")
    content_cn = body.get("content_cn")
    if not parent_id:
        return web.json_response({"error": "缺少 parentId"}, status=400)
    if not name:
        return web.json_response({"error": "名字不能为空"}, status=400)
    if name.startswith("."):
        return web.json_response({"error": "名字不能以点开头"}, status=400)
    is_txt = name.lower().endswith(".txt")
    if is_txt:
        stem = os.path.splitext(name)[0]
        if not stem:
            return web.json_response({"error": "名字不能为空"}, status=400)
        if isinstance(content_cn, str) and content_cn.strip():
            return web.json_response({"error": "散 txt 卡片暂不支持中文提示词"}, status=400)
        name = stem
    pnode = db.node_by_id(parent_id)
    # 父节点两种都合法：普通分类（type=category），或版本组锚点卡（entry 且 vg=1，「新建版本」的落点）。
    # 锚点是空壳不出词，但它照样能挂子条目，所以不能再拿 type=="category" 一刀切。
    is_vg_anchor = bool(pnode and pnode.get("vg") and str(pnode.get("type") or "") == "entry")
    if pnode is None or (str(pnode.get("type") or "") != "category" and not is_vg_anchor):
        return web.json_response({"error": "父分类不存在"}, status=404)
    pid = int(pnode["id"])
    # 非法字符校验只针对「用户真正输入的那一段」：版本组的锚点名（组名）是库里既有的名字，
    # 中文词库场景里常自带 / 之类的标点（如「时间/环境光（单选）」）。若把前缀拼进全名后再整串校验，
    # 锚点自带的 / 会被当成用户输入，新建版本就莫名报「名字含非法字符」。
    pre = _vg_prefix_of(pnode.get("name")) if pnode.get("vg") else ""
    tail = ""
    if pre and (is_vg_anchor or name.startswith(pre + db.VG_SEP)):
        _, tail = db.split_vg_name(name)
        tail = (tail or name.lstrip("#")).strip()
    # 新建版本（父是锚点卡）：前缀由锚点强制管理，前端只填 # 后面那段，这里统一拼成「锚点名#版本名」
    if is_vg_anchor:
        if not tail:
            return web.json_response({"error": "版本名不能为空"}, status=400)
    elif not (pre and tail):
        # 分类级版本组（老形态）：前端没带「锚点名#」前缀时按普通词条处理，
        # 不能因为分类被标了 vg 就给该分类下所有普通词条强塞前缀。
        tail = ""
    check_name = tail if tail else name
    if INVALID_NAME.search(check_name):
        return web.json_response(
            {"error": '名字含非法字符（不能包含 \\ / : * ? " < > |）'}, status=400)
    if pre and tail:
        name = pre + db.VG_SEP + tail
    dup = db.sibling_dup(pid, name)
    if dup is not None:
        return web.json_response({"error": "词条已存在: " + dup}, status=400)
    new_id, ok = db.insert_node(
        pid, "entry", name,
        en=(content if isinstance(content, str) else ""),
        cn=(content_cn if isinstance(content_cn, str) else ""),
    )
    if not ok:
        return web.json_response({"error": "创建失败"}, status=500)
    return web.json_response({"ok": True, "id": str(new_id)})

async def post_wordbank_image(request):
    """删除词条参考图：物理删除本地文件并同步对应数据。

    两张来源分别处理（action 仅支持 delete，images.txt 机制已移除）：
    1. zhule_reference/<词条id>/<文件>：词条上传图，删该词条目录下的文件；
    2. zhule_img/<文件>：图库反查图，删除图库原图本体——原图 + 缩略图 +
       gallery_image 行（gallery_tag 按外键级联）+ 内存索引，等同图库里的删除。
       该图被所有按 tag 引用它的词条同步失去（同一张图全局删除，不是只解除本词条引用）。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    raw_id = (body.get("id") or "").strip()
    image = (body.get("image") or "").strip()
    action = (body.get("action") or "delete").strip()
    if not raw_id or not image:
        return web.json_response({"error": "缺少 id 或 image"}, status=400)
    if action != "delete":
        return web.json_response({"error": "images.txt 已移除，仅支持 action=delete"}, status=400)
    ref_prefix = REF_SUBDIR + "/"
    gal_prefix = "zhule_img/"
    if not (image.startswith(ref_prefix) or image.startswith(gal_prefix)):
        return web.json_response({"error": "不支持的参考图路径"}, status=400)
    node = db.node_by_id(raw_id)
    if node is None:
        return web.json_response({"error": "词条不存在"}, status=404)

    # 图库反查图：走图库单图删除（文件 + 缩略图 + DB 行 + 内存索引），失败原因原样回传
    if image.startswith(gal_prefix):
        from .gallery import delete_gallery_image  # 延迟导入避免循环依赖
        ok, err = delete_gallery_image(image[len(gal_prefix):])
        if not ok:
            return web.json_response({"error": err}, status=500)
        return web.json_response({"ok": True, "images": _card_images(node)})

    # 路径形如 zhule_reference/<词条id>/<文件>：校验 id 归属，防跨词条删除
    parts = image[len(ref_prefix):].split("/")
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
    raw_id = None
    file_field = None
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "id":
            raw_id = (await part.read()).decode("utf-8", "ignore").strip()
        elif part.name == "file":
            file_field = part
    if not raw_id or file_field is None:
        return web.json_response({"error": "缺少 id 或 file"}, status=400)
    node = db.node_by_id(raw_id)
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
    """排序保存（DB 版）：按 order 顺序给各层节点写连续 sort_order。

    body: { order: { 父节点 id(""=根): [子节点 id...], ... } }
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
            if not r:
                continue
            if r not in clean:
                clean.append(r)
        if parent:
            pnode = db.node_by_id(parent)
            if pnode is None:
                errors.append(f"层级「{parent}」不存在")
                continue
            n = db.reorder_layer(int(pnode["id"]), clean)
        else:
            n = db.reorder_top(clean)
        total += n
        layers += 1
    try:
        from . import gallery as _gal
        _gal._tree_cache.update({"ts": 0.0, "sig": None, "tree": None, "anc": None})
    except Exception:
        pass
    return web.json_response({"ok": True, "layers": layers, "total": total, "renamed": total,
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


async def post_debug_log(request):
    """前端随机池调试日志：追加写 log/wordbank_debug_YYYYMMDD.log，异常不抛（日志失败不干扰主流程）。"""
    try:
        body = await request.json()
        lines = body.get("lines") or []
        if not lines:
            return web.json_response({"ok": True})
        os.makedirs(LOG_DIR, exist_ok=True)
        path = os.path.join(LOG_DIR, "wordbank_debug_" + datetime.datetime.now().strftime("%Y%m%d") + ".log")
        stamp = datetime.datetime.now().strftime("%H:%M:%S")
        with open(path, "a", encoding="utf-8") as f:
            for line in lines:
                f.write(stamp + " " + line + "\n")
        return web.json_response({"ok": True})
    except Exception:
        return web.json_response({"ok": False})

