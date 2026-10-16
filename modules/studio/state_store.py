"""Zhule Studio 状态存储：ID → 本地 json 文件（网页选词数据落盘）。

- 文件位置：本插件 modules/studio/state/<ID>.json（随插件走，不污染 ComfyUI input）
- 写入：网页选词变化防抖 POST /zhule_state/save；原子写（tmp + replace）
- 读取：节点执行时按ID读文件（方案：跑的时候临时读，网页与画布解耦）
- 清理：插件启动（注册路由）时扫描工作流目录提取活跃ID，
  删除 state 目录中不在活跃集合且修改时间超过 30 天的孤儿文件（兜底，不打扰正常删除）。
"""
import json
import os
import re
import time

# 安全命名：仅字母/数字/下划线/连字符，防路径穿越
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")

# 孤儿兜底保护期：文件超过 N 天未修改且无工作流引用才删除
ORPHAN_GRACE_DAYS = 30

# 参与孤儿判定的节点类型（每个类型取 widgets_values 中"ID"所在下标）
_BIND_NODE_TYPES = {
    "ZhuleStudio": 0,
}


def ensure_state_dir():
    """确保 state 目录存在。"""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except Exception:
        pass


def valid_id(bind_id):
    return bool(bind_id) and bool(_ID_RE.match(bind_id))


def state_path(bind_id):
    return os.path.join(STATE_DIR, bind_id + ".json")


def load_state(bind_id):
    """读取某个ID的状态，失败返回 None。"""
    if not valid_id(bind_id):
        return None
    try:
        with open(state_path(bind_id), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_state(bind_id, data):
    """原子写入状态，成功返回 True。data 为任意可 JSON 序列化对象。"""
    if not valid_id(bind_id):
        return False
    ensure_state_dir()
    payload = {"bindId": bind_id, "savedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "data": data}
    try:
        tmp = state_path(bind_id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, state_path(bind_id))
        return True
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return False


def delete_state(bind_id):
    """删除某个ID的状态文件，成功返回 True；不存在返回 False。"""
    if not valid_id(bind_id):
        return False
    try:
        p = state_path(bind_id)
        if os.path.exists(p):
            os.remove(p)
            return True
    except Exception:
        pass
    return False


def list_state():
    """列出 state 目录全部文件（bindId + 最后修改时间戳）。"""
    ensure_state_dir()
    out = []
    try:
        for fn in os.listdir(STATE_DIR):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(STATE_DIR, fn)
            try:
                out.append({"bindId": fn[:-5], "mtime": os.path.getmtime(p)})
            except Exception:
                continue
    except Exception:
        pass
    return out


def _locate_comfy_user_dir():
    """定位 ComfyUI 的 user 目录：优先 folder_paths，失败时从插件路径向上推导。"""
    try:
        from folder_paths import base_path
        candidate = os.path.join(base_path, "user")
        if os.path.isdir(candidate):
            return candidate
    except Exception:
        pass
    # 插件根 = custom_nodes/ComfyUI-Zhule-Nodes；user 目录 = ComfyUI 根/user
    comfy_root = os.path.dirname(os.path.dirname(_PLUGIN_ROOT))
    candidate = os.path.join(comfy_root, "user")
    return candidate if os.path.isdir(candidate) else None


def _collect_active_binds():
    """扫描 ComfyUI user 目录下所有工作流 json，提取活跃ID集合。

    提取规则：nodes 中 type 在 _BIND_NODE_TYPES 里的节点，取
    widgets_values[_BIND_NODE_TYPES[type]]（非空字符串）作为ID。
    扫描失败返回 None（调用方跳过本次清理，避免误删）。
    """
    user_dir = _locate_comfy_user_dir()
    if not user_dir:
        return None
    active = set()
    try:
        for root, dirs, files in os.walk(user_dir):
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__")]
            for fn in files:
                if not fn.endswith(".json"):
                    continue
                p = os.path.join(root, fn)
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                nodes = data.get("nodes")
                if not isinstance(nodes, list):
                    continue
                for n in nodes:
                    if not isinstance(n, dict):
                        continue
                    ntype = n.get("type")
                    idx = _BIND_NODE_TYPES.get(ntype)
                    if idx is None:
                        continue
                    wv = n.get("widgets_values")
                    if not isinstance(wv, list) or len(wv) <= idx:
                        continue
                    v = wv[idx]
                    if isinstance(v, str) and v.strip():
                        active.add(v.strip())
    except Exception:
        return None
    return active


def startup_cleanup():
    """插件启动兜底清理：删除无工作流引用且超过保护期的孤儿状态文件。

    正常删除节点由前端画布删除钩子即时清（后续可按需加），本函数只兜底残渣。
    """
    ensure_state_dir()
    active = _collect_active_binds()
    if active is None:
        return
    now = time.time()
    cutoff = ORPHAN_GRACE_DAYS * 86400
    try:
        for fn in os.listdir(STATE_DIR):
            if not fn.endswith(".json"):
                continue
            bind_id = fn[:-5]
            if bind_id in active:
                continue
            p = os.path.join(STATE_DIR, fn)
            try:
                if now - os.path.getmtime(p) > cutoff:
                    os.remove(p)
            except Exception:
                continue
    except Exception:
        pass
