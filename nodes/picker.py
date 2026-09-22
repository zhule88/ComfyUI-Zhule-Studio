import os
import random
import re


def parse_percentages(s):
    result = []
    if not s:
        return result
    for pair in s.split(","):
        pair = pair.strip()
        if ":" in pair:
            name, p = pair.rsplit(":", 1)
            try:
                result.append((name.strip(), float(p.strip())))
            except ValueError:
                pass
    return result


class ZhulePicker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dir_path": ("STRING", {"default": "", "forceInput": True}),
                "mode": (["probability", "condition"], {"default": "probability"}),
                "probability": ("INT", {"default": 100, "min": 0, "max": 100, "step": 1}),
                "filter": ("STRING", {"default": ""}),
                "exclude": ("STRING", {"default": ""}),
                "weights": ("STRING", {"default": ""}),
            },
            "optional": {
                "condition": ("BOOLEAN", {"default": True}),
                "else_text": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "BOOLEAN")
    RETURN_NAMES = ("text", "path", "filename", "passed")
    FUNCTION = "process"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 每次执行都重新跑，不需要 seed
        return float("NaN")

    def process(self, dir_path, mode, probability, filter, exclude, weights, condition=True, else_text=""):
        files = []
        if os.path.isdir(dir_path):
            for root, _, filenames in os.walk(dir_path):
                for f in filenames:
                    if f.endswith(".txt"):
                        files.append(os.path.join(root, f))
        else:
            print(f"[ZhulePicker] 路径无效: {dir_path}")
            return (else_text, "", "", False)

        if filter:
            try:
                pattern = re.compile(filter)
                files = [f for f in files if pattern.search(f)]
            except re.error as e:
                print(f"[ZhulePicker] filter 正则错误: {e}")
                return (else_text, "", "", False)

        if exclude:
            try:
                pattern = re.compile(exclude)
                files = [f for f in files if not pattern.search(f)]
            except re.error as e:
                print(f"[ZhulePicker] exclude 正则错误: {e}")
                return (else_text, "", "", False)

        if not files:
            print(f"[ZhulePicker] 无匹配文件: {dir_path}")
            return (else_text, "", "", False)

        files.sort()

        entries = parse_percentages(weights)
        total_pct = sum(p for _, p in entries)

        if total_pct > 100:
            print(f"[ZhulePicker] ❌ 百分比总和 {total_pct}% 超过 100%")
            return (else_text, "", "", False)

        # 按类别分配
        file_category = []
        for f in files:
            filename = os.path.basename(f)
            cat_idx = None
            for idx, (name, p) in enumerate(entries):
                if name in filename:
                    cat_idx = idx
                    break
            file_category.append(cat_idx)

        cat_counts = [0] * len(entries)
        unlisted_count = 0
        for cat_idx in file_category:
            if cat_idx is None:
                unlisted_count += 1
            else:
                cat_counts[cat_idx] += 1

        cat_per_file = []
        for idx, (name, p) in enumerate(entries):
            count = cat_counts[idx]
            cat_per_file.append(p / count if count > 0 else 0)

        remaining = 100 - total_pct
        unlisted_each = remaining / unlisted_count if unlisted_count > 0 else 0

        file_pcts = []
        for cat_idx in file_category:
            if cat_idx is None:
                file_pcts.append(unlisted_each)
            else:
                file_pcts.append(cat_per_file[cat_idx])

        if entries:
            print(f"[ZhulePicker] 概率表:")
            for idx, (name, p) in enumerate(entries):
                count = cat_counts[idx]
                if count > 0:
                    print(f"[ZhulePicker]   类别 '{name}': {p}% / {count} 个 = 每个 {cat_per_file[idx]:.2f}%")
            if unlisted_count > 0:
                print(f"[ZhulePicker]   未列出: {remaining}% / {unlisted_count} 个 = 每个 {unlisted_each:.2f}%")

        idx = random.choices(range(len(files)), weights=file_pcts, k=1)[0]
        chosen = files[idx]
        filename = os.path.basename(chosen)
        print(f"[ZhulePicker] 抽中: {filename} ({file_pcts[idx]:.2f}%)")

        if mode == "probability":
            roll = random.randint(0, 99)
            passed = roll < probability
            print(f"[ZhulePicker] 概率 {probability}% 掷骰 {roll} → {'通过' if passed else '跳过'}")
        else:
            passed = bool(condition)
            print(f"[ZhulePicker] condition={condition} → {'通过' if passed else '跳过'}")

        if not passed:
            return (else_text, chosen, filename, False)

        try:
            with open(chosen, "r", encoding="utf-8") as f:
                content = f.read().strip()
        except Exception as e:
            print(f"[ZhulePicker] 读取失败: {e}")
            return ("", chosen, filename, False)

        return (content, chosen, filename, True)