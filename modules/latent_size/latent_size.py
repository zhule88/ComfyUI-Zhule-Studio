"""ZhuleLatentSize 节点。迁移自 nodes/latent_size.py。"""
import random

import torch


class ZhuleLatentSize:
    RATIOS = {
        "1:1":  (1024, 1024),
        "3:2":  (1216, 832),
        "2:3":  (832, 1216),
        "4:3":  (1152, 896),
        "3:4":  (896, 1152),
        "16:9": (1344, 768),
        "9:16": (768, 1344),
    }
    LANDSCAPE = ["1:1", "3:2", "4:3", "16:9"]
    PORTRAIT  = ["1:1", "2:3", "3:4", "9:16"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "random_mode": (["手动指定", "完全随机", "随机横屏", "随机竖屏"],
                                {"default": "手动指定"}),
                "ratio": (["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
                          {"default": "1:1"}),
                "batch_size": ("INT", {
                    "default": 1, "min": 1, "max": 64, "step": 1,
                }),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "generate"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def generate(self, random_mode, ratio, batch_size=1):
        if random_mode == "完全随机":
            pool = list(self.RATIOS.keys())
        elif random_mode == "随机横屏":
            pool = self.LANDSCAPE
        elif random_mode == "随机竖屏":
            pool = self.PORTRAIT
        else:  # "手动指定" → 用手动选的
            pool = [ratio]

        chosen = random.choice(pool)
        w, h = self.RATIOS[chosen]

        print(f"[ZhuleLatentSize] random={random_mode} ratio={ratio} → "
              f"{chosen} ({w}×{h}) × {batch_size}")

        latent = torch.zeros([batch_size, 4, h // 8, w // 8])
        return ({"samples": latent},)


NODE_CLASS_MAPPINGS = {"ZhuleLatentSize": ZhuleLatentSize}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleLatentSize": "Zhule Latent Size"}
