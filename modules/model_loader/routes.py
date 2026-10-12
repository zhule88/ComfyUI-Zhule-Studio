"""/zhule/model_arch 路由：safetensors 头读取、架构识别、自动锁定等工具。

迁移自 server.py 对应工具与路由。
"""
import os
import json
import struct

from aiohttp import web

import folder_paths

from ..common.routes import get_prompt_routes


_arch_cache = {}


# ==================== 模型架构识别 ====================

def _read_safetensors_header(path):
    """读 safetensors 头部（含 tensor shape + metadata）。"""
    try:
        with open(path, "rb") as f:
            header_size = struct.unpack("<Q", f.read(8))[0]
            if header_size > 200 * 1024 * 1024:
                return {}
            header = f.read(header_size)
            return json.loads(header.decode("utf-8"))
    except Exception:
        return {}


def _read_lora_manager_meta(path):
    """读 comfyui-lora-manager 生成的 .metadata.json 的 base_model。"""
    meta_path = os.path.splitext(path)[0] + ".metadata.json"
    if not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        base = data.get("base_model", "")
        if base and base.lower() != "unknown":
            return base
    except Exception:
        pass
    return None


def _read_trained_words(path):
    """读 .metadata.json 的 trainedWords 字段，拼成字符串。"""
    meta_path = os.path.splitext(path)[0] + ".metadata.json"
    if not os.path.isfile(meta_path):
        return ""
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        words = data.get("trainedWords", [])
        if isinstance(words, list) and words:
            cleaned = [str(w).strip() for w in words if w and str(w).strip()]
            return ", ".join(cleaned)
    except Exception:
        pass
    return ""


def _read_recommended(path):
    """读 .metadata.json 的 recommended 字段，返回 dict，失败返回 {}。"""
    meta_path = os.path.splitext(path)[0] + ".metadata.json"
    if not os.path.isfile(meta_path):
        return {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        rec = data.get("recommended", {})
        if isinstance(rec, dict):
            return {
                "cfg": rec.get("cfg"),
                "steps": rec.get("steps"),
                "sampler": rec.get("sampler"),
                "scheduler": rec.get("scheduler"),
            }
    except Exception:
        pass
    return {}


def _read_weight(path):
    """读 .metadata.json 的 weight 字段，返回 float，失败返回 None。"""
    meta_path = os.path.splitext(path)[0] + ".metadata.json"
    if not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        w = data.get("weight")
        if w is None:
            return None
        return float(w)
    except (TypeError, ValueError):
        return None
    except Exception:
        return None


def _auto_lock_meta(path):
    """读 json 时自动加 skip_metadata_refresh: true，保护内容不被 Lora-Manager 覆盖。
    只在 json 有"有效内容"时才加锁。"""
    meta_path = os.path.splitext(path)[0] + ".metadata.json"
    if not os.path.isfile(meta_path):
        return
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 已经锁定 → 跳过
        if data.get("skip_metadata_refresh") is True:
            return

        # 判断是否有"有效内容"
        base = str(data.get("base_model", "")).strip()
        words = data.get("trainedWords", [])
        has_base = base and base.lower() != "unknown"
        has_words = isinstance(words, list) and len(words) > 0

        if not (has_base or has_words):
            return  # 没内容，不动它

        # 加锁并原子写回
        data["skip_metadata_refresh"] = True
        tmp_path = meta_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, meta_path)

        print(f"[Zhule] 已自动锁定: {os.path.basename(meta_path)}")
    except Exception as e:
        print(f"[Zhule] 锁定失败 {os.path.basename(meta_path)}: {e}")


def _guess_arch(path):
    """自动判断架构。仅依据 safetensors 头内作者写死的 metadata；
    不再使用文件名、文件大小、tensor shape 等兜底判断，无法判定返回 Unknown。"""
    header = _read_safetensors_header(path)
    meta = header.get("__metadata__", {})
    blob = " ".join([
        str(meta.get("modelspec.architecture", "")).lower(),
        str(meta.get("ss_base_model_version", "")).lower(),
        str(meta.get("ss_sd_model_name", "")).lower(),
    ])

    if "flux" in blob:
        return "Flux"
    if "noobai" in blob:
        return "NoobAI"
    if "illustrious" in blob:
        return "Illustrious"
    if "anima" in blob:
        return "Anima"
    if "pony" in blob:
        return "Pony"
    if "sdxl" in blob:
        return "SDXL"
    if "sd1.5" in blob or "sd_v1" in blob:
        return "SD1.5"

    return "Unknown"


def _guess_arch_cached(path):
    if path in _arch_cache:
        return _arch_cache[path]

    # ★ 自动加锁（保护有内容的 metadata.json）
    _auto_lock_meta(path)

    # ① 优先读 comfyui-lora-manager 的 metadata.json
    lora_meta = _read_lora_manager_meta(path)
    if lora_meta:
        _arch_cache[path] = lora_meta
        return lora_meta

    # ② fallback
    arch = _guess_arch(path)
    _arch_cache[path] = arch
    return arch


# ==================== 路由 ====================

def register_routes():
    routes = get_prompt_routes()
    if routes is None:
        return

    @routes.get("/zhule/model_arch")
    async def zhule_model_arch(request):
        mtype = request.query.get("type", "")
        name = request.query.get("name", "")

        if not name:
            return web.json_response({"arch": "", "trained_words": ""})

        if mtype == "checkpoint":
            path = folder_paths.get_full_path("checkpoints", name)
        elif mtype == "lora":
            path = folder_paths.get_full_path("loras", name)
        else:
            return web.json_response({"arch": "", "trained_words": ""})

        if not path or not os.path.isfile(path):
            return web.json_response({"arch": "", "trained_words": ""})

        arch = _guess_arch_cached(path)

        trained_words = ""
        if mtype == "lora":
            trained_words = _read_trained_words(path)

        return web.json_response({
            "arch": arch,
            "trained_words": trained_words,
            "recommended": _read_recommended(path),
            "weight": _read_weight(path),
        })
