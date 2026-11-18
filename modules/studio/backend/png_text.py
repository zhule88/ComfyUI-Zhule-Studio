"""PNG tEXt chunk 读写工具（二进制级，不重编码像素）。

用途：
- read_png_text(path)：扫描 tEXt / zTXt / iTXt chunk，返回 {keyword: value}（解压 zTXt，iTXt 取 utf8）
- write_png_text(path, updates)：按 keyword 替换/新增 tEXt chunk（新增插到 IEND 前），
  写入后恢复原 mtime（打标不改变图片创建时间，保持默认时间倒序稳定）。

性能：不解码像素，仅遍历 chunk 头，约 0.1ms/张。
"""
import os
import struct
import zlib

_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_MAX_SIZE = 200 * 1024 * 1024  # 200MB 上限，防止误操作超大文件


def _iter_chunks(data):
    """按 (type, data, offset, length) 迭代 PNG chunk，不含签名。"""
    pos = 8
    n = len(data)
    while pos + 8 <= n:
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        body_start = pos + 8
        body_end = body_start + length
        if body_end + 4 > n:
            break
        yield ctype, data[body_start:body_end], pos, length
        pos = body_end + 4  # 跳过 CRC


def _parse_text_chunk(ctype, body):
    """解析单个文本 chunk 为 (keyword, value)；非文本 chunk 返回 None。"""
    if ctype == b"tEXt":
        idx = body.find(b"\x00")
        if idx <= 0:
            return None
        return body[:idx].decode("latin-1", "replace"), body[idx + 1:].decode("utf-8", "replace")
    if ctype == b"zTXt":
        idx = body.find(b"\x00")
        if idx <= 0 or idx + 1 >= len(body):
            return None
        kw = body[:idx].decode("latin-1", "replace")
        method = body[idx + 1]
        try:
            raw = body[idx + 2:]
            if method == 0:
                val = zlib.decompress(raw).decode("utf-8", "replace")
            else:
                val = raw.decode("utf-8", "replace")
        except Exception:
            val = ""
        return kw, val
    if ctype == b"iTXt":
        idx = body.find(b"\x00")
        if idx <= 0:
            return None
        kw = body[:idx].decode("latin-1", "replace")
        # keyword\0 compressFlag\0 method\0 lang\0 translated\0 text
        rest = body[idx + 1:]
        if len(rest) < 5:
            return kw, ""
        comp_flag = rest[0]
        rest = rest[2:]  # skip method
        # 跳过 language 与 translated keyword（各自 \0 结尾）
        try:
            while rest and rest[0] != 0:
                rest = rest[1:]
            rest = rest[1:]
            while rest and rest[0] != 0:
                rest = rest[1:]
            rest = rest[1:]
        except Exception:
            return kw, ""
        try:
            val = zlib.decompress(rest).decode("utf-8", "replace") if comp_flag else rest.decode("utf-8", "replace")
        except Exception:
            val = ""
        return kw, val
    return None


def read_png_text(path):
    """返回 {keyword: value}。非 PNG / 读取失败返回空 dict。"""
    out = {}
    try:
        with open(path, "rb") as f:
            data = f.read(_MAX_SIZE + 1)
    except Exception:
        return out
    if len(data) < 24 or not data.startswith(_PNG_SIG):
        return out
    try:
        for ctype, body, _, _ in _iter_chunks(data):
            parsed = _parse_text_chunk(ctype, body)
            if parsed:
                out.setdefault(parsed[0], parsed[1])
    except Exception:
        pass
    return out


def _crc(ctype, body):
    return struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)


def _make_chunk(ctype, body):
    return struct.pack(">I", len(body)) + ctype + body + _crc(ctype, body)


def write_png_text(path, updates):
    """更新 PNG 文本元数据：updates = {keyword: value}。

    - value 为 None 表示删除该 keyword 的文本 chunk
    - 已存在的同名 chunk：原位替换（zTXt/iTXt 同名也替换为 tEXt，统一格式）
    - 新增：插入到 IEND 之前（PNG 规范允许文本块位于 IDAT 后、IEND 前）
    - 完成后恢复原文件 mtime（时间排序不受打标影响）
    返回 True/False。
    """
    if not updates:
        return True
    try:
        with open(path, "rb") as f:
            data = f.read(_MAX_SIZE + 1)
    except Exception:
        return False
    if len(data) < 24 or not data.startswith(_PNG_SIG):
        return False

    # 收集所有 chunk，同时记录同名文本 chunk 的 offset（用于原位替换）
    chunks = []  # (ctype, body, pos, length)
    replace_pos = {}  # keyword -> pos（同名文本 chunk 的原位位置）
    for ctype, body, pos, length in _iter_chunks(data):
        chunks.append((ctype, body, pos, length))
        parsed = _parse_text_chunk(ctype, body)
        if parsed:
            replace_pos.setdefault(parsed[0], pos)

    new_chunks = []
    replaced = set()
    for ctype, body, pos, length in chunks:
        parsed = _parse_text_chunk(ctype, body)
        if parsed and parsed[0] in updates:
            kw = parsed[0]
            val = updates[kw]
            if val is None:
                continue  # 删除
            if pos == replace_pos.get(kw):
                # 原位替换为 tEXt
                new_chunks.append((b"tEXt", kw.encode("latin-1", "replace") + b"\x00" + val.encode("utf-8"), pos, 0))
                replaced.add(kw)
                continue
        new_chunks.append((ctype, body, pos, length))

    # 新增：插到 IEND 前
    adds = []
    for kw, val in updates.items():
        if val is None or kw in replaced:
            continue
        adds.append((b"tEXt", kw.encode("latin-1", "replace") + b"\x00" + val.encode("utf-8"), -1, 0))

    out = bytearray(data[:8])  # 签名
    for ctype, body, pos, length in new_chunks:
        if ctype == b"IEND" and adds:
            # 新增文本块必须插在 IEND 之前，否则标准解析器（PIL/浏览器）会忽略
            for ctype_a, body_a, _, _ in adds:
                out.extend(_make_chunk(ctype_a, body_a))
        out.extend(_make_chunk(ctype, body))

    try:
        mtime = os.path.getmtime(path)
        tmp = path + ".zhule_tmp"
        with open(tmp, "wb") as f:
            f.write(bytes(out))
        os.replace(tmp, path)
        os.utime(path, (mtime, mtime))
        return True
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return False
