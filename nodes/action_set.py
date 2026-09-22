import os
import re


class ZhuleActionSet:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, 13):
            optional[f"action_{i}"] = ("STRING", {"default": "", "forceInput": True})
        return {
            "required": {
                "symbols": ("STRING", {"default": "[手], [嘴], [腿]"}),
                "separator": ("STRING", {"default": ", "}),
                "tag_pattern": (
                    "STRING",
                    {"default": r"[\\/]([^\\/]+[\\/][^\\/]+)[\\/][^\\/]+\.txt$"}
                ),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("STRING", "STRING") + tuple(["BOOLEAN"] * 12)
    RETURN_NAMES = ("text", "tags") + tuple([f"acc_{i}" for i in range(1, 13)])
    FUNCTION = "process"
    CATEGORY = "Zhule"

    def process(self, symbols, separator, tag_pattern, **kwargs):
        symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]

        try:
            tag_re = re.compile(tag_pattern) if tag_pattern else None
        except re.error as e:
            print(f"[ZhuleActionSet] tag_pattern 正则错误: {e}")
            tag_re = None

        text = ""
        tags = ""
        occupied = set()
        accepted = []
        log = []

        for i in range(1, 13):
            file_path = kwargs.get(f"action_{i}", "")

            if not file_path or not os.path.isfile(file_path):
                accepted.append(False)
                continue

            needs = {s for s in symbol_list if s in file_path}

            if needs & occupied:
                log.append(f"[{i}] 跳过 {os.path.basename(file_path)}")
                accepted.append(False)
                continue

            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
            except Exception as e:
                log.append(f"[{i}] 读取失败 {e}")
                accepted.append(False)
                continue

            if not content:
                accepted.append(False)
                continue

            # 提取 tag
            tag = None
            if tag_re:
                m = tag_re.search(file_path)
                if m:
                    tag = m.group(1)
            if not tag:
                tag = os.path.basename(file_path).replace(".txt", "")

            text = text + separator + content if text else content
            tags = tags + separator + tag if tags else tag
            occupied |= needs
            accepted.append(True)
            log.append(f"[{i}] 加入 {os.path.basename(file_path)} | tag={tag}")

        print("[ZhuleActionSet] " + " | ".join(log))
        print(f"[ZhuleActionSet] 占用: {occupied}")
        print(f"[ZhuleActionSet] 采用: {[i+1 for i, a in enumerate(accepted) if a]}")
        print(f"[ZhuleActionSet] tags: {tags}")

        return tuple([text, tags] + accepted)