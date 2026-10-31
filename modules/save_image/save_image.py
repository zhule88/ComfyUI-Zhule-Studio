"""ZhuleSaveImage v3：固定保存到 output/zhule_studio/zhule_img/。

- 保存位置固定 output/zhule_studio/zhule_img/，文件名 zhule_0001.png 起按全局序号递增
- 元数据写入：
  * prompt / workflow：拖回画布还原工作流
  * zhule_model：优先取输入「自定义模型」，为空时从 prompt 提取主模型；写入前先归一
    （去目录 + 去后缀：绝对路径会被截成纯文件名，否则按绝对路径入库会污染筛选列表），
    再到 model 表取 id，最终写成**单个对象** {"id":..,"n":..}——id 跟随改名，n 兜底
  * zhule_loras：优先取输入「自定义lora」，为空时从 prompt 提取 LoRA 列表（数组）；
    归一与取 id 同上，每个元素一个对象，而不是 id/name 占两个字段
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
    """解析 tags 输入（自定义标签）：JSON 数组字符串；否则按逗号/换行拆分。

    层级路径以 / 分隔段（如 角色/绝区零/尼克），多个路径用英文逗号分隔。
    """
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
    out = []
    for line in s.replace("，", ",").splitlines():
        for part in line.split(","):
            p = part.strip().strip("/")
            if p:
                out.append(p)
    return out


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
                    "placeholder": "以 / 分隔的层级标签路径，如 角色/绝区零/尼克；多个用英文逗号分隔",
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

    def save(self, 图像, 自定义标签="",
             prompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
        output_dir = os.path.join(
            folder_paths.get_output_directory(), "zhule_studio", OUTPUT_SUBDIR)
        os.makedirs(output_dir, exist_ok=True)

        seq = self._next_seq(output_dir)
        # 模型/LoRA 一律由 prompt 自动提取（不再支持自定义输入覆盖）
        model, loras = _extract_model_and_loras(prompt)
        # 无论来源，写入前统一归一（去目录 + 去后缀）。绝对路径在这里被截成纯文件名，
        # 否则模型会按绝对路径入库：筛选列表出现一坨巨长条目，还和同名真名裂成两条。
        # id 与 name 合成一个对象写入：只占一个字段，改名后自动跟随，名字做兜底。
        try:
            from ..studio import db as _db
        except Exception:
            _db = None
        if _db is not None:
            model_ref = _db.model_ref(_db.MODEL_TYPE_MODEL, model) if model else None
            lora_refs = [r for r in (_db.model_ref(_db.MODEL_TYPE_LORA, x)
                                     for x in loras) if r] if loras else []
        else:
            model_ref = {"n": _strip_ext(model)} if model else None
            lora_refs = [{"n": y} for y in (_strip_ext(x) for x in loras)
                         if y] if loras else []
        # 日志仍按展示名打印，保持与旧日志一致
        model = (model_ref or {}).get("n") or ""
        loras = [r.get("n") for r in lora_refs if isinstance(r, dict)]
        prompt_tag_ids = _extract_prompt_tag_ids(prompt)
        # 自定义标签：按 / 路径逐级注册（顶层 parent_id=NULL，独立路径不合并），
        # 写对象数组 {"id":叶子id, "p":完整路径, "n":叶子名}；读取侧按 id 取当前路径，
        # 取不到才用 p/n 兜底，图库与 PNG 元数据保持一致
        custom_tags = _parse_tags(自定义标签)
        if _db is not None:
            pt_refs = _db.tag_refs(prompt_tag_ids)
            ct_refs = [r for r in (_db.custom_tag_path_ref(x) for x in custom_tags)
                       if r]
        else:
            pt_refs = [{"id": int(x), "n": ""}
                       for x in prompt_tag_ids if str(x).strip().isdigit()]
            ct_refs = [{"p": x.strip("/"), "n": x.strip("/").rsplit("/", 1)[-1]}
                       for x in custom_tags if x and x.strip("/")]

        saved = []
        # 先入库拿到行 id（图片身份），写进 PNG 元数据后再落盘；
        # 落盘完成由 index_new 补齐 mtime/size，id 保持不变
        _ids = _db.gallery_reserve(
            [f"{FILE_PREFIX}_{seq + i:04d}.png" for i in range(len(图像))]
        ) if _db is not None else {}
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
            if model_ref:
                metadata.add_text("zhule_model",
                                  json.dumps(model_ref, ensure_ascii=False))
            if lora_refs:
                metadata.add_text("zhule_loras",
                                  json.dumps(lora_refs, ensure_ascii=False))
            # 图片自身身份：图库行的 id。文件被改名后靠它认回同一行
            _sid = _ids.get(file_name)
            if _sid:
                metadata.add_text("zhule_id", str(_sid))
            if pt_refs:
                metadata.add_text("zhule_prompt_tags",
                                  json.dumps(pt_refs, ensure_ascii=False))
            if ct_refs:
                metadata.add_text("zhule_custom_tags",
                                  json.dumps(ct_refs, ensure_ascii=False))

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
