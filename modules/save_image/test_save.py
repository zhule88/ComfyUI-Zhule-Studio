"""ZhuleTestSave 节点。迁移自 nodes/test_save.py。"""
import os
import re

import numpy as np
from PIL import Image

import folder_paths


def _sanitize_segment(name, fallback="_unknown"):
    if name is None:
        return fallback
    name = str(name)
    name = re.sub(r'[<>:"\\|?*]', "_", name)
    name = name.strip(" .")
    return name or fallback


class ZhuleTestSave:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "model_name": ("STRING", {"forceInput": True}),
                "lora_name": ("STRING", {"forceInput": True}),
                "dir_signature": ("STRING", {"forceInput": True}),
                # ★ test_root 支持多级：如 "测试/提示词1"
                "test_root": ("STRING", {"default": "测试"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def save(self, images, model_name, lora_name, dir_signature,
             test_root="测试"):

        output_dir = folder_paths.get_output_directory()

        model_seg = _sanitize_segment(model_name, fallback="_默认模型")
        lora_seg = _sanitize_segment(lora_name, fallback="_默认lora")

        # ★ 拆 dir_signature 为多级
        segments = []
        for seg in (dir_signature or "").replace("\\", "/").split("/"):
            seg = seg.strip()
            if seg:
                segments.append(_sanitize_segment(seg))
        if not segments:
            segments = ["_未知"]

        # ★ 最后一段当文件名；前面当目录
        file_name_base = segments[-1]
        dir_segments = segments[:-1]

        # ★ test_root 支持多级：如 "测试/提示词1"
        root = (test_root or "").replace("\\", "/").strip("/")
        if not root:
            base = output_dir
        elif os.path.isabs(root) or (len(root) > 1 and root[1] == ":"):
            base = root
        else:
            base = os.path.join(output_dir, root)

        # 完整路径：base / model / lora / dir_segments... 
        target_dir = os.path.join(base, model_seg, lora_seg, *dir_segments)
        os.makedirs(target_dir, exist_ok=True)

        file_name = f"{file_name_base}.png"
        full_path = os.path.join(target_dir, file_name)

        for img in images:
            arr = (img.cpu().numpy() * 255).astype(np.uint8)
            Image.fromarray(arr).save(full_path)
            print(f"[ZhuleTestSave] 保存: {full_path}")

        print(f"[ZhuleTestSave] {len(images)} 张 → {target_dir}/")
        return {}


NODE_CLASS_MAPPINGS = {"ZhuleTestSave": ZhuleTestSave}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleTestSave": "Zhule Test Save"}
