"""Zhule Studio 模块入口（薄壳）。

后端实现统一收在 backend/ 子目录：
  - backend/node.py     节点定义（ZhuleStudio）与提示词拼接逻辑
  - backend/routes.py   路由注册
  - backend/api.py      词库/参考图 HTTP 接口与页面对外服务
  - backend/db.py       zhule.db SQLite 数据层
  - backend/gallery.py  图库后端（索引、缩略图、打标）
  - backend/png_text.py PNG tEXt chunk 读写
  - backend/hardlink.py 硬链接右键菜单安装

收集器只扫 modules/<模块>/ 一层，故此处把节点映射与路由注册转导出，
让 modules.studio 与原先平铺结构对 ComfyUI 的表现保持一致：
  - 节点映射在模块导入阶段即取得，不受路由注册成败影响
  - register_routes 内延迟导入路由模块，路由异常只影响路由，不丢节点
"""

from .backend.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS


def register_routes():
    """注册 /zhule_studio/* 路由（延迟导入，避免路由异常牵连节点映射）。"""
    from .backend.routes import register_routes as _register

    return _register()


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "register_routes"]
