"""ZhulePass 节点。迁移自 nodes/pass_gate.py。"""
class ZhulePass:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "forceInput": True}),
                "condition": ("BOOLEAN", {"default": True, "forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "process"
    CATEGORY = "Zhule"

    def process(self, text, condition):
        if condition:
            return (text,)
        return ("",)


NODE_CLASS_MAPPINGS = {"ZhulePass": ZhulePass}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhulePass": "Zhule Pass"}
