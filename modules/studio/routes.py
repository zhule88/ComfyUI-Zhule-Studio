"""Zhule Studio 路由注册：词库 API + 图库 API + Studio 页面静态服务。"""
from ..common.routes import get_prompt_routes
from . import api
from . import gallery


def register_routes():
    routes = get_prompt_routes()
    if routes is None:
        return

    # 图库索引由写入点维护（SaveImage 入库 / 删图 / 打标），无守护线程轮询磁盘
    # 后台预热词库标签索引：避免首次点击图库图片时触发全量 os.walk 造成 2~3s 首点延迟
    gallery.start_warmup()

    # API 路由必须先注册：aiohttp 按注册顺序匹配，避免被下方 catch-all 吞掉
    async def _wordbank(request):
        return await api.get_wordbank(request)

    routes.get("/zhule_studio/api/wordbank")(_wordbank)
    routes.get("/zhule_studio/api/image")(api.get_image)
    routes.post("/zhule_studio/api/rename")(api.post_rename)
    routes.post("/zhule_studio/api/wordbank/delete")(api.post_wordbank_delete)
    routes.post("/zhule_studio/api/wordbank/tab")(api.post_wordbank_tab_create)
    routes.post("/zhule_studio/api/wordbank/chip")(api.post_wordbank_chip_create)
    routes.post("/zhule_studio/api/wordbank/card")(api.post_wordbank_card_create)
    routes.post("/zhule_studio/api/wordbank/image")(api.post_wordbank_image)
    routes.post("/zhule_studio/api/wordbank/image-upload")(api.post_wordbank_image_upload)
    routes.post("/zhule_studio/api/wordbank/sort-save")(api.post_wordbank_sort_save)
    routes.post("/zhule_studio/api/wordbank/clean-cn")(api.post_wordbank_clean_cn)

    # 图库 API
    routes.get("/zhule_studio/api/gallery")(gallery.get_gallery)
    routes.get("/zhule_studio/api/gallery/meta")(gallery.get_gallery_meta)
    routes.get("/zhule_studio/api/gallery/tagtree")(gallery.get_gallery_tagtree)
    # gallery/tagtree/order 已移除：排序统一走 DB 版 wordbank/sort-save（写 sort_order）
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

    # Studio 页面与静态资源
    routes.get("/zhule_studio")(api.get_index)
    routes.get("/zhule_studio/")(api.get_index)
    routes.get("/zhule_studio/{tail:.*}")(api.get_static)
