"""ComfyUI-Zhule-Studio 收集器。

遍历 modules/ 命名空间包，汇总各子模块的节点映射，并触发路由注册。
旧 nodes/ 目录保留不动（不再被引用），原 server.py 路由与工具已拆入各模块。
"""
import os
import importlib
import pkgutil

PLUGIN_ROOT = os.path.dirname(os.path.abspath(__file__))
MODULES_DIR = os.path.join(PLUGIN_ROOT, "modules")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _load_modules():
    if not os.path.isdir(MODULES_DIR):
        return

    # 遍历 modules/ 下各功能子目录（跳过下划线前缀，如 common 仅被显式引用）
    for entry in sorted(os.listdir(MODULES_DIR)):
        sub = os.path.join(MODULES_DIR, entry)
        if not os.path.isdir(sub) or entry.startswith("_"):
            continue

        for fn in sorted(os.listdir(sub)):
            if not fn.endswith(".py") or fn.startswith("_"):
                continue
            # 相对导入：ComfyUI 以 custom_nodes.<插件> 包上下文加载本文件，
            # 插件根目录不在 sys.path 顶层，绝对导入 modules.* 会找不到包
            try:
                mod = importlib.import_module(f".modules.{entry}.{fn[:-3]}", package=__package__)
            except Exception as e:
                print(f"[Zhule] 跳过模块 modules.{entry}.{fn[:-3]}: {e}")
                continue

            cm = getattr(mod, "NODE_CLASS_MAPPINGS", None)
            if isinstance(cm, dict):
                NODE_CLASS_MAPPINGS.update(cm)

            dm = getattr(mod, "NODE_DISPLAY_NAME_MAPPINGS", None)
            if isinstance(dm, dict):
                NODE_DISPLAY_NAME_MAPPINGS.update(dm)

            reg = getattr(mod, "register_routes", None)
            if callable(reg):
                try:
                    reg()
                except Exception as e:
                    print(f"[Zhule] 路由注册失败 modules.{entry}.{fn[:-3]}: {e}")


_load_modules()

# 启动阶段自动清空 log 目录：每次重启自动清空（含测试子目录），保留 _backup* 备份
LOG_DIR = os.path.join(PLUGIN_ROOT, "log")
_LOG_CLEANED = False
_BACKUP_PREFIX = "_backup"


def _cleanup_log_dir():
    """清空插件根 log 目录内容（含其中所有测试子文件夹），保留 _backup* 前缀的备份。

    幂等：同一进程只执行一次；目录不存在时静默跳过；仅操作 LOG_DIR 内条目，
    严禁越界删除非 log 文件。
    """
    global _LOG_CLEANED
    if _LOG_CLEANED:
        return
    _LOG_CLEANED = True
    if not os.path.isdir(LOG_DIR):
        return

    import shutil
    removed = 0
    for name in os.listdir(LOG_DIR):
        if name.startswith(_BACKUP_PREFIX):
            continue
        p = os.path.join(LOG_DIR, name)
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
            removed += 1
        except Exception as e:
            print(f"[Zhule] 清空 log 跳过 {p}: {e}")
    print(f"[Zhule] 启动时已清空 log 目录（保留 _backup*），清理 {removed} 项")


_cleanup_log_dir()

# 前端目录：JS 统一平铺在 web/ 下，ComfyUI 只扫描该目录一层，不递归子目录
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
