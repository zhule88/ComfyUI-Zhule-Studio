"""combo_picker 路由：/zhule/list_dir、/zhule/image、/zhule/delete。

迁移自 server.py 中对应路由与工具（只在本模块注册一次）。
"""
import os
import time
import shutil

from aiohttp import web

from ..common.paths import (
    _get_input_dir,
    _get_output_dir,
    _resolve_path,
    _is_safe,
    _is_safe_for_delete,
)
from ..common.routes import get_prompt_routes


# ==================== 配置 ====================
CACHE_TTL = 30
MAX_IMAGES = 5000
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

_dir_cache = {}


def _scan_images_recursive(root, max_results=MAX_IMAGES):
    cache_key = os.path.abspath(root)
    now = time.time()

    if cache_key in _dir_cache:
        ts, cached = _dir_cache[cache_key]
        if now - ts < CACHE_TTL:
            return cached, False

    images = []
    truncated = False

    for cur_root, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.startswith("."):
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext in IMAGE_EXTS:
                rel = os.path.relpath(
                    os.path.join(cur_root, f), root
                ).replace("\\", "/")
                images.append(rel)
                if len(images) >= max_results:
                    truncated = True
                    break
        if truncated:
            break

    images.sort()
    _dir_cache[cache_key] = (now, images)
    return images, truncated


def _invalidate_cache(abs_path):
    abs_path = os.path.abspath(abs_path)
    for key in list(_dir_cache.keys()):
        try:
            if os.path.commonpath([key, abs_path]) == key:
                del _dir_cache[key]
        except ValueError:
            continue


def _delete_file_and_hardlinks(target):
    try:
        s = os.stat(target)
        target_dev = s.st_dev
        target_ino = s.st_ino
    except OSError:
        return 0

    roots = [_get_input_dir(), _get_output_dir()]
    deleted = 0

    for root in roots:
        if not os.path.isdir(root):
            continue
        for cur_root, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                p = os.path.join(cur_root, f)
                try:
                    st = os.stat(p)
                    if st.st_dev != target_dev:
                        continue
                    if st.st_ino == target_ino:
                        os.remove(p)
                        deleted += 1
                except OSError:
                    continue

    return deleted


# ==================== 路由 ====================

def register_routes():
    routes = get_prompt_routes()
    if routes is None:
        return

    @routes.get("/zhule/list_dir")
    async def zhule_list_dir(request):
        raw = request.query.get("path", "")
        abs_path = _resolve_path(raw)

        if not abs_path or not os.path.isdir(abs_path):
            return web.json_response({
                "error": "path not found", "path": raw, "rel_path": "",
                "parent": None, "siblings": [], "folders": [], "files": [], "images": [],
            })

        if not _is_safe(abs_path):
            return web.json_response({
                "error": "path not allowed", "path": raw, "rel_path": "",
                "parent": None, "siblings": [], "folders": [], "files": [], "images": [],
            })

        folders, files = [], []
        try:
            for entry in sorted(os.listdir(abs_path)):
                if entry.startswith("."):
                    continue
                full = os.path.join(abs_path, entry)
                if os.path.isdir(full):
                    folders.append(entry)
                elif os.path.isfile(full):
                    ext = os.path.splitext(entry)[1].lower()
                    if ext == ".txt":
                        files.append(entry)
        except OSError as e:
            return web.json_response({
                "error": str(e), "path": raw, "rel_path": "",
                "parent": None, "siblings": [], "folders": [], "files": [], "images": [],
            })

        images, truncated = _scan_images_recursive(abs_path)

        input_dir = _get_input_dir()
        parent = None
        if os.path.abspath(abs_path) != input_dir:
            parent_abs = os.path.dirname(abs_path)
            if _is_safe(parent_abs):
                parent = parent_abs

        siblings = []
        if parent:
            try:
                for entry in sorted(os.listdir(parent)):
                    full = os.path.join(parent, entry)
                    if os.path.isdir(full) and not entry.startswith("."):
                        siblings.append(entry)
            except OSError:
                pass

        rel_path = os.path.relpath(abs_path, input_dir).replace("\\", "/")
        if rel_path == ".":
            rel_path = ""

        return web.json_response({
            "path": abs_path,
            "rel_path": rel_path,
            "parent": parent,
            "siblings": siblings,
            "folders": folders,
            "files": files,
            "images": images,
            "truncated": truncated,
        })

    @routes.get("/zhule/image")
    async def zhule_image(request):
        raw = request.query.get("path", "")
        abs_path = _resolve_path(raw)

        if not abs_path or not os.path.isfile(abs_path):
            return web.Response(status=404)
        if not _is_safe(abs_path):
            return web.Response(status=403)

        return web.FileResponse(abs_path)

    @routes.post("/zhule/delete")
    async def zhule_delete(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "请求格式错误"}, status=400)

        raw = data.get("path", "")
        abs_path = _resolve_path(raw)

        if not abs_path or not os.path.exists(abs_path):
            return web.json_response({"error": "路径不存在"}, status=404)

        if not _is_safe_for_delete(abs_path):
            return web.json_response({"error": "路径不允许删除"}, status=403)

        _invalidate_cache(os.path.dirname(abs_path))

        if os.path.isdir(abs_path):
            try:
                shutil.rmtree(abs_path)
                return web.json_response({"ok": True, "type": "dir"})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)

        n = _delete_file_and_hardlinks(abs_path)
        return web.json_response({"ok": True, "type": "file", "deleted": n})
