"""/zhule_artists 路由：画师数据与图片代理。

- GET /zhule_artists/data：返回精简后的画师数组（artists.json）
- GET /zhule_artists/image?id={imageId}：代理 CDN 图片（防路径穿越 + SSRF 校验）
"""
import os
import re
import json

import aiohttp
from aiohttp import web

from ..common.routes import get_prompt_routes

_ARTISTS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artists.json")
_FAVS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "favs.json")

_IMAGE_BASE = "https://cdn.mooshieblob.com/20260425_anima_all_artists/images/"
_IMAGE_HOST = "cdn.mooshieblob.com"
_IMAGE_REFERER = "https://anima.mooshieblob.com/"

# 白名单：字母/数字/下划线/连字符（不含 . 和 /，防路径穿越与 URL 注入）
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _load_artists():
    """读 artists.json，失败返回 []，不抛异常。"""
    try:
        with open(_ARTISTS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _load_favs():
    """读 favs.json，失败返回 []，不抛异常。"""
    try:
        with open(_FAVS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_favs(favs):
    """写 favs.json（原子写：先写临时文件再替换），失败返回 False。"""
    try:
        tmp = _FAVS_JSON + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(favs, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _FAVS_JSON)
        return True
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return False


def register_routes():
    routes = get_prompt_routes()
    if routes is None:
        return

    @routes.get("/zhule_artists/data")
    async def zhule_artists_data(request):
        data = _load_artists()
        return web.json_response(data, dumps=lambda o: json.dumps(o, ensure_ascii=False))

    @routes.get("/zhule_artists/favs")
    async def zhule_artists_favs_get(request):
        return web.json_response(_load_favs())

    @routes.post("/zhule_artists/favs")
    async def zhule_artists_favs_post(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)

        favs = body.get("favs")
        if not isinstance(favs, list):
            return web.json_response({"ok": False, "error": "favs must be list"}, status=400)

        # 仅允许字符串且去重
        cleaned = []
        seen = set()
        for item in favs:
            if isinstance(item, str) and item not in seen:
                seen.add(item)
                cleaned.append(item)

        if not _save_favs(cleaned):
            return web.json_response({"ok": False, "error": "write failed"}, status=500)

        return web.json_response({"ok": True, "favs": cleaned})

    @routes.get("/zhule_artists/image")
    async def zhule_artists_image(request):
        image_id = request.query.get("id", "")
        if not image_id or not _ID_RE.match(image_id):
            return web.Response(status=404)

        url = _IMAGE_BASE + image_id + ".avif"

        # SSRF 防护：校验最终 URL host 必须为 cdn.mooshieblob.com
        try:
            import urllib.parse
            parsed = urllib.parse.urlparse(url)
            if parsed.hostname != _IMAGE_HOST:
                return web.Response(status=404)
        except Exception:
            return web.Response(status=404)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers={"Referer": _IMAGE_REFERER, "User-Agent": "Mozilla/5.0"},
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status != 200:
                        return web.Response(status=404)
                    body = await resp.read()
        except Exception:
            return web.Response(status=404)

        return web.Response(
            body=body,
            content_type="image/avif",
            headers={"Cache-Control": "public, max-age=86400"},
        )
