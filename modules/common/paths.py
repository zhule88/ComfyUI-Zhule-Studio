"""路径安全工具：输入/输出目录获取、路径解析与安全校验。

供各模块 routes 与节点复用（原 server.py / nodes 中的同名工具迁移至此）。
"""
import os

import folder_paths


def _get_input_dir():
    return os.path.abspath(folder_paths.get_input_directory())


def _get_output_dir():
    return os.path.abspath(folder_paths.get_output_directory())


def _resolve_path(p):
    if not p:
        return _get_input_dir()

    p = p.replace("\\", "/").strip("/")
    if p.startswith("./"):
        p = p[2:]

    if os.path.isabs(p) or (len(p) > 1 and p[1] == ":"):
        return os.path.normpath(p)

    base = os.path.dirname(_get_input_dir())
    if p.startswith("input/"):
        return os.path.normpath(os.path.join(base, p))

    return os.path.normpath(os.path.join(folder_paths.get_input_directory(), p))


def _is_safe(abs_path):
    input_dir = _get_input_dir()
    abs_path = os.path.abspath(abs_path)
    try:
        return os.path.commonpath([input_dir, abs_path]) == input_dir
    except ValueError:
        return False


def _is_safe_for_delete(abs_path):
    abs_path = os.path.abspath(abs_path)
    for base in (_get_input_dir(), _get_output_dir()):
        try:
            if os.path.commonpath([base, abs_path]) == base:
                return True
        except ValueError:
            continue
    return False
