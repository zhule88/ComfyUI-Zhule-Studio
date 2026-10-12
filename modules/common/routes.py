"""路由注册辅助：获取 PromptServer 的路由对象，并注册 /zhule/scan_themes。

- get_prompt_routes()：供各模块 routes 获取路由表后注册；
- /zhule/scan_themes：dir_picker 前端依赖（原 server.py 路由迁移）。
- /zhule_modules 系列：web/index.js 动态加载各模块 JS/CSS 的静态服务。
  common 不被 walk_packages 引入，仅随 combo_picker / model_loader 的 routes
  导入时执行一次模块级注册（Python 模块单例保证只注册一次）。
"""
import os
import re

from aiohttp import web

from .paths import _get_input_dir, _resolve_path, _is_safe

try:
    from server import PromptServer

    def get_prompt_routes():
        return PromptServer.instance.routes
except Exception as e:
    print(f"[ZhuleServer] 无法注册路由: {e}")

    def get_prompt_routes():
        return None


# ==================== /zhule/scan_themes ====================

def register_scan_themes():
    routes = get_prompt_routes()
    if routes is None:
        return

    @routes.get("/zhule/scan_themes")
    async def zhule_scan_themes(request):
        raw_root = request.query.get("root", "")
        keywords_str = request.query.get("keywords", "")

        abs_root = _resolve_path(raw_root) if raw_root else _get_input_dir()

        if not abs_root or not os.path.isdir(abs_root):
            return web.json_response({"error": "root 无效", "themes": []})
        if not _is_safe(abs_root):
            return web.json_response({"error": "路径不允许", "themes": []})

        kw_list = [k.strip() for k in keywords_str.split(",") if k.strip()]

        themes = []
        if kw_list:
            kw_set = set(kw_list)
            for cur, dirs, _ in os.walk(abs_root):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                if kw_set.issubset(set(dirs)):
                    themes.append(cur)
                    dirs[:] = []
        else:
            for d in sorted(os.listdir(abs_root)):
                full = os.path.join(abs_root, d)
                if os.path.isdir(full) and not d.startswith("."):
                    themes.append(full)

        input_dir = _get_input_dir()
        rels = []
        for t in themes:
            rel = os.path.relpath(t, input_dir).replace("\\", "/")
            rels.append(rel)

        return web.json_response({"themes": rels})


register_scan_themes()


# ==================== /zhule_modules 静态 JS/CSS 服务 ====================
# web/ 只保留 index.js 入口，各模块 JS 归回 modules/<模块名>/，
# 由 index.js 通过 /zhule_modules 动态 import 加载。

_MODULES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
_ZHULE_NAME_RE = re.compile(r"^[A-Za-z0-9_]+$")
_ZHULE_FILE_RE = re.compile(r"^[A-Za-z0-9_.]+$")


def _iter_module_names_with_js():
    """扫描 modules/ 下含 .js 的目录名，结果稳定排序，可缓存（重启前不变）。"""
    if not os.path.isdir(_MODULES_DIR):
        return []
    names = []
    for entry in sorted(os.listdir(_MODULES_DIR)):
        sub = os.path.join(_MODULES_DIR, entry)
        if not os.path.isdir(sub) or entry.startswith("_"):
            continue
        try:
            files = os.listdir(sub)
        except OSError:
            continue
        if any(f.endswith(".js") for f in files):
            names.append(entry)
    return names


def register_zhule_modules():
    routes = get_prompt_routes()
    if routes is None:
        return

    @routes.get("/zhule_modules")
    async def zhule_modules_list(request):
        return web.json_response(_iter_module_names_with_js())

    @routes.get("/zhule_modules/{name}/{file}")
    async def zhule_modules_file(request):
        name = request.match_info.get("name", "")
        file = request.match_info.get("file", "")

        # 白名单：目录名 [a-zA-Z0-9_]，文件名 [a-zA-Z0-9_.] 且以 .js/.css 结尾
        if not _ZHULE_NAME_RE.match(name) or not _ZHULE_FILE_RE.match(file):
            return web.Response(status=400)
        if not (file.endswith(".js") or file.endswith(".css")):
            return web.Response(status=400)
        # 显式防穿越（正则已排除 .. / \，双保险）
        if ".." in name or ".." in file:
            return web.Response(status=400)

        mod_dir = os.path.realpath(os.path.join(_MODULES_DIR, name))
        file_path = os.path.realpath(os.path.join(mod_dir, file))
        # 确保最终路径仍在模块目录内，杜绝路径穿越
        if not file_path.startswith(mod_dir + os.sep):
            return web.Response(status=404)
        if not os.path.isfile(file_path):
            return web.Response(status=404)

        ctype = "text/javascript" if file.endswith(".js") else "text/css"
        return web.FileResponse(file_path, headers={"Content-Type": ctype})


register_zhule_modules()
