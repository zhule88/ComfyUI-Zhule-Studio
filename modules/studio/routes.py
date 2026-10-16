"""Zhule Studio 路由注册：词库 API + 图库 API + Studio 页面静态服务。"""
from ..common.routes import get_prompt_routes
from . import api
from . import gallery
from . import images_gen
from . import state_store


def register_routes():
    routes = get_prompt_routes()
    if routes is None:
        return

    # 启动兜底清理：删无工作流引用且超保护期的孤儿状态文件
    try:
        state_store.startup_cleanup()
    except Exception:
        pass

    # 启动自动生成词库参考图 images.txt（失败不影响插件启动）
    try:
        images_gen.generate_images_txt()
    except Exception as e:
        print(f"[Zhule] 参考图自动生成失败: {e}")

    # API 路由必须先注册：aiohttp 按注册顺序匹配，避免被下方 catch-all 吞掉
    routes.get("/zhule_studio/api/wordbank")(api.get_wordbank)
    routes.get("/zhule_studio/api/image")(api.get_image)
    routes.post("/zhule_studio/api/rename")(api.post_rename)
    routes.post("/zhule_studio/api/wordbank/delete")(api.post_wordbank_delete)
    routes.post("/zhule_studio/api/wordbank/tab")(api.post_wordbank_tab_create)
    routes.post("/zhule_studio/api/wordbank/chip")(api.post_wordbank_chip_create)
    routes.post("/zhule_studio/api/wordbank/card")(api.post_wordbank_card_create)
    routes.post("/zhule_studio/api/wordbank/image")(api.post_wordbank_image)
    routes.post("/zhule_studio/api/wordbank/image-upload")(api.post_wordbank_image_upload)
    routes.post("/zhule_studio/api/wordbank/sort-save")(api.post_wordbank_sort_save)

    # 图库 API
    routes.get("/zhule_studio/api/gallery")(gallery.get_gallery)
    routes.get("/zhule_studio/api/gallery/meta")(gallery.get_gallery_meta)
    routes.get("/zhule_studio/api/gallery/tagtree")(gallery.get_gallery_tagtree)
    routes.post("/zhule_studio/api/gallery/tagtree/order")(gallery.post_gallery_tagtree_order)
    routes.get("/zhule_studio/api/gallery/detail")(gallery.get_gallery_detail)
    routes.get("/zhule_studio/api/gallery/workflow")(gallery.get_gallery_workflow)
    routes.get("/zhule_studio/api/gallery/thumb")(gallery.get_gallery_thumb)
    routes.get("/zhule_studio/api/gallery/image")(gallery.get_gallery_image)
    routes.post("/zhule_studio/api/gallery/rescan")(gallery.post_gallery_rescan)
    routes.post("/zhule_studio/api/gallery/delete")(gallery.post_gallery_delete)
    routes.post("/zhule_studio/api/gallery/batch-delete")(gallery.post_gallery_batch_delete)
    routes.post("/zhule_studio/api/gallery/batch-link")(gallery.post_gallery_batch_link)
    routes.post("/zhule_studio/api/gallery/tag")(gallery.post_gallery_tag)
    routes.post("/zhule_studio/api/gallery/annotate")(gallery.post_gallery_annotate)
    routes.post("/zhule_studio/api/gallery/rename")(gallery.post_gallery_rename)

    # 状态落盘：网页选词变化 → 存本地文件；节点执行时按ID读取
    routes.post("/zhule_state/save")(api.post_state_save)
    routes.post("/zhule_state/delete")(api.post_state_delete)
    routes.get("/zhule_state/list")(api.get_state_list)

    # Studio 页面与静态资源
    routes.get("/zhule_studio")(api.get_index)
    routes.get("/zhule_studio/")(api.get_index)
    routes.get("/zhule_studio/{tail:.*}")(api.get_static)
