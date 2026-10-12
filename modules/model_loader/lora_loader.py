"""ZhuleLoraLoader 节点。迁移自 nodes/lora_loader.py。

共享工具改为从 .meta import（不再从 checkpoint_loader 导入）。
"""
import os

import folder_paths
import comfy.sd
import comfy.utils

from .meta import read_meta_json, get_trained_words, get_lora_weight


def _list_all_loras():
    """扫描所有 lora 文件。"""
    all_loras = folder_paths.get_filename_list("loras")
    all_loras = [l for l in all_loras if l.lower().endswith(".safetensors")]
    return sorted(all_loras)


class ZhuleLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        lora_choices = ["<none>"] + _list_all_loras()

        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "lora_name": (lora_choices,),
                "strength_model": ("FLOAT", {
                    "default": 0.8, "min": -20.0, "max": 20.0, "step": 0.01,
                }),
                "strength_clip": ("FLOAT", {
                    "default": 0.8, "min": -20.0, "max": 20.0, "step": 0.01,
                }),
                "enabled": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "lora_name", "trained_words")
    FUNCTION = "load"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, model, clip, lora_name,
             strength_model, strength_clip, enabled=True):

        # 未选中或禁用 → 原样输出
        if not enabled or lora_name == "<none>" or not lora_name:
            print(f"[ZhuleLoraLoader] 跳过（enabled={enabled}, name={lora_name!r}）")
            return (model, clip, "", "")

        lora_path = folder_paths.get_full_path("loras", lora_name)
        if not lora_path or not os.path.exists(lora_path):
            print(f"[ZhuleLoraLoader] 文件不存在: {lora_name}")
            return (model, clip, "", "")

        # 读 metadata.json（异常兜底，不崩节点）
        try:
            meta = read_meta_json(lora_path)
        except Exception as e:
            print(f"[ZhuleLoraLoader] 读 metadata.json 失败: {e}")
            meta = {}

        # 切换模型后自动使用配置默认 weight（只替换 model，clip 保持手动）
        weight = get_lora_weight(meta)
        if weight is not None:
            strength_model = weight
            print(f"[ZhuleLoraLoader] default weight={weight} -> strength_model")

        # 读触发词
        trained = get_trained_words(meta)
        if trained:
            print(f"[ZhuleLoraLoader] 触发词: {trained}")

        try:
            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            model_out, clip_out = comfy.sd.load_lora_for_models(
                model, clip, lora, strength_model, strength_clip
            )
        except Exception as e:
            print(f"[ZhuleLoraLoader] 加载失败: {lora_name} - {e}")
            return (model, clip, "", trained)

        # 去后缀、去路径，只要纯名字
        base = os.path.basename(lora_name)
        name_no_ext = os.path.splitext(base)[0]

        print(f"[ZhuleLoraLoader] 加载: {lora_name} "
              f"(model={strength_model}, clip={strength_clip})")

        return (model_out, clip_out, name_no_ext, trained)


NODE_CLASS_MAPPINGS = {"ZhuleLoraLoader": ZhuleLoraLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleLoraLoader": "Zhule Lora Loader"}
