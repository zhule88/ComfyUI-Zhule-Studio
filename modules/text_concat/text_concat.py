"""ZhuleTextConcatenate 节点。迁移自 nodes/text_concat.py。

原 nodes/text_concat.py 未声明映射，映射原由顶层 __init__.py 内联提供；
此处补齐等价映射，保证收集器注册 key / 展示名与旧版一致。
"""
MAX_TEXT_CONCAT_INPUTS = 16


class ZhuleTextConcatenate:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "separator": ("STRING", {
                    "default": ", ",
                    "multiline": False,
                    "forceInput": False,
                }),
                "strip_inputs": ("BOOLEAN", {"default": True}),
                "skip_empty": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                f"text_{i}": ("STRING", {"forceInput": True})
                for i in range(1, MAX_TEXT_CONCAT_INPUTS + 1)
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "concatenate"
    CATEGORY = "Zhule"

    def concatenate(self, separator=", ", strip_inputs=True, skip_empty=True, **kwargs):
        indexed = []
        for name, value in kwargs.items():
            if not name.startswith("text_"):
                continue
            try:
                idx = int(name.removeprefix("text_"))
            except ValueError:
                continue
            indexed.append((idx, value))

        parts = []
        for _, v in sorted(indexed):
            if v is None:
                v = ""
            elif not isinstance(v, str):
                v = str(v)
            if strip_inputs:
                v = v.strip()
            if skip_empty and not v:
                continue
            parts.append(v)

        result = separator.join(parts)
        preview = result if len(result) < 100 else result[:100] + "..."
        print(f"[ZhuleTextConcatenate] 拼接 {len(parts)} 段 → {preview}")
        return (result,)


NODE_CLASS_MAPPINGS = {"ZhuleTextConcatenate": ZhuleTextConcatenate}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleTextConcatenate": "Zhule Text Concatenate"}
