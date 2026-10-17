"""词库参考图自动生成（images.txt）。

反向遍历：以图库 output/zhule_img 下的图片为主体（含子目录递归），读取每张图的
tag 元数据（三源合并：zhule_tags 手动 + zhule_prompt_tags 提示词选中词 +
zhule_custom_tags 自定义，与 gallery._merge_tag_sources 一致），用 tag 反查词库卡片
（卡片 = prompt/ 中含 prompt.txt 的目录，标识名 = 目录名去掉数字前缀，如
01_琴 → 琴），把匹配图片以"相对 output/" 的路径（每行一个）写入对应卡片的
images.txt。仅按需从卡片目录名建立一次标识名索引，主循环不遍历 prompt 树。

幂等：重复启动结果一致（内容相同则不重写）。无匹配的卡片不生成/不修改已有文件。
失败不影响插件启动（调用方 try/except 包裹）。
"""
import json
import os

from ..common.paths import _get_output_dir
from . import png_text
from .api import WORD_BANK_ROOT, parse_folder
from .gallery import INDEX_FILE, _merge_tag_sources, _scan_images

GALLERY_ROOT = os.path.join(_get_output_dir(), "zhule_img")
IMAGES_FILE = "images.txt"
MAIN_FILE = "prompt.txt"


def _load_index_records():
    """读 gallery/index.json 的图库索引，返回 [(key, tags), ...]；索引不可用返回 None。

    key 为相对图库根（zhule_img/）的路径；tags 已是三源合并结果
    （gallery 构建索引时调用 _merge_tag_sources，与本模块语义一致）。
    相比逐张读 PNG（全量 16.7GB IO），仅读单个 JSON（几 MB）。
    """
    try:
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return None
    records = payload.get("records") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        return None
    out = []
    for r in records:
        if not isinstance(r, dict):
            continue
        key = r.get("key")
        tags = r.get("tags")
        if not key or not isinstance(tags, list):
            continue
        cleaned = [str(t).strip() for t in tags if str(t).strip()]
        if cleaned:
            out.append((str(key), cleaned))
    return out or None


def _card_name_index(root):
    """建立卡片标识名索引：标识名 -> [含 prompt.txt 的卡片目录绝对路径, ...]。

    同名卡片（不同父目录）共用同一标识名，都会收到匹配图片。
    """
    index = {}
    if not os.path.isdir(root):
        return index
    for cur, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        if MAIN_FILE in files:
            name = parse_folder(os.path.basename(cur))[1]
            if name:
                index.setdefault(name, []).append(cur)
    return index


def _write_images_txt(folder, lines):
    """原子写入 images.txt（相对 output/ 路径，每行一个）。内容相同则跳过。"""
    path = os.path.join(folder, IMAGES_FILE)
    text = "\n".join(lines) + "\n" if lines else ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            if f.read() == text:
                return "unchanged"
    except OSError:
        pass
    tmp = path + ".gen_tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)
    return "written"


def generate_images_txt(word_bank_root=None, gallery_root=None, dry_run=False):
    """以图库图片为主体，反查词库卡片并汇总写入 images.txt。

    返回统计 dict：
      cards         有匹配的卡片数
      images        图库图片总数
      matched       有匹配的图片数
      written       实际写入文件的卡片数
      unchanged     内容相同未重写的卡片数
      skipped       无匹配未处理的卡片数
      examples      示例 [{card, folder, count, first}]
    """
    wb = os.path.abspath(word_bank_root or WORD_BANK_ROOT)
    g_root = os.path.abspath(gallery_root or GALLERY_ROOT)

    # 卡片标识名索引（唯一一次 prompt 目录访问，主循环不遍历 prompt 树）
    name_index = _card_name_index(wb)

    # 图库数据源：优先读 gallery/index.json（零 PNG IO）；索引不可用时回退全量扫 PNG
    index_records = _load_index_records()
    if index_records is not None:
        image_entries = [("zhule_img/" + key.replace(os.sep, "/"), tags)
                         for key, tags in index_records]
    else:
        image_entries = []
        for rel, full in _scan_images(g_root):
            texts = png_text.read_png_text(full)
            tags = _merge_tag_sources(texts)
            if tags:
                image_entries.append(("zhule_img/" + rel.replace(os.sep, "/"), tags))

    # 按图片 tag 反查卡片，汇总命中：卡片目录 -> set(相对 output/ 图片路径)
    card_hits = {}
    matched_images = 0
    for output_rel, tags in image_entries:
        hit = False
        for t in tags:
            folders = name_index.get(t)
            if not folders:
                continue
            hit = True
            for folder in folders:
                card_hits.setdefault(folder, set()).add(output_rel)
        if hit:
            matched_images += 1

    stats = {
        "cards": len(card_hits),
        "images": len(image_entries),
        "matched": matched_images,
        "written": 0,
        "unchanged": 0,
        "skipped": 0,
        "examples": [],
    }

    for folder in sorted(card_hits):
        hits = sorted(card_hits[folder])
        if not hits:
            stats["skipped"] += 1
            continue
        if not dry_run:
            status = _write_images_txt(folder, hits)
            if status == "written":
                stats["written"] += 1
            else:
                stats["unchanged"] += 1
        if len(stats["examples"]) < 5:
            stats["examples"].append({
                "card": parse_folder(os.path.basename(folder))[1],
                "folder": os.path.relpath(folder, wb).replace(os.sep, "/"),
                "count": len(hits),
                "first": hits[0],
            })

    if dry_run:
        stats["written"] = stats["unchanged"] = 0
    return stats


def main():
    """命令行入口：python -m modules.studio.images_gen [--dry-run]"""
    import sys
    dry = "--dry-run" in sys.argv
    result = generate_images_txt(dry_run=dry)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
