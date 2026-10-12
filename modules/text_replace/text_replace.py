"""ZhuleTextReplace 节点。迁移自 nodes/text_replace.py。"""
import re


class ZhuleTextReplace:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 输入文本：必须连线（通常是 picker 的 path 或 text）
                "text": ("STRING", {
                    "default": "",
                    "forceInput": True,
                }),

                # 查找内容：手动输入，支持正则
                "find": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "forceInput": False,
                }),

                # 替换内容：手动输入，支持 \1 \2 捕获组
                "replace": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "forceInput": False,
                }),

                # 是否启用正则模式
                "use_regex": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("result", "count")
    FUNCTION = "replace"
    CATEGORY = "Zhule"

    def replace(self, text, find, replace, use_regex=True):
        # find 为空，原样返回
        if not find:
            print("[ZhuleTextReplace] find 为空，原样返回")
            return (text, 0)

        # ==================== 正则模式 ====================
        if use_regex:
            try:
                pattern = re.compile(find)
            except re.error as e:
                print(f"[ZhuleTextReplace] ❌ 正则错误: {e}")
                print(f"[ZhuleTextReplace]    find = {find!r}")
                return (text, 0)
            try:
                result, count = pattern.subn(replace, text)
            except re.error as e:
                print(f"[ZhuleTextReplace] ❌ replace 中的反斜杠错误: {e}")
                print(f"[ZhuleTextReplace]    replace = {replace!r}")
                return (text, 0)

        # ==================== 纯文本模式 ====================
        else:
            count = text.count(find)
            result = text.replace(find, replace)

        # ==================== 日志 ====================
        print(f"[ZhuleTextReplace] {'正则' if use_regex else '纯文本'}替换 {count} 处")
        if count > 0:
            preview = result if len(result) < 100 else result[:100] + "..."
            print(f"[ZhuleTextReplace] 结果: {preview}")

        return (result, count)


NODE_CLASS_MAPPINGS = {"ZhuleTextReplace": ZhuleTextReplace}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleTextReplace": "Zhule Text Replace"}
