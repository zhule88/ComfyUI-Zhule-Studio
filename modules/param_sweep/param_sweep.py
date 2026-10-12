"""ZhuleParamSweep 节点。迁移自 nodes/param_sweep.py。"""
import comfy.samplers


ALL_SAMPLERS = [
    "dpmpp_2m_sde",
    "dpmpp_2m",
    "dpmpp_3m_sde",
    "dpmpp_sde",
    "dpmpp_2s_ancestral",
    "euler",
    "euler_ancestral",
    "uni_pc",
    "heun",
    "lcm",
]

ALL_SCHEDULERS = ["karras", "simple", "normal", "exponential", "sgm_uniform"]

COMBOS = [f"{s}|{sc}" for s in ALL_SAMPLERS for sc in ALL_SCHEDULERS]


class ZhuleParamSweep:
    _mem = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sweep_param": ([
                    "steps",
                    "cfg",
                    "sampler_name",
                    "scheduler",
                    "sampler × scheduler",
                ], {"default": "steps"}),
                "step_current": ("INT", {"default": 20, "min": 1, "max": 500}),
                "step_delta":   ("INT", {"default": 5, "min": 1, "max": 100}),
                "cfg_current":  ("FLOAT", {"default": 6.0, "min": 0.1, "max": 30.0, "step": 0.1}),
                "cfg_delta":    ("FLOAT", {"default": 1.0, "min": 0.1, "max": 20.0, "step": 0.1}),
                "start_combo":  (COMBOS, {"default": "dpmpp_2m_sde|karras"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("INT", "FLOAT", "*", "*", "STRING")
    RETURN_NAMES = ("steps", "cfg", "sampler_name", "scheduler", "dir_signature")
    FUNCTION = "generate"
    CATEGORY = "Zhule"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def generate(self, sweep_param,
                 step_current, step_delta,
                 cfg_current, cfg_delta,
                 start_combo,
                 unique_id=None):

        key = str(unique_id) if unique_id is not None else "global"
        state = self._mem.setdefault(key, {"offset": 0})

        offset = state["offset"]
        state["offset"] = offset + 1

        parts = start_combo.split("|")
        sampler_start = parts[0] if len(parts) > 0 else ALL_SAMPLERS[0]
        scheduler_start = parts[1] if len(parts) > 1 else ALL_SCHEDULERS[0]

        steps = step_current
        cfg = cfg_current
        sampler = sampler_start
        scheduler = scheduler_start

        n_s = len(ALL_SAMPLERS)
        n_sc = len(ALL_SCHEDULERS)

        if sweep_param == "steps":
            steps = step_current + offset * step_delta
        elif sweep_param == "cfg":
            cfg = round(cfg_current + offset * cfg_delta, 4)
        elif sweep_param == "sampler_name":
            i = ALL_SAMPLERS.index(sampler_start) if sampler_start in ALL_SAMPLERS else 0
            sampler = ALL_SAMPLERS[(i + offset) % n_s]
        elif sweep_param == "scheduler":
            j = ALL_SCHEDULERS.index(scheduler_start) if scheduler_start in ALL_SCHEDULERS else 0
            scheduler = ALL_SCHEDULERS[(j + offset) % n_sc]
        elif sweep_param == "sampler × scheduler":
            i = ALL_SAMPLERS.index(sampler_start) if sampler_start in ALL_SAMPLERS else 0
            j = ALL_SCHEDULERS.index(scheduler_start) if scheduler_start in ALL_SCHEDULERS else 0
            k = offset % (n_s * n_sc)
            sampler = ALL_SAMPLERS[(i + k // n_sc) % n_s]
            scheduler = ALL_SCHEDULERS[(j + k % n_sc) % n_sc]

        cfg_str = f"{cfg:g}"
        s_tag = f"s{steps}"
        c_tag = f"c{cfg_str}"

        if sweep_param == "steps":
            # 固定：cfg/sampler/scheduler → 文件夹；变化：steps → 文件名
            dir_signature = f"{c_tag}_{sampler}_{scheduler}/{s_tag}"

        elif sweep_param == "cfg":
            dir_signature = f"{s_tag}_{sampler}_{scheduler}/{c_tag}"

        elif sweep_param == "sampler_name":
            dir_signature = f"{s_tag}_{c_tag}_{scheduler}/{sampler}"

        elif sweep_param == "scheduler":
            dir_signature = f"{s_tag}_{c_tag}_{sampler}/{scheduler}"

        else:  # sampler × scheduler
            # ★ 固定：steps/cfg → 一级文件夹；sampler → 二级文件夹；scheduler → 文件名
            dir_signature = f"{s_tag}_{c_tag}/{sampler}/{scheduler}"

        print(f"[ZhuleParamSweep] #{key} offset={offset} → {dir_signature}")

        return {
            "ui": {
                "current_steps": [steps],
                "current_cfg": [cfg],
                "current_sampler": [sampler],
                "current_scheduler": [scheduler],
            },
            "result": (steps, cfg, sampler, scheduler, dir_signature),
        }


NODE_CLASS_MAPPINGS = {"ZhuleParamSweep": ZhuleParamSweep}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleParamSweep": "Zhule Param Sweep"}
