"""Zhule Gallery 后端：图片索引、聚合元数据、缩略图缓存、打标（写 PNG 元数据）。

数据模型（与 ZhuleSaveImage v2 / 图库字段化架构一致）：
- 图片元数据存在 PNG tEXt chunk：zhule_model / zhule_loras / zhule_tags / zhule_prompt_tags /
  zhule_custom_tags / prompt / workflow
- 标签三类分源：
  * zhule_tags：图库详情页手动打标（可增删）
  * zhule_prompt_tags：ZhuleStudio 提示词选中词（保存时写入，图库只读）
  * zhule_custom_tags：工作流自定义 tag（SaveImage tags 端口写入，图库只读）
- 图库根目录：output/zhule_studio/zhule_img（只扫这一个目录，历史旧目录一律忽略）
- 索引：启动/刷新时扫描图库根目录读取元数据，json 缓存到本模块 gallery/index.json
- 用户自定义 tag 分组：gallery/meta.json
- 打标：写 PNG tEXt chunk（不重编码像素），保留原 mtime

索引记录：
  key: 相对图库根目录的 posix 路径（唯一）
  mtime/size/name/model/loras/tags/hasWF/hasPrompt
  tags 为三源合并（供筛选/搜索）；详情接口按来源分开返回
"""
import asyncio
import hashlib
import json
import os
import re
import threading
import time
import shutil

import folder_paths
from aiohttp import web

from . import png_text
from .api import WORD_BANK_ROOT, parse_folder, _path_sort_key
from ..common.paths import _get_output_dir

GALLERY_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_FILE = os.path.join(GALLERY_DIR, "gallery", "index.json")
META_FILE = os.path.join(GALLERY_DIR, "gallery", "meta.json")
STUDIO_SUBDIR = "zhule_studio"  # output 下统一收纳目录：zhule_img / zhule_thumbs / zhule_link
SCHEMA_VERSION = 3  # 图库数据迁入 output/zhule_studio 下

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

def _default_meta():
    return {"tags": [], "updatedAt": ""}


def load_meta():
    try:
        with open(META_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("tags"), list):
            return data
    except Exception:
        pass
    return _default_meta()


def save_meta(meta):
    os.makedirs(os.path.dirname(META_FILE), exist_ok=True)
    meta["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    tmp = META_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    os.replace(tmp, META_FILE)


def _tag_groups(meta):
    """name -> group 映射。"""
    return {t.get("name"): t.get("group") or "其他" for t in meta.get("tags", []) if t.get("name")}


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
    """解析 JSON 数组字符串；失败返回 []。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
    except Exception:
        pass
    return []


def _clean_prompt_tags(tags):
    """清洗提示词标签：剔除伪标签，兼容历史错误写入的整段提示词。

    正常词条名来自词库词条文件名/最后一级目录名；整段正向提示词（按逗号或段落
    误拆）表现为：超长、含换行、或含多个逗号且长度明显大于词条名。"""
    if not tags:
        return []
    out = []
    for t in tags:
        s = str(t).strip()
        if not s:
            continue
        if len(s) > 100:
            continue
        if "\n" in s or "\r" in s:
            continue
        if s.count(",") >= 2 and len(s) > 40:
            continue
        out.append(s)
    return out


def _split_tags(raw):
    """解析标签输入：JSON 数组字符串；失败则按行拆分（与 save_image._parse_tags 语义一致）。"""
    if not raw:
        return []
    s = str(raw).strip()
    if not s:
        return []
    try:
        data = json.loads(s)
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
        if isinstance(data, str) and data.strip():
            return [data.strip()]
    except Exception:
        pass
    return [line.strip() for line in s.splitlines() if line.strip()]


def _merge_tag_sources(texts):
    """合并三源标签（手动优先），去重保持顺序，返回字符串数组（索引/筛选用）。"""
    manual = _json_list(texts.get("zhule_tags"), "zhule_tags")
    prompt = _clean_prompt_tags(_json_list(texts.get("zhule_prompt_tags"), "zhule_prompt_tags"))
    custom = _json_list(texts.get("zhule_custom_tags"), "zhule_custom_tags")
    seen = set()
    merged = []
    for n in manual + prompt + custom:
        if n not in seen:
            seen.add(n)
            merged.append(n)
    return merged


def _extract_selected_names(pt):
    """从 PNG 内 prompt JSON 提取 ZhuleStudio 选中词 name 数组（提示词标签来源）。"""
    if not pt:
        return []
    try:
        prompt = json.loads(pt)
    except Exception:
        return []
    if not isinstance(prompt, dict):
        return []
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == "ZhuleStudio":
            try:
                sel = json.loads((node.get("inputs") or {}).get("_selected", "[]") or "[]")
            except Exception:
                sel = []
            if not isinstance(sel, list):
                return []
            # 兼容：网页经 state 文件驱动时 widget _selected 恒为 "[]"，PNG 元数据丢失词条。
            # 用ID从 state 文件兜底读取（与 ZhuleStudio 节点运行逻辑一致）。
            if not sel:
                try:
                    from .state_store import load_state
                    payload = load_state(str((node.get("inputs") or {}).get("ID") or ""))
                    sel = (payload or {}).get("data", {}).get("selected") or []
                except Exception:
                    sel = []
            names = []
            for s in sel:
                if isinstance(s, dict):
                    # 新格式 [{name, content}]：取词条名
                    n = str(s.get("name") or "").strip()
                    if n:
                        names.append(n)
                else:
                    # 旧格式纯字符串：原样保留
                    t = str(s).strip()
                    if t:
                        names.append(t)
            return names
    return []


def _extract_save_tags(pt):
    """从 PNG 内 prompt JSON 提取 ZhuleSaveImage 节点 自定义标签 端口值（自定义 tag 回填来源）。
    兼容新旧端口名：新图端口为 自定义标签，旧图为 自定义tags / tags。"""
    if not pt:
        return []
    try:
        prompt = json.loads(pt)
    except Exception:
        return []
    if not isinstance(prompt, dict):
        return []
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == "ZhuleSaveImage":
            inputs = node.get("inputs") or {}
            raw = inputs.get("自定义标签") or inputs.get("自定义tags") or inputs.get("tags")
            if raw:
                return _split_tags(raw)
    return []


def _extract_zhule_model(texts):
    """提取模型名：优先 zhule_model 元数据；缺失时从 prompt 元数据兜底（兼容 ZhuleCheckpointLoader 等复合模型旧图）。"""
    m = (texts.get("zhule_model") or "").strip()
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


def _backfill_tag_fields(full, texts):
    """存量迁移：从 prompt 元数据回填只读标签字段，并把手动标签中重复项移除。

    仅当 zhule_prompt_tags / zhule_custom_tags 均为空、且 PNG 内带 prompt 元数据时执行
    （早期保存节点未写入标签字段，从 prompt 的 ZhuleStudio 选中词快照回填只读标签，
    供图库筛选使用）；同时剔除手动标签 zhule_tags 中与回填结果重复的项。
    返回 (prompt_tags, custom_tags, manual_tags)。
    """
    prompt_tags = _clean_prompt_tags(_json_list(texts.get("zhule_prompt_tags"), "zhule_prompt_tags"))
    custom_tags = _json_list(texts.get("zhule_custom_tags"), "zhule_custom_tags")
    manual = _json_list(texts.get("zhule_tags"), "zhule_tags")
    if not prompt_tags and not custom_tags and texts.get("prompt"):
        sel = _extract_selected_names(texts.get("prompt"))
        if sel:
            prompt_tags = sel
        custom = _extract_save_tags(texts.get("prompt"))
        if custom:
            custom_tags = custom
    keep = [t for t in manual if t not in prompt_tags and t not in custom_tags]
    updates = {}
    if prompt_tags:
        updates["zhule_prompt_tags"] = json.dumps(prompt_tags, ensure_ascii=False)
    if custom_tags:
        updates["zhule_custom_tags"] = json.dumps(custom_tags, ensure_ascii=False)
    if len(keep) != len(manual):
        updates["zhule_tags"] = json.dumps(keep, ensure_ascii=False)
    if updates and not png_text.write_png_text(full, updates):
        print(f"[ZhuleGallery] 标签字段迁移失败: {full}")
    return prompt_tags, custom_tags, keep


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
    # 兼容：网页经 state 文件驱动时 widget _selected 恒为 "[]"，PNG 元数据丢失词条。
    # 用ID从 state 文件兜底读取（与 ZhuleStudio 节点运行逻辑一致），
    # 使旧图也能还原完整提示词。
    if not isinstance(data, list) or not data:
        try:
            from .state_store import load_state
        except Exception:
            load_state = None
        if load_state is not None:
            try:
                payload = load_state(str(inputs.get("ID") or ""))
                sel = (payload or {}).get("data", {}).get("selected")
                if isinstance(sel, list):
                    data = [s for s in sel if isinstance(s, dict) and s.get("content")]
            except Exception:
                data = None
    parts = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                # 与 ZhuleStudio 节点运行逻辑一致：取 content（真实提示词文本）
                c = str(item.get("content") or "").strip()
                if c:
                    parts.append(c)
            else:
                t = str(item).strip()
                if t:
                    parts.append(t)
    selected = ", ".join(parts).strip()
    if pre and selected:
        return pre + ", " + selected
    return pre or selected or None


def build_index(force=False):
    """全量重建索引（只扫 zhule_image）。返回索引列表。"""
    global _index, _index_built_at, _index_rev
    root = _gallery_root()
    meta = load_meta()
    groups = _tag_groups(meta)
    records = []
    for rel, full in _scan_images(root):
        try:
            st = os.stat(full)
        except OSError:
            continue
        texts = png_text.read_png_text(full)
        model = _extract_zhule_model(texts)
        loras = _json_list(texts.get("zhule_loras"), "zhule_loras")
        # 存量迁移 + 三源合并（手动优先，供筛选/搜索）
        _pt, _ct, _mt = _backfill_tag_fields(full, texts)
        tags = _mt + [t for t in (_pt + _ct) if t not in _mt]
        wf = texts.get("workflow")
        pt = texts.get("prompt")
        records.append({
            "key": rel,
            "name": os.path.basename(full),
            "mtime": int(st.st_mtime),
            "size": st.st_size,
            "model": model,
            "loras": loras,
            "tags": tags,
            "hasWF": bool(wf),
            "hasPrompt": bool(pt),
            "tg": [groups.get(t, "其他") for t in tags],
        })
    # 按时间倒序缓存
    records.sort(key=lambda r: r["mtime"], reverse=True)
    _index = records
    _index_rev += 1
    _index_built_at = time.time()
    try:
        os.makedirs(os.path.dirname(INDEX_FILE), exist_ok=True)
        payload = {"schema": SCHEMA_VERSION, "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "count": len(records), "records": records}
        with _rename_lock:
            tmp = INDEX_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, INDEX_FILE)
    except Exception as e:
        print(f"[ZhuleGallery] 索引缓存写入失败: {e}")
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

    索引来源仅两种：
    1. 守护线程 incremental_sync 增量同步（日常主力，覆盖增删改）；
    2. 手动 rescan（设置面板『重建索引』按钮，全量遍历唯一入口）。
    index.json 缺失/损坏/schema 不符时**不自动全量重建**——全量遍历属大范围操作，
    只允许人工手动触发，此处返回空列表并提示用户手动重建。
    """
    global _index, _index_rev
    if _index is None:
        # 尝试从缓存加载
        try:
            with open(INDEX_FILE, "r", encoding="utf-8") as f:
                payload = json.load(f)
            if payload.get("schema") == SCHEMA_VERSION and isinstance(payload.get("records"), list):
                _index = payload["records"]
                _index_rev += 1
        except Exception:
            _index = None
        if _index is None:
            print("[ZhuleGallery] 索引缺失/损坏，跳过自动重建：请在设置面板手动点击『重建索引』")
            return []
    return _index


def get_tag_ref_index():
    """tag -> [带 zhule_img/ 前缀的相对 output 路径] 反向引用索引（词库参考图数据源）。

    以内存 _index 为唯一事实源（守护线程增量同步维护其正确性），一次遍历构建
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
    meta = load_meta()
    groups = _tag_groups(meta)
    tags = [{"name": n, "count": c, "group": groups.get(n, "其他")}
            for n, c in tag_count.items()]
    # meta 中用户自定义但未使用的 tag 也展示
    for t in meta.get("tags", []):
        n = t.get("name")
        if n and n not in tag_count:
            tags.append({"name": n, "count": 0, "group": groups.get(n, "其他")})
    tags.sort(key=lambda x: (x["group"], -x["count"], x["name"]))
    models = [{"name": n, "count": c} for n, c in sorted(model_count.items())]
    loras = [{"name": n, "count": c} for n, c in sorted(lora_count.items())]
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
# 词库目录结构与 api.py 卡片判定保持一致：
#   顶层 = Tab 目录；中间层 = 普通子目录；卡片层 = 词条（叶子）。
# 判定叶子：目录含 prompt.txt，或目录无子目录且恰有一个非系统 txt（文件夹卡片）；
#   其余散 txt 单独成叶。
_TREE_TTL = 30
_tree_cache = {"ts": 0.0, "sig": None, "tree": None, "anc": None}
_TREE_SKIP = {"__pycache__"}


# ==================== 标签树排序（编号即顺序） ====================

def _within_bank(rel):
    """rel（相对词库根）是否位于词库目录内，防路径穿越。"""
    base = os.path.realpath(WORD_BANK_ROOT)
    full = os.path.realpath(os.path.join(base, rel))
    try:
        return os.path.commonpath([base, full]) == base
    except ValueError:
        return False


def _dir_sort_key(name):
    """按文件夹前缀编号排序：有编号在前按数字（去零），无编号在后按名称。"""
    num, disp = parse_folder(name)
    return (0 if num > 0 else 1, num, disp.lower(), disp)


def _tree_sig():
    """轻量目录签名：词库根目录与直接子项（tab）的 mtime/size。"""
    parts = []
    try:
        parts.append(str(os.stat(WORD_BANK_ROOT).st_mtime))
        for name in sorted(os.listdir(WORD_BANK_ROOT)):
            p = os.path.join(WORD_BANK_ROOT, name)
            try:
                st = os.stat(p)
                parts.append(f"{name}:{int(st.st_mtime)}:{st.st_size}")
            except OSError:
                pass
    except OSError:
        pass
    return "|".join(parts)


def _tree_leaf_dir(dirpath):
    """目录是否为词条（卡片）层：含 prompt.txt，或无子目录且恰有一个非系统 txt。"""
    try:
        entries = list(os.scandir(dirpath))
    except OSError:
        return True
    files = [e for e in entries if e.is_file(follow_symlinks=False)]
    dirs = [e for e in entries if e.is_dir(follow_symlinks=False)]
    for f in files:
        if f.name == "prompt.txt":
            return True
    if not dirs:
        txts = [f for f in files if f.name.lower().endswith(".txt")
                and f.name not in ("prompt_cn.txt", "images.txt")]
        if len(txts) == 1:
            return True
    return False


def _build_tag_tree():
    """扫描词库目录，返回 (tree, ancestors)。
    tree: [{name, rel, depth, leaf, children}]（顶层为 tab）
    ancestors: name -> tuple(祖先显示名)（不含自身；仅记录有目录归属的节点）
    """
    tree = []
    anc = {}

    def walk(dirpath, depth, anc_names):
        nodes = []
        parent_rel = os.path.relpath(dirpath, WORD_BANK_ROOT).replace(os.sep, "/")
        if parent_rel == ".":
            parent_rel = ""
        try:
            entries = sorted(os.scandir(dirpath), key=lambda e: _dir_sort_key(e.name))
        except OSError:
            return nodes
        for e in entries:
            if e.name.startswith(".") or e.name in _TREE_SKIP:
                continue
            if e.name in ("prompt.txt", "prompt_cn.txt", "images.txt"):
                continue
            if e.is_dir(follow_symlinks=False):
                _, disp = parse_folder(e.name)
                rel = os.path.relpath(e.path, WORD_BANK_ROOT).replace(os.sep, "/")
                children = walk(e.path, depth + 1, anc_names + [disp])
                leaf = _tree_leaf_dir(e.path)
                node = {"name": disp, "rel": rel, "depth": depth,
                        "leaf": leaf, "children": children if not leaf else []}
                nodes.append(node)
                if anc_names:
                    anc[disp] = tuple(anc_names)
            elif e.name.lower().endswith(".txt"):
                stem = os.path.splitext(e.name)[0]
                _, disp = parse_folder(stem)
                rel = os.path.relpath(e.path, WORD_BANK_ROOT).replace(os.sep, "/")
                node = {"name": disp, "rel": rel, "depth": depth,
                        "leaf": True, "children": []}
                nodes.append(node)
                if anc_names:
                    anc[disp] = tuple(anc_names)
        return nodes

    if os.path.isdir(WORD_BANK_ROOT):
        tree = walk(WORD_BANK_ROOT, 0, [])
    return tree, anc


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


def _tag_hit(tag, rec_tags, anc):
    """标签命中：直接匹配 或 图片某直接 tag 的祖先归属包含该标签。"""
    if tag in rec_tags:
        return True
    if anc:
        for rt in rec_tags:
            if tag in anc.get(rt, ()):
                return True
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
    """
    best = None
    for rt in rec_tags:
        if rt == tag or tag in anc.get(rt, ()):
            rel = rel_map.get(rt)
            if rel and (best is None or rel.count("/") > best.count("/")):
                best = rel
    return best or ""


def _matches(rec, tags, models, loras, q, anc=None, tag_mode="and"):
    if tags:
        rec_tags = set(rec.get("tags", []))
        if anc is None:
            _, anc = get_tag_tree()
        hits = [_tag_hit(t, rec_tags, anc) for t in tags]
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

async def get_gallery(request):
    """列表：?page=&pageSize=&sort=&q=&tags=&models=&loras="""
    records = get_index()
    try:
        page = max(1, int(request.query.get("page", 1)))
    except ValueError:
        page = 1
    try:
        page_size = min(200, max(1, int(request.query.get("pageSize", 60))))
    except ValueError:
        page_size = 60
    sort = request.query.get("sort", "time_desc")
    q = (request.query.get("q") or "").strip()
    tags = _split_csv(request.query.get("tags"))
    models = _split_csv(request.query.get("models"))
    loras = _split_csv(request.query.get("loras"))
    tag_mode = (request.query.get("mode") or "and").strip().lower()
    if tag_mode not in ("and", "or"):
        tag_mode = "and"

    _, anc = get_tag_tree()
    filtered = [r for r in records if _matches(r, tags, models, loras, q, anc, tag_mode)]
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
            keyf = lambda r: _path_sort_key(_deepest_tag_rel(r.get("tags", []), tags[0], anc, rel_map))
        else:
            keyf = lambda r: _path_sort_key(r.get("key", ""))
        filtered.sort(key=keyf, reverse=(sort == "dir_desc"))
    else:
        filtered.sort(key=lambda r: r["mtime"], reverse=True)

    total = len(filtered)
    start = (page - 1) * page_size
    items = filtered[start:start + page_size]
    return web.json_response({
        "total": total, "page": page, "pageSize": page_size,
        "items": items, "builtAt": _index_built_at,
        "building": _index_building,
    })


async def get_gallery_meta(request):
    get_index()
    data = aggregate(_index or [])
    data["building"] = _index_building
    return web.json_response(data)


async def get_gallery_tagtree(request):
    """标签层级树：基于词库 prompt 目录的目录结构（顶层=Tab，叶子=词条）。"""
    tree, _ = get_tag_tree()
    return web.json_response({
        "tree": tree,
        "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    })


async def post_gallery_tagtree_order(request):
    """按拖拽后的新顺序重命名该层目录（编号即顺序，目录名写入连续编号）。
    body: {"parent": str, "rels": [str,...]}，parent 为该层父节点 rel（顶层为 ""）。
    重命名采用两阶段防冲突：先全部转为临时名，再按新序写回连续编号。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "无效的 JSON"}, status=400)
    parent = (body.get("parent") or "").strip().replace("\\", "/")
    rels = body.get("rels")
    if not isinstance(rels, list):
        return web.json_response({"ok": False, "error": "rels 必须为数组"}, status=400)
    clean = []
    seen = set()
    for r in rels:
        if isinstance(r, str):
            r = r.strip().replace("\\", "/")
            if r and r not in seen and _within_bank(r):
                clean.append(r)
                seen.add(r)
    # 定位目标层目录
    if parent:
        if not _within_bank(parent):
            return web.json_response({"ok": False, "error": "parent 越界"}, status=400)
        base = os.path.realpath(os.path.join(WORD_BANK_ROOT, parent))
    else:
        base = os.path.realpath(WORD_BANK_ROOT)
    if not os.path.isdir(base):
        return web.json_response({"ok": False, "error": "目录不存在"}, status=404)
    try:
        _renumber_layer(base, clean)
    except OSError as e:
        return web.json_response({"ok": False, "error": f"重命名失败: {e}"}, status=500)
    # 编号/排序变化立即生效：清空标签树缓存
    _tree_cache.update({"ts": 0.0, "sig": None, "tree": None, "anc": None})
    return web.json_response({"ok": True, "parent": parent, "count": len(clean)})


def _renumber_layer(base, rels):
    """按 rels 顺序重命名 base 下的子目录，生成连续编号（两阶段防冲突）。
    rels 为前端新顺序（该层全部节点 rel，含 txt 散卡片）。只重命名目录，
    txt 散卡片保持原名（无编号时排序靠后）。子目录若不在 rels 中，按名称序补到末尾。
    """
    dirs = []
    for e in os.scandir(base):
        if e.is_dir(follow_symlinks=False) and not e.name.startswith("."):
            dirs.append(e.name)
    if not dirs:
        return
    dirs.sort(key=_dir_sort_key)
    # 按 rels 顺序排列（只取目录项），其余补末尾
    ordered = []
    seen = set()
    for r in rels:
        name = os.path.basename(r)
        if name in dirs and name not in seen:
            ordered.append(name)
            seen.add(name)
    for n in dirs:
        if n not in seen:
            ordered.append(n)
    # 阶段1：全部转临时名，避免目标名冲突
    tmp_names = []
    for i, n in enumerate(ordered):
        tmp = os.path.join(base, f".__zhule_ren_{i:04d}")
        os.rename(os.path.join(base, n), tmp)
        tmp_names.append((tmp, n))
    # 阶段2：按新序写回连续编号（与 display name 拼接）
    for idx, (tmp, n) in enumerate(tmp_names, start=1):
        _, disp = parse_folder(n)
        new_name = f"{idx:02d}_{disp}"
        os.rename(tmp, os.path.join(base, new_name))


async def get_gallery_detail(request):
    """单图详情：完整 PNG 元数据（workflow/prompt 只回存在标志与预览）。"""
    rel = (request.query.get("path") or "").strip()
    full = _safe_full(rel)
    if not full or not os.path.isfile(full):
        return web.json_response({"error": "文件不存在"}, status=404)
    texts = png_text.read_png_text(full)
    wf = texts.get("workflow") or ""
    pt = texts.get("prompt") or ""
    st = os.stat(full)
    # 三源标签按来源标记：手动可增删，提示词/自定义只读
    manual = _json_list(texts.get("zhule_tags"), "zhule_tags")
    prompt = _clean_prompt_tags(_json_list(texts.get("zhule_prompt_tags"), "zhule_prompt_tags"))
    custom = _json_list(texts.get("zhule_custom_tags"), "zhule_custom_tags")
    seen = set()
    tags = []
    for n in manual:
        tags.append({"name": n, "prompt": False, "custom": False})
        seen.add(n)
    for n in prompt:
        if n not in seen:
            tags.append({"name": n, "prompt": True, "custom": False})
            seen.add(n)
    for n in custom:
        if n not in seen:
            tags.append({"name": n, "prompt": False, "custom": True})
            seen.add(n)
    return web.json_response({
        "path": rel,
        "name": os.path.basename(full),
        "mtime": int(st.st_mtime),
        "size": st.st_size,
        "model": _extract_zhule_model(texts),
        "loras": _json_list(texts.get("zhule_loras"), "zhule_loras"),
        "tags": tags,
        "hasWF": bool(wf),
        "workflowSize": len(wf),
        "hasPrompt": bool(pt),
        "promptPreview": _extract_positive_prompt(pt) or pt[:MAX_WORKFLOW_PREVIEW],
    })


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
        return web.json_response({"error": f"删除失败: {e}"}, status=500)

    # 刷新内存索引与索引缓存
    global _index, _index_rev
    if _index is not None:
        _index = [r for r in _index if r.get("key") != rel]
        _index_rev += 1
        try:
            with open(INDEX_FILE, "r", encoding="utf-8") as f:
                payload = json.load(f)
            payload["records"] = _index
            payload["count"] = len(_index or [])
            payload["builtAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            tmp = INDEX_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, INDEX_FILE)
        except Exception as e:
            print(f"[ZhuleGallery] 索引缓存写入失败: {e}")

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
                deleted.append(rel)
            except OSError as e:
                failed.append({"path": rel, "error": f"删除失败: {e}"})
        except Exception as e:
            failed.append({"path": rel, "error": f"删除异常: {e}"})

    # 刷新内存索引与索引缓存
    global _index, _index_rev
    delset = set(deleted)
    if _index is not None:
        _index = [r for r in _index if r.get("key") not in delset]
        _index_rev += 1
    try:
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            payload = json.load(f)
        recs = payload.get("records")
        if isinstance(recs, list):
            payload["records"] = [r for r in recs if r.get("key") not in delset]
            payload["count"] = len(payload["records"])
            payload["builtAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            tmp = INDEX_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, INDEX_FILE)
    except Exception as e:
        print(f"[ZhuleGallery] 索引缓存写入失败: {e}")

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


async def post_gallery_tag(request):
    """body: { name, group } 创建 tag（含分组）。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    name = (body.get("name") or "").strip()
    group = (body.get("group") or "其他").strip() or "其他"
    if not name:
        return web.json_response({"error": "标签名不能为空"}, status=400)
    if len(name) > 60 or len(group) > 30:
        return web.json_response({"error": "名称过长"}, status=400)
    meta = load_meta()
    for t in meta["tags"]:
        if t.get("name") == name:
            t["group"] = group
            save_meta(meta)
            return web.json_response({"ok": True, "created": False})
    meta["tags"].append({"name": name, "group": group})
    save_meta(meta)
    return web.json_response({"ok": True, "created": True})


async def post_gallery_annotate(request):
    """body: { path, tags?: [str] } 打标（写 PNG 元数据）。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON 解析失败"}, status=400)
    rel = (body.get("path") or "").strip()
    full = _safe_full(rel)
    if not full or not os.path.isfile(full):
        return web.json_response({"error": "文件不存在"}, status=404)

    updates = {}
    if "tags" in body:
        tags = body.get("tags")
        if not isinstance(tags, list):
            return web.json_response({"error": "tags 必须是数组"}, status=400)
        clean = [str(x).strip() for x in tags if str(x).strip()]
        if len(clean) > 100:
            return web.json_response({"error": "标签过多"}, status=400)
        updates["zhule_tags"] = json.dumps(clean, ensure_ascii=False)
    if not updates:
        return web.json_response({"error": "没有可更新字段"}, status=400)

    if not png_text.write_png_text(full, updates):
        return web.json_response({"error": "PNG 元数据写入失败"}, status=500)

    # 更新内存索引与索引缓存
    global _index
    if _index is not None:
        texts = png_text.read_png_text(full)
        for r in _index:
            if r.get("key") == rel:
                r["model"] = _extract_zhule_model(texts)
                r["loras"] = _json_list(texts.get("zhule_loras"), "zhule_loras")
                r["tags"] = _merge_tag_sources(texts)
                meta = load_meta()
                groups = _tag_groups(meta)
                r["tg"] = [groups.get(t, "其他") for t in r["tags"]]
                break
    # 更新缓存文件（仅当索引文件存在时）
    try:
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            payload = json.load(f)
        recs = payload.get("records")
        if isinstance(recs, list):
            texts = png_text.read_png_text(full)
            for r in recs:
                if r.get("key") == rel:
                    r["model"] = _extract_zhule_model(texts)
                    r["loras"] = _json_list(texts.get("zhule_loras"), "zhule_loras")
                    r["tags"] = _merge_tag_sources(texts)
                    meta = load_meta()
                    groups = _tag_groups(meta)
                    r["tg"] = [groups.get(t, "其他") for t in r["tags"]]
                    break
            tmp = INDEX_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, INDEX_FILE)
    except Exception:
        pass

    return web.json_response({"ok": True})


_rename_state = {"done": False, "updated": 0, "renamed_file": False, "error": None}


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
    """后台执行：重命名模型文件 + 批量更新引用该模型的图片 PNG 元数据与索引。

    old：原名（可带后缀）；new：新全名（后端已补后缀）；base_old：原名去后缀。
    """
    records = get_index()
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
    # 2) 批量更新图片 PNG 元数据（文件数未知，可能较多，放在后台线程执行）
    for r in records:
        rel = r.get("key")
        full = _safe_full(rel)
        if not full or not os.path.isfile(full):
            continue
        texts = png_text.read_png_text(full)
        updates = {}
        if kind == "model":
            cur = _extract_zhule_model(texts)
            if cur and (cur == old or (base_old and os.path.splitext(cur)[0] == base_old)):
                updates["zhule_model"] = new
        else:
            loras = _json_list(texts.get("zhule_loras"), "zhule_loras")
            hit = False
            new_loras = []
            seen = set()
            for l in loras:
                l2 = new if (l == old or (base_old and os.path.splitext(l)[0] == base_old)) else l
                if l2 not in seen:
                    seen.add(l2)
                    new_loras.append(l2)
                if l2 != l:
                    hit = True
            if hit:
                updates["zhule_loras"] = json.dumps(new_loras, ensure_ascii=False)
        if not updates:
            continue
        if not png_text.write_png_text(full, updates):
            file_err = file_err or f"PNG 元数据写入失败: {rel}"
            continue
        updated += 1
        if kind == "model":
            r["model"] = new
        else:
            r["loras"] = _json_list(updates["zhule_loras"], "zhule_loras")
    # 3) 写回索引缓存（防并发覆盖）
    try:
        with _rename_lock:
            with open(INDEX_FILE, "r", encoding="utf-8") as f:
                payload = json.load(f)
            payload["records"] = records
            payload["count"] = len(records)
            payload["builtAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            tmp = INDEX_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, INDEX_FILE)
    except Exception as e:
        print(f"[ZhuleGallery] 后台重命名索引缓存写入失败: {e}")
    print(f"[ZhuleGallery] 后台重命名完成: kind={kind} {old}->{new} updated={updated} file_renamed={renamed_file}")
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


# ---------------------------------------------------------------------------
# 实时同步：守护线程专门维护索引，增量对比磁盘与索引，覆盖保存/删除/改 tag 及一切外部改动
# ---------------------------------------------------------------------------
_sync_lock = threading.Lock()
_sync_watcher_started = False


def _disk_scan(root):
    """轻量扫描图库根目录：文件名 -> (size, mtime)。不读 PNG 元数据，毫秒级。"""
    disk = {}
    try:
        with os.scandir(root) as it:
            for e in it:
                try:
                    if e.is_file():
                        st = e.stat()
                        disk[e.name] = (st.st_size, int(st.st_mtime))
                except OSError:
                    continue
    except OSError:
        pass
    return disk


def _make_record(rel, full):
    """按 build_index 同款字段逻辑构造单条索引记录（只处理一张图）。"""
    st = os.stat(full)
    texts = png_text.read_png_text(full)
    model = _extract_zhule_model(texts)
    loras = _json_list(texts.get("zhule_loras"), "zhule_loras")
    _pt, _ct, _mt = _backfill_tag_fields(full, texts)
    tags = _mt + [t for t in (_pt + _ct) if t not in _mt]
    groups = _tag_groups(load_meta())
    return {
        "key": rel,
        "name": os.path.basename(full),
        "mtime": int(st.st_mtime),
        "size": st.st_size,
        "model": model,
        "loras": loras,
        "tags": tags,
        "hasWF": bool(texts.get("workflow")),
        "hasPrompt": bool(texts.get("prompt")),
        "tg": [groups.get(t, "其他") for t in tags],
    }


def _load_index_cache():
    """从 index.json 加载缓存索引到内存（守护线程惰性启动时用）。"""
    global _index, _index_rev
    try:
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            payload = json.load(f)
        if isinstance(payload.get("records"), list) and payload.get("schema") == SCHEMA_VERSION:
            _index = payload["records"]
            _index_rev += 1
            return True
    except Exception:
        pass
    return False


def _write_index_cache():
    """原子写回 index.json（.tmp + os.replace，与 build_index 同款）。"""
    try:
        os.makedirs(os.path.dirname(INDEX_FILE), exist_ok=True)
        payload = {"schema": SCHEMA_VERSION,
                   "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "count": len(_index), "records": _index}
        with _rename_lock:
            tmp = INDEX_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, INDEX_FILE)
        return True
    except Exception as e:
        print(f"[ZhuleGallery] 索引增量写盘失败: {e}")
        return False


def incremental_sync():
    """增量同步：对比图库磁盘与索引，增删改后原子写回 index.json。

    磁盘有索引无 -> 新增；磁盘无索引有 -> 删除；
    size/mtime 变化 -> 重读该图元数据更新记录。
    返回 (added, removed, updated)；无变化返回 None；全量重建进行中返回 None（下一轮再同步）。
    """
    global _index, _index_rev
    if _index_building:
        return None
    with _sync_lock:
        root = _gallery_root()
        disk = _disk_scan(root)
        if not disk:
            return None
        if _index is None:
            if not _load_index_cache():
                return None
        by_key = {r["key"]: r for r in _index}
        added, updated = [], []
        for rel, (size, mtime) in disk.items():
            rec = by_key.get(rel)
            if rec is None:
                full = _safe_full(rel)
                if full and os.path.isfile(full):
                    try:
                        added.append(_make_record(rel, full))
                    except Exception:
                        continue
            elif rec.get("size") != size or rec.get("mtime") != mtime:
                full = _safe_full(rel)
                if full and os.path.isfile(full):
                    try:
                        updated.append(_make_record(rel, full))
                    except Exception:
                        continue
        removed = [r for r in _index if r["key"] not in disk]
        if not added and not removed and not updated:
            return None
        upd_map = {r["key"]: r for r in updated}
        new_index = []
        for r in _index:
            if r["key"] not in disk:
                continue
            new_index.append(upd_map.get(r["key"], r))
        new_index.extend(added)
        new_index.sort(key=lambda r: r["mtime"], reverse=True)
        _index = new_index
        _index_rev += 1
        _write_index_cache()
        print(f"[ZhuleGallery] 增量同步完成: +{len(added)} -{len(removed)} ~{len(updated)}")
        return len(added), len(removed), len(updated)


def start_index_sync_watcher(interval=3.0):
    """启动后台守护线程：定时增量同步磁盘与索引，覆盖一切针对图库文件夹的操作。"""
    global _sync_watcher_started
    if _sync_watcher_started:
        return
    _sync_watcher_started = True

    def _loop():
        while True:
            try:
                incremental_sync()
            except Exception:
                pass
            time.sleep(interval)

    threading.Thread(target=_loop, daemon=True, name="zhule-index-sync").start()
    print(f"[ZhuleGallery] 索引实时同步守护已启动 interval={interval}s")
