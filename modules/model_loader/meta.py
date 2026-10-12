"""共享 metadata 工具：checkpoint_loader 与 lora_loader 复用。

迁移自 nodes/checkpoint_loader.py 的共享工具段（勿删）。
"""
import os
import json
import random


# ==================== 采样器/调度器选择 ====================

SAMPLER_CHOICES = [
    "euler", "euler_ancestral", "heun", "heunpp2", "dpm_2", "dpm_2_ancestral",
    "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde",
    "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu",
    "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm", "ipndm", "ipndm_v",
    "deis", "res_multistep", "res_multistep_cfg_pp", "res_multistep_ancestral",
    "res_multistep_ancestral_cfg_pp", "gradient_estimation",
    "gradient_estimation_cfg_pp", "er_sde", "seeds_2", "seeds_3",
    "sa_solver", "sa_solver_pece", "uni_pc", "uni_pc_bh2",
]

SCHEDULER_CHOICES = [
    "normal", "karras", "exponential", "sgm_uniform", "simple",
    "ddim_uniform", "beta", "linear_quadratic", "kl_optimal",
]


# ==================== metadata 读取 ====================

def read_meta_json(model_path: str) -> dict:
    """读同目录下 .metadata.json，异常安全，失败返回 {}。"""
    if not model_path:
        return {}
    meta_path = os.path.splitext(model_path)[0] + ".metadata.json"
    if not os.path.isfile(meta_path):
        return {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[Zhule] 读 metadata.json 失败 {os.path.basename(meta_path)}: {e}")
        return {}


def _as_list(value) -> list:
    """标量转单元素列表，列表原样返回，None 返回空列表。"""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _at(values: list, idx: int, default):
    """按索引取值；越界回退到最后一个，空列表用默认值。"""
    if not values:
        return default
    return values[min(idx, len(values) - 1)]


def get_checkpoint_defaults(meta: dict) -> dict:
    """提取推荐参数（原始数组，不挑选）。缺字段补默认值。"""
    base_model = str(meta.get("base_model") or "Unknown")
    rec = meta.get("recommended")
    rec = rec if isinstance(rec, dict) else {}
    return {
        "base_model": base_model,
        "cfgs": _as_list(rec.get("cfg", 7.0)),
        "stepss": _as_list(rec.get("steps", 25)),
        "samplers": _as_list(rec.get("sampler", "euler")),
        "schedulers": _as_list(rec.get("scheduler", "normal")),
    }


def _pick_numeric(values: list, mode: str, default):
    """数值型推荐取值：
    - 单值 → 直接用
    - 二元 [min, max] → 视为范围：random 在范围内随机取，fixed 取中值（避免默认最小）
    - 三元及以上 → 档位列表：random 随机取一个，fixed 取第一个
    """
    vals = [v for v in values if isinstance(v, (int, float))]
    if not vals:
        return default
    if len(vals) == 1:
        return vals[0]
    if len(vals) == 2:
        lo, hi = sorted(vals)
        if mode == "random":
            if all(isinstance(x, int) for x in vals):
                return random.randint(int(lo), int(hi))
            return round(random.uniform(float(lo), float(hi)), 2)
        mid = (lo + hi) / 2
        if all(isinstance(x, int) for x in vals):
            return int(round(mid))
        return round(mid, 2)
    # 档位列表（>=3 项）
    return random.choice(vals) if mode == "random" else vals[0]


def pick_recommended(rec: dict, mode: str,
                     manual_cfg: float, manual_steps: int,
                     manual_sampler: str, manual_scheduler: str) -> tuple:
    """按 mode 挑一组推荐参数 (base_model, cfg, steps, sampler, scheduler)。

    - random: sampler/scheduler 随机一个；cfg/steps 若是范围则范围内随机取
    - fixed: sampler/scheduler 取第一个；cfg/steps 范围取中值、档位列表取第一档
    - manual: 用 manual_* widget 的值
    """
    if mode == "manual":
        return (rec["base_model"], float(manual_cfg), int(manual_steps),
                manual_sampler, manual_scheduler)

    samplers = rec["samplers"] or ["euler"]
    schedulers = rec["schedulers"] or ["normal"]
    n = min(len(samplers), len(schedulers))
    idx = random.randrange(n) if mode == "random" else 0

    cfg = _pick_numeric(rec["cfgs"], mode, 7.0)
    steps = _pick_numeric(rec["stepss"], mode, 25)

    return (
        rec["base_model"],
        float(cfg),
        int(steps),
        samplers[idx],
        schedulers[idx],
    )


def get_trained_words(meta: dict) -> str:
    """读 trainedWords 字段，用 ", " 拼接成字符串。"""
    words = meta.get("trainedWords", [])
    if isinstance(words, list) and words:
        cleaned = [str(w).strip() for w in words if w and str(w).strip()]
        return ", ".join(cleaned)
    return ""


def get_lora_weight(meta: dict):
    """读 weight 字段（Civitai 推荐强度），非法值返回 None。"""
    w = meta.get("weight")
    if w is None:
        return None
    try:
        return float(w)
    except (TypeError, ValueError):
        return None
