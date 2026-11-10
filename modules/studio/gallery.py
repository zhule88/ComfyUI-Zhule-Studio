"""Zhule Gallery 后端：图片索引、聚合元数据、缩略图缓存、打标（写 PNG 元数据）。

数据模型（与 ZhuleSaveImage v2 / 图库字段化架构一致）：
- 图片元数据存在 PNG tEXt chunk：zhule_model / zhule_loras / zhule_prompt_tags /
  zhule_custom_tags / prompt / workflow
- 模型引用已 id 化：zhule_model 与 zhule_loras 的元素写成**单个对象** {"id":..,"n":..}
  （id 指向 zhule.db 的 model 表，改名后图片自动跟随；n 为兜底展示名）。
  老图存的仍是纯字符串，读写两侧同时兼容（见 _extract_zhule_model / _json_list），
  所以存量图一张都不用重写
- 标签两源（zhule_tags 已废弃并并入 zhule_custom_tags，见 _parse_record_tags 解析）：
  * zhule_prompt_tags：ZhuleStudio 提示词选中词（保存时写入，图库只读，可按项删）
  * zhule_custom_tags：自定义标签（SaveImage 自定义标签端口 + 图库详情页打标，可增删）
- 图库根目录：output/zhule_studio/zhule_img（只扫这一个目录，历史旧目录一律忽略）
- 索引：由写入点维护（SaveImage 入库 / 删图 / 打标各自行级写库），落 zhule.db
  gallery_image/gallery_tag；全量遍历仅由设置面板『重建索引』手动触发，无守护线程轮询
- 用户自定义 tag 分组：gallery/meta.json
- 打标：写 PNG tEXt chunk（不重编码像素），保留原 mtime

索引记录：
  key: 相对图库根目录的 posix 路径（唯一）
  mtime/size/name/model/loras/tags/prompt/hasPrompt
  prompt 为 PNG tEXt prompt 原文（落 zhule.db gallery_image.prompt，避免重复读 PNG）；
  hasPrompt 由 prompt 非空推导；hasWF 不再落库，详情接口实时读 PNG workflow 推导
  tags 为三源合并（供筛选/搜索）；详情接口按来源分开返回
"""
import asyncio
import hashlib
import json
import os
import random
import re
import threading
import time
import shutil
from collections import OrderedDict

import folder_paths
from aiohttp import web

from . import db
from . import png_text
from .api import _path_sort_key, _node_raw_name
from ..common.paths import _get_output_dir

GALLERY_DIR = os.path.dirname(os.path.abspath(__file__))
# 图库索引已迁移 SQLite（zhule.db gallery_image / gallery_tag 表），不再读写 cache/gallery_index.json。
# 自定义标签字典+分组也已迁入 zhule.db custom_tag 表，不再读写 gallery/meta.json。
STUDIO_SUBDIR = "zhule_studio"  # output 下统一收纳目录：zhule_img / zhule_thumbs / zhule_link / zhule_reference
SCHEMA_VERSION = 4  # schema4：records[].tags 元素升级为 {id,name}（id 定位、name 展示/过滤）；读取兼容 schema3 字符串数组

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
_SKIP_DIRS = {"thumbnails", "zhule_thumbs", "prompt_csv", "zhule image"}
MAX_WORKFLOW_PREVIEW = 800

_index = None  # 内存缓存：list[dict]
_index_built_at = 0.0
_index_rev = 0  # 索引变更版本号（build/get/load/删/增量 6 处 +1），get_tag_ref_index 据此失效重建
_ref_cache = {"sig": None, "data": None}  # tag -> [zhule_img/ 相对路径] 反向索引缓存


def _gallery_root():
    """图库根目录：output/zhule_studio/zhule_img（ZhuleSaveImage 实际输出，唯一图源）。"""
    return os.path.join(_get_output_dir(), STUDIO_SUBDIR, "zhule_img")


def _safe_full(rel):
    """把索引相对路径解析为图库根下的绝对路径，防路径穿越。"""
    root = os.path.abspath(_gallery_root())
    full = os.path.abspath(os.path.join(root, rel))
    if not (full == root or full.startswith(root + os.sep)):
        return None
    return full


# ==================== 索引 ====================

def _scan_images(root):
    """递归扫描图片文件，返回 [(rel, full)]，排除系统目录与符号链接回环。

    Windows junction 会被 os.walk 当普通目录跟随，需用 realpath 去重防回环；
    正常的链接目录（如整合包把图库挂进 output）仍然跟随。
    """
    found = []
    if not os.path.isdir(root):
        return found
    visited_real = set()
    for cur, dirs, files in os.walk(root, followlinks=False):
        real = os.path.realpath(cur)
        if real in visited_real:
            dirs[:] = []
            continue
        visited_real.add(real)
        keep = []
        for d in sorted(dirs):
            if d.startswith(".") or d in _SKIP_DIRS:
                continue
            full_d = os.path.join(cur, d)
            # 普通符号链接（非 junction）不跟随；junction/目录按 realpath 去重防回环
            try:
                if os.path.islink(full_d) and not _is_junction(full_d):
                    continue
                if os.path.realpath(full_d) in visited_real:
                    continue
            except OSError:
                continue
            keep.append(d)
        dirs[:] = keep
        for fn in sorted(files):
            if fn.startswith("."):
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext in IMAGE_EXTS:
                full = os.path.join(cur, fn)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                found.append((rel, full))
    return found


def _is_junction(path):
    """Windows junction / mount point 识别（reparse point 且是目录）。"""
    try:
        attrs = os.lstat(path)
        if not hasattr(attrs, "st_reparse_tag"):
            return False
        return bool(attrs.st_reparse_tag)
    except Exception:
        return False


def _json_list(raw, key):
    """解析 JSON 数组字符串；失败返回 []。

    元素支持两种形态：纯字符串（老数据）或 {"id":..,"n":..} 对象（新写入格式），
    统一提取展示名——两种形态混存时解析结果仍然一致，老图因此不必重写。
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            out = []
            for x in data:
                if isinstance(x, dict):
                    s = str(x.get("n") or x.get("name") or "").strip()
                else:
                    s = str(x).strip()
                if s:
                    out.append(s)
            return out
    except Exception:
        pass
    return []


def _extract_zhule_model(texts):
    """提取模型名：优先 zhule_model 元数据；缺失时从 prompt 元数据兜底（兼容 ZhuleCheckpointLoader 等复合模型旧图）。"""
    m = (texts.get("zhule_model") or "").strip()
    if m:
        # 新格式是单个 {"id":..,"n":..} 对象：统一取展示名，兼容旧的纯字符串写入。
        # 只有一种写法会命中这条：save_image 新图；老图仍是纯字符串，直接往下走。
        if m.startswith("{"):
            try:
                obj = json.loads(m)
                if isinstance(obj, dict):
                    m = str(obj.get("n") or obj.get("name") or "").strip()
            except Exception:
                pass
        if m:
            return m
    pt = texts.get("prompt") or ""
    if not pt:
        return ""
    try:
        prompt = json.loads(pt)
    except Exception:
        return ""
    if not isinstance(prompt, dict):
        return ""
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        cls = node.get("class_type", "")
        if cls.startswith("ZhuleCheckpointLoader") or cls.startswith("CheckpointLoader") or cls.startswith("UNETLoader") or cls.startswith("DiffusionLoader"):
            inputs = node.get("inputs") or {}
            for key in ("ckpt_name", "unet_name", "model_name"):
                v = inputs.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
    return ""


def _parse_record_tags(texts):
    """解析 PNG 元数据中的标签字段（纯读取，不写回、不反查）。

    提示词标签只认词条 id（老自由文本名与词库无对应，不反查）；自定义标签
    先按 id 取当前完整路径，取不到才用 p/n 兜底。
    返回 (prompt_ids, custom_tags, pt_names)：
    - prompt_ids：词条 id 字符串数组
    - custom_tags：自定义标签显示名数组
    - pt_names：{id: PNG 自带的默认名}，词条被删、按 id 查不到时用它兜底显示
    """
    refs = _parse_tag_refs(texts.get("zhule_prompt_tags"))
    pids = [i for i, _n in refs if i]
    pt_names = {i: n for i, n in refs if i and n}
    # 自定义标签：先按 id 取当前**完整路径**（层级/改名后自动跟随），取不到才用 p/n 兜底
    cidx = _custom_tag_path_index()
    custom_tags = []
    for cid, pth, nm in _parse_custom_tag_refs(texts.get("zhule_custom_tags")):
        _cur = (cidx.get(str(cid)) or pth or nm) if cid else (pth or nm)
        if _cur:
            custom_tags.append(_cur)
    return pids, custom_tags, pt_names


def _extract_positive_prompt(pt):
    """从 PNG 内 prompt JSON 提取正面提示词（ZhuleStudio 前置提示词 + 选中词）。

    前置提示词可能直接是文本，也可能是对节点输出（如 ZhuleArtistPicker）的引用；
    _selected 为选中词 name 字符串数组（出图时快照）。解析失败返回 None。
    """
    if not pt:
        return None
    try:
        prompt = json.loads(pt)
    except Exception:
        return None
    if not isinstance(prompt, dict):
        return None

    studio = None
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == "ZhuleStudio":
            studio = node
            break
    if studio is None:
        return None
    inputs = studio.get("inputs") or {}

    def _resolve_link(v):
        """["node_id", out_idx] -> 被引用节点输出文本；普通字符串直接返回。"""
        if isinstance(v, str):
            return v
        if (isinstance(v, list) and len(v) == 2
                and isinstance(v[0], (str, int)) and str(v[0]).isdigit()):
            ref = prompt.get(str(v[0]))
            if not isinstance(ref, dict):
                return ""
            cls = ref.get("class_type", "")
            ref_inputs = ref.get("inputs") or {}
            if cls == "ZhuleArtistPicker":
                # slug 数组 -> tag（@前缀）逗号拼接，与节点运行结果一致
                slugs = _json_list(ref_inputs.get("_selected"), "_selected")
                tags = []
                try:
                    from ..artist_picker.node import _load_slug_to_tag
                    mapping = _load_slug_to_tag()
                    for s in slugs:
                        tags.append(mapping.get(s, "@" + s))
                except Exception:
                    tags = ["@" + s for s in slugs]
                return ", ".join(tags)
            # 其它节点无法确定输出，回退空串
            return ""
        return ""

    pre = _resolve_link(inputs.get("前置提示词", "")).strip()
    # _selected 是词库选中词条（出图时快照）：支持 [{name, content}] 或旧格式字符串数组
    raw = inputs.get("_selected")
    data = None
    if isinstance(raw, list):
        data = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            data = None
    # 快照为空（新节点/手动 Run 未选词）不再从 state 文件兜底
    if not isinstance(data, list):
        data = []
    items = []
    for item in data:
        if isinstance(item, dict):
            items.append(item)
        else:
            t = str(item).strip()
            if t:
                items.append({"id": "", "name": "", "content": t})
    # 与 ZhuleStudio 节点运行逻辑完全同一套：段级排除词（override）过滤 + 前置提示词拼接，
    # 保证图库存的提示词与真实出图一致（图库标签反查依赖这段文本）
    from .node import build_prompt
    positive, _neg = build_prompt(items, pre or "")
    return positive or None


def build_index(force=False):
    """全量重建索引（只扫 zhule_image）。返回索引列表。"""
    global _index, _index_built_at, _index_rev
    root = _gallery_root()
    records = []
    # 复用 _make_record：与单点写入完全同一套字段逻辑（含存量迁移、id->名字还原）
    for rel, full in _scan_images(root):
        try:
            records.append(_make_record(rel, full))
        except Exception:
            continue
    # 按时间倒序缓存
    records.sort(key=lambda r: r["mtime"], reverse=True)
    _index = records
    _index_rev += 1
    _index_built_at = time.time()
    if not _write_index_cache():
        print("[ZhuleGallery] 索引缓存写入失败（zhule.db 图库表）")
    print(f"[ZhuleGallery] 索引重建完成: {len(records)} 张")
    return records


_index_building = False  # 后台重建进行中（防止并发重复触发）


def _bg_build_worker(force):
    """后台线程执行索引重建（build_index 自身更新 _index 与缓存文件）。"""
    global _index_building
    try:
        build_index(force=force)
    finally:
        _index_building = False


def _start_bg_build(force=False):
    """幂等启动后台索引重建线程。已在重建中则跳过。"""
    global _index_building
    if _index_building:
        return False
    _index_building = True
    threading.Thread(target=_bg_build_worker, args=(force,), daemon=True).start()
    return True


def get_index():
    """获取索引。

    索引由「写入点」维护：SaveImage 保存即入库、删图与打标各自行级写库，
    无守护线程轮询磁盘。
    库为空/不可用时**不自动全量重建**——全量遍历属大范围操作，只允许人工在
    设置面板点『重建索引』，此处返回空列表并提示用户。
    """
    global _index, _index_rev
    if _index is None:
        # 尝试从 DB 加载（zhule.db 图库表）
        try:
            records = db.gallery_load_records()
        except Exception:
            records = None
        if not records:
            # 表缺失时 DB 层会自建空表并返回 []，此处统一按「索引为空」处理
            print("[ZhuleGallery] 索引为空/不可用，跳过自动重建：请在设置面板手动点击『重建索引』")
            return []
        _index = records
        _index_rev += 1
    return _index


def get_tag_ref_index():
    """tag -> [带 zhule_img/ 前缀的相对 output 路径] 反向引用索引（词库参考图数据源）。

    以内存 _index 为唯一事实源（写入点行级写库维护其正确性），一次遍历构建
    {tag: [path, ...]} 并按 _index_rev 版本号失效重建，避免词库每卡片 O(N) 全扫。
    索引不可用（缺失/损坏未重建）时返回空 dict。
    """
    global _index_rev
    if _ref_cache["sig"] == _index_rev and _ref_cache["data"] is not None:
        return _ref_cache["data"]
    idx = get_index()
    data = {}
    if idx:
        for r in idx:
            key = r.get("key")
            if not key:
                continue
            tags = r.get("tags") or []
            if not tags:
                continue
            path = "zhule_img/" + key.replace(os.sep, "/")
            for t in tags:
                if t:
                    data.setdefault(t, []).append(path)
    _ref_cache["sig"] = _index_rev
    _ref_cache["data"] = data
    return data


# ==================== 聚合 ====================

def aggregate(records):
    """从索引聚合筛选面板数据。"""
    tag_count, model_count, lora_count = {}, {}, {}
    for r in records:
        for t in r.get("tags", []):
            tag_count[t] = tag_count.get(t, 0) + 1
        if r.get("model"):
            model_count[r["model"]] = model_count.get(r["model"], 0) + 1
        for l in r.get("loras", []):
            lora_count[l] = lora_count.get(l, 0) + 1
    meta = db.custom_tag_meta()
    tags = [{"name": n, "count": c} for n, c in tag_count.items()]
    # meta 中用户自定义但未使用的 tag 也展示
    for t in meta.get("tags", []):
        n = t.get("name")
        if n and n not in tag_count:
            tags.append({"name": n, "count": 0})
    tags.sort(key=lambda x: (-x["count"], x["name"]))
    # 选项统一来自 model 表：按 type 分类、isdel=0 才出现（改名后跟着变、删除后消失）。
    # 计数仍按图片记录统计——只算数量，不决定「有哪些选项」。
    mrows = db.model_index(only_alive=True)
    m_names = sorted({v["name"] for v in mrows.values()
                      if v.get("type") == db.MODEL_TYPE_MODEL and v.get("name")})
    l_names = sorted({v["name"] for v in mrows.values()
                      if v.get("type") == db.MODEL_TYPE_LORA and v.get("name")})
    if not m_names and not l_names:
        # 兜底：model 表为空时不至于让筛选列表整个消失
        m_names, l_names = sorted(model_count.keys()), sorted(lora_count.keys())
    models = [{"name": n, "count": model_count.get(n, 0)} for n in m_names]
    loras = [{"name": n, "count": lora_count.get(n, 0)} for n in l_names]
    return {"tags": tags, "models": models, "loras": loras,
            "total": len(records)}


# ==================== 缩略图 ====================

def _thumb_path(rel, mtime):
    digest = hashlib.sha1(f"{rel}|{mtime}".encode("utf-8")).hexdigest()[:16]
    return os.path.join(_get_output_dir(), STUDIO_SUBDIR, "zhule_thumbs", digest + ".jpg")


def ensure_thumb(rel):
    """返回缩略图绝对路径；不存在则生成（最长边 512px）。"""
    full = _safe_full(rel)
    if not full:
        return None
    try:
        st = os.stat(full)
    except OSError:
        return None
    thumb = _thumb_path(rel, int(st.st_mtime))
    if os.path.isfile(thumb):
        return thumb
    try:
        from PIL import Image
        im = Image.open(full)
        im.thumbnail((512, 512))
        im = im.convert("RGB")
        os.makedirs(os.path.dirname(thumb), exist_ok=True)
        im.save(thumb, "JPEG", quality=82, optimize=True)
        return thumb
    except Exception as e:
        print(f"[ZhuleGallery] 缩略图生成失败 {rel}: {e}")
        return None


# ==================== 过滤器 ====================

def _split_csv(raw):
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


# ==================== 标签层级树（基于词库 prompt 目录） ====================
_TREE_TTL = 600
_tree_cache = {"ts": 0.0, "sig": None, "tree": None, "anc": None}


def _tree_sig():
    """词库树签名：zhule.db 数据版本号（词库每次写操作递增），驱动 TTL 缓存失效。

    不再扫描词库磁盘目录（词库已切 DB，无目录变更可观察）。"""
    try:
        return "db:" + str(db.version())
    except Exception:
        return "db:?"


def _wb_tree_data():
    """读 zhule.db 词库树（db.fetch_tree()）；读取失败返回 None。

    薄封装仅为兼容旧调用点把「读树失败」表达成 None，不再有任何扫盘回退。
    """
    try:
        return db.fetch_tree()
    except Exception:
        return None


def _tag_tree_from_cache(tree_nodes):
    """由 zhule.db 词库树构造标签树 (tree, ancestors)。

    tree 元素：{id, name, rel, depth, leaf, children}；
    rel 由父链原始节点名还原；id 为词条 id（词条改名/移动后不脱钩）。
    """
    tree = []
    anc = {}

    def build(nodes, depth, anc_names, parent_rawnames):
        out = []
        for nd in nodes or []:
            raw = _node_raw_name(nd)
            disp = nd.get("name") or raw
            rel = "/".join(parent_rawnames + [raw])
            if nd.get("type") == "entry":
                # mute：词条静音标记（1=静音）。前端「隐藏被静音的提示词」开关开启时据此过滤节点
                #
                # 版本组锚点（vg=1）是一种特殊 entry：它自己不出词（空壳入口），下面挂的是
                # 同一提示词的各个版本（同样都是 entry）。标签树必须把它当成「可展开的分组容器」
                # 往下递归，否则各版本标签在树里彻底消失，连带三个后果：
                #   ① 词库卡片跳图库带的是版本 id，树里查不到名字，过滤区只能露出裸数字 id；
                #   ② 锚点自己从不被选中（不出词），不汇总子版本时它的关联数恒为 0；
                #   ③ 点锚点做不了「整组聚合筛选」（子树 id 展开依赖树结构）。
                # 普通 entry 仍是叶子，其下即使有历史残留子节点也不递归（保持原有语义）。
                _vg = int(nd.get("vg") or 0)
                kids = build(nd.get("children") or [], depth + 1,
                             anc_names + [disp], parent_rawnames + [raw]) if _vg else []
                node = {"id": nd.get("id") or "", "name": disp, "rel": rel,
                        "depth": depth, "leaf": not bool(kids), "children": kids,
                        "mute": int(nd.get("mute") or 0)}
                if _vg:
                    # 前端据此把该节点当版本组入口（可展开/整组筛选），与普通词条标签区分
                    node["vg"] = 1
            else:
                kids = build(nd.get("children") or [], depth + 1,
                             anc_names + [disp], parent_rawnames + [raw])
                node = {"id": nd.get("id") or "", "name": disp, "rel": rel,
                        "depth": depth, "leaf": False, "children": kids}
            out.append(node)
            if anc_names:
                anc[disp] = tuple(anc_names)
        return out

    for top in tree_nodes or []:
        raw = _node_raw_name(top)
        disp = top.get("name") or raw
        kids = build(top.get("children") or [], 1, [disp], [raw])
        tree.append({"id": top.get("id") or "", "name": disp, "rel": raw,
                     "depth": 0, "leaf": not bool(kids), "children": kids})
    return tree, anc


def _build_tag_tree():
    """返回 (tree, ancestors)，数据源为 zhule.db 的 prompt 表（不再扫盘）。

    tree: [{id, name, rel, depth, leaf, children}]（顶层为 tab）
    ancestors: name -> tuple(祖先显示名)（不含自身；仅记录有目录归属的节点）
    """
    return _tag_tree_from_cache(db.fetch_tree())


def get_tag_tree(force=False):
    """返回 (tree, ancestors)，TTL + 目录签名缓存。"""
    now = time.time()
    sig = _tree_sig()
    if not force and _tree_cache["tree"] is not None \
            and _tree_cache["sig"] == sig \
            and (now - _tree_cache["ts"]) < _TREE_TTL:
        return _tree_cache["tree"], _tree_cache["anc"]
    tree, anc = _build_tag_tree()
    _tree_cache.update({"ts": now, "sig": sig, "tree": tree, "anc": anc})
    return tree, anc


# ==================== 词条中文提示词索引（tag -> prompt_cn.txt 首行） ====================
# 图库 tag 与词库词条同源（词条名 = 目录名去数字前缀），中文提示词框按 tag 拼接展示，
# 直接复用词库词条目录下的 prompt_cn.txt 首行。TTL + 目录签名缓存，与标签树策略一致。
# 数据源为 zhule.db prompt 表，TTL 缓存（已无扫盘回退）。
_TAG_CN_CACHE = {"ts": 0.0, "sig": None, "data": None}


def _tag_cn_index():
    """词条显示名 -> 中文提示词（cn 首行），读 zhule.db prompt 表 + TTL 缓存。"""
    now = time.time()
    sig = _tree_sig()
    if _TAG_CN_CACHE["data"] is not None \
            and _TAG_CN_CACHE["sig"] == sig \
            and (now - _TAG_CN_CACHE["ts"]) < _TREE_TTL:
        return _TAG_CN_CACHE["data"]
    data = db.tag_cn_index()
    _TAG_CN_CACHE.update({"ts": now, "sig": sig, "data": data})
    return data


# ==================== 词条英文提示词索引（tag -> prompt.txt 全文） ====================
# 图库详情英文提示词高亮按英文词条文本在 promptPreview 中子串匹配，
# 词条名是中文目录名，直接匹配英文永不命中，故读词条目录下 prompt.txt 作英文词条文本。
# 数据源为 zhule.db prompt 表，TTL 缓存（已无扫盘回退）。
_TAG_EN_CACHE = {"ts": 0.0, "sig": None, "data": None}


def _tag_en_index():
    """词条显示名 -> 英文提示词（en 全文），读 zhule.db prompt 表 + TTL 缓存。"""
    now = time.time()
    sig = _tree_sig()
    if _TAG_EN_CACHE["data"] is not None \
            and _TAG_EN_CACHE["sig"] == sig \
            and (now - _TAG_EN_CACHE["ts"]) < _TREE_TTL:
        return _TAG_EN_CACHE["data"]
    data = db.tag_en_index()
    _TAG_EN_CACHE.update({"ts": now, "sig": sig, "data": data})
    return data


# ==================== 词条 id 索引（name <-> id，id 定位核心） ====================
# 图库提示词标签在 PNG 里按 id 存，词条改名/移动后标签不脱钩；
# 两个索引均由 zhule.db 的词库树提供（id 为 prompt 表自增 id）。
# 注：name->id 仅供存量数据（PNG 里存的是老词条名）迁移时使用，新链路无需反查。
_TAG_ID_CACHE = {"ts": 0.0, "sig": None, "data": None}
_TAG_NAME_CACHE = {"ts": 0.0, "sig": None, "data": None}


def _tag_id_index():
    """词条显示名 -> id 映射（entry 节点），带 TTL + 目录签名缓存。"""
    now = time.time()
    sig = _tree_sig()
    if _TAG_ID_CACHE["data"] is not None \
            and _TAG_ID_CACHE["sig"] == sig \
            and (now - _TAG_ID_CACHE["ts"]) < _TREE_TTL:
        return _TAG_ID_CACHE["data"]
    data = db.tag_id_index()
    _TAG_ID_CACHE.update({"ts": now, "sig": sig, "data": data})
    return data


def _tag_name_index():
    """词条 id -> 显示名映射（entry 节点），带 TTL + 数据签名缓存。

    提示词标签在 PNG 内按 id 持久化，本索引负责把 id 还原成展示名。
    """
    now = time.time()
    sig = _tree_sig()
    if _TAG_NAME_CACHE["data"] is not None \
            and _TAG_NAME_CACHE["sig"] == sig \
            and (now - _TAG_NAME_CACHE["ts"]) < _TREE_TTL:
        return _TAG_NAME_CACHE["data"]
    # 按 id 直取（不做同名去重）：同名词条存在于多个分支时，非首个 id 也必须能还原
    data = db.tag_name_by_id_index()
    _TAG_NAME_CACHE.update({"ts": now, "sig": sig, "data": data})
    return data


def _tag_name(eid):
    """按词条 id 还原显示名；词条已删除/未收录返回空串。"""
    return _tag_name_index().get(str(eid)) or ""


def _parse_tag_refs(raw):
    """把标签元数据解析成 [(id, name), ...]。

    三种形态都认，混在一个数组里也能解析：
      [{"id":12,"n":"xxx"}]  新格式（对象数组，与 model / lora 同一套形态）
      [12, 7]                纯 id 数组
      ["xxx"]                老格式（纯名字）
    """
    out = []
    if not raw:
        return out
    try:
        data = json.loads(raw)
    except Exception:
        return out
    if not isinstance(data, list):
        return out
    for x in data:
        if isinstance(x, dict):
            tid = str(x.get("id") or "").strip()
            nm = str(x.get("n") or x.get("name") or "").strip()
        elif isinstance(x, bool):
            continue
        elif isinstance(x, (int, float)):
            tid, nm = str(int(x)), ""
        else:
            s = str(x).strip()
            tid, nm = (s, "") if s.isdigit() else ("", s)
        if tid or nm:
            out.append((tid, nm))
    return out


def _parse_custom_tag_refs(raw):
    """把自定义标签元数据解析成 [(id, path, name), ...]。

    在 _parse_tag_refs 基础上多取**完整路径** p（层级化后 '角色/绝区零/尼克'）：
      [{"id":12,"p":"角色/绝区零/尼克","n":"尼克"}]  层级新格式
      [{"id":12,"n":"xxx"}]                        扁平老格式（path 回退 n）
      ["角色/绝区零/尼克"]                          纯路径字符串（老格式）
    """
    out = []
    if not raw:
        return out
    try:
        data = json.loads(raw)
    except Exception:
        return out
    if not isinstance(data, list):
        return out
    for x in data:
        if isinstance(x, dict):
            tid = str(x.get("id") or "").strip()
            nm = str(x.get("n") or x.get("name") or "").strip()
            p = str(x.get("p") or "").strip()
        elif isinstance(x, bool):
            continue
        elif isinstance(x, (int, float)):
            tid, nm, p = str(int(x)), "", ""
        else:
            s = str(x).strip()
            tid, nm, p = (s, "", "") if s.isdigit() else ("", s, s)
        if tid or nm or p:
            out.append((tid, p or nm, nm))
    return out


_CUSTOM_NAME_CACHE = {"ts": 0, "data": None}


def _custom_tag_name_index():
    """自定义标签 id -> 当前显示名，带 30 秒缓存（避免逐图查库）。

    「先按 id 取，取不到才用 PNG 里自带的默认名」的第一跳。
    """
    now = time.time()
    if _CUSTOM_NAME_CACHE["data"] is not None \
            and (now - _CUSTOM_NAME_CACHE["ts"]) < 30:
        return _CUSTOM_NAME_CACHE["data"]
    data = db.custom_tag_name_index()
    _CUSTOM_NAME_CACHE.update({"ts": now, "data": data})
    return data


_CUSTOM_PATH_CACHE = {"ts": 0, "data": None}


def _custom_tag_path_index():
    """自定义标签 id -> 完整路径（层级化 '角色/绝区零/尼克'），带 30 秒缓存。

    旧扁平数据（顶层节点）路径即自身名，天然兼容。
    """
    now = time.time()
    if _CUSTOM_PATH_CACHE["data"] is not None \
            and (now - _CUSTOM_PATH_CACHE["ts"]) < 30:
        return _CUSTOM_PATH_CACHE["data"]
    data = db.custom_tag_path_index()
    _CUSTOM_PATH_CACHE.update({"ts": now, "data": data})
    return data


def _remove_prompt_tags(cur, names):
    """按展示名从提示词标签数组里删除条目。

    PNG 内提示词标签是词条 id，而前端删除时给的是展示名，故须把名字映射回 id 再比对
    （直接按名字过滤会一个都删不掉）。同时兼容数组里残留的老名字。
    """
    rm = {n for n in (names or []) if n}
    if not rm:
        return [str(x).strip() for x in cur or [] if str(x).strip()]
    out = []
    for x in cur or []:
        s = str(x).strip()
        if not s or s in rm:
            continue
        if s.isdigit() and _tag_name(s) in rm:
            continue
        out.append(s)
    return out


def _tag_cn(name):
    """词条 tag 的中文提示词：词库词条中文优先，未命中查内置常用标签翻译表，仍无则空串。"""
    r = _tag_cn_index().get(name) or _TAG_CN_FALLBACK.get(name, "")
    return r


def _tag_en(name):
    """词条 tag 的英文提示词：词库词条 prompt.txt 全文，词库未收录则空串（前端回退 tag 名）。"""
    r = _tag_en_index().get(name) or ""
    return r


# ==================== 常用标签中文翻译表（词库未收录时的兜底） ====================
# 图库详情中文提示词框按 tag 拼接，词库词条未覆盖的通用标签在此查中文，
# 覆盖数量/姿势/表情/服饰/场景/视角/画质等高频 AI 绘图标签。key 一律小写。
_TAG_CN_FALLBACK = {
    "1girl": "少女", "1boy": "少年", "solo": "单人", "multiple girls": "多名少女",
    "multiple boys": "多名少年", "group": "多人", "no humans": "无人",
    # 姿势
    "standing": "站立", "sitting": "坐着", "lying": "躺卧", "kneeling": "跪姿",
    "walking": "行走", "running": "奔跑", "jumping": "跳跃", "dancing": "跳舞",
    "bending over": "弯腰", "bending forward": "前倾", "leaning forward": "前倾",
    "looking at viewer": "看向观众", "looking away": "视线移开", "looking down": "低头看",
    "looking up": "仰头看", "looking back": "回头", "head tilt": "歪头",
    "arms up": "举起双臂", "arms crossed": "双臂交叉", "hands on hips": "叉腰",
    "hand on own face": "手抚脸颊", "hand on own chest": "手放胸前",
    "finger to own mouth": "手指抵唇", "peace sign": "比V手势", "v sign": "比V手势",
    "thumbs up": "竖大拇指", "heart hands": "比心", "salute": "敬礼",
    "hugging self": "抱臂", "squatting": "蹲下", "spread legs": "双腿张开",
    "kneeling on one knee": "单膝跪地", "crossed legs": "跷二郎腿", "leg up": "抬腿",
    "skirt lift": "掀起裙子", "lifting hem": "掀起衣摆", "dress lift": "提起裙摆",
    "straddling": "跨坐", "on all fours": "四肢着地", "crawling": "匍匐",
    "upside down": "倒立", "back arched": "弓背", "arched back": "弓背",
    "from behind": "背后视角", "from above": "俯视", "from below": "仰视",
    "pov": "第一人称视角", "first-person view": "第一人称视角", "profile": "侧面",
    "side view": "侧面", "back view": "背面", "reflection": "倒影",
    "mirror": "镜子", "in front of mirror": "镜子前", "mirror reflection": "镜中倒影",
    "selfie": "自拍",
    # 表情
    "smile": "微笑", "happy": "开心", "sad": "悲伤", "crying": "哭泣", "tears": "流泪",
    "angry": "生气", "pout": "噘嘴", "blush": "脸红", "embarrassed": "害羞",
    "shy": "害羞", "shy smile": "羞笑", "flirty": "挑逗", "teasing": "挑逗",
    "smug": "得意", "confident": "自信", "serious": "严肃", "surprised": "惊讶",
    "shocked": "震惊", "scared": "害怕", "sleepy": "困倦", "tired": "疲惫",
    "bored": "无聊", "annoyed": "不耐烦", "disgusted": "厌恶", "worried": "担忧",
    "thinking": "思考", "confused": "困惑", "excited": "兴奋", "laughing": "大笑",
    "grin": "咧嘴笑", "winking": "眨眼", "wink": "眨眼", "open mouth": "张嘴",
    "tongue out": "吐舌", "sticking out tongue": "吐舌", "drooling": "流口水",
    "licking lips": "舔嘴唇", "biting lip": "咬唇", "seductive": "魅惑",
    "seductive smile": "魅惑微笑", "gentle smile": "温柔微笑", "evil smile": "坏笑",
    # 身材与裸露
    "flat chest": "平胸", "breasts": "胸部", "breasts exposed": "胸部裸露",
    "exposed breasts": "裸露胸部", "nipples": "乳头", "nipples hard": "乳头挺立",
    "nipple piercing": "乳头钉", "areolae": "乳晕", "cleavage": "乳沟",
    "sideboob": "侧乳", "underboob": "下乳", "large breasts": "巨乳",
    "small breasts": "贫乳", "navel": "肚脐", "belly": "腹部", "abs": "腹肌",
    "midriff": "露腰", "panties": "内裤", "thong": "丁字裤",
    # 服饰
    "skirt": "裙子", "mini skirt": "迷你裙", "dress": "连衣裙",
    "swimsuit": "泳装", "bikini": "比基尼", "one-piece swimsuit": "连体泳衣",
    "school uniform": "校服", "sailor uniform": "水手服", "maid": "女仆装",
    "maid outfit": "女仆装", "kimono": "和服", "yukata": "浴衣", "qipao": "旗袍",
    "cheongsam": "旗袍", "armor": "铠甲", "military uniform": "军装", "suit": "西装",
    "lab coat": "白大褂", "coat": "外套", "jacket": "夹克", "hoodie": "连帽衫",
    "sweater": "毛衣", "cardigan": "开衫", "shirt": "衬衫", "white shirt": "白衬衫",
    "t-shirt": "T恤", "tank top": "背心", "crop top": "露脐装", "blouse": "罩衫",
    "jeans": "牛仔裤", "shorts": "短裤", "stockings": "长筒袜", "thighhighs": "过膝袜",
    "kneehighs": "及膝袜", "pantyhose": "连裤袜", "socks": "袜子",
    "thighhigh boots": "过膝靴", "boots": "靴子", "shoes": "鞋子", "heels": "高跟鞋",
    "barefoot": "赤脚", "gloves": "手套", "hat": "帽子", "cap": "鸭舌帽",
    "beret": "贝雷帽", "hood": "兜帽", "hair ribbon": "发带", "hair bow": "发饰",
    "ribbon": "缎带", "lace": "蕾丝", "frills": "荷叶边", "ruffles": "褶边",
    "bow": "蝴蝶结", "collar": "衣领", "necktie": "领带", "choker": "项圈",
    "necklace": "项链", "earrings": "耳环", "ring": "戒指", "bracelet": "手链",
    "glasses": "眼镜", "sunglasses": "墨镜", "monocle": "单片眼镜", "eyepatch": "眼罩",
    "mask": "面具", "scarf": "围巾", "apron": "围裙", "backpack": "背包",
    # 发型
    "ahoge": "呆毛", "twintails": "双马尾", "ponytail": "马尾", "braid": "辫子",
    "side braid": "侧辫", "buns": "丸子头", "hair bun": "丸子头", "hime cut": "公主切",
    "short hair": "短发", "long hair": "长发", "medium hair": "中长发",
    "straight hair": "直发", "wavy hair": "卷发", "curly hair": "卷发",
    "messy hair": "凌乱头发", "hair between eyes": "中分", "bangs": "刘海",
    "sidelocks": "鬓发", "drills": "钻头卷发", "two-tone hair": "双色发",
    "gradient hair": "渐变发", "low twintails": "低双马尾",
    "blonde hair": "金发", "brown hair": "棕发", "black hair": "黑发",
    "white hair": "白发", "silver hair": "银发", "red hair": "红发",
    "pink hair": "粉发", "blue hair": "蓝发", "green hair": "绿发",
    "purple hair": "紫发", "orange hair": "橙发", "gray hair": "灰发",
    # 兽耳/异形
    "cat ears": "猫耳", "fox ears": "狐耳", "wolf ears": "狼耳",
    "rabbit ears": "兔耳", "elf ears": "精灵耳", "pointy ears": "尖耳",
    "animal ears": "兽耳", "tail": "尾巴", "cat tail": "猫尾", "fox tail": "狐尾",
    "wings": "翅膀", "angel wings": "天使翅膀", "demon wings": "恶魔翅膀",
    "halo": "光环", "horns": "角", "devil horns": "恶魔角", "aura": "气场",
    # 光影/氛围
    "glowing": "发光", "glow": "辉光", "sparkles": "闪光", "particles": "粒子",
    "magic": "魔法", "fire": "火焰", "flame": "火焰", "water": "水", "rain": "雨",
    "lightning": "闪电", "wind": "风", "petals": "花瓣", "cherry blossoms": "樱花",
    "sakura": "樱花", "leaves": "树叶", "stars": "星星", "moon": "月亮",
    "crescent moon": "新月", "sun": "太阳", "sunset": "日落", "sunrise": "日出",
    "sky": "天空", "clouds": "云", "night": "夜晚", "night sky": "夜空",
    "indoors": "室内", "outdoors": "室外", "forest": "森林", "mountain": "山",
    "beach": "海滩", "ocean": "海洋", "sea": "海", "lake": "湖", "river": "河流",
    "city": "城市", "street": "街道", "building": "建筑", "castle": "城堡",
    "temple": "寺庙", "shrine": "神社", "room": "房间", "bedroom": "卧室",
    "bathroom": "浴室", "kitchen": "厨房", "classroom": "教室", "library": "图书馆",
    "stage": "舞台", "balcony": "阳台", "window": "窗户", "door": "门", "stairs": "楼梯",
    "grass": "草地", "flower field": "花田", "flower garden": "花园", "garden": "花园",
    "snow": "雪", "snowing": "下雪", "winter": "冬天", "autumn": "秋天",
    "spring": "春天", "summer": "夏天", "day": "白天", "dusk": "黄昏", "dawn": "黎明",
    "neon lights": "霓虹灯", "light rays": "光线", "lens flare": "镜头光晕",
    "bokeh": "散景", "depth of field": "景深", "blur": "模糊", "motion blur": "动态模糊",
    "fisheye": "鱼眼", "wide shot": "广角", "close-up": "特写", "full body": "全身",
    "upper body": "上半身", "upper half": "上半身", "bust shot": "半身像",
    "headshot": "头部特写", "face": "脸部", "face focus": "面部特写",
    "eye focus": "眼睛特写", "cowboy shot": "中景", "backlight": "逆光",
    "rim light": "轮廓光", "silhouette": "剪影", "shadow": "阴影",
    "cinematic": "电影感", "cinematic lighting": "电影布光", "dramatic lighting": "戏剧性布光",
    "soft lighting": "柔和光线", "hard lighting": "硬光", "volumetric lighting": "体积光",
    "atmospheric": "氛围感", "moody": "忧郁", "dark": "黑暗", "gloomy": "阴沉",
    "photorealistic": "写实", "realistic": "写实", "watercolor": "水彩",
    "oil painting": "油画", "anime style": "动漫风格", "3d": "三维", "cg": "CG",
    "pixel art": "像素画", "sketch": "素描", "lineart": "线稿", "monochrome": "单色",
    "greyscale": "灰度", "sepia": "棕褐色", "colorful": "多彩", "vibrant": "鲜艳",
    "pastel": "柔和色", "film grain": "胶片颗粒", "vintage": "复古", "retro": "复古",
    "futuristic": "未来感", "sci-fi": "科幻", "fantasy": "奇幻", "horror": "恐怖",
    "gothic": "哥特", "cyberpunk": "赛博朋克", "steampunk": "蒸汽朋克",
    "wuxia": "武侠", "xianxia": "仙侠", "fantasy setting": "奇幻背景",
    "medieval": "中世纪", "modern": "现代", "historical": "历史", "ancient": "古代",
    "desert": "沙漠", "cave": "洞穴", "volcano": "火山", "waterfall": "瀑布",
    "bridge": "桥", "road": "道路", "train": "火车", "airplane": "飞机", "ship": "船",
    "car": "汽车", "bicycle": "自行车", "motorcycle": "摩托车", "umbrella": "伞",
    "parasol": "阳伞",
    # 画质/质量
    "masterpiece": "杰作", "best quality": "最佳画质", "high quality": "高质量",
    "highres": "高分辨率", "ultra detailed": "超精细", "detailed": "精细",
    "intricate details": "复杂细节", "extremely detailed": "极致细节",
    "absurdres": "超高清", "8k": "8K", "4k": "4K", "2k": "2K",
    "wallpaper": "壁纸", "official art": "官方插画", "original": "原创",
    "highly detailed": "高度精细", "sharp focus": "锐利对焦",
    "depth of field": "景深", "dynamic angle": "动态视角", "dynamic pose": "动态姿势",
}


_ID_NAME_CACHE = {"sig": None, "data": None}


def _id_name_map():
    """当前词库缓存树 id -> 显示名（扫盘回退且无 id 时为空）。

    按 db.version() 签名缓存，避免点击标签过滤/目录排序时每次匹配都重复
    全量构建整棵词库树的 id->name 映射（词库大时同样拖慢过滤响应）。
    """
    try:
        sig = "db:" + str(db.version())
    except Exception:
        sig = "db:?"
    if _ID_NAME_CACHE["sig"] == sig and _ID_NAME_CACHE["data"] is not None:
        return _ID_NAME_CACHE["data"]
    m = {}
    tree = _wb_tree_data()
    if not tree:
        return m

    def walk(nodes):
        for n in nodes:
            nid = n.get("id")
            if nid:
                m[str(nid)] = n.get("name", "")
            walk(n.get("children") or [])

    walk(tree)
    _ID_NAME_CACHE.update({"sig": sig, "data": m})
    return m


_TAG_ANC_IDS_CACHE = {"sig": None, "data": None}


def _tag_anc_ids():
    """词条 id -> 祖先 id 集合（不含自身），按 db.version() 签名缓存。

    SQL 过滤需保持原 anc 语义：筛选父级词条时，图片挂任一子级词条也命中。
    由词库树递归构造一次，避免过滤时对每棵子树全树扫描。
    """
    try:
        sig = "db:" + str(db.version())
    except Exception:
        sig = "db:?"
    if _TAG_ANC_IDS_CACHE["sig"] == sig and _TAG_ANC_IDS_CACHE["data"] is not None:
        return _TAG_ANC_IDS_CACHE["data"]
    tree = get_tag_tree()[0]
    m = {}

    def walk(nodes, anc_ids):
        for n in nodes:
            nid = n.get("id")
            if nid:
                m[str(nid)] = set(anc_ids)
                walk(n.get("children") or [], anc_ids + [str(nid)])
            else:
                walk(n.get("children") or [], anc_ids)

    walk(tree, [])
    _TAG_ANC_IDS_CACHE.update({"sig": sig, "data": m})
    return m


def _prompt_subtree_ids(pid):
    """词条 id 的子树 id 集合（含自身）。

    SQL 过滤前把父级词条展开成全部后代，保持"筛选父级词条命中其分支下图片"
    的既有 anc 语义（gallery_tag.prompt_id 只存直接关联的叶子词条）。
    """
    pid = str(pid).strip()
    if not pid.isdigit():
        return {pid} if pid else set()
    anc = _tag_anc_ids()
    out = {pid}
    for cid, a in anc.items():
        if pid in a:
            out.add(cid)
    return out


_TAG_ID_GLOBAL_CACHE = {"sig": None, "data": None}


def _tag_id_global():
    """tag 名 -> id 全集：当前词库缓存（name->id）+ 图库索引持久化 tagIds（历史旧名）。

    词条改名后旧名仍保留在既有图片记录的 tagIds 中，据此可实现「旧 name 图片
    按新 name 过滤仍命中」（定位用 id、展示用 name）。

    按 (_index_rev, db.version()) 双签名缓存：图片打标/新图或词库增删改任一变化即重建。
    此前每次匹配都全量遍历 _index 所有图片，点标签过滤时对每条记录重复执行，
    图库大时呈 O(N²) 级卡顿（点击后延迟数秒）。缓存后只在签名变化时重建一次。
    """
    try:
        sig = str(_index_rev) + "|" + str(db.version())
    except Exception:
        sig = str(_index_rev) + "|?"
    if _TAG_ID_GLOBAL_CACHE["sig"] == sig and _TAG_ID_GLOBAL_CACHE["data"] is not None:
        return _TAG_ID_GLOBAL_CACHE["data"]
    m = {}
    try:
        m.update(_tag_id_index())
    except Exception:
        pass
    try:
        if _index is not None:
            for r in _index:
                for n, i in (r.get("tagIds") or {}).items():
                    if i and n not in m:
                        m[n] = str(i)
    except Exception:
        pass
    _TAG_ID_GLOBAL_CACHE.update({"sig": sig, "data": m})
    return m


def _tag_hit(tag, rec_tags, anc, rel_map=None):
    """标签命中：直接匹配 或 图片某直接 tag 的祖先归属包含该标签；
    带 rel（词条相对路径）时按 rel 子树精确匹配，仅命中该层级分支下的词条。

    id 归并兜底：词条改名/移动后，图片上仍存旧 name，而筛选用的是新 name；
    通过 tagIds 把双方归并到同一 id 后仍可命中（定位用 id、展示用 name）。
    """
    if isinstance(tag, tuple):
        name, rel = tag
    else:
        name, rel = tag, None
    if rel and rel_map:
        for rt in rec_tags:
            r = rel_map.get(rt)
            # 自定义标签在 rec_tags 里存的是完整路径（'测试/喜欢'），提示词树 rel_map 查不到，
            # 直接拿 rt 本身当路径比较——否则带 rel 的自定义标签（ltags 老路径）恒不命中
            if r is None:
                r = rt
            if r and (r == rel or r.startswith(rel + "/")):
                return True
        return False
    if name in rec_tags:
        return True
    if anc:
        for rt in rec_tags:
            if name in anc.get(rt, ()):
                return True
    # id 归并兜底
    try:
        gid = _tag_id_global()
        tid = gid.get(name)
        if tid:
            id_name = _id_name_map()
            for rt in rec_tags:
                rtid = gid.get(rt)
                if rtid and rtid == tid:
                    return True
                if anc and rtid:
                    cur = id_name.get(rtid)
                    if cur and name in anc.get(cur, ()):
                        return True
    except Exception:
        pass
    return False


def _tag_rel_map(tree):
    """词条显示名 -> rel 路径映射（首见优先，同名取先见者）。"""
    m = {}

    def walk(nodes):
        for n in nodes:
            if n["name"] not in m:
                m[n["name"]] = n["rel"]
            walk(n["children"])

    walk(tree)
    return m


def _deepest_tag_rel(rec_tags, tag, anc, rel_map):
    """图片命中的词条中，属于 tag 子树且层级最深的那个 rel（无则空串）。

    用于「目录序」：筛选某个标签后，卡片按其命中最深词条的目录编号顺序排列，
    例如筛选「蒙德」时，01_琴% 目录的图排在 02_丽莎% 之前。
    词条改名后经 id 归并兜底，旧 name 图片仍可按当前名定位 rel。
    """
    best = None
    if isinstance(tag, str) and tag.isdigit():
        # SQL 过滤路径传入词条 id：按记录 id 集合直接定位当前名，再做子树归属判断
        try:
            gid = _tag_id_global()
            id_name = _id_name_map()
            anc_ids = _tag_anc_ids()
            for rt in rec_tags:
                rtid = gid.get(rt)
                if not rtid:
                    continue
                cur = id_name.get(rtid)
                if not cur:
                    continue
                if rtid == tag or tag in anc_ids.get(cur, set()):
                    rel = rel_map.get(cur)
                    if rel and (best is None or rel.count("/") > best.count("/")):
                        best = rel
        except Exception:
            return ""
        return best or ""
    for rt in rec_tags:
        if rt == tag or tag in anc.get(rt, ()):
            rel = rel_map.get(rt)
            if rel and (best is None or rel.count("/") > best.count("/")):
                best = rel
    if best:
        return best
    try:
        gid = _tag_id_global()
        tid = gid.get(tag)
        if tid:
            id_name = _id_name_map()
            for rt in rec_tags:
                rtid = gid.get(rt)
                if rtid != tid:
                    continue
                cur = id_name.get(rtid)
                if not cur:
                    continue
                if tag == cur or tag in anc.get(cur, ()):
                    rel = rel_map.get(cur)
                    if rel and (best is None or rel.count("/") > best.count("/")):
                        best = rel
    except Exception:
        return ""
    return best or ""


def _matches(rec, tags, models, loras, q, anc=None, tag_mode="and"):
    if tags:
        rec_tags = set(rec.get("tags", []))
        # 提示词标签在 PNG 内按 id 存：按 id 筛选可不受词条改名影响（改名后无需重建索引）
        # 两路取 id：_make_record 内存记录带 promptIds；DB 加载记录只有 tagIds(name->id)
        rec_ids = {str(x).strip() for x in (rec.get("promptIds") or []) if str(x).strip()}
        rec_ids |= {str(v).strip() for v in (rec.get("tagIds") or {}).values()
                    if str(v).strip()}
        if anc is None:
            _, anc = get_tag_tree()
        rel_map = None
        if any(isinstance(t, tuple) for t in tags):
            rel_map = _tag_rel_map(get_tag_tree()[0])
        hits = []
        for t in tags:
            n = t[0] if isinstance(t, tuple) else t
            # 纯数字串视为词条 id，直接对 promptIds 匹配；其余走显示名/祖先匹配
            if isinstance(n, str) and n.isdigit():
                hits.append(n in rec_ids)
            else:
                hits.append(_tag_hit(t, rec_tags, anc, rel_map))
        # and：满足全部已启用 tag（默认）；or：满足任一即可
        if tag_mode == "or":
            if not any(hits):
                return False
        else:
            if not all(hits):
                return False
    if models and rec.get("model") not in models:
        return False
    if loras and not (set(rec.get("loras", [])) & set(loras)):
        return False
    if q:
        hay = " ".join([rec.get("name", ""), rec.get("model", ""),
                        " ".join(rec.get("tags", [])),
                        " ".join(rec.get("loras", []))]).lower()
        if q.lower() not in hay:
            return False
    return True


# ==================== HTTP handlers ====================

def _gallery_filtered(query):
    """按查询参数筛选图库（不解析 page/pageSize），返回已排序的记录列表（未分页）。

    与 /gallery 列表共用同一筛选语义：tags/ctags 优先按 id 走 SQL 直查，
    ltags/无 id 老状态回退内存逐条匹配；排序规则与列表一致。
    """
    sort = query.get("sort", "time_desc")
    q = (query.get("q") or "").strip()
    tags = []
    for t in _split_csv(query.get("tags")):
        if "|" in t:
            n, _, r = t.partition("|")
            tags.append((n, r))
        else:
            tags.append(t)
    ctags = _split_csv(query.get("ctags"))
    ltags = []
    for t in _split_csv(query.get("ltags")):
        if "|" in t:
            n, _, r = t.partition("|")
            ltags.append((n, r))
        else:
            ltags.append(t)
    models = _split_csv(query.get("models"))
    loras = _split_csv(query.get("loras"))
    tag_mode = (query.get("mode") or "and").strip().lower()
    if tag_mode not in ("and", "or"):
        tag_mode = "and"

    # 标签过滤主路径：优先按 id 走 SQL（gallery_tag 直查）；仅当请求含非数字 name
    # （老状态 / URL 直达 / 旧前端）时回退原内存逐条匹配。
    legacy_name_tags = []
    for t in tags:
        n = t[0] if isinstance(t, tuple) else t
        if not (isinstance(n, str) and n.isdigit()):
            legacy_name_tags.append(t)
    if legacy_name_tags or ltags:
        records = get_index()
        _, anc = get_tag_tree()
        use_tags = tags + ltags
        filtered = [r for r in records if _matches(r, use_tags, models, loras, q, anc, tag_mode)]
        # 自定义标签 id 不被 legacy 路径吞掉：老状态混入任一无 id 标签（ltags 非空）即走进本分支，
        # 此前 ctags 在此被完全忽略 → 自定义标签筛选整体失效。ctags 仍走 SQL 直查后按 mode 合并：
        # and=与内存结果交集；or=把 ctags 命中但 tags/ltags 未命中的图补入（其余条件仍需满足）
        if ctags:
            cgids = db.gallery_query_tag_gids([], ctags, tag_mode)
            if cgids is not None:
                if tag_mode == "or":
                    have = {r.get("id") for r in filtered}
                    filtered += [r for r in records
                                 if r.get("id") in cgids and r.get("id") not in have
                                 and _matches(r, [], models, loras, q, anc, tag_mode)]
                else:
                    filtered = [r for r in filtered if r.get("id") in cgids]
    else:
        # 父级词条展开为子树 id（保持 anc 语义），再交给 SQL 直查 gallery_tag；
        # 每个词条一个分组，and 模式逐组命中后交集（图须同时挂这些词条分支的标签）
        prompt_groups = []
        for t in tags:
            n = t[0] if isinstance(t, tuple) else t
            if isinstance(n, str) and n.isdigit():
                prompt_groups.append(list(_prompt_subtree_ids(n)))
        gids = db.gallery_query_tag_gids(prompt_groups, ctags, tag_mode)
        if gids is None:
            records = get_index()
        elif not gids:
            records = []
        else:
            records = db.gallery_load_records(gids) or []
        _, anc = get_tag_tree()
        # 标签已由 SQL 过滤，此处只处理 q / models / loras
        filtered = [r for r in records if _matches(r, [], models, loras, q, anc, tag_mode)]
    if sort == "time_asc":
        filtered.sort(key=lambda r: r["mtime"])
    elif sort == "time_desc":
        filtered.sort(key=lambda r: r["mtime"], reverse=True)
    elif sort == "name_asc":
        filtered.sort(key=lambda r: (r["name"].lower(), r["mtime"]))
    elif sort == "name_desc":
        filtered.sort(key=lambda r: (r["name"].lower(), r["mtime"]), reverse=True)
    elif sort in ("dir_asc", "dir_desc"):
        # 目录序：单选标签时按词条目录编号顺序（琴% 在 丽莎% 前）；否则按图片输出目录路径序
        if len(tags) == 1:
            rel_map = _tag_rel_map(get_tag_tree()[0])
            tg0 = tags[0][0] if isinstance(tags[0], tuple) else tags[0]
            keyf = lambda r: _path_sort_key(_deepest_tag_rel(r.get("tags", []), tg0, anc, rel_map))
        else:
            keyf = lambda r: _path_sort_key(r.get("key", ""))
        filtered.sort(key=keyf, reverse=(sort == "dir_desc"))
    else:
        filtered.sort(key=lambda r: r["mtime"], reverse=True)
    return filtered


async def get_gallery(request):
    """列表：?page=&pageSize=&sort=&q=&tags=&ctags=&ltags=&models=&loras=

    tags=词条 id（逗号分隔，纯数字）；ctags=自定义标签 id（逗号分隔）；
    两者均按 id 直查 gallery_tag 表过滤，命中后仅加载候选图 id 的记录，
    不再全量加载图库后在 Python 里逐条遍历匹配。
    ltags=旧 name|rel 兼容路径（老 localStorage 状态 / URL 直达无 id 时兜底）。
    """
    try:
        page = max(1, int(request.query.get("page", 1)))
    except ValueError:
        page = 1
    try:
        page_size = min(200, max(1, int(request.query.get("pageSize", 60))))
    except ValueError:
        page_size = 60
    filtered = _gallery_filtered(request.query)
    total = len(filtered)
    start = (page - 1) * page_size
    items = filtered[start:start + page_size]
    return web.json_response({
        "total": total, "page": page, "pageSize": page_size,
        "items": items, "builtAt": _index_built_at,
        "building": _index_building,
    })


# 命中池 id 列表 LRU 缓存：key=筛选参数（不含 page/pageSize）+ 索引版本，
# 索引变更（builtAt/building 变化）后自动失效；上限 100 条防膨胀。
_gallery_ids_cache = OrderedDict()
_GALLERY_IDS_CACHE_MAX = 100


def _gallery_ids_key(query):
    parts = []
    for k in ("sort", "q", "tags", "ctags", "ltags", "models", "loras", "mode"):
        v = query.get(k)
        if v:
            parts.append(f"{k}={v}")
    # 版本号必须用 _index_rev（新增入库/删除/改名/打标都会 +1），不能只挂 _index_built_at。
    # 历史 bug：_index_built_at 仅在「重建索引」时更新，新图入库后本缓存永不失效 →
    # /gallery/ids 命中池停留在旧快照（缺新图、多已删图），而 /gallery 列表读的是实时 _index。
    # 于是点开刚生成的图，命中池里找不到它 → 详情位置恒显示「— / N」，
    # 左右箭头提示「当前图片不在筛选结果内，无法按筛选翻页」。
    return ("|".join(parts) + "|rev=" + str(_index_rev)
            + "|built=" + str(_index_built_at) + "|bld=" + str(_index_building))


def _gallery_ids(query):
    """按当前筛选条件返回全部命中记录的 key（有序）列表，带 LRU 缓存。"""
    key = _gallery_ids_key(query)
    hit = _gallery_ids_cache.get(key)
    if hit is not None:
        _gallery_ids_cache.move_to_end(key)
        return hit
    filtered = _gallery_filtered(query)
    ids = [r["key"] for r in filtered]
    _gallery_ids_cache[key] = ids
    if len(_gallery_ids_cache) > _GALLERY_IDS_CACHE_MAX:
        _gallery_ids_cache.popitem(last=False)
    return ids


async def get_gallery_ids(request):
    """命中池 id 列表：与 /gallery 相同筛选参数（忽略 page/pageSize），返回全部命中 key 数组。

    供图库详情弹层在图片两侧做上一张/下一张/骰子随机导航：随机与翻页都只
    在“当前筛选条件的完整命中池”内进行（如过滤胡桃后命中 7430 张，则在 7430 张里随机）。
    """
    ids = _gallery_ids(request.query)
    return web.json_response({"total": len(ids), "ids": ids})


async def get_gallery_random(request):
    """随机拼页：与 /gallery 相同筛选参数（忽略 page），从当前筛选命中池中随机抽取
    pageSize 张图，按随机顺序返回 items（total 为命中池总数）。

    供筛选区「🎲」按钮使用：不是跳到随机页码，而是从命中池随机抽图凑成一页展示。
    """
    try:
        page_size = min(200, max(1, int(request.query.get("pageSize", 60))))
    except ValueError:
        page_size = 60
    ids = _gallery_ids(request.query)
    total = len(ids)
    n = min(page_size, total)
    if n <= 0:
        return web.json_response({"total": 0, "pageSize": 0, "items": []})
    picked = random.sample(ids, n)
    items = db.gallery_load_records_by_keys(picked)
    return web.json_response({"total": total, "pageSize": n, "items": items})




async def get_gallery_meta(request):
    get_index()
    data = aggregate(_index or [])
    data["building"] = _index_building
    return web.json_response(data)


def _build_custom_tag_tree():
    """自定义标签层级树（供 tagtree 接口合并展示）。

    custom_tag 表按 parent_id 组织层级；构造为与词库树同构的节点
    [{id, name, rel, leaf, children}]，rel 用**完整路径**（'测试/喜欢'）保证节点 key 唯一。
    顶层**不包总壳**：直接返回自定义标签的顶层节点数组（如 '测试' 分支），
    由调用方拼到词库树之后，二者同级并列（来源靠 isCustom 标记区分）。
    """
    rows = db.custom_tag_rows()
    if not rows:
        return []
    nodes = {i: {"id": i, "name": n, "parent": p, "children": []}
             for i, p, n in rows if n}
    roots = []
    for nid, node in nodes.items():
        if node["parent"] is not None and node["parent"] in nodes:
            nodes[node["parent"]]["children"].append(node)
        else:
            roots.append(node)

    def sort_rec(ns):
        ns.sort(key=lambda x: x["id"])
        for n in ns:
            sort_rec(n["children"])
    sort_rec(roots)

    def to_tree(ns, prefix):
        out = []
        for n in ns:
            rel = "/".join([prefix, n["name"]]) if prefix else n["name"]
            kids = to_tree(n["children"], rel)
            out.append({
                "id": str(n["id"]),
                "name": n["name"],
                "rel": rel,
                "leaf": not kids,
                "isCustom": True,
                "children": kids,
            })
        return out
    return to_tree(roots, "")


async def get_gallery_tagtree(request):
    """标签层级树：词库 prompt 目录树（顶层=Tab，叶子=词条）+ 自定义标签层级树（不套总壳，置于树末，二者同级并列）。

    每个节点附带 count（关联图数）：一次 gallery_tag_counts() 全量统计，按节点 id 分域命中，
    供编辑面板与外部过滤区直接渲染角标。节点 count = 自身直接关联 + 所有后代关联之和，
    因此「角色/神态/服装」这类目录节点也能显示整棵子树的总图数，不再恒为 0。
    """
    tree, _ = get_tag_tree()
    custom_tree = _build_custom_tag_tree()
    if custom_tree:
        tree = list(tree) + custom_tree
    # 深拷贝：get_tag_tree() 返回的树可能被缓存复用，不能就地改（否则其他调用方拿到带 count 的旧树）
    tree = json.loads(json.dumps(tree))
    counts = db.gallery_tag_counts()

    def attach(ns):
        # 返回本层子树合计：节点 count = 自身直接关联 + 所有后代关联之和。
        # 目录/分组容器本身通常没有直接挂接图片，若不向上汇总，面板顶层分类会全为 0。
        total = 0
        for n in ns:
            try:
                nid = int(n.get("id"))
            except (TypeError, ValueError):
                nid = None
            own = 0
            if nid is not None:
                src = counts["custom"] if n.get("isCustom") else counts["prompt"]
                own = src.get(nid, 0)
            sub = attach(n["children"]) if n.get("children") else 0
            n["count"] = own + sub
            total += own + sub
        return total

    attach(tree)
    return web.json_response({
        "tree": tree,
        "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    })


# 详情接口内存缓存：按 (rel, mtime, size) 缓存，打标/改名/删除会保留原 mtime，需手动失效
_detail_cache = {}
_DETAIL_CACHE_MAX = 300

def _drop_detail_cache(rel=None):
    """清除详情缓存。rel 为 None 时全清；否则仅删该 rel 的缓存项。"""
    if rel is None:
        _detail_cache.clear()
        return
    for key in [k for k in _detail_cache if k[0] == rel]:
        _detail_cache.pop(key, None)


async def get_gallery_detail(request):
    """单图详情：数据源为 DB（gallery_image + gallery_tag/gallery_lora 关联）。

    词条/自定义标签/模型/LORA 名均经 id 关联实时取（改名自动跟随），prompt 直读 DB，
    不再逐张打开 PNG 读 tEXt 元数据；打标/重命名等行级写库后本接口自动取到新值。
    workflow 未落库，hasWF 恒 False（不展示 workflow 入口）；如需 workflow 原文，
    仍可走 get_gallery_workflow 的 PNG 兜底读取（按钮跳转场景）。
    """
    rel = (request.query.get("path") or "").strip()
    if not rel:
        return web.json_response({"error": "文件不存在"}, status=404)
    rec = db.gallery_get_by_name(rel)
    if rec is None:
        return web.json_response({"error": "文件不存在"}, status=404)
    # 词条标签（prompt 类）在前、自定义标签（custom 类）在后；名字均取 DB 当前值
    # 关联图数（count）：一次统计 gallery_tag 全量，按标签 id 命中；
    # 前端「标签关联数角标」开关关闭时不渲染，后端仍返回，切开关无需重新请求。
    _counts = db.gallery_tag_counts()
    tags = []
    for n in rec.get("tags") or []:
        _pid = rec.get("tagIds", {}).get(n) or ""
        _cnt = 0
        if str(_pid).strip().isdigit():
            _cnt = _counts["prompt"].get(int(_pid), 0)
        tags.append({"id": _pid, "name": n,
                     "prompt": True, "custom": False, "count": _cnt,
                     "cn": _tag_cn(n), "en": _tag_en(n)})
    for full in rec.get("customTags") or []:
        # 展示层只需叶子名（完整路径供删除/筛选兜底；有 id 时前端优先用 id）
        leaf = (re.split(r"[/\\:\-]", full)[-1] or full).strip()
        _cid = rec.get("customIds", {}).get(full) or ""
        _ccnt = 0
        if str(_cid).strip().isdigit():
            _ccnt = _counts["custom"].get(int(_cid), 0)
        tags.append({"id": _cid, "name": leaf,
                     "prompt": False, "custom": True, "path": full, "count": _ccnt,
                     "cn": _tag_cn(leaf), "en": _tag_en(leaf)})
    pt = rec.get("prompt") or ""
    data = {
        "path": rel,
        "name": rec.get("name") or os.path.basename(rel.replace("/", os.sep).replace("\\", os.sep)),
        "mtime": int(rec.get("mtime") or 0),
        "size": int(rec.get("size") or 0),
        "model": rec.get("model") or "",
        "loras": rec.get("loras") or [],
        "tags": tags,
        "hasWF": False,
        "workflowSize": 0,
        "hasPrompt": bool(pt),
        "promptPreview": _extract_positive_prompt(pt) or pt[:MAX_WORKFLOW_PREVIEW],
    }
    return web.json_response(data)


async def get_gallery_workflow(request):
    """返回 PNG 内 workflow JSON 原文（前端跳转 ComfyUI 导入用）。"""
    rel = (request.query.get("path") or "").strip()
    full = _safe_full(rel)
    if not full or not os.path.isfile(full):
        return web.json_response({"error": "文件不存在"}, status=404)
    texts = png_text.read_png_text(full)
    wf = texts.get("workflow")
    if not wf:
        return web.json_response({"error": "该图片没有 workflow 元数据"}, status=404)
    return web.Response(text=wf, content_type="application/json")


async def get_gallery_thumb(request):
    rel = (request.query.get("path") or "").strip()
    thumb = ensure_thumb(rel)
    if not thumb:
        return web.Response(status=404)
    resp = web.FileResponse(thumb, headers={"Content-Type": "image/jpeg"})
    # 禁止浏览器按 URL 缓存旧缩略图：同名文件重建后 URL 相同，需每次重新验证
    resp.headers["Cache-Control"] = "no-cache"
    return resp


async def get_gallery_image(request):
    """返回图库原图（按 zhule_img 相对路径解析，供详情页大图展示）。"""
    rel = (request.query.get("path") or "").strip()
    full = _safe_full(rel)
    if not full or not os.path.isfile(full):
        return web.Response(status=404)
    resp = web.FileResponse(full)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


async def post_gallery_rescan(request):
    started = _start_bg_build(force=True)
    return web.json_response({"ok": True, "building": started})


def delete_gallery_image(rel, with_records=True):
    """删除图库单张图：原图 + 缩略图（with_records 时一并清内存索引行、DB 记录、详情缓存）。

    rel 为图库根（zhule_img）下的相对路径，即索引 key。文件已不存在时仍会清理残留
    记录（幂等），保证「本地文件」与「DB 数据」两边一致。返回 (ok, error)。
    图库删除接口与词库参考图删除（zhule_img/ 前缀）共用本函数，避免两套删除逻辑。
    """
    global _index, _index_rev
    rel = (rel or "").strip().replace("\\", "/")
    if not rel:
        return False, "路径不能为空"
    full = _safe_full(rel)
    if not full:
        return False, "路径越界或非法"
    if os.path.isfile(full):
        # 先按当前 mtime 计算缩略图路径并尽力清理
        try:
            st = os.stat(full)
            thumb = _thumb_path(rel, int(st.st_mtime))
            if os.path.isfile(thumb):
                os.remove(thumb)
        except OSError:
            pass
        try:
            os.remove(full)
        except OSError as e:
            return False, f"删除失败: {e}"
    if with_records:
        # 更新内存索引 + 行级删除（只删这一行，不做全表替换）
        if _index is not None:
            _index = [r for r in _index if r.get("key") != rel]
        _index_rev += 1
        db.gallery_delete_records([rel])
        _drop_detail_cache(rel)
    return True, None


async def post_gallery_delete(request):
    """body: { path } 删除图片原图与对应缩略图，并刷新索引缓存。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    rel = (body.get("path") or "").strip()
    if not rel:
        return web.json_response({"error": "路径不能为空"}, status=400)
    full = _safe_full(rel)
    if not full or not os.path.isfile(full):
        return web.json_response({"error": "图片不存在"}, status=404)

    ok, err = delete_gallery_image(rel)
    if not ok:
        return web.json_response({"error": err}, status=500)
    return web.json_response({"ok": True, "path": rel})


async def _post_gallery_batch_delete_impl(request):
    """body: { paths: [rel, ...] } 批量删除图片原图与对应缩略图，并一次性刷新索引缓存。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "请求体必须是 JSON 对象"}, status=400)
    raw = body.get("paths")
    if not isinstance(raw, list) or not raw:
        return web.json_response({"error": "paths 不能为空"}, status=400)
    if len(raw) > 500:
        return web.json_response({"error": "单次最多删除 500 张"}, status=400)

    # 去重（保留顺序）；非字符串元素不中断，直接记入 failed
    seen = set()
    paths = []
    deleted = []
    failed = []
    for p in raw:
        if not isinstance(p, str):
            failed.append({"path": str(p), "error": "路径必须是字符串"})
            continue
        rel = p.strip()
        if rel and rel not in seen:
            seen.add(rel)
            paths.append(rel)

    for rel in paths:
        # 单条失败不中断：越界/非法路径（如 null 字节）、stat/删除异常均记入 failed
        try:
            full = _safe_full(rel)
            if not full or not os.path.isfile(full):
                failed.append({"path": rel, "error": "图片不存在"})
                continue
            # with_records=False：内存索引与 DB 记录在循环结束后一次性处理，避免逐条重建列表
            ok, err = delete_gallery_image(rel, with_records=False)
            if ok:
                deleted.append(rel)
            else:
                failed.append({"path": rel, "error": err})
        except Exception as e:
            failed.append({"path": rel, "error": f"删除异常: {e}"})

    # 更新内存索引 + 行级删除（只删这几行，不做全表替换）
    global _index, _index_rev
    delset = set(deleted)
    if _index is not None:
        _index = [r for r in _index if r.get("key") not in delset]
        _index_rev += 1
    if deleted:
        db.gallery_delete_records(deleted)

    for _r in deleted:
        _drop_detail_cache(_r)
    return web.json_response({
        "ok": True,
        "count": len(deleted),
        "deleted": deleted,
        "failed": failed,
    })


async def post_gallery_batch_delete(request):
    """批量删除入口：兜底异常返回结构化错误，避免裸 500。"""
    try:
        return await _post_gallery_batch_delete_impl(request)
    except Exception as e:
        print(f"[ZhuleGallery] 批量删除异常: {e}")
        return web.json_response({"ok": False, "error": f"批量删除失败: {e}"}, status=500)


def _link_root():
    """硬链接导出根目录：output/zhule_studio/zhule_link（与图库同卷，硬链接有效）。"""
    return os.path.join(_get_output_dir(), STUDIO_SUBDIR, "zhule_link")


def _unique_dest(target_dir, filename):
    """目标目录内同名冲突自动加后缀 (1)、(2)...，返回可用路径。"""
    base, ext = os.path.splitext(filename)
    cand = os.path.join(target_dir, filename)
    n = 1
    while os.path.exists(cand):
        cand = os.path.join(target_dir, f"{base}({n}){ext}")
        n += 1
    return cand


async def _post_gallery_batch_link_impl(request):
    """body: { paths: [rel, ...], folder?: string }
    把选中的图片以硬链接平铺到 output/zhule_link/<folder>（每次导出独立子文件夹，不平铺）。
    同卷用 os.link 零拷贝；跨卷/文件系统不支持时回退为复制副本。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "请求体必须是 JSON 对象"}, status=400)
    raw = body.get("paths")
    if not isinstance(raw, list) or not raw:
        return web.json_response({"error": "paths 不能为空"}, status=400)
    if len(raw) > 500:
        return web.json_response({"error": "单次最多导出 500 张"}, status=400)

    seen = set()
    paths = []
    for p in raw:
        if isinstance(p, str):
            rel = p.strip()
            if rel and rel not in seen:
                seen.add(rel)
                paths.append(rel)
    if not paths:
        return web.json_response({"error": "paths 不能为空"}, status=400)

    # 每次导出独立子文件夹：优先用户指定名（仅单层，防穿越），否则时间戳；重名自动加序号
    folder = str(body.get("folder") or "").strip()
    if folder:
        folder = folder.replace("/", "_").replace("\\", "_")
        if folder in (".", ".."):
            folder = ""
    if not folder:
        folder = time.strftime("%Y%m%d_%H%M%S")
    root = _link_root()
    target = os.path.join(root, folder)
    n = 1
    while os.path.exists(target):
        target = os.path.join(root, f"{folder}_{n}")
        n += 1
    os.makedirs(target, exist_ok=True)

    created = []
    copied = []
    failed = []
    for rel in paths:
        try:
            full = _safe_full(rel)
            if not full or not os.path.isfile(full):
                failed.append({"path": rel, "error": "图片不存在"})
                continue
            dest = _unique_dest(target, os.path.basename(full))
            try:
                os.link(full, dest)
                created.append(os.path.basename(dest))
            except OSError:
                shutil.copy2(full, dest)
                copied.append(os.path.basename(dest))
        except Exception as e:
            failed.append({"path": rel, "error": f"导出异常: {e}"})

    return web.json_response({
        "ok": True,
        "count": len(created) + len(copied),
        "created": created,
        "copied": copied,
        "failed": failed,
        "target": target,
    })


async def post_gallery_batch_link(request):
    """批量硬链接导出入口：兜底异常返回结构化错误，避免裸 500。"""
    try:
        return await _post_gallery_batch_link_impl(request)
    except Exception as e:
        print(f"[ZhuleGallery] 批量硬链接异常: {e}")
        return web.json_response({"ok": False, "error": f"批量硬链接失败: {e}"}, status=500)


def _norm_tag_names(v):
    """归一化标签名数组 → set[str]；非法返回 None。"""
    if not isinstance(v, list):
        return None
    return {str(x).strip() for x in v if str(x).strip()}


async def post_gallery_annotate(request):
    """body: { path, tags?: [str], remove_prompt?: [str], remove_custom?: [str] } 打标/删标（写 PNG 元数据）。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    rel = (body.get("path") or "").strip()
    full = _safe_full(rel)
    if not full or not os.path.isfile(full):
        return web.json_response({"error": "文件不存在"}, status=404)

    # 自定义标签为唯一可写标签字段：tags 全量重写；remove_custom 兼容 id/完整路径/叶子名三种匹配
    texts = png_text.read_png_text(full)
    custom_cur = _json_list(texts.get("zhule_custom_tags"), "zhule_custom_tags")
    updates = {}
    if "tags" in body:
        tags = body.get("tags")
        if not isinstance(tags, list):
            return web.json_response({"error": "tags 必须是数组"}, status=400)
        clean = []
        for x in tags:
            s = str(x or "").strip().strip("/")
            if s:
                clean.append(s)
        if len(clean) > 100:
            return web.json_response({"error": "标签过多"}, status=400)
        # 层级注册：每个路径按 / 拆段逐级 find-or-create，写对象数组（含叶子 id 与完整路径 p）
        refs = []
        for p in clean:
            r = db.custom_tag_path_ref(p)
            if r is None:
                continue
            refs.append(r if r.get("id") else {"p": r["p"], "n": r["n"]})
        custom_cur = refs
        updates["zhule_custom_tags"] = json.dumps(refs, ensure_ascii=False)
    if body.get("remove_custom") is not None:
        names = _norm_tag_names(body.get("remove_custom"))
        if names is None:
            return web.json_response({"error": "remove_custom 必须是字符串数组"}, status=400)
        # 兼容 dict（对象数组：p 完整路径 / n 叶子名 / id 三者任一命中即删）
        # 与纯字符串（老格式，按原样匹配）两种存量形态
        kept = []
        for x in custom_cur:
            if isinstance(x, dict):
                hit = any(str(x.get(k) or "").strip() in names for k in ("p", "n", "id"))
                if not hit:
                    kept.append(x)
            else:
                key = str(x).strip()
                if key and key not in names:
                    kept.append(x)
        custom_cur = kept
        updates["zhule_custom_tags"] = json.dumps(custom_cur, ensure_ascii=False)
    if body.get("remove_prompt") is not None:
        names = _norm_tag_names(body.get("remove_prompt"))
        if names is None:
            return web.json_response({"error": "remove_prompt 必须是字符串数组"}, status=400)
        cur = _json_list(texts.get("zhule_prompt_tags"), "zhule_prompt_tags")
        updates["zhule_prompt_tags"] = json.dumps(
            _remove_prompt_tags(cur, names), ensure_ascii=False)
    if not updates:
        return web.json_response({"error": "没有可更新字段"}, status=400)

    if not png_text.write_png_text(full, updates):
        return web.json_response({"error": "PNG 元数据写入失败"}, status=500)

    # 更新内存索引 + 行级写回（只写这一张，不做全表替换）
    global _index, _index_rev
    try:
        rec = _make_record(rel, full)
    except OSError:
        rec = None
    if rec is not None:
        if _index is not None:
            for i, r in enumerate(_index):
                if r.get("key") == rel:
                    _index[i] = rec
                    break
            else:
                _index.insert(0, rec)
            _index_rev += 1
        db.gallery_upsert_records([rec])

    _drop_detail_cache(rel)
    return web.json_response({"ok": True})


_rename_state = {"done": False, "updated": 0, "renamed_file": False, "error": None}


async def post_gallery_custom_tag(request):
    """自定义标签增删改（图库编辑面板的标签层级里就地维护）。

    body:
      {op:"create", parent_id?: int|None, name: str}  在父级下新建（顶层 parent_id 省略）
      {op:"rename", id: int, name: str}               重命名（同级去重）
      {op:"delete", id: int}                          删除该标签及其全部子级
    返回 {ok, id?, err?}；删除额外返回 removed（删掉的节点数）/ unlinked（解除关联的图片数）。
    """
    global _index
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    op = (body.get("op") or "").strip().lower()
    if op == "create":
        cid, err, existed = db.custom_tag_create(body.get("parent_id"), body.get("name"))
        if err and not cid:
            return web.json_response({"error": err}, status=400)
        return web.json_response({"ok": True, "id": cid, "existed": existed, "err": err})
    if op == "rename":
        err = db.custom_tag_rename(body.get("id"), body.get("name"))
        if err:
            return web.json_response({"error": err}, status=400)
        # 改名后图片展示名经 id 实时反查自动跟随，只需让详情缓存与列表内存索引失效
        _drop_detail_cache(None)
        _index = None
        return web.json_response({"ok": True})
    if op == "delete":
        ids, rels = db.custom_tag_delete(body.get("id"))
        if not ids:
            return web.json_response({"error": "标签不存在"}, status=404)
        idset = {str(x) for x in ids}
        # PNG 里的 zhule_custom_tags 快照同步清理：否则重扫/打标会把已删标签写回
        for rel in rels:
            full = _safe_full(rel)
            if not full or not os.path.isfile(full):
                continue
            try:
                texts = png_text.read_png_text(full)
                cur = _json_list(texts.get("zhule_custom_tags"), "zhule_custom_tags")
                kept = []
                for x in cur:
                    if isinstance(x, dict) and str(x.get("id") or "") in idset:
                        continue
                    kept.append(x)
                if len(kept) != len(cur):
                    png_text.write_png_text(full, {
                        "zhule_custom_tags": json.dumps(kept, ensure_ascii=False)
                    })
            except Exception as e:
                print(f"[ZhuleGallery] 清理图片标签快照失败 {rel}: {e}")
            _drop_detail_cache(rel)
        _index = None
        return web.json_response({
            "ok": True, "removed": len(ids), "unlinked": len(rels)
        })
    return web.json_response({"error": "未知操作"}, status=400)


def _model_library_dir(kind):
    """模型/LoRA 文件所在目录（ComfyUI models 下）。"""
    try:
        if kind == "model":
            dirs = folder_paths.get_folder_paths("checkpoints")
        else:
            dirs = folder_paths.get_folder_paths("loras")
        if dirs:
            return dirs[0]
    except Exception:
        pass
    return None


def _find_model_file(kind, name):
    """在模型库目录中查找 <name> 文件；找不到时按去后缀名尝试匹配。返回 (完整路径, 库目录)。"""
    base = _model_library_dir(kind)
    if not base or not os.path.isdir(base):
        return None, base
    full = os.path.join(base, name)
    if os.path.isfile(full):
        return full, base
    stem = os.path.splitext(name)[0]
    try:
        for fn in os.listdir(base):
            if os.path.splitext(fn)[0] == stem:
                return os.path.join(base, fn), base
    except OSError:
        pass
    return None, base


def _do_rename_work(kind, old, new, base_old):
    """后台执行：改 model 表一行 + 同步内存索引。

    old：原名（可带后缀）；new：新全名（后端已补后缀）；base_old：原名去后缀。

    图片侧存的是 model 表的 id（老图只有名字，按名字兜底反查），所以改名
    **不再逐张重写 PNG** —— 只改 model 表那一行，展示名由读取侧按 id 实时解析。
    这一步把「遍历七千张读 PNG、重写元数据、全表替换」瘦成了一条 UPDATE。
    """
    mtype = db.MODEL_TYPE_MODEL if kind == "model" else db.MODEL_TYPE_LORA
    mrow = db.model_lookup(mtype, old)
    new_name = db.normalize_model_name(new)
    updated = 0
    renamed_file = False
    file_err = None
    # 1) 重命名模型文件（仅当文件真实存在且位于模型库目录内时）
    src, lib_dir = _find_model_file(kind, old)
    if src and os.path.isfile(src) and lib_dir:
        lib_abs = os.path.abspath(lib_dir)
        src_abs = os.path.abspath(src)
        try:
            inside = os.path.commonpath([lib_abs, src_abs]) == lib_abs
        except ValueError:
            inside = False
        if inside:
            dst = os.path.join(lib_abs, new)
            try:
                os.rename(src, dst)
                renamed_file = True
            except OSError as e:
                file_err = f"模型文件重命名失败: {e}"
    # 2) 改 model 表那一行：存了 id 的图片因此自动跟随，不会再裂成两条
    if mrow:
        if not db.model_rename(mrow["id"], new_name):
            file_err = file_err or "模型表改名失败"
    else:
        db.model_upsert(mtype, new_name)
    # 3) 内存索引改展示名（纯内存，无文件 IO、无全表替换）
    for r in get_index() or []:
        if kind == "model":
            if r.get("model") in (old, base_old):
                r["model"] = new_name
                updated += 1
        else:
            ls = r.get("loras") or []
            if old in ls or base_old in ls:
                r["loras"] = [new_name if x in (old, base_old) else x for x in ls]
                updated += 1
    print(f"[ZhuleGallery] 后台重命名完成: kind={kind} {old}->{new} updated={updated} file_renamed={renamed_file}")
    _drop_detail_cache()  # 重命名会批量改写多图元数据且保留 mtime，详情缓存全部失效
    _rename_state["done"] = True
    _rename_state["updated"] = updated
    _rename_state["renamed_file"] = renamed_file
    _rename_state["error"] = file_err


_rename_lock = threading.Lock()


async def post_gallery_rename(request):
    """body: { kind: "model"|"lora", old, new } 后台批量重命名模型/LoRA：
    重命名实际模型文件，并写回所有引用该模型的图片 PNG 元数据。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    kind = (body.get("kind") or "").strip().lower()
    old = (body.get("old") or "").strip()
    new = (body.get("new") or "").strip()
    if kind not in ("model", "lora"):
        return web.json_response({"error": "kind 必须是 model 或 lora"}, status=400)
    if not old or not new:
        return web.json_response({"error": "旧名/新名不能为空"}, status=400)
    if len(old) > 512 or len(new) > 512:
        return web.json_response({"error": "名称过长"}, status=400)
    base_old = os.path.splitext(old)[0]
    base_new = os.path.splitext(new)[0]
    if base_old == base_new:
        return web.json_response({"ok": True, "updated": 0})
    # 前端只填纯名字（不含后缀），后端自动保留原扩展名
    if os.path.splitext(new)[1]:
        new_full = new
    else:
        new_full = base_new + os.path.splitext(old)[1]
    if not new_full.strip() or re.search(r'[\\/:*?"<>|]', new_full):
        return web.json_response({"error": "名称不合法"}, status=400)
    # 后台异步执行：涉及文件数未知，避免阻塞请求
    global _rename_state
    _rename_state = {"done": False, "updated": 0, "renamed_file": False, "error": None}
    asyncio.create_task(asyncio.to_thread(_do_rename_work, kind, old, new_full, base_old))
    return web.json_response({"ok": True, "async": True, "target": new_full})


async def post_gallery_rename_file(request):
    """图片原地改名：body { path, new }。

    new 为纯文件名（**不含目录与扩展名**），自动保留原扩展名。
    同步范围：磁盘文件 + 索引 key（内存列表与 zhule.db 行）+ 缩略图 + 详情缓存。

    os.rename 不改动文件内容也不更新 mtime，故列表按时间的排序位置保持不变；
    但缩略图 key 是 sha1(rel|mtime)，rel 变化会导致整个 key 改变，所以这里
    把旧缩略图直接改名为新 key——既避免残留垃圾文件，也省去一次重新解码生成。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)

    rel = (body.get("path") or "").strip()
    new = (body.get("new") or "").strip()
    if not rel:
        return web.json_response({"error": "路径不能为空"}, status=400)
    if not new:
        return web.json_response({"error": "新名称不能为空"}, status=400)
    if len(new) > 200:
        return web.json_response({"error": "名称过长"}, status=400)
    # 非法字符（含路径分隔符）：改名只允许在本目录内换名字，不能借機跨目录写
    if new in (".", "..") or new.startswith(".") or re.search(r'[\\/:*?"<>|]', new):
        return web.json_response({"error": "名称不合法"}, status=400)

    full = _safe_full(rel)
    if not full or not os.path.isfile(full):
        return web.json_response({"error": "图片不存在"}, status=404)

    _old_dir, old_name = (rel.rsplit("/", 1) if "/" in rel else ("", rel))
    old_base, ext = os.path.splitext(old_name)
    if new == old_base:
        return web.json_response({"ok": True, "unchanged": True,
                                  "path": rel, "name": old_name})

    parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
    new_rel = (parent + "/" if parent else "") + new + ext
    dst = _safe_full(new_rel)
    if not dst:
        return web.json_response({"error": "目标路径越界"}, status=400)
    if os.path.exists(dst):
        return web.json_response({"error": "同名文件已存在"}, status=409)

    try:
        old_mtime = int(os.stat(full).st_mtime)
    except OSError:
        old_mtime = 0
    try:
        os.rename(full, dst)
    except OSError as e:
        return web.json_response({"error": "改名失败: " + str(e)}, status=500)

    try:
        st = os.stat(dst)
        new_mtime, new_size = int(st.st_mtime), st.st_size
    except OSError:
        new_mtime, new_size = old_mtime, 0

    old_thumb = _thumb_path(rel, old_mtime)
    new_thumb = _thumb_path(new_rel, new_mtime)
    if os.path.isfile(old_thumb):
        try:
            if os.path.isfile(new_thumb):
                os.remove(old_thumb)
            else:
                os.rename(old_thumb, new_thumb)
        except OSError:
            pass  # 缩略图失败不影响改名结果，缺失时会按需重新生成

    new_rec = None
    index = get_index()
    for i, r in enumerate(index):
        if r.get("key") != rel:
            continue
        rec = dict(r)
        rec["key"] = new_rel
        rec["name"] = new + ext
        rec["mtime"] = new_mtime
        rec["size"] = new_size
        index[i] = rec
        new_rec = rec
        break
    if new_rec is not None:
        # 行级迁移：先按新 key 落库（tag 行随之重建），再删旧 key。
        # 记录里的 promptIds / customTags 在两种来源下都存在，标签不会丢。
        if new_rec.get("id"):
            # 只改这一行的 name：id 与 tag 行全部保留，PNG 里的 zhule_id 继续有效
            if not db.gallery_update_key(new_rec["id"], new_rel):
                print("[ZhuleGallery] 图片改名后索引写入失败: " + new_rel)
        else:
            # 没有 id 的老记录：退回按名字插新行 + 删旧行
            if not db.gallery_upsert_records([new_rec]):
                print("[ZhuleGallery] 图片改名后索引写入失败: " + new_rel)
            db.gallery_delete_records([rel])

    _drop_detail_cache()
    return web.json_response({"ok": True, "path": new_rel, "name": new + ext,
                              "oldPath": rel, "mtime": new_mtime, "size": new_size})


# ---------------------------------------------------------------------------
def _extract_ref_id(raw):
    """从模型类元数据取 id：新格式是 {"id":..,"n":..} 对象，老格式是纯名字（返回 None）。"""
    s = (raw or "").strip()
    if not s.startswith("{"):
        return None
    try:
        obj = json.loads(s)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    try:
        return int(obj.get("id"))
    except (TypeError, ValueError):
        return None


def _make_record(rel, full):
    """按 build_index 同款字段逻辑构造单条索引记录（只处理一张图）。"""
    st = os.stat(full)
    texts = png_text.read_png_text(full)
    model = _extract_zhule_model(texts)
    loras = _json_list(texts.get("zhule_loras"), "zhule_loras")
    # 图片自身身份：PNG 里存的 gallery 行 id（新图由 save_image 写入）。
    # 有它，图片文件被改名后仍能认回同一行，不会当成新图另起一行。
    self_id = None
    _sid = (texts.get("zhule_id") or "").strip()
    if _sid.isdigit():
        self_id = int(_sid)
    # 模型 id：新格式是 {"id":..,"n":..} 对象；老图只有名字就按名字查表
    model_id = _extract_ref_id(texts.get("zhule_model"))
    if not model_id and model:
        _r = db.model_lookup(db.MODEL_TYPE_MODEL, model)
        model_id = _r["id"] if _r else None
    # LoRA id：zhule_loras 新格式是 {"id":..,"n":..} 对象数组，直接取 id；
    # 老格式纯名字按名查表兜底。lora_ids 缺失曾导致 _make_record 抛 NameError，
    # 新图 index_new 被静默吞掉、图库只留 mtime=0 的空行。
    lora_ids = []
    try:
        _lo = json.loads(texts.get("zhule_loras") or "[]")
        if isinstance(_lo, list):
            for x in _lo:
                if isinstance(x, dict):
                    _lid = x.get("id")
                    if _lid is not None:
                        try:
                            lora_ids.append(int(_lid))
                        except (TypeError, ValueError):
                            pass
                        continue
                    _ln = str(x.get("n") or x.get("name") or "").strip()
                else:
                    _ln = str(x).strip()
                if _ln:
                    _r = db.model_lookup(db.MODEL_TYPE_LORA, _ln)
                    if _r and _r.get("id"):
                        lora_ids.append(_r["id"])
    except Exception:
        pass
    # 落库只存正面提示词文本：整份 workflow/prompt JSON 由详情接口实时读 PNG，不落库
    _pp = _extract_positive_prompt(texts.get("prompt")) or ""
    # 提示词标签按词条 id 传递；纯解析，不写回 PNG
    pids, custom_tags, pt_names = _parse_record_tags(texts)
    # id -> 显示名：词条改名后展示名实时跟着变，标签不脱钩。
    # 词条被删（按 id 查不到）时用 PNG 里自带的默认名兜底
    tag_ids = {}
    for _i in pids:
        _n = _tag_name(_i) or pt_names.get(str(_i)) or ""
        if _n:
            tag_ids[_n] = _i
    # 展示顺序：提示词标签（词库词条）在前，自定义标签在后
    tags = [n for n in tag_ids if n not in custom_tags] + list(custom_tags)
    rec = {
        "key": rel,
        "name": os.path.basename(full),
        "mtime": int(st.st_mtime),
        "size": st.st_size,
        "id": self_id,
        "model": model,
        "modelId": model_id,
        "loras": loras,
        "loraIds": lora_ids,
        "tags": tags,
        "tagIds": tag_ids,
        "customTags": list(custom_tags),
        "promptIds": pids,
        "hasWF": bool(texts.get("workflow")),
        "hasPrompt": bool(_pp),
        "prompt": _pp,
    }
    return rec


def _write_index_cache():
    """全量写回 zhule.db 图库表（gallery_image / gallery_tag）。

    内存内部格式（tags 为 name 字符串数组 + tagIds）直接交给 DB 层：
    prompt 类标签按词库显示名反查 id 落 prompt_id 外键；custom 类标签按
    custom_tag 字典反查/插入落 custom_id 外键。
    """
    try:
        return db.gallery_save_records(_index)
    except Exception as e:
        print(f"[ZhuleGallery] 索引缓存写入失败（zhule.db 图库表）: {e}")
        return False


def index_new(pairs):
    """保存节点写入新图后直接入库：pairs = [(rel, full), ...]。

    图库索引由「写入点」维护——SaveImage 入库 / 删图 / 打标各自直接写库，
    不再有守护线程轮询磁盘。本函数只 upsert 传入的这几条，不做全表替换。
    内存索引未加载时跳过（下次打开图库页会从 DB 读到最新数据）。
    返回入库条数。
    """
    global _index, _index_rev
    recs = []
    for rel, full in pairs or []:
        try:
            recs.append(_make_record(rel, full))
        except Exception as e:
            print(f"[ZhuleGallery] index_new 跳过 {rel}: {e}")
            continue
    if not recs:
        return 0
    db.gallery_upsert_records(recs)
    if _index is not None:
        for rec in recs:
            for i, r in enumerate(_index):
                if r.get("key") == rec["key"]:
                    _index[i] = rec
                    break
            else:
                _index.append(rec)
        _index.sort(key=lambda r: r["mtime"], reverse=True)
        _index_rev += 1
    return len(recs)


_warmup_started = False


def warmup_tag_caches():
    """后台预热图库详情依赖的标签翻译索引与标签树。

    _tag_cn_index()/_tag_en_index() 首次调用会全量 os.walk 词库目录构建映射
    （实测各约 1.5s/1.7s），get_gallery_detail 未命中缓存时会对每张图逐个 tag
    调用 _tag_cn/_tag_en。在插件路由注册阶段后台预热这两个索引，使首次点击
    图库图片时命中内存缓存，将首点延迟从秒级降到毫秒级。
    失败静默，不阻塞插件启动。
    """
    try:
        _tag_cn_index()
        _tag_en_index()
        get_tag_tree()
    except Exception:
        pass


def start_warmup():
    """启动后台预热线程（幂等，可重复调用）。"""
    global _warmup_started
    if _warmup_started:
        return
    _warmup_started = True
    threading.Thread(target=warmup_tag_caches, daemon=True, name="zhule-gallery-warmup").start()
    print("[ZhuleGallery] 标签索引后台预热已启动")
