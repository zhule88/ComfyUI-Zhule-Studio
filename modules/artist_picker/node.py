"""ZhuleArtistPicker 节点。

画师选择器：前端面板选择画师后，把 slug 数组 JSON 写入 _selected widget，
节点执行时解析 slug 并映射为 tag（@前缀），输出逗号分隔的 tag 字符串。
随机由前端完成：随机模式开启后，前端从"当前筛选后的展示集合"随机挑一个 slug
写入 _selected，后端不做任何筛选假设，未来新增筛选条件无需改动本节点。
"""
import json
import os

_ARTISTS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artists.json")
_SLUG_TO_TAG = None


def _load_slug_to_tag():
    """读取 artists.json，构建 slug -> tag 映射；失败返回空 dict。"""
    global _SLUG_TO_TAG
    if _SLUG_TO_TAG is not None:
        return _SLUG_TO_TAG
    mapping = {}
    try:
        with open(_ARTISTS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            for item in data:
                slug = item.get("slug")
                tag = item.get("tag")
                if slug and tag:
                    mapping[slug] = tag
    except Exception:
        mapping = {}
    _SLUG_TO_TAG = mapping
    return mapping


class ZhuleArtistPicker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "_selected": ("STRING", {"default": "[]"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("tag",)
    FUNCTION = "pick"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 每次 Queue 都重新读取 _selected，面板选择后立即生效
        return float("nan")

    def pick(self, _selected="[]"):
        raw = _selected
        if raw is None:
            raw = "[]"
        if not isinstance(raw, str):
            try:
                raw = json.dumps(raw)
            except Exception:
                raw = "[]"

        tags = []
        mapping = _load_slug_to_tag()
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                for item in data:
                    s = str(item).strip()
                    if s:
                        tags.append(mapping.get(s, "@" + s))
        except Exception:
            # 解析失败兜底返回空字符串，不崩节点
            return ("",)

        return (", ".join(tags),)


NODE_CLASS_MAPPINGS = {"ZhuleArtistPicker": ZhuleArtistPicker}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleArtistPicker": "Zhule Artist Picker"}
