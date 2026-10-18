"""Zhule Studio 后端：扫描词库、图片代理、重命名卡片、Studio 页面静态服务。

词库目录约定（兼容两套命名）：
  插件根 prompt/（ComfyUI-Zhule-Studio/prompt，随插件走）
    ├── 角色/                          ← Tab
    │   └── .../07_银狼LV.999@/         ← 中间层（chip，@/% 等后缀原样保留）
    │       └── 银狼LV.999_服装/         ← 卡片文件夹
    │           └── 银狼LV.999.txt      ← 卡片内容
    └── 构图/
        ├── 角度视角/01_正面平视/        ← 卡片文件夹（含 prompt.txt）
        │   ├── prompt.txt             ← 显式内容文件（优先）
        │   ├── prompt_cn.txt          ← 中文（可选）
        │   └── images.txt             ← 每行一个相对 output/ 的图片路径（可选）
        └── 景深层次/01_浅景深虚化.txt    ← 散放 txt：每个 txt 一张卡片

命名：{数字}_{名字} 或 {数字} {名字}，无编号也支持。
卡片判定：
  1. 文件夹含 prompt.txt → 文件夹卡片（名字取文件夹名）
  2. 文件夹无子目录且只含一个 txt → 文件夹卡片（名字取文件夹名）
  3. 其余情况每个散 txt 各成一张卡片（名字取 txt 文件名，如"无.txt"）
图片：images.txt 优先；否则卡片文件夹内的真实图片；再否则父目录图片（角色立绘）。
"""
import json
import os
import re
import shutil
import time

from aiohttp import web

from ..common.paths import _get_output_dir
from . import state_store

STUDIO_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.abspath(os.path.join(STUDIO_DIR, "web"))

WORD_BANK_ROOT = os.path.abspath(os.path.join(STUDIO_DIR, "..", "..", "prompt"))
IMAGE_ROOT = _get_output_dir()

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


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _read_lines(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip()]
    except Exception:
        return []


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


def _bank_rel(folder):
    return os.path.relpath(folder, WORD_BANK_ROOT).replace(os.sep, "/")


def _card_images(folder):
    """词条卡片参考图数据源（按优先级）：

    1. 词条目录内本地上传图片（与 prompt.txt 同级，优先展示）；
    2. 图库 index 反查：以卡片标识名（目录名去数字前缀）匹配图库 tags，
       返回带 zhule_img/ 前缀的相对 output 路径（数据源为内存 index，守护线程维护正确性）；
    3. 父目录图片（角色立绘，仅 Tab 之下的中间层）。

    images.txt 中间产物已停用，不再读取/生成。
    """
    local = _list_images(folder)
    if local:
        rel = _bank_rel(folder)
        return [rel + "/" + f for f in local]

    name = parse_folder(os.path.basename(folder))[1]
    if name:
        from .gallery import get_tag_ref_index  # 延迟导入避免循环依赖
        refs = get_tag_ref_index().get(name)
        if refs:
            return refs

    parent = os.path.dirname(folder)
    parent_rel = _bank_rel(parent)
    # 父目录必须是 Tab 之下的中间层（排除 Tab 本身，避免误吃 Tab 级图片）
    if parent != WORD_BANK_ROOT and "/" in parent_rel:
        pimgs = _list_images(parent)
        if pimgs:
            return [parent_rel + "/" + f for f in pimgs]
    return []


def _card_mtime(path):
    """返回卡片对应路径的 mtime 时间戳（供词库按时间排序），不存在时返回 0。"""
    try:
        return int(os.path.getmtime(path))
    except OSError:
        return 0


def _folder_card(folder, rel, content_file):
    """文件夹卡片：名字/编号取文件夹名，chips 为父目录链（Tab 之下、卡片文件夹之前的全部祖先层）。"""
    folder_name = os.path.basename(folder)
    number, display_name = parse_folder(folder_name)
    parts = rel.replace(os.sep, "/").split("/") if rel else []
    chips = [parse_folder(p)[1] for p in parts[1:-1]]

    return {
        "name": display_name,
        "number": number,
        "rawName": folder_name,
        "relPath": rel.replace(os.sep, "/"),
        "chips": chips,
        "chipKeys": _chip_keys(parts, end=len(parts) - 1),
        "content": _read(content_file),
        "content_cn": _read(os.path.join(folder, CN_FILE)),
        "images": _card_images(folder),
        "mtime": _card_mtime(folder),
    }


def _txt_card(folder, rel, txt_file):
    """散 txt 卡片：名字/编号取 txt 文件名，chips 为父目录链。

    卡片层定位：优先取与 txt 同名的文件夹（标准结构 XX/XX.txt），
    找不到则 txt 所在目录即卡片层。chips = Tab 之下、卡片层之前的全部祖先层。
    """
    stem = os.path.splitext(txt_file)[0]
    number, display_name = parse_folder(stem)
    parts = rel.replace(os.sep, "/").split("/") if rel else []
    _, stem_disp = parse_folder(stem)
    entry_idx = -1
    for i in range(len(parts) - 1, 0, -1):
        if parse_folder(parts[i])[1] == stem_disp:
            entry_idx = i
            break
    end = entry_idx if entry_idx > 0 else len(parts) - 1
    chips = [parse_folder(p)[1] for p in parts[1:end]]

    return {
        "name": display_name,
        "number": number,
        "rawName": txt_file,
        "relPath": (rel.replace(os.sep, "/") + "/" + txt_file),
        "chips": chips,
        "chipKeys": _chip_keys(parts, end=end),
        "content": _read(os.path.join(folder, txt_file)),
        "content_cn": "",
        "images": [],
        "mtime": _card_mtime(os.path.join(folder, txt_file)),
    }


def _scan_tab(tab_path):
    cards = []
    for root, dirs, files in os.walk(tab_path):
        # 目录按前缀编号排序（编号即顺序）：有编号在前按数字，无编号在后按显示名
        dirs[:] = sorted([d for d in dirs if not d.startswith(".")],
                         key=lambda x: (0 if parse_folder(x)[0] > 0 else 1,
                                        parse_folder(x)[0], parse_folder(x)[1].lower(), x))
        rel = os.path.relpath(root, WORD_BANK_ROOT)
        if "/" not in rel and os.sep not in rel:
            continue  # Tab 根目录本身

        txts = [f for f in files
                if not f.startswith(".")
                and f.lower().endswith(".txt")
                and f not in (CN_FILE, IMAGES_FILE)]
        if not txts:
            continue

        if MAIN_FILE in txts:
            # 显式 prompt.txt 文件夹卡片
            cards.append(_folder_card(root, rel, os.path.join(root, MAIN_FILE)))
        elif len(txts) == 1 and not dirs:
            # 单子 txt 且无子目录：文件夹卡片（保留文件夹名差异，如 银狼LV.999_服装）
            cards.append(_folder_card(root, rel, os.path.join(root, txts[0])))
        else:
            # 散 txt：每个 txt 一张卡片（如 景深层次/01_浅景深虚化.txt、腿部/无.txt）
            txts.sort(key=lambda x: (parse_folder(os.path.splitext(x)[0])[1].lower(), x))
            for t in txts:
                cards.append(_txt_card(root, rel, t))

    # 层级深度优先排序：完整相对路径按每段编号转数字逐段比较（父级分出先后后，
    # 其全部后代子项整体排在下一个父级分支之前），等价于「先排完 半室外 的所有
    # 子文件夹，再排 室内」；无编号段排在有编号段之后。
    cards.sort(key=lambda c: _path_sort_key(c["relPath"]))
    return cards


# 词库扫描缓存：按 tab 粒度惰性缓存。仅当访问某个 tab 时才扫描该 tab，已加载 tab 常驻内存
# （TTL 过期或目录签名变化时只重扫单个 tab，不再全量遍历所有分类）。
_WB_TTL = 30
_wb_tab_cache = {}


def _wb_sig():
    """轻量目录签名：根下每个直接子项（tab）的 mtime/size，返回 {name: sig} 供按 tab 失效。"""
    sigs = {}
    try:
        for name in sorted(os.listdir(WORD_BANK_ROOT)):
            p = os.path.join(WORD_BANK_ROOT, name)
            try:
                st = os.stat(p)
                sigs[name] = f"{int(st.st_mtime)}:{st.st_size}"
            except OSError:
                pass
    except OSError:
        pass
    return sigs


def _scan_one_tab(name, sigs):
    """只扫描单个 tab 并写入按 tab 缓存。"""
    _wb_tab_cache[name] = {
        "ts": time.time(),
        "sig": sigs.get(name),
        "payload": _scan_tab(os.path.join(WORD_BANK_ROOT, name)),
    }


def scan_word_bank(force=False, tab=None):
    if not os.path.isdir(WORD_BANK_ROOT):
        return {"root": WORD_BANK_ROOT, "tabs": [], "data": {},
                "error": "词库目录不存在: " + WORD_BANK_ROOT}

    now = time.time()
    sigs = _wb_sig()

    # tabs 列表：根下目录（排除 . 开头），保持原有编号排序
    tabs = []
    for name in sorted(os.listdir(WORD_BANK_ROOT),
                       key=lambda n: (0 if parse_folder(n)[0] > 0 else 1,
                                      parse_folder(n)[0], parse_folder(n)[1].lower(), n)):
        if not os.path.isdir(os.path.join(WORD_BANK_ROOT, name)) or name.startswith("."):
            continue
        tabs.append(name)

    if force:
        _wb_tab_cache.clear()
        if tab is None:
            # 手动全量刷新：重建所有 tab
            for name in tabs:
                _scan_one_tab(name, sigs)
            return {"root": WORD_BANK_ROOT, "tabs": tabs,
                    "data": {n: list(_wb_tab_cache[n]["payload"]) for n in tabs}}

    result = {"root": WORD_BANK_ROOT, "tabs": tabs, "data": {}}

    if tab is not None:
        # 按需读：只保证目标 tab 数据
        if tab not in tabs:
            result["data"][tab] = []
            return result
        ent = _wb_tab_cache.get(tab)
        if ent is None or ent["sig"] != sigs.get(tab) or (now - ent["ts"]) >= _WB_TTL:
            _scan_one_tab(tab, sigs)
        result["data"][tab] = list(_wb_tab_cache[tab]["payload"])
        return result

    # 无指定 tab（首屏/局部刷新）：返回已缓存 tab，未缓存时至少保证第一个 tab 有数据
    for name, ent in _wb_tab_cache.items():
        if name in tabs:
            result["data"][name] = list(ent["payload"])
    if not result["data"] and tabs:
        _scan_one_tab(tabs[0], sigs)
        result["data"][tabs[0]] = list(_wb_tab_cache[tabs[0]]["payload"])
    return result


# ============================================================
# HTTP handlers
# ============================================================
async def get_wordbank(request):
    force = request.query.get("refresh") == "1"
    tab = request.query.get("tab")
    return web.json_response(scan_word_bank(force=force, tab=(tab or None)))


async def get_image(request):
    """先按相对 output/ 解析（index 反查的 zhule_img/ 路径），找不到再按相对词库根解析（文件夹内图片）。

    图库物理目录已迁入 output/zhule_studio/ 下，zhule_img/ 前缀的 path 按新根解析。"""
    path = request.query.get("path", "")
    roots = (IMAGE_ROOT, WORD_BANK_ROOT)
    if path.startswith("zhule_img/"):
        roots = (os.path.join(IMAGE_ROOT, "zhule_studio"), WORD_BANK_ROOT)
    for root in roots:
        full = os.path.abspath(os.path.join(root, path))
        if _is_within(root, full) and os.path.isfile(full):
            return web.FileResponse(full)
    return web.Response(status=404)


async def post_rename(request):
    """
    body: { path: "主题/02_沙滩/服饰/79 丝带边泳装", name: "丝带边泳装，轮廓以缎带饰边",
            content?: "英文提示词", content_cn?: "中文提示词" }

    取消编号排名逻辑：名字保存/改名时不再自动加编号前缀，重命名词条目录时用纯名字。
    content/content_cn 可选：提供时同步写回提示词内容文件（文件夹卡片写 prompt.txt /
    prompt_cn.txt；散 txt 卡片写回该 txt 文件本身，散 txt 不支持中文）。
    """
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
    if INVALID_NAME.search(name):
        return web.json_response({"error": "名字含非法字符"}, status=400)

    old_full = os.path.abspath(os.path.join(WORD_BANK_ROOT, rel_path))
    if not _is_within(WORD_BANK_ROOT, old_full):
        return web.json_response({"error": "路径越界"}, status=403)

    is_txt = rel_path.lower().endswith(".txt")
    if is_txt:
        if not os.path.isfile(old_full):
            return web.json_response({"error": "文件不存在"}, status=404)
        if os.path.basename(old_full) in (MAIN_FILE, CN_FILE, IMAGES_FILE):
            return web.json_response({"error": "不能重命名系统文件"}, status=400)
        ext = os.path.splitext(old_full)[1]
        new_name = name + ext
    else:
        if not os.path.isdir(old_full):
            return web.json_response({"error": "文件夹不存在"}, status=404)
        new_name = name

    parent = os.path.dirname(old_full)
    new_full = os.path.join(parent, new_name)

    if new_full != old_full and os.path.exists(new_full):
        return web.json_response({"error": "目标已存在"}, status=409)

    content = body.get("content")
    content_cn = body.get("content_cn")
    has_content = isinstance(content, str)
    has_content_cn = isinstance(content_cn, str)

    # 内容文件定位（与扫描判定一致）：散 txt → 该 txt 本身；文件夹 → prompt.txt 优先，
    # 否则唯一 txt；重命名后路径自动跟随新目录
    content_target = None
    if is_txt:
        content_target = new_full
    else:
        if os.path.isfile(os.path.join(old_full, MAIN_FILE)):
            content_target = os.path.join(old_full, MAIN_FILE)
        else:
            txts = [f for f in os.listdir(old_full)
                    if not f.startswith(".")
                    and f.lower().endswith(".txt")
                    and f not in (CN_FILE, IMAGES_FILE)]
            if len(txts) == 1:
                content_target = os.path.join(old_full, txts[0])

    try:
        if new_full != old_full:
            os.rename(old_full, new_full)
        if has_content and content_target:
            with open(content_target, "w", encoding="utf-8") as f:
                f.write(content)
        if has_content_cn and not is_txt:
            with open(os.path.join(new_full, CN_FILE), "w", encoding="utf-8") as f:
                f.write(content_cn)
    except Exception as e:
        return web.json_response({"error": "保存失败: " + str(e)}, status=500)

    # 目录结构可能已变：使词库扫描缓存失效，保证下次刷新拿到最新数据
    _wb_tab_cache.clear()
    return web.json_response({"ok": True})


async def post_wordbank_delete(request):
    """body: { path } 删除词条（散 txt 文件或卡片目录及其文件）。

    仅允许删除词条层（Tab 之下的卡片）；禁止删除 Tab 根目录、词库根目录及系统文件，
    路径一律校验在词库根目录（插件 prompt/）之内。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)

    rel_path = (body.get("path") or "").strip()
    if not rel_path:
        return web.json_response({"error": "缺少 path"}, status=400)

    old_full = os.path.abspath(os.path.join(WORD_BANK_ROOT, rel_path))
    if not _is_within(WORD_BANK_ROOT, old_full) or old_full == os.path.abspath(WORD_BANK_ROOT):
        return web.json_response({"error": "路径越界"}, status=403)

    is_txt = rel_path.lower().endswith(".txt")
    if is_txt:
        if os.path.basename(old_full) in (MAIN_FILE, CN_FILE, IMAGES_FILE):
            return web.json_response({"error": "不能删除系统文件"}, status=400)
        if not os.path.isfile(old_full):
            return web.json_response({"error": "文件不存在"}, status=404)
    else:
        if "/" not in rel_path:
            return web.json_response({"error": "不能删除 Tab 根目录"}, status=400)
        if not os.path.isdir(old_full):
            return web.json_response({"error": "文件夹不存在"}, status=404)

    try:
        if is_txt:
            os.remove(old_full)
        else:
            shutil.rmtree(old_full)
    except OSError as e:
        return web.json_response({"error": "删除失败: " + str(e)}, status=500)

    _wb_tab_cache.clear()
    return web.json_response({"ok": True})


async def post_wordbank_tab_create(request):
    """body: { name } 在词库根新建一个 Tab 大类目录（纯名字，无编号）。

    校验：非空、无非法字符、不以点开头、显示名不与其他 Tab 重复（含编号前缀的
    显示名去重，避免出现“角色”与“01_角色”两个同名大类）。
    """
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

    new_full = os.path.abspath(os.path.join(WORD_BANK_ROOT, name))
    if not _is_within(WORD_BANK_ROOT, new_full):
        return web.json_response({"error": "路径越界"}, status=403)

    if os.path.exists(new_full):
        return web.json_response({"error": "分类已存在: " + name}, status=400)
    if os.path.isdir(WORD_BANK_ROOT):
        for n in os.listdir(WORD_BANK_ROOT):
            if n.startswith("."):
                continue
            if not os.path.isdir(os.path.join(WORD_BANK_ROOT, n)):
                continue
            _, disp = parse_folder(n)
            if disp.lower() == name.lower():
                return web.json_response({"error": "分类已存在: " + disp}, status=400)

    try:
        os.makedirs(new_full)
    except OSError as e:
        return web.json_response({"error": "创建失败: " + str(e)}, status=500)

    _wb_tab_cache.clear()
    return web.json_response({"ok": True, "tab": name})


async def post_wordbank_chip_create(request):
    """body: { tab, parent, name } 在指定大类下新建一个小类（子分类）目录。

    tab 为大类目录名（词库根的直接子目录）；parent 为相对 tab 的父路径
    （如 "A/B"，空串表示直接建在 tab 下）；name 为小类名（纯名字，无编号）。
    """
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
    if INVALID_NAME.search(name):
        return web.json_response({"error": "名字含非法字符"}, status=400)
    if name.startswith("."):
        return web.json_response({"error": "名字不能以点开头"}, status=400)
    if INVALID_NAME.search(parent.replace("/", "")):
        return web.json_response({"error": "父路径含非法字符"}, status=400)

    tab_full = os.path.abspath(os.path.join(WORD_BANK_ROOT, tab))
    if not _is_within(WORD_BANK_ROOT, tab_full) or tab_full == os.path.abspath(WORD_BANK_ROOT):
        return web.json_response({"error": "路径越界"}, status=403)
    if not os.path.isdir(tab_full):
        return web.json_response({"error": "大类不存在: " + tab}, status=404)

    parent_full = os.path.abspath(os.path.join(tab_full, parent)) if parent else tab_full
    if not _is_within(tab_full, parent_full):
        return web.json_response({"error": "路径越界"}, status=403)
    if not os.path.isdir(parent_full):
        return web.json_response({"error": "父分类不存在"}, status=404)

    new_full = os.path.join(parent_full, name)
    if os.path.exists(new_full):
        return web.json_response({"error": "分类已存在: " + name}, status=400)

    # 同级显示名去重（含编号前缀，如“氛围”与“01_氛围”视为重名）
    try:
        for n in os.listdir(parent_full):
            if n.startswith("."):
                continue
            if not os.path.isdir(os.path.join(parent_full, n)):
                continue
            _, disp = parse_folder(n)
            if disp.lower() == name.lower():
                return web.json_response({"error": "分类已存在: " + disp}, status=400)
    except OSError:
        pass

    try:
        os.makedirs(new_full)
    except OSError as e:
        return web.json_response({"error": "创建失败: " + str(e)}, status=500)

    _wb_tab_cache.clear()
    return web.json_response({"ok": True})


async def post_wordbank_card_create(request):
    """body: { tab, parent, name, content, content_cn } 在父分类下新建词条卡片。

    name 以 .txt 结尾 → 创建散 txt 文件；否则创建文件夹卡片（目录 + prompt.txt，
    可选 prompt_cn.txt）。
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
    if INVALID_NAME.search(name):
        return web.json_response({"error": "名字含非法字符"}, status=400)
    if name.startswith("."):
        return web.json_response({"error": "名字不能以点开头"}, status=400)
    if INVALID_NAME.search(parent.replace("/", "")):
        return web.json_response({"error": "父路径含非法字符"}, status=400)

    tab_full = os.path.abspath(os.path.join(WORD_BANK_ROOT, tab))
    if not _is_within(WORD_BANK_ROOT, tab_full) or tab_full == os.path.abspath(WORD_BANK_ROOT):
        return web.json_response({"error": "路径越界"}, status=403)
    if not os.path.isdir(tab_full):
        return web.json_response({"error": "大类不存在: " + tab}, status=404)

    parent_full = os.path.abspath(os.path.join(tab_full, parent)) if parent else tab_full
    if not _is_within(tab_full, parent_full):
        return web.json_response({"error": "路径越界"}, status=403)
    if not os.path.isdir(parent_full):
        return web.json_response({"error": "父分类不存在"}, status=404)

    is_txt = name.lower().endswith(".txt")
    if is_txt:
        if not os.path.splitext(name)[0]:
            return web.json_response({"error": "名字不能为空"}, status=400)
        if isinstance(content_cn, str) and content_cn.strip():
            return web.json_response({"error": "散 txt 卡片暂不支持中文提示词"}, status=400)

    new_full = os.path.join(parent_full, name)
    if os.path.exists(new_full):
        return web.json_response({"error": "词条已存在: " + name}, status=400)

    # 卡片显示名去重：文件夹卡片与散 txt 的显示名均与同级已有卡片比对
    if os.path.isdir(parent_full):
        try:
            for n in os.listdir(parent_full):
                if n.startswith("."):
                    continue
                p = os.path.join(parent_full, n)
                if os.path.isdir(p):
                    _, disp = parse_folder(n)
                    if disp.lower() == name.lower():
                        return web.json_response({"error": "词条已存在: " + disp}, status=400)
                elif n.lower().endswith(".txt"):
                    _, disp = parse_folder(os.path.splitext(n)[0])
                    if disp.lower() == name.lower():
                        return web.json_response({"error": "词条已存在: " + disp}, status=400)
        except OSError:
            pass

    try:
        if is_txt:
            with open(new_full, "w", encoding="utf-8") as f:
                f.write(content if isinstance(content, str) else "")
        else:
            os.makedirs(new_full)
            with open(os.path.join(new_full, MAIN_FILE), "w", encoding="utf-8") as f:
                f.write(content if isinstance(content, str) else "")
            if isinstance(content_cn, str) and content_cn.strip():
                with open(os.path.join(new_full, CN_FILE), "w", encoding="utf-8") as f:
                    f.write(content_cn)
    except OSError as e:
        return web.json_response({"error": "创建失败: " + str(e)}, status=500)

    _wb_tab_cache.clear()
    return web.json_response({"ok": True})


async def post_wordbank_image(request):
    """body: { path, image, action, name } 删除卡片图片 / 取消作为参考图。

    action=delete：物理删除图片；若该图由 images.txt 引入，同时移出行列表。
    action=unref：仅把该图从 images.txt 取消（不再作为参考图，文件保留）。
    返回更新后的卡片图片列表（同 _card_images 兜底规则）。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)

    rel_path = (body.get("path") or "").strip()
    image = (body.get("image") or "").strip()
    action = (body.get("action") or "").strip()
    if not rel_path or not image:
        return web.json_response({"error": "缺少 path 或 image"}, status=400)
    if action not in ("delete", "unref"):
        return web.json_response({"error": "action 仅支持 delete/unref"}, status=400)

    card_full = os.path.abspath(os.path.join(WORD_BANK_ROOT, rel_path))
    if not _is_within(WORD_BANK_ROOT, card_full):
        return web.json_response({"error": "路径越界"}, status=403)

    folder = os.path.dirname(card_full) if os.path.isfile(card_full) else card_full
    if not os.path.isdir(folder):
        return web.json_response({"error": "卡片目录不存在"}, status=404)

    txt_path = os.path.join(folder, IMAGES_FILE)
    lines = _read_lines(txt_path)

    if image in lines:
        # 图片由 images.txt 引入：delete 删物理文件 + 移行；unref 仅移行
        if action == "delete":
            deleted = False
            for root in (IMAGE_ROOT, WORD_BANK_ROOT):
                full = os.path.abspath(os.path.join(root, image))
                if _is_within(root, full) and os.path.isfile(full):
                    try:
                        os.remove(full)
                        deleted = True
                    except OSError as e:
                        return web.json_response({"error": "删除文件失败: " + str(e)}, status=500)
                    break
            if not deleted:
                return web.json_response({"error": "图片文件不存在: " + image}, status=404)
        new_lines = [l for l in lines if l != image]
        if new_lines:
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write("\n".join(new_lines) + "\n")
        elif os.path.isfile(txt_path):
            os.remove(txt_path)
    else:
        # 兜底图片（文件夹内 / 父目录）：仅支持物理删除
        if action == "unref":
            return web.json_response({"error": "该图片不在 images.txt 中，无法取消参考"}, status=400)
        full = os.path.abspath(os.path.join(WORD_BANK_ROOT, image))
        if not _is_within(WORD_BANK_ROOT, full) or not os.path.isfile(full):
            return web.json_response({"error": "图片文件不存在: " + image}, status=404)
        try:
            os.remove(full)
        except OSError as e:
            return web.json_response({"error": "删除文件失败: " + str(e)}, status=500)

    _wb_tab_cache.clear()
    return web.json_response({"ok": True, "images": _card_images(folder)})


async def post_wordbank_image_upload(request):
    """body(multipart): path=词条relPath, file=图片文件。

    将参考图保存到词条目录（与 prompt.txt 同级），不写 images.txt，
    不参与图库 output 逻辑。返回更新后的卡片图片列表（同 _card_images 兜底规则）。
    """
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

    card_full = os.path.abspath(os.path.join(WORD_BANK_ROOT, rel_path))
    if not _is_within(WORD_BANK_ROOT, card_full):
        return web.json_response({"error": "路径越界"}, status=403)
    folder = os.path.dirname(card_full) if os.path.isfile(card_full) else card_full
    if not os.path.isdir(folder):
        return web.json_response({"error": "卡片目录不存在"}, status=404)

    filename = os.path.basename(file_field.filename or "")
    if not filename:
        return web.json_response({"error": "缺少文件名"}, status=400)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in IMAGE_EXTS:
        return web.json_response({"error": "仅支持图片文件: " + "/".join(sorted(IMAGE_EXTS))}, status=400)

    # 重名防覆盖：追加序号
    target = os.path.abspath(os.path.join(folder, filename))
    if not _is_within(WORD_BANK_ROOT, target):
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

    _wb_tab_cache.clear()
    return web.json_response({"ok": True, "images": _card_images(folder)})


# ============================================================
# 词库排序保存：手动触发，按整个树的新顺序把编号写回目录
# ============================================================
def _same_numbered(name, idx, disp):
    """name 是否已等于第 idx 位目标名（兼容 {数字}_{名} 与 {数字} {名}）。"""
    return name == f"{idx:02d}_{disp}" or name == f"{idx} {disp}"


def _renumber_bank_layer(base, rels):
    """按 rels 顺序重命名 base 下的子项（目录 + 散 txt），生成连续编号。

    两阶段重命名防冲突（全部先转临时名再写回编号名），任一步失败回滚原名。
    返回实际重命名条目数；顺序未变且编号已连续时返回 0（避免无谓重命名）。
    """
    items = []
    try:
        for e in os.scandir(base):
            if e.name.startswith("."):
                continue
            if e.is_dir(follow_symlinks=False):
                items.append(e.name)
            elif e.is_file(follow_symlinks=False) and e.name.lower().endswith(".txt") \
                    and e.name not in (MAIN_FILE, CN_FILE, IMAGES_FILE):
                items.append(e.name)
    except OSError:
        return 0
    if not items:
        return 0

    ordered = []
    seen = set()
    for r in rels:
        if r in items and r not in seen:
            ordered.append(r)
            seen.add(r)
    rest = [n for n in items if n not in seen]
    rest.sort(key=lambda n: _seg_key(n))
    ordered.extend(rest)

    # 顺序与编号均无需变化则跳过
    changed = False
    for idx, n in enumerate(ordered, start=1):
        num, disp = parse_folder(n)
        if not _same_numbered(n, idx, disp):
            changed = True
            break
    if not changed:
        return 0

    tmp_list = []
    renamed = []
    stamp = int(time.time() * 1000)
    try:
        # 阶段1：全部转临时名
        for i, n in enumerate(ordered):
            tmp = os.path.join(base, f".__zhule_sort_{stamp}_{i:04d}")
            os.rename(os.path.join(base, n), tmp)
            tmp_list.append((tmp, n))
        # 阶段2：按新序写回连续编号
        for idx, (tmp, n) in enumerate(tmp_list, start=1):
            _, disp = parse_folder(n)
            final = os.path.join(base, f"{idx:02d}_{disp}")
            os.rename(tmp, final)
            renamed.append((final, tmp, n))
    except OSError:
        # 回滚：final -> tmp，然后 tmp -> 原名
        for final, tmp, _n in reversed(renamed):
            try:
                os.rename(final, tmp)
            except OSError:
                pass
        for tmp, n in reversed(tmp_list):
            try:
                os.rename(tmp, os.path.join(base, n))
            except OSError:
                pass
        raise
    return len(ordered)


async def post_wordbank_sort_save(request):
    """body: { order: { 父相对路径(词库根下, ""表示根): [子项原始名...], ... } }

    手动触发「排序保存」：按整个树的新顺序把顺序写回并覆盖文件夹——对每个父目录，
    其子目录/散 txt 按列表顺序重命名为连续编号（两阶段防冲突，失败回滚）。
    仅处理前端提交的层级；未出现在列表中的现有子项按原规则排到末尾。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)

    order = body.get("order")
    if not isinstance(order, dict):
        return web.json_response({"error": "order 必须为对象"}, status=400)

    base_root = os.path.realpath(WORD_BANK_ROOT)
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
            full = os.path.realpath(os.path.join(base_root, parent))
            if not _is_within(base_root, full) or not os.path.isdir(full):
                errors.append(f"层级「{parent}」目录不存在或越界")
                continue
            base = full
        else:
            base = base_root
        try:
            n = _renumber_bank_layer(base, clean)
            total += n
            layers += 1
        except OSError as e:
            errors.append(f"层级「{parent or '(根)'}」重命名失败: {e}")

    _wb_tab_cache.clear()
    try:
        from . import gallery as _gal
        _gal._tree_cache.update({"ts": 0.0, "sig": None, "tree": None, "anc": None})
    except Exception:
        pass
    return web.json_response({"ok": True, "layers": layers, "renamed": total,
                              "errors": errors})
    """body: { path: 词条相对路径, image: images.txt 中的图片路径, action: "delete"|"unref", name?: 词条名 }

    action=delete：从磁盘删除该图片文件（先按相对 output/ 解析，再按相对词库根解析，
                   均做越界校验），并从词条目录 images.txt 移除该行。
    action=unref ：取消作为参考图——从图片 PNG 元数据（zhule_prompt_tags / zhule_tags /
                   zhule_custom_tags）中移除词条名，并同步移除 images.txt 该行。
    返回 { ok, images }：images 为更新后的剩余图片列表，前端单卡片刷新用。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)

    rel_path = (body.get("path") or "").strip()
    image = (body.get("image") or "").strip()
    action = (body.get("action") or "").strip()
    name = (body.get("name") or "").strip()

    if not rel_path or not image:
        return web.json_response({"error": "缺少 path/image"}, status=400)
    if action not in ("delete", "unref"):
        return web.json_response({"error": "action 必须是 delete 或 unref"}, status=400)
    if action == "unref" and not name:
        return web.json_response({"error": "缺少 name"}, status=400)

    folder = os.path.abspath(os.path.join(WORD_BANK_ROOT, rel_path))
    if not _is_within(WORD_BANK_ROOT, folder) or folder == os.path.abspath(WORD_BANK_ROOT):
        return web.json_response({"error": "路径越界"}, status=403)
    if not os.path.isdir(folder):
        return web.json_response({"error": "词条目录不存在"}, status=404)

    lines = _read_lines(os.path.join(folder, IMAGES_FILE))
    if image not in lines:
        return web.json_response({"error": "该图片不在词条的 images.txt 中"}, status=400)

    # 解析图片真实路径：优先相对 output/（images.txt 约定），其次相对词库根（兼容旧结构）
    img_full = None
    for root in (IMAGE_ROOT, WORD_BANK_ROOT):
        cand = os.path.abspath(os.path.join(root, image))
        if _is_within(root, cand) and os.path.isfile(cand):
            img_full = cand
            break
    if img_full is None:
        return web.json_response({"error": "图片文件不存在"}, status=404)

    if action == "delete":
        try:
            os.remove(img_full)
        except OSError as e:
            return web.json_response({"error": "图片删除失败: " + str(e)}, status=500)
    else:
        # 取消参考图：移除 PNG 元数据中等于词条名的 tag（JSON 数组格式）
        from . import png_text
        texts = png_text.read_png_text(img_full)
        updates = {}
        for kw in ("zhule_prompt_tags", "zhule_tags", "zhule_custom_tags"):
            raw = texts.get(kw)
            if not raw:
                continue
            try:
                arr = json.loads(raw)
                if not isinstance(arr, list):
                    continue
            except Exception:
                continue
            clean = [str(t) for t in arr if str(t).strip() and str(t).strip() != name]
            if len(clean) != len(arr):
                updates[kw] = json.dumps(clean, ensure_ascii=False)
        if updates and not png_text.write_png_text(img_full, updates):
            return web.json_response({"error": "PNG 元数据写入失败"}, status=500)

    # 同步 images.txt：移除该行
    remaining = [l for l in lines if l != image]
    try:
        with open(os.path.join(folder, IMAGES_FILE), "w", encoding="utf-8") as f:
            f.write("\n".join(remaining) + ("\n" if remaining else ""))
    except OSError as e:
        return web.json_response({"error": "images.txt 写入失败: " + str(e)}, status=500)

    return web.json_response({"ok": True, "images": remaining})


# ============================================================
# 状态落盘：网页选词变化 → 本地 json（按ID），节点执行时读取
# ============================================================
async def post_state_save(request):
    """body: { bindId: "ID", data: { prompt, ... } }"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)

    bind_id = (body.get("bindId") or "").strip()
    if not state_store.valid_id(bind_id):
        return web.json_response({"error": "ID非法"}, status=400)
    data = body.get("data")
    if data is None:
        return web.json_response({"error": "缺少 data"}, status=400)

    if not state_store.save_state(bind_id, data):
        return web.json_response({"error": "写入失败"}, status=500)
    return web.json_response({"ok": True})


async def post_state_delete(request):
    """body: { bindId: "ID" }"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)

    bind_id = (body.get("bindId") or "").strip()
    if not state_store.valid_id(bind_id):
        return web.json_response({"error": "ID非法"}, status=400)
    return web.json_response({"ok": state_store.delete_state(bind_id)})


async def get_state_list(request):
    return web.json_response({"files": state_store.list_state()})


# ============================================================
# Studio 页面静态服务
# ============================================================
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
