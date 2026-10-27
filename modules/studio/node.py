import json

from nodes import CLIPTextEncode


class ZhuleStudio:
    """Prompt Manager：网页选词 + 节点内前置/负面提示词，输出双 CONDITIONING。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "用于编码提示词的 CLIP 模型"}),
                "ID": (
                    "STRING",
                    {"default": "", "tooltip": "全局ID：词库网页按它定位本节点，请手动填写且保证各工作流间唯一"},
                ),
                "前置提示词": (
                    "STRING",
                    {"multiline": True, "default": "", "tooltip": "拼接到网页所选提示词的前面"},
                ),
                "负面提示词": (
                    "STRING",
                    {"multiline": True, "default": "", "tooltip": "负面提示词"},
                ),
            },
            "hidden": {"_selected": ("STRING", {"default": "[]"})},
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正面提示词", "负面提示词")
    FUNCTION = "encode"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def _parse_items(self, _selected="[]"):
        try:
            items = json.loads(_selected) if isinstance(_selected, str) else _selected
        except Exception:
            items = []
        if not isinstance(items, list):
            items = []
        return [i for i in items if isinstance(i, dict)]

    def _parse_selected(self, _selected="[]"):
        items = self._parse_items(_selected)
        parts = []
        for item in items:
            parts.append(item.get("content", ""))
        return ", ".join(p for p in parts if p)

    def encode(self, clip, ID="", 前置提示词="", 负面提示词="", _selected="[]"):
        items = self._parse_items(_selected)
        if items:
            # widget _selected 有词条（词库页驱动时 studio.js 已写入本轮真实 items，
            # 含遍历/随机池抽出的校服词条）→ 以它为准，避免 state 文件滞后导致出图雷同
            selected = self._parse_selected(_selected)
        else:
            # widget 为空（新节点/画布手动 Run）：无词条，不拼接提示词
            selected = ""
        if 前置提示词 and selected:
            positive = 前置提示词 + ", " + selected
        else:
            positive = 前置提示词 or selected

        encoder = CLIPTextEncode()
        return (
            encoder.encode(clip, positive)[0],
            encoder.encode(clip, 负面提示词)[0],
        )


NODE_CLASS_MAPPINGS = {"ZhuleStudio": ZhuleStudio}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleStudio": "Zhule Studio"}
