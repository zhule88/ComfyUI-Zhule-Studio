"""ZhuleComboPicker 节点。迁移自 nodes/combo_picker.py。

路径工具改用 common.paths（行为一致）。
"""
import os
import random
import re

from ..common.paths import _get_input_dir, _resolve_path


class ZhuleComboPicker:
    _counters = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pick_mode": (["random", "fixed", "increment"],
                              {"default": "random"}),
                "mode": (["probability", "condition"],
                         {"default": "condition"}),
                "condition": ("BOOLEAN", {"default": True}),
                "else_text": ("STRING", {"default": ""}),
                "probability": ("INT", {"default": 100, "min": 0, "max": 100, "step": 1}),
                "filter": ("STRING", {"default": ""}),
                "exclude": ("STRING", {"default": ""}),
                "weights": ("STRING", {"default": ""}),
                "list_height": ("INT", {
                    "default": 260, "min": 80, "max": 1500, "step": 20,
                }),
                "font_size": ("INT", {
                    "default": 15, "min": 10, "max": 32, "step": 1,
                }),
                "show_panel": ("BOOLEAN", {"default": True}),
                "_current_dir": ("STRING", {"default": "", "multiline": False}),
                "_locked_file": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "dir_path": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "BOOLEAN")
    RETURN_NAMES = ("text", "path", "filename", "passed")
    FUNCTION = "process"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def process(self, pick_mode, mode, condition, else_text,
                probability, filter, exclude, weights,
                list_height=260, font_size=15, show_panel=True,
                _current_dir="", _locked_file="", unique_id=None,
                dir_path=None):

        def ret(text, path, filename, passed):
            return (text, path, filename, passed)

        if dir_path and str(dir_path).strip():
            scan_root = _resolve_path(dir_path)
            print(f"[ZhuleComboPicker] 使用 dir_path: {dir_path}")
        elif _current_dir == "__empty__":
            print(f"[ZhuleComboPicker] 空状态")
            return ret(else_text, "", "", False)
        elif _current_dir:
            scan_root = _resolve_path(_current_dir)
        else:
            scan_root = _get_input_dir()

        if not os.path.isdir(scan_root):
            print(f"[ZhuleComboPicker] 扫描目录无效: {scan_root}")
            return ret(else_text, "", "", False)

        files = []
        for root, _, filenames in os.walk(scan_root):
            for f in filenames:
                if f.lower().endswith(".txt"):
                    files.append(os.path.join(root, f))

        if filter:
            try:
                pat = re.compile(filter)
                files = [f for f in files if pat.search(f)]
            except re.error as e:
                print(f"[ZhuleComboPicker] filter 正则错误: {e}")
                return ret(else_text, "", "", False)

        if exclude:
            try:
                pat = re.compile(exclude)
                files = [f for f in files if not pat.search(f)]
            except re.error as e:
                print(f"[ZhuleComboPicker] exclude 正则错误: {e}")
                return ret(else_text, "", "", False)

        if not files:
            print(f"[ZhuleComboPicker] 无匹配文件: {scan_root}")
            return ret(else_text, "", "", False)

        files.sort()
        total = len(files)

        chosen = None

        if _locked_file and pick_mode == "fixed":
            resolved = _resolve_path(_locked_file)
            if resolved and os.path.isfile(resolved):
                norm = os.path.normpath(resolved)
                if norm in [os.path.normpath(f) for f in files]:
                    chosen = norm

        if chosen is None:
            if pick_mode == "increment":
                key = str(unique_id) if unique_id is not None else "global"
                current = self._counters.get(key, 0)
                if current >= total:
                    current = 0
                real_idx = current % total
                self._counters[key] = current + 1
                chosen = files[real_idx]
            elif pick_mode == "fixed":
                chosen = files[0]
            else:
                chosen = random.choice(files)

        filename = os.path.basename(chosen)

        if mode == "probability":
            roll = random.randint(0, 99)
            passed = roll < probability
        else:
            passed = bool(condition)

        if not passed:
            return ret(else_text, "", "", False)

        try:
            with open(chosen, "r", encoding="utf-8") as f:
                content = f.read().strip()
        except Exception as e:
            print(f"[ZhuleComboPicker] 读取失败: {e}")
            return ret("", "", "", False)

        return ret(content, chosen, filename, True)


NODE_CLASS_MAPPINGS = {"ZhuleComboPicker": ZhuleComboPicker}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleComboPicker": "Zhule Combo Picker"}
