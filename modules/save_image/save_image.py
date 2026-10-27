"""ZhuleSaveImage v3：固定保存到 output/zhule_studio/zhule_img/。

- 保存位置固定 output/zhule_studio/zhule_img/，文件名 zhule_0001.png 起按全局序号递增
- 元数据写入：
  * prompt / workflow：拖回画布还原工作流
  * zhule_model：优先取输入「自定义模型」，为空时从 prompt 提取主模型；写入前统一去扩展名后缀
  * zhule_loras：优先取输入「自定义lora」，为空时从 prompt 提取 LoRA 列表（数组）；写入前统一去扩展名后缀
  * zhule_prompt_tags：保存时从出图时刻 workflow（ZhuleStudio 输入节点 _selected 快照）
    自动提取的**词条 id 数组**（图库只读）。按 id 存而非词条名，词条改名/移动后标签不脱钩
  * zhule_custom_tags：来自可选输入 自定义标签（JSON 数组字符串）；图库详情页在同一字段上增删，
    是唯一的自定义标签字段（旧 zhule_tags 已并入本字段，存量图由全量重建时迁移）
- 保存后直接把新图写入图库索引（zhule.db），图库不再靠守护线程扫盘发现新图
"""
import json
import os

import numpy as np
from PIL import Image, PngImagePlugin

import folder_paths


OUTPUT_SUBDIR = "zhule_img"
FILE_PREFIX = "zhule"

# class_type 前缀匹配：兼容 CheckpointLoaderSimple / CheckpointLoaderSimpleSD1 / UNETLoader / ZhuleLoraLoader 等
# 模型节点：CheckpointLoader* 用 ckpt_name，UNETLoader/DiffusionLoader 用 unet_name/model_name
MODEL_NODE_PREFIXES = ("ZhuleCheckpointLoader", "CheckpointLoader", "UNETLoader", "DiffusionLoader")
MODEL_NAME_KEYS = ("ckpt_name", "unet_name", "model_name")
LORA_NODE_PREFIXES = ("LoraLoader", "ZhuleLoraLoader")

# 模型/LoRA 文件名扩展名（按长度降序，先匹配长的）
_MODEL_EXTS = (
    ".safetensors", ".safetensor", ".ckpt", ".pth", ".pt",
    ".bin", ".sft", ".onnx", ".gguf",
)


def _strip_ext(name):
    """去除模型/LoRA 文件名扩展名后缀（.safetensors/.ckpt/.pt/.bin/.sft 等）。

    仅去除已知模型扩展名；非模型扩展名或已无后缀的字符串原样返回。
    """
    s = str(name).strip()
    if not s:
        return s
    low = s.lower()
    for ext in _MODEL_EXTS:
        if low.endswith(ext):
            return s[: -len(ext)]
    return s


def _extract_model_and_loras(prompt):
    """从执行 prompt JSON 提取主模型名与 LoRA 名列表。"""
    model = None
    loras = []
    if not isinstance(prompt, dict):
        return model, loras
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        cls = node.get("class_type", "")
        inputs = node.get("inputs") or {}
        if cls.startswith(MODEL_NODE_PREFIXES):
            name = ""
            for key in MODEL_NAME_KEYS:
                v = inputs.get(key)
                if isinstance(v, str) and v.strip():
                    name = v.strip()
                    break
            if name:
                model = name
        elif cls.startswith(LORA_NODE_PREFIXES):
            # 自定义节点（如 ZhuleLoraLoader）带 enabled 开关：enabled=false 时不提取
            if "enabled" in inputs and not inputs.get("enabled"):
                continue
            name = inputs.get("lora_name")
            if isinstance(name, str) and name.strip() and name not in loras:
                loras.append(name.strip())
    return model, loras


def _parse_tags(raw):
    """解析 tags 输入（自定义tags）：JSON 数组字符串；失败则按行拆分。"""
    if not raw:
        return []
    s = str(raw).strip()
    if not s:
        return []
    try:
        data = json.loads(s)
    except (json.JSONDecodeError, TypeError):
        data = None
    if isinstance(data, list):
        return [str(x).strip() for x in data if str(x).strip()]
    if isinstance(data, str) and data.strip():
        return [data.strip()]
    return [line.strip() for line in s.splitlines() if line.strip()]


def _parse_selected(raw):
    """解析 ZhuleStudio _selected：可能是数组或 JSON 数组字符串。
    非 JSON 文本（如整段正向提示词）不再按行拆分成标签，返回 []，避免把提示词段落写入标签。"""
    if isinstance(raw, list):
        return [str(s).strip() for s in raw if str(s).strip()]
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
        if isinstance(data, str) and data.strip():
            return [data.strip()]
    return []


def _extract_prompt_tag_ids(prompt):
    """从执行 prompt JSON 提取提示词 tag 的**词条 id 数组**（与词条显示名解耦）。

    仅取 ZhuleStudio 输入节点 _selected 快照：
    - 元素为 dict 时取 id（词条 id：图库按 id 存，词条改名/移动后标签不脱钩）；
    - 旧数据只有 name 时回退取 name（重建索引时的存量迁移负责转成 id）；
    - 元素为纯字符串（旧格式，整段提示词文本）时原样保留，兼容历史工作流；
    - 无快照时返回空数组，不再把正向提示词文本（前置提示词）按逗号或段落拆成标签。
    返回 list[str]（元素为词条 id 字符串）。
    """
    if not isinstance(prompt, dict):
        return []
    studio = None
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == "ZhuleStudio":
            studio = node
            break
    if studio is None:
        return []
    inputs = studio.get("inputs") or {}

    def _resolve_link(v):
        """["node_id", out_idx] -> 被引用节点输出文本；普通字符串直接返回。"""
        if isinstance(v, str):
            return v
        if (isinstance(v, list) and len(v) == 2
                and isinstance(v[0], (str, int)) and str(v[0]).isdigit()):
            ref = prompt.get(str(v[0]))
            if not isinstance(ref, dict):
                return ""
            cls = ref.get("class_type", "")
            ref_inputs = ref.get("inputs") or {}
            if cls == "ZhuleArtistPicker":
                # slug 数组 -> tag（@前缀）逗号拼接，与节点运行结果一致
                slugs = _parse_selected(ref_inputs.get("_selected"))
                tags = []
                try:
                    from ..artist_picker.node import _load_slug_to_tag
                    mapping = _load_slug_to_tag()
                    for s in slugs:
                        tags.append(mapping.get(s, "@" + s))
                except Exception:
                    tags = ["@" + s for s in slugs]
                return ", ".join(tags)
            # 其它节点无法确定输出，回退空串
            return ""
        return ""

    # 解析 _selected 快照：支持 [{name, content}, ...] 或 ["文本", ...]（旧格式）
    raw = inputs.get("_selected")
    data = None
    if isinstance(raw, list):
        data = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            data = None
    if not isinstance(data, list) or not data:
        return []
    tags = []
    for item in data:
        if isinstance(item, dict):
            # 优先词条 id；旧数据无 id 时回退 name（由重建索引时的存量迁移转 id）
            eid = str(item.get("id") or "").strip()
            if eid:
                tags.append(eid)
                continue
            name = str(item.get("name") or "").strip()
            if name:
                tags.append(name)
        else:
            text = str(item).strip()
            if text:
                tags.append(text)
    return tags


class ZhuleSaveImage:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
            "optional": {
                "自定义标签": ("STRING", {
                    "multiline": False,
                    "default": "",
                    "placeholder": "填写 JSON 数组字符串，如 [\"tag1\", \"tag2\"]",
                }),
                "自定义模型": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "留空自动提取；填写则优先使用，如 anime.safetensors",
                }),
                "自定义lora": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "留空自动提取；填写则优先使用，JSON 数组字符串",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    @staticmethod
    def _next_seq(output_dir):
        """扫描目录取最大 zhule_<n>.png 序号，返回下一个。"""
        seq = 0
        if os.path.isdir(output_dir):
            prefix_len = len(FILE_PREFIX) + 1
            for f in os.scandir(output_dir):
                if not f.is_file() or not f.name.endswith(".png"):
                    continue
                base = f.name[:-4]
                if base.startswith(FILE_PREFIX + "_") and base[prefix_len:].isdigit():
                    seq = max(seq, int(base[prefix_len:]))
        return seq + 1

    def save(self, 图像, 自定义标签="", 自定义模型="", 自定义lora="",
             prompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
        manual_model = str(自定义模型 or "").strip()
        manual_loras_raw = 自定义lora
        output_dir = os.path.join(
            folder_paths.get_output_directory(), "zhule_studio", OUTPUT_SUBDIR)
        os.makedirs(output_dir, exist_ok=True)

        seq = self._next_seq(output_dir)
        model, loras = _extract_model_and_loras(prompt)
        # 手动输入优先：填了自定义模型/LoRA 就覆盖自动提取结果
        if manual_model:
            model = manual_model
        manual_loras = _parse_tags(manual_loras_raw)
        if manual_loras:
            loras = manual_loras
        # 无论来源，写入前统一去除扩展名后缀（图库快速访问用，不带 .safetensors 等）
        if model:
            model = _strip_ext(model)
        if loras:
            loras = [_strip_ext(x) for x in loras if _strip_ext(x)]
        prompt_tag_ids = _extract_prompt_tag_ids(prompt)
        custom_tags = _parse_tags(自定义标签)

        saved = []
        for i, img in enumerate(图像):
            arr = (img.cpu().numpy() * 255).astype(np.uint8)
            image = Image.fromarray(arr)
            file_name = f"{FILE_PREFIX}_{seq + i:04d}.png"
            full_path = os.path.join(output_dir, file_name)

            metadata = PngImagePlugin.PngInfo()
            if prompt is not None:
                metadata.add_text("prompt", json.dumps(prompt))
            if extra_pnginfo and "workflow" in extra_pnginfo:
                metadata.add_text(
                    "workflow", json.dumps(extra_pnginfo["workflow"])
                )
            if model:
                metadata.add_text("zhule_model", model)
            if loras:
                metadata.add_text("zhule_loras", json.dumps(loras))
            if prompt_tag_ids:
                metadata.add_text("zhule_prompt_tags",
                                 json.dumps(prompt_tag_ids))
            if custom_tags:
                metadata.add_text("zhule_custom_tags", json.dumps(custom_tags))

            image.save(full_path, pnginfo=metadata, compress_level=4)
            saved.append((file_name, full_path))
            print(f"[ZhuleSaveImage] 保存 {file_name}  model={model or '-'} "
                  f"loras={loras or '-'} prompt_tags={prompt_tag_ids or '-'} "
                  f"tags={custom_tags or '-'}")
        print(f"[ZhuleSaveImage] 共保存 {len(图像)} 张 -> {output_dir}")
        # 新图直接入图库索引（写入点维护，不再有守护线程扫盘）；图库模块缺失时静默跳过
        if saved:
            try:
                from ..studio import gallery
                gallery.index_new(saved)
            except Exception:
                pass
        return {}


NODE_CLASS_MAPPINGS = {"ZhuleSaveImage": ZhuleSaveImage}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleSaveImage": "Zhule Save Image"}
