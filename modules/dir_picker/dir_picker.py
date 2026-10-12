"""ZhuleDirPicker 节点。迁移自 nodes/dir_picker.py。

不注册路由；list_dir / scan_themes 由 combo_picker / common 注册，前端直接调用。
"""
import os
import random

from ..common.paths import _get_input_dir


def _rel_to_input(abs_path):
    input_dir = _get_input_dir()
    rel = os.path.relpath(abs_path, input_dir).replace("\\", "/")
    return "" if rel == "." else rel


def _resolve_abs(p):
    """把相对/绝对路径统一转成绝对路径。"""
    if not p:
        return _get_input_dir()

    p = p.replace("\\", "/").strip("/")
    if os.path.isabs(p) or (len(p) > 1 and p[1] == ":"):
        return os.path.normpath(p)

    return os.path.normpath(os.path.join(_get_input_dir(), p))


class ZhuleDirPicker:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["浏览", "随机"], {"default": "浏览"}),
                "keywords": ("STRING", {"default": "情境,服装"}),
                "font_size": ("INT", {"default": 15, "min": 10, "max": 32, "step": 1}),
                "enable": ("BOOLEAN", {"default": True}),
                "show_panel": ("BOOLEAN", {"default": True}),
                "_current_dir": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("dir_path",)
    FUNCTION = "pick"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, mode="浏览", _current_dir="", enable=True, **kwargs):
        if not enable:
            return ""
        if mode == "随机":
            return float("NaN")
        return f"{_current_dir}"

    def pick(self, mode="浏览", keywords="", font_size=15, enable=True,
             show_panel=True, _current_dir=""):

        if not enable:
            print(f"[ZhuleDirPicker] 已禁用，输出空")
            return ("",)

        if mode == "随机":
            # ★ 从当前浏览目录往下扫；没有就在 input 根
            if _current_dir and _current_dir.strip():
                root = _resolve_abs(_current_dir)
            else:
                root = _get_input_dir()

            if not os.path.isdir(root):
                print(f"[ZhuleDirPicker] 扫描根无效: {root}")
                return ("",)

            kw_list = [k.strip() for k in keywords.split(",") if k.strip()]

            if kw_list:
                candidates = []
                kw_set = set(kw_list)
                for cur, dirs, _ in os.walk(root):
                    dirs[:] = [d for d in dirs if not d.startswith(".")]
                    if kw_set.issubset(set(dirs)):
                        candidates.append(cur)
                        dirs[:] = []
                desc = f"关键词={kw_list}"
            else:
                candidates = [
                    os.path.join(root, d) for d in os.listdir(root)
                    if os.path.isdir(os.path.join(root, d)) and not d.startswith(".")
                ]
                desc = "直接子目录"

            if not candidates:
                print(f"[ZhuleDirPicker] 未找到候选目录 ({desc}) from {root}")
                return ("",)

            chosen = random.choice(candidates)
            rel = _rel_to_input(chosen)
            print(f"[ZhuleDirPicker] 随机 {desc} 共{len(candidates)}个 → {rel}")
            return (rel,)

        # 浏览模式
        if not _current_dir:
            print(f"[ZhuleDirPicker] 当前无目录，输出空")
            return ("",)

        if os.path.isabs(_current_dir):
            rel = _rel_to_input(_current_dir)
        else:
            rel = _current_dir.strip("/").replace("\\", "/")

        print(f"[ZhuleDirPicker] 输出当前目录: {rel}")
        return (rel,)


NODE_CLASS_MAPPINGS = {"ZhuleDirPicker": ZhuleDirPicker}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleDirPicker": "Zhule Dir Picker"}
