import json
import re

from nodes import CLIPTextEncode


# ============================================================
# 提示词段解析 / 排除词引擎
# ============================================================
# 段分隔：半角逗号、全角逗号、顿号、分号、换行（提示词里这些都是分隔符）
_SEG_SPLIT = re.compile(r"[,，、;；\n\r]+")
# 段内分词：空白（含全角空格）
_TOK_SPLIT = re.compile(r"[\s\u3000]+")


def _split_segments(text):
    """把一段提示词文本切成「逗号段」列表（去空白、丢空段）。"""
    if not isinstance(text, str):
        return []
    out = []
    for raw in _SEG_SPLIT.split(text):
        seg = raw.strip()
        if seg:
            out.append(seg)
    return out


def _parse_filters(override):
    """排除词文本 → [[word, ...], ...]。

    规则：按逗号（中/英）、顿号、分号、换行拆成多个「排除条件」，
    每个条件内部再按空格拆词；条件内任一命中即算命中（写 hair 就能拦下所有颜色头发）。
    """
    groups = []
    if not isinstance(override, str) or not override.strip():
        return groups
    for raw in _SEG_SPLIT.split(override):
        words = [w.lstrip("+") for w in _TOK_SPLIT.split(raw.strip().lower())]
        words = [w for w in words if w]
        if words:
            groups.append(words)
    return groups


_COARSE_CACHE = {}


def _coarse_pattern(words):
    """并集正则（键为词元组，命中缓存）：一次扫描即可判断某段是否可能被排除。"""
    pat = _COARSE_CACHE.get(words)
    if pat is None:
        pat = re.compile("|".join(re.escape(w) for w in words))
        _COARSE_CACHE[words] = pat
    return pat


def build_prompt(items, prefix=""):
    """词条 items → (正面提示词, 负面提示词)。

    items 每项：{id, name, content, neg?, override?}

    排除词（override）语义：
    - 只作用于「别的词条」产出的提示词段，永远不删自己那一条（这就是手动选发型、
      在发型词条里写 hair 去排除角色词条自带 hair 的用法）；
    - 粒度是「逗号段」：命中即删掉该段，同一条目里的其它段保留；
    - 汇总口径：把所有条目的排除词并成一个大池，对每个段先做一次并集正则粗筛，
      命中后再逐条件细判并跳过同源条件（粗筛一次扫描，词多了也不会退化成双 for）。
    """
    items = [i for i in items if isinstance(i, dict)]

    # 1) 展开为「段 + 来源 id」
    segments = []
    for item in items:
        src = str(item.get("id") or "")
        for seg in _split_segments(item.get("content", "")):
            segments.append((src, seg))

    # 2) 展开排除条件为「来源 id + 词 + 是否 AND」
    filters = []
    for item in items:
        src = str(item.get("id") or "")
        for words in _parse_filters(item.get("override", "")):
            filters.append((src, words))

    # 3) 并集正则粗筛（一次扫描判断「这段有没有可能被删」）
    kept = []
    if filters:
        all_words = tuple(sorted({w for _, ws in filters for w in ws}, key=len, reverse=True))
        coarse = _coarse_pattern(all_words)
        for src, seg in segments:
            low = seg.lower()
            if not coarse.search(low):
                kept.append(seg)
                continue
            # 命中粗筛才细判：逐条件核对，跳过与段同源的条件（不删自己）
            matched = False
            for fsrc, words in filters:
                if fsrc == src:
                    continue
                if any(w in low for w in words):
                    matched = True
                    break
            if not matched:
                kept.append(seg)
    else:
        kept = [seg for _, seg in segments]

    # 4) 正面提示词：前置提示词 + 逗号段
    selected = ", ".join(kept)
    if prefix and selected:
        positive = prefix + ", " + selected
    else:
        positive = prefix or selected

    # 5) 负面提示词：所有条目 neg 汇总（按段拆、小写去重、保序）
    negs, seen = [], set()
    for item in items:
        for seg in _split_segments(item.get("neg", "")):
            key = seg.lower()
            if key in seen:
                continue
            seen.add(key)
            negs.append(seg)
    return positive, ", ".join(negs)


class ZhuleStudio:
    """Prompt Manager：网页选词 + 节点内前置/负面提示词，输出双 CONDITIONING。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "用于编码提示词的 CLIP 模型"}),
                "ID": (
                    "STRING",
                    {"default": "", "tooltip": "全局ID：词库网页按它定位本节点，请手动填写且保证各工作流间唯一"},
                ),
                "前置提示词": (
                    "STRING",
                    {"multiline": True, "default": "", "tooltip": "拼接到网页所选提示词的前面"},
                ),
                "负面提示词": (
                    "STRING",
                    {"multiline": True, "default": "", "tooltip": "负面提示词（词条自带的负面提示词会自动追加在其后）"},
                ),
            },
            "hidden": {"_selected": ("STRING", {"default": "[]"})},
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正面提示词", "负面提示词")
    FUNCTION = "encode"
    CATEGORY = "Zhule"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def _parse_items(self, _selected="[]"):
        try:
            items = json.loads(_selected) if isinstance(_selected, str) else _selected
        except Exception:
            items = []
        if not isinstance(items, list):
            items = []
        return [i for i in items if isinstance(i, dict)]

    def encode(self, clip, ID="", 前置提示词="", 负面提示词="", _selected="[]"):
        items = self._parse_items(_selected)
        # widget _selected 有词条（词库页驱动时 studio.js 已写入本轮真实 items，含遍历/随机池
        # 抽出的校服词条）→ 以它为准，避免 state 文件滞后导致出图雷同；为空（新节点/画布手动 Run）
        # 则无词条，只保留手填内容。
        positive, neg_extra = build_prompt(items, 前置提示词 or "")
        if neg_extra:
            negative = (负面提示词 + ", " + neg_extra) if 负面提示词 else neg_extra
        else:
            negative = 负面提示词

        encoder = CLIPTextEncode()
        return (
            encoder.encode(clip, positive)[0],
            encoder.encode(clip, negative)[0],
        )


NODE_CLASS_MAPPINGS = {"ZhuleStudio": ZhuleStudio}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleStudio": "Zhule Studio"}
