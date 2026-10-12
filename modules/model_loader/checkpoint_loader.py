"""ZhuleCheckpointLoader 节点。迁移自 nodes/checkpoint_loader.py。"""
import os

import folder_paths
import comfy.sd
import comfy.samplers

from .meta import (
    SAMPLER_CHOICES,
    SCHEDULER_CHOICES,
    read_meta_json,
    get_checkpoint_defaults,
    pick_recommended,
)


class ZhuleCheckpointLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name": (folder_paths.get_filename_list("checkpoints"),),
                "mode": (["random", "fixed", "manual"], {"default": "random"}),
                "manual_cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 30.0, "step": 0.1}),
                "manual_steps": ("INT", {"default": 25, "min": 1, "max": 150, "step": 1}),
                "manual_sampler": (SAMPLER_CHOICES, {"default": "euler"}),
                "manual_scheduler": (SCHEDULER_CHOICES, {"default": "normal"}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "STRING",
                    "FLOAT", "INT",
                    comfy.samplers.KSampler.SAMPLERS,
                    comfy.samplers.KSampler.SCHEDULERS)
    RETURN_NAMES = ("MODEL", "CLIP", "VAE", "model_name",
                    "cfg", "steps", "sampler_name", "scheduler")
    FUNCTION = "load"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, ckpt_name,
             mode="random", manual_cfg=7.0, manual_steps=25,
             manual_sampler="euler", manual_scheduler="normal"):
        ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)

        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        model, clip, vae = out[:3]

        # 去路径、去后缀，只要纯名字
        base = os.path.basename(ckpt_name)
        name_no_ext = os.path.splitext(base)[0]

        # 读推荐参数（异常兜底，不崩节点）
        try:
            rec = get_checkpoint_defaults(read_meta_json(ckpt_path))
            _, cfg, steps, sampler_name, scheduler = pick_recommended(
                rec, mode, manual_cfg, manual_steps, manual_sampler, manual_scheduler)
        except Exception as e:
            print(f"[ZhuleCheckpointLoader] 读取推荐参数失败: {e}")
            cfg, steps, sampler_name, scheduler = 7.0, 25, "euler", "normal"

        print(f"[ZhuleCheckpointLoader] 加载: {ckpt_name} -> "
              f"cfg={cfg} steps={steps} {sampler_name}/{scheduler} (mode={mode})")

        return (model, clip, vae, name_no_ext,
                cfg, steps, sampler_name, scheduler)


NODE_CLASS_MAPPINGS = {"ZhuleCheckpointLoader": ZhuleCheckpointLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleCheckpointLoader": "Zhule Checkpoint Loader"}
