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

    def _load_state_selected(self, bind_id=""):
        """有ID且存在 state 文件时，返回网页最近保存的选中词列表；无则返回 None。

        方案：网页选词防抖写入 modules/studio/state/<ID>.json，
        节点运行时临时读取（画布手动 Run 也读最新）；widget _selected 仅作无文件时的兜底。
        """
        if not bind_id:
            return None
        try:
            from .state_store import load_state
        except Exception:
            try:
                from modules.studio.state_store import load_state
            except Exception:
                return None
        try:
            payload = load_state(bind_id)
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        selected = data.get("selected")
        if not isinstance(selected, list):
            return None
        return [s for s in selected if isinstance(s, dict) and s.get("content")]

    def encode(self, clip, ID="", 前置提示词="", 负面提示词="", _selected="[]"):
        remote = self._load_state_selected(ID)
        if remote is not None:
            # 网页有保存记录（含清空）→ 以它为准；None 表示无文件才退回 widget _selected
            items = remote
            selected = ", ".join(s["content"] for s in remote)
        else:
            items = self._parse_items(_selected)
            selected = self._parse_selected(_selected)
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
