"""ZhuleSaveImage 节点。迁移自 nodes/save_image.py。"""
import os
import re

import numpy as np
from PIL import Image

import folder_paths


# ==================== 内部常量 ====================
BUCKET_SIZE = 100
BUCKET_DIGITS = 2
FILE_DIGITS = 2

MAX_LINK_INPUTS = 16
LINK_PREFIX = "link_"

# ★ 未提供 model_name / lora_name 时的兜底文件夹名
DEFAULT_FOLDER = "_默认"


def _strip_numeric_prefix(name: str) -> str:
    if "_" in name:
        head, tail = name.split("_", 1)
        if head.isdigit():
            return tail
    return name


def make_hardlink_or_copy(src, dst):
    if os.path.exists(dst):
        try:
            if os.path.samefile(src, dst):
                return True, "exists_same"
        except OSError:
            pass
        try:
            os.remove(dst)
        except OSError as e:
            print(f"[ZhuleSaveImage] 删除旧文件失败: {dst} - {e}")
            return False, "failed"

    try:
        os.link(src, dst)
        return True, "hardlink"
    except OSError:
        try:
            import shutil
            shutil.copy2(src, dst)
            return True, "copy"
        except Exception as e2:
            print(f"[ZhuleSaveImage] 链接/复制失败: {src} → {dst} - {e2}")
            return False, "failed"


class ZhuleSaveImage:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "folder_path": ("STRING", {
                    "default": "",
                    "forceInput": False,
                }),
                "bucket_prefix": ("STRING", {"default": ""}),
                "file_prefix": ("STRING", {"default": ""}),
            },
            "optional": {
                "model_name": ("STRING", {"forceInput": True}),
                "lora_name": ("STRING", {"forceInput": True}),
                **{f"{LINK_PREFIX}{i}": ("STRING", {"forceInput": True})
                   for i in range(1, MAX_LINK_INPUTS + 1)},
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
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
    def _find_current_position(base_dir, bucket_prefix, file_prefix):
        if not os.path.isdir(base_dir):
            return 1, 0

        bucket_pattern = re.compile(rf"^{re.escape(bucket_prefix)}_(\d+)$")
        max_bucket = 0
        for entry in os.scandir(base_dir):
            if not entry.is_dir():
                continue
            m = bucket_pattern.match(entry.name)
            if m:
                try:
                    max_bucket = max(max_bucket, int(m.group(1)))
                except ValueError:
                    pass

        if max_bucket == 0:
            return 1, 0

        bucket_name = f"{bucket_prefix}_{max_bucket:0{BUCKET_DIGITS}d}"
        bucket_dir = os.path.join(base_dir, bucket_name)

        file_pattern = re.compile(
            rf"^{re.escape(file_prefix)}_(\d+)_(\d+)\.png$",
            re.IGNORECASE,
        )
        max_file = -1
        if os.path.isdir(bucket_dir):
            for f in os.scandir(bucket_dir):
                if not f.is_file():
                    continue
                m = file_pattern.match(f.name)
                if m:
                    try:
                        max_file = max(max_file, int(m.group(2)))
                    except ValueError:
                        pass

        next_idx = max_file + 1
        if next_idx >= BUCKET_SIZE:
            return max_bucket + 1, 0

        return max_bucket, next_idx

    def save(self, images, folder_path, bucket_prefix, file_prefix,
             model_name=None, lora_name=None,
             unique_id=None, **kwargs):

        output_dir = folder_paths.get_output_directory()
        norm = folder_path.replace("\\", "/").strip("/")

        # 前缀兜底（用原始 folder_path 的末段）
        if not bucket_prefix.strip():
            if norm:
                last_seg = norm.split("/")[-1]
                bucket_prefix = _strip_numeric_prefix(last_seg) or "img"
            else:
                bucket_prefix = "img"
        if not file_prefix.strip():
            file_prefix = bucket_prefix

        # ★ model / lora 兜底值
        m = (model_name or "").strip() or DEFAULT_FOLDER
        l = (lora_name or "").strip() or DEFAULT_FOLDER

        # ★★★ 关键改动：model / lora 放在 folder_path 前面 ★★★
        # 结果：output / model / lora / folder_path / 桶 / 文件
        if norm:
            base_dir = os.path.join(output_dir, m, l, *norm.split("/"))
        else:
            base_dir = os.path.join(output_dir, m, l)

        # ==================== 收集额外链接目录 ====================
        link_dirs = []
        indexed_links = []
        for name, value in kwargs.items():
            if not name.startswith(LINK_PREFIX):
                continue
            try:
                idx = int(name[len(LINK_PREFIX):])
            except ValueError:
                continue
            indexed_links.append((idx, value))

        for _, value in sorted(indexed_links):
            if value is None:
                continue
            v = str(value).strip()
            if not v:
                continue
            for line in v.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if os.path.isabs(line):
                    link_dirs.append(line)
                else:
                    link_dirs.append(os.path.join(output_dir, line))

        link_dirs = list(dict.fromkeys(link_dirs))

        # ==================== 扫描起点 ====================
        start_bucket, start_file_idx = self._find_current_position(
            base_dir, bucket_prefix, file_prefix,
        )

        print(f"[ZhuleSaveImage] 主目录={m}/{l}/{norm or '.'} "
              f"bucket_prefix='{bucket_prefix}' file_prefix='{file_prefix}' "
              f"桶={start_bucket} 下一个桶内编号={start_file_idx} "
              f"额外链接={len(link_dirs)} 个")

        # ==================== 循环写图 ====================
        last_bucket = ""
        for i, img in enumerate(images):
            total = start_file_idx + i
            bucket_offset = total // BUCKET_SIZE
            local_idx = total % BUCKET_SIZE

            bucket_no = start_bucket + bucket_offset
            bucket_name = f"{bucket_prefix}_{bucket_no:0{BUCKET_DIGITS}d}"
            file_name = (
                f"{file_prefix}_{bucket_no:0{BUCKET_DIGITS}d}"
                f"_{local_idx:0{FILE_DIGITS}d}.png"
            )

            # 主输出：output / model / lora / folder_path / 桶 / 文件
            save_dir = os.path.join(base_dir, bucket_name)
            os.makedirs(save_dir, exist_ok=True)
            full_path = os.path.join(save_dir, file_name)

            arr = (img.cpu().numpy() * 255).astype(np.uint8)
            Image.fromarray(arr).save(full_path)
            last_bucket = bucket_name

            # ==================== 硬链接：link / model / lora / 文件 ====================
            for link_base in link_dirs:
                link_dir = os.path.join(link_base, m, l)
                os.makedirs(link_dir, exist_ok=True)
                link_path = os.path.join(link_dir, file_name)
                ok, mode = make_hardlink_or_copy(full_path, link_path)
                if mode == "hardlink":
                    print(f"[ZhuleSaveImage]   硬链接: {link_path}")
                elif mode == "copy":
                    print(f"[ZhuleSaveImage]   ⚠️ 复制（硬链接失败）: {link_path}")
                elif mode == "failed":
                    print(f"[ZhuleSaveImage]   ❌ 失败: {link_path}")

        # ==================== 落点日志 ====================
        end_total = start_file_idx + len(images) - 1
        end_bucket = start_bucket + end_total // BUCKET_SIZE
        end_local = end_total % BUCKET_SIZE

        print(f"[ZhuleSaveImage] 保存 {len(images)} 张 → "
              f"{m}/{l}/{norm or '<空>'} / {last_bucket} / "
              f"(桶 {start_bucket}~{end_bucket}，"
              f"最后一张 {file_prefix}_{end_bucket:0{BUCKET_DIGITS}d}"
              f"_{end_local:0{FILE_DIGITS}d}.png)")

        return {}


NODE_CLASS_MAPPINGS = {"ZhuleSaveImage": ZhuleSaveImage}
NODE_DISPLAY_NAME_MAPPINGS = {"ZhuleSaveImage": "Zhule Save Image"}
