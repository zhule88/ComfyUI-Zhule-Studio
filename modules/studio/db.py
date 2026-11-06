"""Zhule Studio 词库 SQLite 数据层（运行时唯一数据源）。

自 DB 迁移后，词库的增删改查全部走 zhule.db（表 prompt），
代码不再扫描 / 读写 modules/studio/prompt 文件夹与 wordbank_index.json。
本模块提供：建树、节点定位、增删改、排序、标签索引、图库联动查询，
并维护内存数据版本号供 gallery 的 TTL 缓存失效判断。
"""
import json
import os
import re
import sqlite3
import threading
import time

_STUDIO_DIR = os.path.dirname(os.path.abspath(__file__))
# 全插件唯一数据源：词库 prompt / 图库 gallery_image+gallery_tag / 自定义标签 custom_tag 同库。
# 落位 modules/studio/zhule.db（随插件走，勿移出插件目录，否则重装即丢数据）。
DB_PATH = os.path.join(_STUDIO_DIR, "zhule.db")
TABLE = "prompt"  # 词库表（2259 行；另存在 AUTOINCREMENT 序列）

_lock = threading.RLock()
# 自定义标签路径分隔符：/ \ - : 四种均视为层级分隔；注册/展示统一按 / 归一存储。
_TAG_PATH_SEP_RE = re.compile(r"[/\\:\-]")
_version = 0


def version():
    """返回数据版本号（每次写操作递增），供缓存签名失效判断。"""
    return _version


def _bump():
    global _version
    _version += 1


_schema_checked = False


def _ensure_schema(conn):
    """确保全部业务表存在（幂等，进程内只执行一次）。

    prompt / custom_tag / gallery_image / gallery_tag 四张表原由一次性迁移脚本创建，
    脚本未入库：丢库或换库后各读写函数都会抛 no such table，词库页与图库双双不可用，
    且『重建索引』也救不回来。统一在连接建立时建表，任何入口拿到的连接都可直接用。
    """
    global _schema_checked
    if _schema_checked:
        return
    try:
        _ensure_prompt_schema(conn)
        _ensure_gallery_schema(conn)
    except sqlite3.Error as e:
        print(f"[ZhuleDB] 表结构初始化失败: {e}")
        return
    _schema_checked = True


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _ensure_schema(conn)
    return conn


def _now():
    return int(time.time())


def _sort_key(node):
    so = node.get("sortOrder")
    flag = 0 if (so is not None and so > 0) else 1
    return (flag, so or 0, (node.get("name") or "").lower(), node.get("name") or "")


def raw_name(node):
    """节点原始名（含编号前缀）：与磁盘目录命名一致。sort_order<=0 视为无编号。"""
    so = node.get("sortOrder")
    nm = node.get("name") or ""
    if so is not None and so > 0:
        return f"{so:02d}_{nm}"
    return nm


def fetch_tree():
    """全树：顶层 tab（parent_id NULL）按 sort_order/名称排序。

    返回 [{id, type, name, en?, cn?, sortOrder?, updatedAt?, children?}]，
    id 为 DB 自增 id（str）；updatedAt 为 updated_at 时间戳（卡片按时间排序用）。
    """
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, parent_id, type, name, en, cn, sort_order, updated_at "
                "FROM {0} WHERE isdel=0 ORDER BY id".format(TABLE)
            ).fetchall()
        finally:
            conn.close()
    by_parent = {}
    for r in rows:
        by_parent.setdefault(r["parent_id"], []).append(r)

    def build(pid):
        kids = []
        for r in by_parent.get(pid, []):
            node = {"id": str(r["id"]), "type": r["type"], "name": r["name"] or ""}
            if r["type"] == "entry":
                node["en"] = r["en"] or ""
                node["cn"] = r["cn"] or ""
            if r["sort_order"]:
                node["sortOrder"] = r["sort_order"]
            node["updatedAt"] = r["updated_at"] or 0
            ch = build(r["id"])
            if ch:
                node["children"] = ch
            kids.append(node)
        kids.sort(key=_sort_key)
        return kids

    return build(None)


def resolve_path(raw_path):
    """原始相对路径（如 01_角色/银狼LV.999@/银狼LV.999_服装）→ (node, rel, is_root)。

    node 为节点 dict（含 id/type/name/en/cn/sortOrder/children 结构，children 已构建）；
    rel 为归一化 posix 相对路径；is_root 表示顶层 Tab。
    匹配顺序：先按原始名（编号前缀），再按显示名。找不到返回 (None, None, False)。
    """
    parts = [p for p in (raw_path or "").replace("\\", "/").split("/") if p]
    if not parts:
        return None, None, False
    tree = fetch_tree()
    cur = tree
    node = None
    raws = []
    for seg in parts:
        found = None
        for child in cur:
            raw = raw_name(child)
            if raw == seg or child.get("name") == seg:
                found = child
                break
        if found is None:
            return None, None, False
        node = found
        raws.append(raw_name(found))
        cur = found.get("children") or []
    return node, "/".join(raws), len(parts) == 1


def node_by_raw_path(raw_path):
    """resolve_path 的简化版：仅返回节点 dict（不存在返回 None）。"""
    node, _, _ = resolve_path(raw_path)
    return node


def node_by_id(node_id):
    """按 DB id 查询未删除节点。返回 dict {id, parent_id, type, name, en, cn, sortOrder, updatedAt}，不存在返回 None。"""
    try:
        node_id = int(node_id)
    except (TypeError, ValueError):
        return None
    with _lock:
        conn = connect()
        try:
            r = conn.execute(
                "SELECT id, parent_id, type, name, en, cn, sort_order, updated_at "
                "FROM {0} WHERE id=? AND isdel=0".format(TABLE),
                (node_id,),
            ).fetchone()
            if r is None:
                return None
            return {
                "id": str(r["id"]),
                "parent_id": r["parent_id"],
                "type": r["type"],
                "name": r["name"] or "",
                "en": r["en"] or "",
                "cn": r["cn"] or "",
                "sortOrder": r["sort_order"],
                "updatedAt": r["updated_at"] or 0,
            }
        finally:
            conn.close()


def get_parent_id(node_id):
    with _lock:
        conn = connect()
        try:
            r = conn.execute(
                "SELECT parent_id FROM {0} WHERE id=? AND isdel=0".format(TABLE), (node_id,)
            ).fetchone()
            return r["parent_id"] if r else None
        finally:
            conn.close()


def sibling_dup(parent_id, name, exclude_id=None):
    """同父下是否已有同名节点（含编号前缀去重，忽略大小写）。返回已存在节点名。"""
    with _lock:
        conn = connect()
        try:
            if exclude_id is not None:
                rows = conn.execute(
                    "SELECT id, name, sort_order FROM {0} WHERE parent_id IS ? AND id<>? AND isdel=0".format(TABLE),
                    (parent_id, exclude_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, name, sort_order FROM {0} WHERE parent_id IS ? AND isdel=0".format(TABLE),
                    (parent_id,),
                ).fetchall()
        finally:
            conn.close()
    low = name.lower()
    for r in rows:
        nm = r["name"] or ""
        if nm.lower() == low:
            return nm or name
    return None


def insert_node(parent_id, type_, name, en="", cn="", so=None):
    """新增节点；parent_id=None 为顶层 Tab。sort_order 默认取同父 max+1。

    返回 (id, ok)。调用方应先做同名/参数校验。
    """
    with _lock:
        conn = connect()
        try:
            if so is None:
                cur = conn.execute(
                    "SELECT COALESCE(MAX(sort_order),0) FROM {0} WHERE parent_id IS ? AND isdel=0".format(TABLE),
                    (parent_id,),
                )
                so = (cur.fetchone()[0] or 0) + 1
            now = _now()
            cur = conn.execute(
                "INSERT INTO {0} (parent_id, type, name, en, cn, sort_order, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)".format(TABLE),
                (parent_id, type_, name, en, cn, so, now, now),
            )
            conn.commit()
            _bump()
            return cur.lastrowid, True
        except sqlite3.Error:
            return None, False
        finally:
            conn.close()


def update_node(node_id, name=None, en=None, cn=None):
    """编辑节点：可选更新 name/en/cn，并刷新 updated_at。"""
    with _lock:
        conn = connect()
        try:
            sets, vals = [], []
            if name is not None:
                sets.append("name=?")
                vals.append(name)
            if en is not None:
                sets.append("en=?")
                vals.append(en)
            if cn is not None:
                sets.append("cn=?")
                vals.append(cn)
            if not sets:
                return False
            sets.append("updated_at=?")
            vals.append(_now())
            vals.append(node_id)
            conn.execute(
                "UPDATE {0} SET {1} WHERE id=?".format(TABLE, ", ".join(sets)), vals
            )
            conn.commit()
            _bump()
            return True
        except sqlite3.Error:
            return False
        finally:
            conn.close()


def _subtree_ids(conn, node_id):
    """BFS 收集节点自身及全部未删除子孙的 DB id（调用方负责持有连接与事务）。"""
    ids = [node_id]
    cur = [node_id]
    while True:
        ph = ",".join("?" * len(cur))
        rows = conn.execute(
            "SELECT id FROM {0} WHERE parent_id IN ({1}) AND isdel=0".format(TABLE, ph), cur
        ).fetchall()
        nxt = [r["id"] for r in rows]
        if not nxt:
            break
        ids.extend(nxt)
        cur = nxt
    return ids


def subtree_ids(node_id):
    """返回节点自身及全部未删除子孙的 DB id 列表（只读）。

    供删除前收集附属资源之用（例如清理 zhule_reference/<词条id>/ 参考图目录）。
    """
    try:
        node_id = int(node_id)
    except (TypeError, ValueError):
        return []
    with _lock:
        conn = connect()
        try:
            return _subtree_ids(conn, node_id)
        except sqlite3.Error:
            return []
        finally:
            conn.close()


def delete_subtree(node_id):
    """软删除节点及全部子孙（BFS 收集后代后统一 UPDATE isdel=1，不真删）。

    返回标记为已删除的行数（含节点自身）。软删后所有读取路径按 isdel=0 过滤，
    节点在词库树/标签索引中不可见；数据仍在库中，后续可恢复。
    """
    with _lock:
        conn = connect()
        try:
            ids = _subtree_ids(conn, node_id)
            ph = ",".join("?" * len(ids))
            now = _now()
            conn.execute(
                "UPDATE {0} SET isdel=1, updated_at=? WHERE id IN ({1}) AND isdel=0".format(TABLE, ph),
                [now] + ids,
            )
            conn.commit()
            _bump()
            return len(ids)
        except sqlite3.Error:
            return 0
        finally:
            conn.close()


def _reorder(pid, ordered_ids):
    """按 ordered_ids（子节点 DB id 数组）顺序给指定父层的子节点赋连续 sort_order=1..n。

    未出现在列表中的现有节点按原规则排到末尾。返回更新的节点数。
    """
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, name, sort_order FROM {0} WHERE parent_id IS ? AND isdel=0".format(TABLE),
                (pid,),
            ).fetchall()
        finally:
            conn.close()
    row_ids = {r["id"] for r in rows}
    ordered, seen = [], set()
    for nid in ordered_ids or []:
        try:
            nid = int(nid)
        except (TypeError, ValueError):
            continue
        if nid in row_ids and nid not in seen:
            ordered.append(nid)
            seen.add(nid)
    rest = [r for r in rows if r["id"] not in seen]
    rest.sort(key=lambda r: (
        0 if (r["sort_order"] or 0) > 0 else 1,
        r["sort_order"] or 0,
        (r["name"] or "").lower(),
        r["name"] or "",
    ))
    ordered.extend(r["id"] for r in rest)
    if not ordered:
        return 0
    with _lock:
        conn = connect()
        try:
            now = _now()
            for idx, nid in enumerate(ordered, start=1):
                conn.execute(
                    "UPDATE {0} SET sort_order=?, updated_at=? WHERE id=?".format(TABLE),
                    (idx, now, nid),
                )
            conn.commit()
            _bump()
            return len(ordered)
        except sqlite3.Error:
            return 0
        finally:
            conn.close()


def reorder_layer(parent_node_id, ordered_raws):
    """排序指定父节点（非顶层）的直系子节点。"""
    return _reorder(parent_node_id, ordered_raws)


def reorder_top(ordered_raws):
    """排序顶层 Tab（parent_id NULL）。"""
    return _reorder(None, ordered_raws)


def tag_id_index():
    """词条显示名 -> DB id（str）。同名取树序第一个（与旧实现一致）。

    注意：**不过滤 isdel**——图库侧依赖本索引把 gallery_tag.prompt_id 反查成
    标签名；词条软删后图片里已有的标签必须继续显示（黑名单只作用于词库管理与
    新标签引用，不影响旧关联展示）。
    """
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, name FROM {0} WHERE type='entry' AND name<>'' "
                "ORDER BY sort_order, name, id".format(TABLE)
            ).fetchall()
        finally:
            conn.close()
    data = {}
    for r in rows:
        n = r["name"]
        if n and n not in data:
            data[n] = str(r["id"])
    return data


def tag_cn_index():
    """词条显示名 -> cn 首行（用于图库详情中文标签填充）。

    注意：**不过滤 isdel**——图库侧用于给旧关联标签补中文，词条软删后仍应生效。
    """
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT name, cn FROM {0} WHERE type='entry' AND cn IS NOT NULL AND cn<>'' "
                "ORDER BY sort_order, name, id".format(TABLE)
            ).fetchall()
        finally:
            conn.close()
    data = {}
    for r in rows:
        n = r["name"]
        if n and n not in data:
            first = (r["cn"] or "").splitlines()[0].strip()
            if first:
                data[n] = first
    return data


def tag_en_index():
    """词条显示名 -> en 全文（用于图库详情英文提示词填充）。

    注意：**不过滤 isdel**——图库侧用于给旧关联标签补英文，词条软删后仍应生效。
    """
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT name, en FROM {0} WHERE type='entry' AND en IS NOT NULL AND en<>'' "
                "ORDER BY sort_order, name, id".format(TABLE)
            ).fetchall()
        finally:
            conn.close()
    data = {}
    for r in rows:
        n = r["name"]
        if n and n not in data:
            en = (r["en"] or "").strip()
            if en:
                data[n] = en
    return data


def clean_en_cn():
    """去中文清理（en 字段中移除中文字符与中文标点）。返回 (updated, total)。"""
    cjk = "".join([
        "[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]",
    ])
    import re as _re
    pat = _re.compile(cjk)
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, en FROM {0} WHERE type='entry' AND en IS NOT NULL AND en<>'' AND isdel=0".format(TABLE)
            ).fetchall()
            updated = 0
            now = _now()
            for r in rows:
                cleaned = pat.sub("", r["en"] or "")
                if cleaned != (r["en"] or ""):
                    conn.execute(
                        "UPDATE {0} SET en=?, updated_at=? WHERE id=?".format(TABLE),
                        (cleaned, now, r["id"]),
                    )
                    updated += 1
            conn.commit()
            if updated:
                _bump()
            return updated, len(rows)
        finally:
            conn.close()


# ==================== 图库数据层（gallery_image / gallery_tag / custom_tag） ====================
# 图库索引从 gallery_index.json 迁移到 SQLite：gallery_image 表存图片记录
# （name 为图库相对路径定位字段，与磁盘按名定位行为一致），gallery_tag 表存标签
# （prompt 类标签存 prompt_id 外键，展示名 LEFT JOIN prompt 表取；custom 类标签存
# custom_id 外键，展示名 LEFT JOIN custom_tag 字典表取，不再自存 name）。
# 本层与词库 prompt 表同库事务：gallery 模块读侧调 gallery_load_records，
# 写侧调 gallery_save_records（全量重建）/ gallery_upsert_records（单点写入）。

GAL_IMG_TABLE = "gallery_image"
GAL_TAG_TABLE = "gallery_tag"
GAL_LORA_TABLE = "gallery_lora"
CUSTOM_TAG_TABLE = "custom_tag"  # 自定义标签字典表（仿 prompt 表：父子层级 + name）

# 模型字典表：底模型与 LoRA 共用一张表，靠 type 区分
MODEL_TABLE = "model"
MODEL_TYPE_MODEL = "model"  # 底模型（checkpoints / diffusion_models / unet 归一）
MODEL_TYPE_LORA = "lora"


def _add_column_if_missing(conn, table, column, ddl):
    """给已存在的表补列（幂等）；列已存在则什么都不做。

    CREATE TABLE IF NOT EXISTS 不会给旧表加列，故新列一律走这条路径，
    这样老库升级后也能直接具备新列。
    """
    try:
        cols = {r["name"] for r in conn.execute(
            "PRAGMA table_info({0})".format(table)).fetchall()}
    except Exception:
        return
    if column not in cols:
        conn.execute("ALTER TABLE {0} ADD COLUMN {1} {2}".format(table, column, ddl))


def _ensure_prompt_schema(conn):
    """确保词库 prompt 表存在（幂等）。

    表结构由代码自带（schema as code）：新环境拿到空库时也能直接用，
    不必依赖任何外部迁移脚本。
    """
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "parent_id INTEGER REFERENCES {0}(id) ON DELETE CASCADE,"
        "type TEXT NOT NULL,"
        "name TEXT NOT NULL,"
        "en TEXT NOT NULL DEFAULT '',"
        "cn TEXT NOT NULL DEFAULT '',"
        "sort_order INTEGER DEFAULT 0,"
        "isdel INTEGER NOT NULL DEFAULT 0,"
        "neg TEXT NOT NULL DEFAULT '',"
        "override TEXT NOT NULL DEFAULT '',"
        "created_at INTEGER NOT NULL,"
        "updated_at INTEGER NOT NULL"
        ")".format(TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_name ON {0}(name)".format(TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_parent ON {0}(parent_id)".format(TABLE)
    )
    # 存量库升级：新列一律走幂等补列路径（CREATE TABLE IF NOT EXISTS 不会给旧表加列）
    _ensure_column(conn, TABLE, "isdel", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, TABLE, "neg", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, TABLE, "override", "TEXT NOT NULL DEFAULT ''")
    # 依赖新列的索引必须放在补列之后，否则旧库会报 no such column
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_type_del ON {0}(type, isdel)".format(TABLE)
    )


def _ensure_custom_tag_schema(conn):
    """确保 custom_tag 字典表存在（幂等）。"""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "parent_id INTEGER REFERENCES {0}(id) ON DELETE CASCADE,"
        "name TEXT NOT NULL,"
        "sort_order INTEGER DEFAULT 0,"
        "isdel INTEGER NOT NULL DEFAULT 0,"
        "created_at INTEGER NOT NULL,"
        "updated_at INTEGER NOT NULL"
        ")".format(CUSTOM_TAG_TABLE)
    )
    _add_column_if_missing(conn, CUSTOM_TAG_TABLE, "isdel", "INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_parent ON {0}(parent_id)".format(CUSTOM_TAG_TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_name ON {0}(name)".format(CUSTOM_TAG_TABLE)
    )


def _drop_column(conn, table, col):
    """幂等摘列：已有该列才 DROP（SQLite 3.35+ 支持 DROP COLUMN）。"""
    try:
        cols = conn.execute("PRAGMA table_info({0})".format(table)).fetchall()
    except sqlite3.Error:
        return
    if not any(c["name"] == col for c in cols):
        return
    try:
        conn.execute("ALTER TABLE {0} DROP COLUMN {1}".format(table, col))
    except sqlite3.Error as e:
        print(f"[ZhuleDB] 摘除列 {table}.{col} 失败: {e}")


def _ensure_column(conn, table, col, decl):
    """幂等补列：已有该列则跳过。存量库升级用（CREATE TABLE 只在空库生效）。"""
    try:
        cols = conn.execute("PRAGMA table_info({0})".format(table)).fetchall()
    except sqlite3.Error:
        return
    if any(c["name"] == col for c in cols):
        return
    conn.execute("ALTER TABLE {0} ADD COLUMN {1} {2}".format(table, col, decl))


def _as_int_or_none(v):
    """把 id 类字段转成 int；“无”返回 None（不写库时用 NULL，不写 0 误导）。"""
    try:
        return int(v) if v not in (None, "", "0") else None
    except (TypeError, ValueError):
        return None


def _ensure_gallery_schema(conn):
    """确保图库三表存在（幂等）+ 定位索引，并清理存量的误存数据。

    表结构由代码自带（schema as code）：新环境拿到空库时也能直接用，
    不必依赖任何外部迁移脚本。

    gallery_image.model_id 指向 model 表那一行：模型改名后按 id 取到当前名字，
    图片因此一张都不用重写。gallery_image 不再自存 model / loras 名字快照：
    模型名经 model_id JOIN model 表取得；lora 经 gallery_lora 关联表多对多挂接，
    展示名同样按 lora_id JOIN model 表实时取。存量库由迁移脚本
    （RENAME→建新表→INSERT SELECT→DROP）摘掉 model / loras 两列并回填
    gallery_lora。

    gallery_tag.gallery_id 级联：删图时只删 gallery_image，tag 行由外键自动清除。
    gallery_lora.gallery_id / lora_id 均级联：删图/删 lora 时关联行自动清除。
    """
    _ensure_custom_tag_schema(conn)
    _ensure_model_schema(conn)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "name TEXT NOT NULL,"
        "mtime INTEGER NOT NULL DEFAULT 0,"
        "size INTEGER NOT NULL DEFAULT 0,"
        "prompt TEXT NOT NULL DEFAULT '',"
        "created_at INTEGER NOT NULL,"
        "updated_at INTEGER NOT NULL,"
        "model_id INTEGER"
        ")".format(GAL_IMG_TABLE)
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "gallery_id INTEGER NOT NULL REFERENCES {1}(id) ON DELETE CASCADE,"
        "prompt_id INTEGER REFERENCES {2}(id) ON DELETE CASCADE,"
        "custom_id INTEGER REFERENCES {3}(id) ON DELETE CASCADE"
        ")".format(GAL_TAG_TABLE, GAL_IMG_TABLE, TABLE, CUSTOM_TAG_TABLE)
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "gallery_id INTEGER NOT NULL REFERENCES {1}(id) ON DELETE CASCADE,"
        "lora_id INTEGER NOT NULL REFERENCES {2}(id) ON DELETE CASCADE,"
        "UNIQUE(gallery_id, lora_id)"
        ")".format(GAL_LORA_TABLE, GAL_IMG_TABLE, MODEL_TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_name ON {0}(name)".format(GAL_IMG_TABLE)
    )
    _ensure_column(conn, GAL_IMG_TABLE, "model_id", "INTEGER")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_model ON {0}(model_id)".format(GAL_IMG_TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_gallery ON {0}(gallery_id)".format(GAL_TAG_TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_lora ON {0}(lora_id)".format(GAL_LORA_TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_gallery ON {0}(gallery_id)".format(GAL_LORA_TABLE)
    )
    # 存量清理：gallery_image.prompt 曾误存整份 workflow JSON，一律清空。
    # 必须放在建表之后——否则空库上会抛 no such table，导致 connect() 失败、
    # 路由注册中断、/zhule_studio 直接 404。
    # 正面提示词待重建索引时由 _make_record 重新写入；workflow 不落库。
    conn.execute(
        "UPDATE {0} SET prompt='' WHERE prompt LIKE '{{%'".format(GAL_IMG_TABLE)
    )


MODEL_SUFFIXES = (".safetensors", ".ckpt", ".pt", ".bin", ".pth", ".gguf", ".sft")
# 推断 type 用的模型库目录：统一按归一后的正斜杠路径匹配
_LORA_DIRS = ("/models/loras/",)
_MODEL_DIRS = ("/models/checkpoints/", "/models/diffusion_models/", "/models/unet/")


def normalize_model_name(raw):
    """把任意形态的模型引用归一成展示名。

    兼容三种输入：纯名字（anima-base-v1）、带后缀文件名、绝对路径
    （D:\\...\\models\\diffusion_models\\anima-base-v1.0.safetensors）。

    绝对路径只留 basename——ComfyUI 目录整体搬迁也不会让身份漂移；
    去后缀走**已知后缀清单**而不是 splitext，像 anima-base-v1.0 这种
    多点名字才不会被切成 anima-base-v1。
    """
    s = (raw or "").strip().replace("\\", "/")
    if not s:
        return ""
    name = s.rsplit("/", 1)[-1]
    low = name.lower()
    for suf in MODEL_SUFFIXES:
        if low.endswith(suf):
            name = name[: -len(suf)]
            break
    return name.strip()


def _ensure_model_schema(conn):
    """确保模型字典表存在（幂等）。

    UNIQUE(type, name) 且 name 带 COLLATE NOCASE：Windows 文件名不区分大小写，
    否则 Animabase / animabase 会裂成两行。
    """
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "type TEXT NOT NULL,"
        "name TEXT NOT NULL COLLATE NOCASE,"
        "isdel INTEGER NOT NULL DEFAULT 0,"
        "created_at INTEGER NOT NULL,"
        "updated_at INTEGER NOT NULL,"
        "UNIQUE(type, name)"
        ")".format(MODEL_TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_type_del ON {0}(type, isdel)".format(MODEL_TABLE)
    )
    # 存量库摘掉废弃的两列：prev_names（改名历史）、path（最后见到的路径）
    _drop_column(conn, MODEL_TABLE, "prev_names")
    _drop_column(conn, MODEL_TABLE, "path")


def model_lookup(type_, name):
    """按 (type, name) 定位一行（name 已归一）。

    返回 dict(id/type/name/isdel) 或 None。
    """
    key = normalize_model_name(name)
    if not key or not type_:
        return None
    with _lock:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT id, type, name, isdel FROM {0} "
                "WHERE type=? AND name=?".format(MODEL_TABLE), (type_, key)
            ).fetchone()
        finally:
            conn.close()
    if row is None:
        return None
    return {"id": row["id"], "type": row["type"], "name": row["name"],
            "isdel": row["isdel"]}


def model_upsert(type_, name):
    """按归一化名字取 id；查不到才新建。返回 id，失败返回 0。"""
    key = normalize_model_name(name)
    if not key or not type_:
        return 0
    row = model_lookup(type_, key)
    if row is not None:
        return row["id"]
    now = _now()
    with _lock:
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO {0} (type, name, isdel, created_at, updated_at) "
                "VALUES (?,?,0,?,?)".format(MODEL_TABLE),
                (type_, key, now, now),
            )
            conn.commit()
            return cur.lastrowid
        except sqlite3.IntegrityError:
            r = conn.execute(
                "SELECT id FROM {0} WHERE type=? AND name=?".format(MODEL_TABLE),
                (type_, key),
            ).fetchone()
            return r["id"] if r else 0
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 模型写入失败: {e}")
            return 0
        finally:
            conn.close()


def model_rename(mid, new_name):
    """改名的唯一入口。成功返回 True。

    图片一个字节都不用改——它们存的是 id，名字由读取侧按 id 实时解析
    （见 gallery_load_records）。目标名已被别的行占用时返回 False（UNIQUE 拦截）。
    """
    new = normalize_model_name(new_name)
    if not mid or not new:
        return False
    with _lock:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT name FROM {0} WHERE id=?".format(MODEL_TABLE), (int(mid),)
            ).fetchone()
            if row is None:
                return False
            if row["name"] == new:
                return True
            conn.execute(
                "UPDATE {0} SET name=?, updated_at=? WHERE id=?".format(MODEL_TABLE),
                (new, _now(), int(mid)),
            )
            conn.commit()
            return True
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 模型改名失败: {e}")
            return False
        finally:
            conn.close()


def model_index(only_alive=False):
    """一次性取回 {id: {type, name, isdel}}，供批量解析（避免每张图各查一次库）。

    only_alive=True 只返回未删除的行，供筛选选项聚合使用。
    """
    data = {}
    with _lock:
        conn = connect()
        try:
            sql = "SELECT id, type, name, isdel FROM {0}".format(MODEL_TABLE)
            if only_alive:
                sql += " WHERE isdel=0"
            for r in conn.execute(sql).fetchall():
                data[r["id"]] = {"type": r["type"], "name": r["name"], "isdel": r["isdel"]}
        finally:
            conn.close()
    return data


def model_ref(type_, name):
    """归一 + UPSERT 拿 id，返回单个 {'id':..,'n':..}。

    id 与 name 合在**一个对象**里而不是两个字段：写 PNG 或 JSON 都只占一格，
    读的时候也不用两边对齐（平行数组一旦错位就永久错乱）。
    id 让图片在模型改名后自动跟随，n 是兜底——DB 没了也还能显示。
    数据层不可用时退化为 {'n': 名字}，不阻断保存。
    """
    key = normalize_model_name(name)
    if not key:
        return None
    mid = model_upsert(type_, key)
    return {"id": mid, "n": key} if mid else {"n": key}


# -------------------- 自定义标签字典表（custom_tag） --------------------
# 仿 prompt 表：parent_id 支持父子层级（ON DELETE CASCADE 级联删除子孙），
# name 为标签显示名，sort_order 控制同级顺序。gallery_tag.custom_id 外键引用本表，
# 图片标签不再自存 name 字符串，改名/层级调整后展示名经 JOIN 实时更新。


def custom_tag_id_index():
    """自定义标签 name -> id（str）。同名取顶层优先、树序第一个（与词条索引同构）。

    供 gallery 侧自定义标签展示/定位与写回反查使用。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            rows = conn.execute(
                "SELECT id, parent_id, name FROM {0} WHERE name<>'' "
                "ORDER BY (parent_id IS NULL) DESC, sort_order, name, id".format(CUSTOM_TAG_TABLE)
            ).fetchall()
        finally:
            conn.close()
    data = {}
    for r in rows:
        n = r["name"]
        if n and n not in data:
            data[n] = str(r["id"])
    return data


def custom_tag_name_index():
    """自定义标签 id -> name（由 name->id 索引反置）。

    读取侧「先按 id 取当前名」用：自定义标签改名后，图片按 id 自动跟随。
    """
    out = {}
    for n, i in custom_tag_id_index().items():
        out.setdefault(str(i), n)
    return out


def custom_tag_upsert(name):
    """按名字取自定义标签 id；没有就建一行。返回 id，失败返回 0。"""
    n = (name or "").strip()
    if not n:
        return 0
    idx = custom_tag_id_index()
    if n in idx:
        try:
            return int(idx[n])
        except (TypeError, ValueError):
            return 0
    with _lock:
        conn = connect()
        try:
            cur = conn.execute(
                "SELECT COALESCE(MAX(sort_order),0) FROM {0} "
                "WHERE parent_id IS NULL".format(CUSTOM_TAG_TABLE)
            )
            max_so = cur.fetchone()[0] or 0
            now = _now()
            cur2 = conn.execute(
                "INSERT INTO {0} (parent_id, name, sort_order, "
                "created_at, updated_at) VALUES (NULL,?,?,?,?)".format(CUSTOM_TAG_TABLE),
                (n, max_so + 1, now, now),
            )
            conn.commit()
            return cur2.lastrowid
        except sqlite3.IntegrityError:
            r = conn.execute(
                "SELECT id FROM {0} WHERE name=?".format(CUSTOM_TAG_TABLE), (n,)
            ).fetchone()
            return r["id"] if r else 0
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 自定义标签写入失败: {e}")
            return 0
        finally:
            conn.close()


# -------------------- 自定义标签层级（/ 路径） --------------------
# 层级注册规则（与 prompt 表 category 同构）：
# 输入 '角色/绝区零/尼克' 按 / 拆段，从根（parent_id=NULL）逐级 find-or-create，
# 返回**叶子**节点 id。'绝区零/尼克' 是独立路径：其顶层 '绝区零' 与
# '角色/绝区零' 中的 '绝区零'（parent=角色）是不同节点，互不合并。
# 字符串只接受 / 作为层级分隔符；空段忽略（'角色//尼克' 按 '角色/尼克' 处理）。


def custom_tag_find(parent_id, name):
    """在指定父级下精确查找同名自定义标签。返回 id（int）或 0。"""
    n = (name or "").strip()
    if not n:
        return 0
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            r = conn.execute(
                "SELECT id FROM {0} WHERE parent_id IS ? AND name=? LIMIT 1"
                .format(CUSTOM_TAG_TABLE), (parent_id, n)
            ).fetchone()
        finally:
            conn.close()
    return r["id"] if r else 0


def custom_tag_child_insert(parent_id, name):
    """在指定父级下创建自定义标签子节点。返回 id，失败返回 0。"""
    n = (name or "").strip()
    if not n:
        return 0
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            cur = conn.execute(
                "SELECT COALESCE(MAX(sort_order),0) FROM {0} WHERE parent_id IS ?"
                .format(CUSTOM_TAG_TABLE), (parent_id,)
            )
            max_so = cur.fetchone()[0] or 0
            now = _now()
            cur2 = conn.execute(
                "INSERT INTO {0} (parent_id, name, sort_order, isdel, "
                "created_at, updated_at) VALUES (?,?,?,0,?,?)".format(CUSTOM_TAG_TABLE),
                (parent_id, n, max_so + 1, now, now),
            )
            conn.commit()
            return cur2.lastrowid
        except sqlite3.IntegrityError:
            r = conn.execute(
                "SELECT id FROM {0} WHERE parent_id IS ? AND name=? LIMIT 1"
                .format(CUSTOM_TAG_TABLE), (parent_id, n)
            ).fetchone()
            return r["id"] if r else 0
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 自定义标签子节点写入失败: {e}")
            return 0
        finally:
            conn.close()


def custom_tag_upsert_path(path):
    """按 / 路径逐级 find-or-create 自定义标签，返回**叶子** id（int），失败返回 0。

    顶层段（第一个）在 parent_id=NULL 下定位；后续段挂在上一段节点下。
    已存在路径全部复用，不重复建。
    """
    p = (path or "").strip().strip("/")
    if not p:
        return 0
    segs = [s.strip() for s in _TAG_PATH_SEP_RE.split(p) if s and s.strip()]
    if not segs:
        return 0
    pid = None
    cid = 0
    for seg in segs:
        found = custom_tag_find(pid, seg)
        if found:
            cid = found
        else:
            cid = custom_tag_child_insert(pid, seg)
            if not cid:
                return 0
        pid = cid
    return cid


def custom_tag_path_ref(path):
    """按 / 路径注册并返回 {"id":叶子id, "p":完整路径, "n":叶子名}；失败返回 {"p":原路径, "n":""}。"""
    p = (path or "").strip().strip("/")
    if not p:
        return None
    segs = [s.strip() for s in _TAG_PATH_SEP_RE.split(p) if s and s.strip()]
    if not segs:
        return None
    cid = custom_tag_upsert_path(p)
    if cid:
        return {"id": cid, "p": "/".join(segs), "n": segs[-1]}
    return {"p": "/".join(segs), "n": segs[-1]}


def custom_tag_path_index():
    """自定义标签 id -> 完整路径（str）。沿 parent 链拼接，顶层节点路径即自身名。

    读取侧「先按 id 取当前完整路径」用：层级/改名后图片按 id 自动跟随展示完整路径。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            rows = conn.execute(
                "SELECT id, parent_id, name FROM {0} WHERE name<>'' "
                "ORDER BY id".format(CUSTOM_TAG_TABLE)
            ).fetchall()
        finally:
            conn.close()
    nodes = {}
    for r in rows:
        nodes[r["id"]] = {"parent": r["parent_id"], "name": r["name"]}
    out = {}
    for nid in nodes:
        parts = []
        cur = nid
        guard = 0
        while cur is not None and guard < 64:
            node = nodes.get(cur)
            if not node:
                break
            parts.append(node["name"])
            cur = node["parent"]
            guard += 1
        if parts:
            out[str(nid)] = "/".join(reversed(parts))
    return out


def custom_tag_rows():
    """自定义标签全量行 [(id, parent_id, name)]，供前端层级树构造（tagtree 接口合并）。

    按 id 稳定序返回；仅含非空名节点（与 custom_tag_path_index 口径一致）。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            rows = conn.execute(
                "SELECT id, parent_id, name FROM {0} WHERE name<>'' "
                "ORDER BY id".format(CUSTOM_TAG_TABLE)
            ).fetchall()
        finally:
            conn.close()
    return [(int(r["id"]), r["parent_id"], (r["name"] or "").strip()) for r in rows]


def custom_tag_get(tid):
    """取单个自定义标签行 {"id","parent_id","name"}；不存在/非法返回 None。"""
    try:
        i = int(tid)
    except (TypeError, ValueError):
        return None
    if i <= 0:
        return None
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            r = conn.execute(
                "SELECT id, parent_id, name FROM {0} WHERE id=?".format(CUSTOM_TAG_TABLE), (i,)
            ).fetchone()
        finally:
            conn.close()
    if not r:
        return None
    return {"id": int(r["id"]), "parent_id": r["parent_id"], "name": (r["name"] or "").strip()}


def custom_tag_subtree_ids(tid):
    """节点自身 + 全部后代 id 列表（按 id 升序；防环最多 4096 个）。"""
    try:
        root = int(tid)
    except (TypeError, ValueError):
        return []
    if root <= 0:
        return []
    rows = custom_tag_rows()
    kids = {}
    valid = set()
    for i, p, _n in rows:
        valid.add(i)
        if p is not None:
            kids.setdefault(int(p), []).append(i)
    if root not in valid:
        return []
    out, stack, seen = [], [root], set()
    while stack and len(out) < 4096:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        out.append(cur)
        stack.extend(kids.get(cur) or [])
    return sorted(out)


def custom_tag_create(parent_id, name):
    """在指定父级下新建自定义标签（parent_id 为 None/空表示顶层）。

    同级同名已存在时**直接复用**该节点（不报错，返回 exist=1）。
    返回 (id, err, existed)：成功时 err 为空串。
    """
    n = (name or "").strip().strip("/")
    if not n:
        return 0, "名称不能为空", 0
    if len(n) > 40:
        return 0, "名称最多 40 字", 0
    if _TAG_PATH_SEP_RE.search(n):
        return 0, "名称不能包含 / \\ : - 等层级分隔符", 0
    pid = None
    if parent_id not in (None, "", 0, "0"):
        try:
            pid = int(parent_id)
        except (TypeError, ValueError):
            return 0, "父级标签无效", 0
        if not custom_tag_get(pid):
            return 0, "父级标签不存在", 0
    exist = custom_tag_find(pid, n)
    if exist:
        return int(exist), "", 1
    cid = custom_tag_child_insert(pid, n)
    if not cid:
        return 0, "写入失败", 0
    return int(cid), "", 0


def custom_tag_rename(tid, name):
    """重命名自定义标签（同级去重）。返回错误串；成功返回空串。"""
    node = custom_tag_get(tid)
    if not node:
        return "标签不存在"
    n = (name or "").strip().strip("/")
    if not n:
        return "名称不能为空"
    if len(n) > 40:
        return "名称最多 40 字"
    if _TAG_PATH_SEP_RE.search(n):
        return "名称不能包含 / \\ : - 等层级分隔符"
    if n == node["name"]:
        return ""
    dup = custom_tag_find(node["parent_id"], n)
    if dup and int(dup) != node["id"]:
        return "同级已存在同名标签"
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            conn.execute(
                "UPDATE {0} SET name=?, updated_at=? WHERE id=?".format(CUSTOM_TAG_TABLE),
                (n, _now(), node["id"]),
            )
            conn.commit()
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 自定义标签改名失败: {e}")
            return "写入失败"
        finally:
            conn.close()
    return ""


def custom_tag_delete(tid):
    """删除自定义标签及其全部后代，并清理图库侧的引用。

    返回 (ids, rels)：ids 为被删的 custom_tag id 列表（含后代），
    rels 为受影响的图库图片相对路径（供上层清理 PNG 内的标签快照）。
    字典表删除后，读取侧 custom_tag_path_index 查不到 id → 图片不再展示该标签。
    """
    ids = custom_tag_subtree_ids(tid)
    if not ids:
        return [], []
    ph = ",".join("?" * len(ids))
    rels = []
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            try:
                _ensure_gallery_schema(conn)
                rows = conn.execute(
                    "SELECT DISTINCT i.name AS n FROM {0} t "
                    "JOIN {1} i ON i.id=t.gallery_id WHERE t.custom_id IN ({2})"
                    .format(GAL_TAG_TABLE, GAL_IMG_TABLE, ph), ids
                ).fetchall()
                rels = [(r["n"] or "").strip() for r in rows if (r["n"] or "").strip()]
                conn.execute(
                    "DELETE FROM {0} WHERE custom_id IN ({1})".format(GAL_TAG_TABLE, ph), ids
                )
            except sqlite3.Error as e:
                print(f"[ZhuleDB] 自定义标签关联清理失败: {e}")
            conn.execute(
                "DELETE FROM {0} WHERE id IN ({1})".format(CUSTOM_TAG_TABLE, ph), ids
            )
            conn.commit()
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 自定义标签删除失败: {e}")
            return [], []
        finally:
            conn.close()
    return ids, rels


def tag_refs(ids):
    """批量把词条 id 转成 [{"id":..,"n":..}]；**一次查表**，不逐个查。

    n 是写盘那一刻的名字快照，作兜底：词条后来被删了，读取侧按 id 查不到时用它。
    """
    idx = {}
    for n, i in tag_id_index().items():
        idx.setdefault(str(i), n)
    out = []
    for x in ids or []:
        s = str(x).strip()
        if not s.isdigit():
            continue
        out.append({"id": int(s), "n": idx.get(s, "")})
    return out


def custom_tag_meta():
    """自定义标签字典（取代原 gallery/meta.json 的 load 侧）。

    返回 {"tags": [{"name":...}], "updatedAt": ""}，
    与 gallery.aggregate 消费的结构保持一致。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            rows = conn.execute(
                "SELECT name FROM {0} WHERE name<>'' "
                "ORDER BY name, id".format(CUSTOM_TAG_TABLE)
            ).fetchall()
        finally:
            conn.close()
    seen, tags = set(), []
    for r in rows:
        n = r["name"]
        if n and n not in seen:
            seen.add(n)
            tags.append({"name": n})
    return {"tags": tags, "updatedAt": ""}


def gallery_load_records(ids=None):
    """从 DB 加载图库记录（内部 records 格式）；ids 非空时仅加载命中 id 的子集。

    ids 为可迭代的 gallery_image.id（词条/自定义标签 SQL 过滤命中后的候选集），
    供 get_gallery 标签过滤主路径使用——避免全量加载后在 Python 里逐条遍历匹配。
    ids 为空集合时直接返回 []；ids 为 None 时加载全量（原行为不变）。

    返回 list[dict]，每条含：
    key/name/mtime/size/model/loras/loraIds/tags/tagIds/customTags/prompt/hasPrompt。
    key 即 gallery_image.name（图库相对路径，与磁盘记录行为一致）；
    model 为 model_id JOIN model 表取到的当前模型名（改名自动跟随）；
    loras 为 lora 名数组（gallery_lora 关联 + lora_id JOIN model 表实时取）；
    loraIds 为 lora_id 数组（写回时直接落 gallery_lora，不再按名字猜）；
    tags 为标签显示名数组（prompt 类经 id->name 反查，custom 类经 custom_id LEFT
    JOIN custom_tag 取名——不再读自存 name）；
    tagIds 为 prompt 类 name->prompt_id 映射（词条改名后按 id 不脱钩）；
    prompt 为图片 prompt 文本（DB 直读，避免每次读 PNG）；
    hasPrompt 由 prompt 非空推导。
    注：hasWF 已不落库（列表链路无消费者），真实值以详情接口
    get_gallery_detail 实时读 PNG workflow 推导为准。
    读取失败（表缺失等）返回 None（调用方按索引不可用处理）；空库返回 []。
    """
    id_name = {}
    for n, i in tag_id_index().items():
        id_name[i] = n
    # 自定义标签按 id 反查**完整路径**（层级化：'角色/绝区零/尼克'；顶层节点路径即自身名）
    cid_name = custom_tag_path_index()
    # 模型表一次取回：model_id / lora_id 按 id 反查当前名，改名后自动跟随
    midx = model_index()
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            if ids is not None:
                # 标签过滤主路径：只取 SQL 命中后的候选子集，不整库加载
                _id_list = [int(x) for x in ids if str(x).strip().isdigit()]
                if not _id_list:
                    return []
                _ph = ",".join("?" * len(_id_list))
                _cond = " WHERE id IN ({0})".format(_ph)
                _tcond = " WHERE gallery_id IN ({0})".format(_ph)
                imgs = conn.execute(
                    "SELECT id, name, mtime, size, model_id, prompt "
                    "FROM {0}{1} ORDER BY id".format(GAL_IMG_TABLE, _cond),
                    _id_list
                ).fetchall()
                tags = conn.execute(
                    "SELECT gallery_id, prompt_id, custom_id FROM {0}{1} ORDER BY id".format(GAL_TAG_TABLE, _tcond),
                    _id_list
                ).fetchall()
                lora_rows = conn.execute(
                    "SELECT gallery_id, lora_id FROM {0}{1}".format(GAL_LORA_TABLE, _tcond),
                    _id_list
                ).fetchall()
            else:
                imgs = conn.execute(
                    "SELECT id, name, mtime, size, model_id, prompt "
                    "FROM {0} ORDER BY id".format(GAL_IMG_TABLE)
                ).fetchall()
                tags = conn.execute(
                    "SELECT gallery_id, prompt_id, custom_id FROM {0} ORDER BY id".format(GAL_TAG_TABLE)
                ).fetchall()
                lora_rows = conn.execute(
                    "SELECT gallery_id, lora_id FROM {0}".format(GAL_LORA_TABLE)
                ).fetchall()
        finally:
            conn.close()
    if not imgs:
        return []
    tag_map = {}
    for r in tags:
        tag_map.setdefault(r["gallery_id"], []).append(
            (r["prompt_id"], r["custom_id"])
        )
    lora_map = {}
    for r in lora_rows:
        lora_map.setdefault(r["gallery_id"], []).append(r["lora_id"])
    records = []
    for im in imgs:
        key = (im["name"] or "").strip()
        if not key:
            continue
        tag_names, ids, custom_ids = [], {}, {}
        custom_names = []
        # 展示顺序：提示词标签（词库词条）在前，自定义标签在后；同组内保持 gallery_tag 行序
        _rows = tag_map.get(im["id"], [])
        for pid, cid in _rows:
            if pid is not None:
                nm = id_name.get(str(pid))
                if nm:
                    tag_names.append(nm)
                    ids[nm] = str(pid)
        for pid, cid in _rows:
            if pid is None and cid is not None:
                nm = cid_name.get(str(cid))
                if nm and nm not in custom_ids:
                    tag_names.append(nm)
                    custom_ids[nm] = str(cid)
                    custom_names.append(nm)
        # 模型名按 model_id JOIN model 表实时取：改名后自动跟随，不再存名字快照
        mid = im["model_id"] if "model_id" in im.keys() else None
        model_name = ""
        if mid:
            mrow = midx.get(mid)
            if mrow and mrow.get("type") == MODEL_TYPE_MODEL:
                model_name = mrow["name"] or ""
        # lora 名按 gallery_lora 关联 + lora_id JOIN model 表实时取
        lora_names, lora_ids = [], []
        for lid in lora_map.get(im["id"], []):
            lrow = midx.get(lid)
            if lrow and lrow.get("type") == MODEL_TYPE_LORA:
                lora_ids.append(str(lid))
                lora_names.append(lrow["name"] or "")
        records.append({
            "key": key,
            "name": os.path.basename(key.replace("/", os.sep).replace("\\", os.sep)),
            "mtime": im["mtime"] or 0,
            "size": im["size"] or 0,
            "id": im["id"],
            "model": model_name,
            "modelId": mid,
            "loras": lora_names,
            "loraIds": lora_ids,
            "tags": tag_names,
            "tagIds": ids,
            "customTags": custom_names,
            # 反查回 id：行级 upsert 直接按 id 落库，不再次按名字猜
            "promptIds": list(ids.values()),
            "prompt": im["prompt"] or "",
            "hasPrompt": bool(im["prompt"]),
        })
    records.sort(key=lambda r: r["mtime"], reverse=True)
    return records


def gallery_load_records_by_keys(keys):
    """按图库相对路径（name/key）批量加载记录，返回顺序与传入 keys 保持一致。

    供随机拼页等“已知 key 列表、需要整行记录”的场景：先按 name IN 反查
    gallery_image.id，再复用 gallery_load_records 的关联组装（模型/LORA/标签
    实时 JOIN），避免重新全量筛选。查不到的 key 直接跳过。
    """
    keys = [k for k in keys if k]
    if not keys:
        return []
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            _ph = ",".join("?" * len(keys))
            rows = conn.execute(
                "SELECT id, name FROM {0} WHERE name IN ({1})".format(GAL_IMG_TABLE, _ph),
                keys
            ).fetchall()
        finally:
            conn.close()
    ids = [r["id"] for r in rows]
    if not ids:
        return []
    recs = gallery_load_records(ids) or []
    by_key = {r["key"]: r for r in recs}
    return [by_key[k] for k in keys if k in by_key]


def gallery_get_by_name(key):
    """按图库相对路径取单条详情记录（字段同 gallery_load_records 单条 + customIds）。

    图库详情数据源（不再读 PNG 元数据）：prompt/标签/模型/LORA 均经 DB 关联实时取。
    key 为 gallery_image.name（图库相对路径，与详情接口 ?path= 一致）；查不到返回 None。
    customIds 为自定义标签完整路径 -> id（str），详情展示/删除用 id 定位（id 优先于路径）。
    """
    key = (key or "").strip()
    if not key:
        return None
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            row = conn.execute(
                "SELECT id FROM {0} WHERE name = ?".format(GAL_IMG_TABLE), (key,)
            ).fetchone()
            gid = int(row["id"]) if row else None
        finally:
            conn.close()
    if gid is None:
        return None
    records = gallery_load_records(ids=[gid])
    if not records:
        return None
    rec = records[0]
    # 自定义标签完整路径 -> id（gallery_load_records 未暴露该映射；custom_tag_id_index
    # 的 key 是节点名即叶子名，故先取叶子再反查）
    rec["customIds"] = {}
    if rec.get("customTags"):
        nidx = custom_tag_id_index()
        for full in rec["customTags"]:
            leaf = full.rsplit("/", 1)[-1] or full
            cid = nidx.get(leaf) or nidx.get(full)
            if cid:
                rec["customIds"][full] = str(cid)
    return rec


def gallery_query_tag_gids(prompt_groups=None, custom_ids=None, mode="and"):
    """按标签 id 直查 gallery_tag，返回命中图库 id 集合（SQL 过滤，不走内存遍历）。

    prompt_groups -> list[list]，每个元素是一个词条及其子树展开后的所有 id（含自身）；
        按词条分组，保证 and 模式下"图须同时挂这些词条分支的标签"（逐组命中后交集，
        若平铺成一个 IN 列表会把组内并集误当命中）。
    custom_ids -> 自定义标签 id 列表，每个 id 连同其 custom_tag 子树后代一起命中
        （父级分组下钻到叶子；图片 gallery_tag.custom_id 只挂叶子 id，选父级必须展开才有命中）。
    mode: and=同时满足所有标签（交集）；or=满足任一（并集）。
    无任何过滤条件时返回 None（调用方按"无需标签过滤"处理）。
    """
    groups = []
    for g in (prompt_groups or []):
        ids = [str(x).strip() for x in g if str(x).strip().isdigit()]
        if ids:
            groups.append(ids)
    customs = [str(x).strip() for x in (custom_ids or []) if str(x).strip().isdigit()]
    if not groups and not customs:
        return None
    single_sets = []
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            for ids in groups:
                ph = ",".join("?" * len(ids))
                rows = conn.execute(
                    "SELECT DISTINCT gallery_id FROM {0} WHERE prompt_id IN ({1})".format(GAL_TAG_TABLE, ph),
                    ids
                ).fetchall()
                single_sets.append({r["gallery_id"] for r in rows})
            for cid in customs:
                # 子树展开：图片只挂叶子 custom_id，父级分组 id 必须下钻到后代一起命中，
                # 否则选父级分组（如"角色"）筛选恒为空（与 prompt 侧 _prompt_subtree_ids 对齐）
                _ensure_custom_tag_schema(conn)
                try:
                    root = int(cid)
                except ValueError:
                    continue
                ids = [root]
                frontier = [root]
                while frontier:
                    ph = ",".join("?" * len(frontier))
                    kid_rows = conn.execute(
                        "SELECT id FROM {0} WHERE parent_id IN ({1})".format(CUSTOM_TAG_TABLE, ph),
                        frontier
                    ).fetchall()
                    frontier = [r["id"] for r in kid_rows if r["id"] not in ids]
                    ids.extend(frontier)
                ph = ",".join("?" * len(ids))
                rows = conn.execute(
                    "SELECT DISTINCT gallery_id FROM {0} WHERE custom_id IN ({1})".format(GAL_TAG_TABLE, ph),
                    ids
                ).fetchall()
                single_sets.append({r["gallery_id"] for r in rows})
        finally:
            conn.close()
    if mode == "or":
        out = set()
        for s in single_sets:
            out |= s
        return out
    out = set(single_sets[0])
    for s in single_sets[1:]:
        out &= s
    return out


def gallery_tag_counts():
    """统计每个标签关联的图片数（详情页标签右侧角标用）。

    返回 {"prompt": {prompt_id(int): 图数}, "custom": {custom_id(int): 图数}}。
    计数按 gallery_tag 行去重 gallery_id，同一张图同一标签只算一次。
    自定义标签只算叶子自身的挂接（图片只挂叶子），父级不汇总子级。
    读取失败返回空映射（调用方按 0 处理，不影响详情展示）。
    """
    out = {"prompt": {}, "custom": {}}
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            prow = conn.execute(
                "SELECT prompt_id AS id, COUNT(DISTINCT gallery_id) AS n FROM {0} "
                "WHERE prompt_id IS NOT NULL GROUP BY prompt_id".format(GAL_TAG_TABLE)
            ).fetchall()
            crow = conn.execute(
                "SELECT custom_id AS id, COUNT(DISTINCT gallery_id) AS n FROM {0} "
                "WHERE custom_id IS NOT NULL GROUP BY custom_id".format(GAL_TAG_TABLE)
            ).fetchall()
        except Exception:
            return out
        finally:
            conn.close()
    for r in prow:
        out["prompt"][int(r["id"])] = int(r["n"] or 0)
    for r in crow:
        out["custom"][int(r["id"])] = int(r["n"] or 0)
    return out


def gallery_save_records(records):
    """全量写回图库：替换 gallery_image / gallery_tag 两表（单事务）。

    records 为内部 records 格式（与 gallery_load_records 对称）：提示词标签走
    rec["promptIds"]（词条 id，直接落 prompt_id，不做名字反查）；自定义标签走
    rec["customTags"]（按 custom_tag 字典 upsert 后落 custom_id）；
    prompt 为图片 prompt 文本（不再写 has_wf/has_prompt/tg 冗余列）。
    写入失败返回 False（事务整体回滚，不污染原数据）。
    """
    custom_tag_id = custom_tag_id_index()
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            old_created = {}
            for r in conn.execute(
                "SELECT name, created_at FROM {0}".format(GAL_IMG_TABLE)
            ).fetchall():
                old_created[r["name"]] = r["created_at"]
            # 全量重建前先记录旧词条关联（gallery_name -> prompt_id 集合）：
            # 软删词条的旧关联在重建时保留，图库标签不因词条软删而消失
            legacy_by_name = {}
            for r in conn.execute(
                "SELECT gi.name AS gn, gt.prompt_id AS pid FROM {0} gi "
                "JOIN {1} gt ON gt.gallery_id = gi.id "
                "WHERE gt.prompt_id IS NOT NULL".format(GAL_IMG_TABLE, GAL_TAG_TABLE)
            ).fetchall():
                if r["pid"] is not None:
                    legacy_by_name.setdefault(r["gn"], set()).add(r["pid"])
            conn.execute("DELETE FROM {0}".format(GAL_TAG_TABLE))
            conn.execute("DELETE FROM {0}".format(GAL_IMG_TABLE))
            now = _now()
            for rec in records or []:
                key = (rec.get("key") or "").strip()
                if not key:
                    continue
                created = old_created.get(key, now)
                cur = conn.execute(
                    "INSERT INTO {0} "
                    "(name, mtime, size, model_id, prompt, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?)".format(GAL_IMG_TABLE),
                    (key, rec.get("mtime") or 0, rec.get("size") or 0,
                     _as_int_or_none(rec.get("modelId") or rec.get("model_id")),
                     rec.get("prompt") or "",
                     created, now),
                )
                gid = cur.lastrowid
                _upsert_gallery_loras(conn, gid, rec.get("loraIds") or [])
                _insert_gallery_tags(conn, gid, rec, custom_tag_id, legacy_by_name.get(key))

            conn.commit()
            _bump()
            return True
        except sqlite3.Error:
            return False
        finally:
            conn.close()


def _insert_gallery_tags(conn, gid, rec, custom_tag_id, legacy=None):
    """写入一张图的标签行（gallery_tag），两路来源各自去重。

    提示词标签走**词条 id**：rec["promptIds"] 直接落 prompt_id，**不做名字反查**
    （归属在 SaveImage 保存时就已确定，词条改名/移动后标签不脱钩）。
    自定义标签仍按名字 upsert custom_tag 字典表后落 custom_id。

    legacy：该图在 DB 中已存在的旧词条关联 prompt_id 集合（全量重建时传入）。
    黑名单语义：软删词条（isdel=1）属于 legacy 的旧关联保留（图库标签不消失）；
    不属于 legacy 的新引用一律跳过（软删词条不能再被选作新标签）。
    单条打标路径不传 legacy，等价于空集——软删词条一律不可成为新标签。
    """
    legacy = legacy or set()
    seen = set()
    for raw in rec.get("promptIds") or []:
        s = str(raw or "").strip()
        if not s.isdigit() or s in seen:
            continue
        seen.add(s)
        pid = int(s)
        row = conn.execute(
            "SELECT id, isdel FROM {0} WHERE id=? AND type='entry'".format(TABLE), (pid,)
        ).fetchone()
        if row is None:
            continue
        # 软删词条：仅允许保留重建前的旧关联，不允许成为新标签
        if row["isdel"] and pid not in legacy:
            continue
        conn.execute(
            "INSERT INTO {0} (gallery_id, prompt_id, custom_id) "
            "VALUES (?,?,NULL)".format(GAL_TAG_TABLE),
            (gid, pid),
        )
    for t in rec.get("customTags") or []:
        t = (t or "").strip().strip("/")
        if not t or t in seen:
            continue
        seen.add(t)
        segs = [s.strip() for s in _TAG_PATH_SEP_RE.split(t) if s and s.strip()]
        if not segs:
            continue
        # 层级注册：顶层在 parent_id=NULL 下 find-or-create，后续段挂在前一段下。
        # 同一路径已存在时全部复用，不重复建；不同父级下的同名节点互不合并。
        pid = None
        cid = None
        for seg in segs:
            r = conn.execute(
                "SELECT id FROM {0} WHERE parent_id IS ? AND name=? LIMIT 1"
                .format(CUSTOM_TAG_TABLE), (pid, seg)
            ).fetchone()
            if r is not None:
                cid = r["id"]
            else:
                cur2 = conn.execute(
                    "SELECT COALESCE(MAX(sort_order),0) FROM {0} WHERE parent_id IS ?"
                    .format(CUSTOM_TAG_TABLE), (pid,)
                )
                max_so = cur2.fetchone()[0] or 0
                cnow = _now()
                cur3 = conn.execute(
                    "INSERT INTO {0} (parent_id, name, sort_order, created_at, updated_at) "
                    "VALUES (?,?,?,?,?)".format(CUSTOM_TAG_TABLE),
                    (pid, seg, max_so + 1, cnow, cnow),
                )
                cid = cur3.lastrowid
            pid = cid
        if cid:
            conn.execute(
                "INSERT INTO {0} (gallery_id, prompt_id, custom_id) "
                "VALUES (?,NULL,?)".format(GAL_TAG_TABLE),
                (gid, int(cid)),
            )


def _upsert_gallery_loras(conn, gid, lora_ids):
    """整图重写图片-lora 关联：清掉本图旧关联，按 lora_ids 重新插入（幂等）。

    仅写入 model 表中真实存在的 lora（type='lora'）；物理不存在的 id 跳过。
    供 gallery_save_records（全量重建）与 gallery_upsert_records（行级写入）共用。
    """
    conn.execute(
        "DELETE FROM {0} WHERE gallery_id=?".format(GAL_LORA_TABLE), (gid,)
    )
    seen = set()
    for raw in lora_ids or []:
        s = str(raw or "").strip()
        if not s.isdigit() or s in seen:
            continue
        seen.add(s)
        lid = int(s)
        row = conn.execute(
            "SELECT id FROM {0} WHERE id=? AND type=?".format(MODEL_TABLE),
            (lid, MODEL_TYPE_LORA),
        ).fetchone()
        if row is None:
            continue
        conn.execute(
            "INSERT OR IGNORE INTO {0} (gallery_id, lora_id) VALUES (?,?)".format(GAL_LORA_TABLE),
            (gid, lid),
        )


def gallery_upsert_records(records):
    """行级写入/更新图库记录：**只动传入的这几条，不做全表替换**。

    供保存新图、打标等单点写入使用，替代 gallery_save_records 的 O(N) 全量重写：
    给 1 张图加 1 个标签 = 写 1 行图 + 1 行 tag，其余图完全不受影响。

    不调用 _bump()：图库索引变化与词库树无关，无需让词库侧缓存失效。
    返回写入条数；失败返回 0（事务整体回滚）。
    """
    if not records:
        return 0
    custom_tag_id = custom_tag_id_index()
    with _lock:
        conn = connect()
        try:
            now = _now()
            n = 0
            for rec in records:
                key = (rec.get("key") or "").strip()
                if not key:
                    continue
                row = conn.execute(
                    "SELECT id FROM {0} WHERE name=?".format(GAL_IMG_TABLE), (key,)
                ).fetchone()
                if row is None:
                    rid = _as_int_or_none(rec.get("id"))
                    cols = ["name", "mtime", "size", "model_id",
                            "prompt", "created_at", "updated_at"]
                    vals = [key, rec.get("mtime") or 0, rec.get("size") or 0,
                            _as_int_or_none(rec.get("modelId") or rec.get("model_id")),
                            rec.get("prompt") or "", now, now]
                    if rid:
                        # 显式 id：图片改名时把原行的身份带过来，id 不漂移
                        cols.insert(0, "id")
                        vals.insert(0, rid)
                    cur = conn.execute(
                        "INSERT INTO {0} ({1}) VALUES ({2})".format(
                            GAL_IMG_TABLE, ",".join(cols),
                            ",".join(["?"] * len(vals))),
                        vals,
                    )
                    gid = rid or cur.lastrowid
                    _upsert_gallery_loras(conn, gid, rec.get("loraIds") or [])
                else:
                    gid = row["id"]
                    # model_id 用 COALESCE：调用方没给就保持原值，不会被顺手清空
                    conn.execute(
                        "UPDATE {0} SET mtime=?, size=?, "
                        "model_id=COALESCE(?, model_id), prompt=?, updated_at=? "
                        "WHERE id=?".format(GAL_IMG_TABLE),
                        (rec.get("mtime") or 0, rec.get("size") or 0,
                         _as_int_or_none(rec.get("modelId") or rec.get("model_id")),
                         rec.get("prompt") or "", now, gid),
                    )
                    _upsert_gallery_loras(conn, gid, rec.get("loraIds") or [])
                    # 标签整体重写：tag 行不随 UPDATE 级联，先清本图旧 tag；
                    # 清之前记录旧词条关联（软删词条的旧标签据此保留，不消失）
                    legacy = set()
                    for r in conn.execute(
                        "SELECT prompt_id FROM {0} WHERE gallery_id=? AND prompt_id IS NOT NULL".format(GAL_TAG_TABLE), (gid,)
                    ).fetchall():
                        legacy.add(r["prompt_id"])
                    conn.execute(
                        "DELETE FROM {0} WHERE gallery_id=?".format(GAL_TAG_TABLE), (gid,)
                    )
                _insert_gallery_tags(conn, gid, rec, custom_tag_id, legacy if row is not None else None)
                n += 1
            conn.commit()
            return n
        except sqlite3.Error as e:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            print(f"[ZhuleDB] 图库行级写入失败: {e}")
            return 0
        finally:
            conn.close()


def gallery_update_key(gid, new_key):
    """图片改名：只改这一行的 name（相对路径），**id 与 tag 行全部保持不变**。

    比「按新名插一行 + 删旧行」更好：id 不漂移（PNG 里存的 zhule_id 继续有效），
    tag 行也不用级联删除再重建。返回影响行数。
    """
    with _lock:
        conn = connect()
        try:
            cur = conn.execute(
                "UPDATE {0} SET name=?, updated_at=? WHERE id=?".format(GAL_IMG_TABLE),
                (new_key or "", _now(), int(gid)),
            )
            conn.commit()
            return cur.rowcount or 0
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 图片改名同步失败: {e}")
            return 0
        finally:
            conn.close()


def gallery_reserve(rels):
    """为即将保存的图片预建 DB 行，返回 {rel: id}：**先有身份，后落盘**。

    save_image 先拿行 id 写进 PNG 元数据（zhule_id），图片文件改名后仍按 id
    认回同一行，不会当成新图另起一行。落盘后由 index_new 补齐 mtime/size。
    同名行已存在时直接复用其 id（重复保存、序号回绕都不会出错）。
    """
    out = {}
    if not rels:
        return out
    now = _now()
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            for rel in rels:
                key = (rel or "").strip()
                if not key:
                    continue
                row = conn.execute(
                    "SELECT id FROM {0} WHERE name=?".format(GAL_IMG_TABLE), (key,)
                ).fetchone()
                if row is not None:
                    out[key] = row["id"]
                    continue
                cur = conn.execute(
                    "INSERT INTO {0} (name, mtime, size, model_id, prompt, "
                    "created_at, updated_at) VALUES (?,0,0,NULL,'',?,?)".format(GAL_IMG_TABLE),
                    (key, now, now),
                )
                out[key] = cur.lastrowid
            conn.commit()
        except sqlite3.Error as e:
            print(f"[ZhuleDB] 预建图库行失败: {e}")
        finally:
            conn.close()
    return out


def gallery_delete_records(keys):
    """行级删除图库记录（tag 行由 gallery_id 外键 ON DELETE CASCADE 一并清除）。

    返回删除条数；失败返回 0。
    """
    if not keys:
        return 0
    with _lock:
        conn = connect()
        try:
            n = 0
            for key in keys:
                key = (key or "").strip()
                if not key:
                    continue
                cur = conn.execute(
                    "DELETE FROM {0} WHERE name=?".format(GAL_IMG_TABLE), (key,)
                )
                n += cur.rowcount or 0
            conn.commit()
            return n
        except sqlite3.Error as e:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            print(f"[ZhuleDB] 图库行级删除失败: {e}")
            return 0
        finally:
            conn.close()
