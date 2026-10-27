"""Zhule Studio 词库 SQLite 数据层（运行时唯一数据源）。

自 DB 迁移后，词库的增删改查全部走 zhule.db（表 prompt），
代码不再扫描 / 读写 modules/studio/prompt 文件夹与 wordbank_index.json。
本模块提供：建树、节点定位、增删改、排序、标签索引、图库联动查询，
并维护内存数据版本号供 gallery 的 TTL 缓存失效判断。
"""
import json
import os
import sqlite3
import threading
import time

_STUDIO_DIR = os.path.dirname(os.path.abspath(__file__))
# 全插件唯一数据源：词库 prompt / 图库 gallery_image+gallery_tag / 自定义标签 custom_tag 同库。
# 落位 modules/studio/zhule.db（随插件走，勿移出插件目录，否则重装即丢数据）。
DB_PATH = os.path.join(_STUDIO_DIR, "zhule.db")
TABLE = "prompt"  # 词库表（2259 行；另存在 AUTOINCREMENT 序列）

_lock = threading.RLock()
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
                "FROM {0} ORDER BY id".format(TABLE)
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


def get_parent_id(node_id):
    with _lock:
        conn = connect()
        try:
            r = conn.execute(
                "SELECT parent_id FROM {0} WHERE id=?".format(TABLE), (node_id,)
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
                    "SELECT id, name, sort_order FROM {0} WHERE parent_id IS ? AND id<>?".format(TABLE),
                    (parent_id, exclude_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, name, sort_order FROM {0} WHERE parent_id IS ?".format(TABLE),
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
                    "SELECT COALESCE(MAX(sort_order),0) FROM {0} WHERE parent_id IS ?".format(TABLE),
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


def delete_subtree(node_id):
    """递归删除节点及全部子孙（BFS 收集后代后一次删除）。返回删除行数。"""
    with _lock:
        conn = connect()
        try:
            ids = [node_id]
            cur = [node_id]
            while True:
                ph = ",".join("?" * len(cur))
                rows = conn.execute(
                    "SELECT id FROM {0} WHERE parent_id IN ({1})".format(TABLE, ph), cur
                ).fetchall()
                nxt = [r["id"] for r in rows]
                if not nxt:
                    break
                ids.extend(nxt)
                cur = nxt
            ph = ",".join("?" * len(ids))
            conn.execute("DELETE FROM {0} WHERE id IN ({1})".format(TABLE, ph), ids)
            conn.commit()
            _bump()
            return len(ids)
        except sqlite3.Error:
            return 0
        finally:
            conn.close()


def _reorder(pid, ordered_raws):
    """按 ordered_raws 顺序给指定父层的子节点赋连续 sort_order=1..n。

    匹配先按原始名（编号前缀）再按显示名；未出现在列表中的现有节点按原规则排到末尾。
    返回更新的节点数。
    """
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, name, sort_order FROM {0} WHERE parent_id IS ?".format(TABLE),
                (pid,),
            ).fetchall()
        finally:
            conn.close()
    item_map = {}
    for r in rows:
        so = r["sort_order"] or 0
        item_map.setdefault(f"{so:02d}_{r['name']}" if so > 0 else r["name"], r["id"])
        item_map.setdefault(r["name"], r["id"])
    ordered, seen = [], set()
    for rawname in ordered_raws or []:
        if not rawname:
            continue
        nid = item_map.get(rawname)
        if nid is None or nid in seen:
            continue
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
    """词条显示名 -> DB id（str）。同名取树序第一个（与旧实现一致）。"""
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
    """词条显示名 -> cn 首行（用于图库详情中文标签填充）。"""
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
    """词条显示名 -> en 全文（用于图库详情英文提示词填充）。"""
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
                "SELECT id, en FROM {0} WHERE type='entry' AND en IS NOT NULL AND en<>''".format(TABLE)
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
CUSTOM_TAG_TABLE = "custom_tag"  # 自定义标签字典表（仿 prompt 表：父子层级 + name）


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


def _ensure_custom_tag_schema(conn):
    """确保 custom_tag 字典表存在（幂等）。

    group 为标签分组（原存于 gallery/meta.json，随自定义标签迁入本表）。
    """
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "parent_id INTEGER REFERENCES {0}(id) ON DELETE CASCADE,"
        "name TEXT NOT NULL,"
        "group_name TEXT NOT NULL DEFAULT '',"
        "sort_order INTEGER DEFAULT 0,"
        "created_at INTEGER NOT NULL,"
        "updated_at INTEGER NOT NULL"
        ")".format(CUSTOM_TAG_TABLE)
    )
    _add_column_if_missing(conn, CUSTOM_TAG_TABLE, "group_name", "TEXT NOT NULL DEFAULT ''")


def _ensure_gallery_schema(conn):
    """确保图库两表存在（幂等）+ 定位索引，并清理存量的误存数据。

    表结构由代码自带（schema as code）：新环境拿到空库时也能直接用，
    不必依赖任何外部迁移脚本。

    gallery_tag.gallery_id 级联：删图时只删 gallery_image，tag 行由外键自动清除。
    """
    _ensure_custom_tag_schema(conn)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS {0} ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "name TEXT NOT NULL,"
        "mtime INTEGER NOT NULL DEFAULT 0,"
        "size INTEGER NOT NULL DEFAULT 0,"
        "model TEXT NOT NULL DEFAULT '',"
        "loras TEXT NOT NULL DEFAULT '',"
        "prompt TEXT NOT NULL DEFAULT '',"
        "created_at INTEGER NOT NULL,"
        "updated_at INTEGER NOT NULL"
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
        "CREATE INDEX IF NOT EXISTS idx_{0}_name ON {0}(name)".format(GAL_IMG_TABLE)
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_{0}_gallery ON {0}(gallery_id)".format(GAL_TAG_TABLE)
    )
    # 存量清理：gallery_image.prompt 曾误存整份 workflow JSON，一律清空。
    # 必须放在建表之后——否则空库上会抛 no such table，导致 connect() 失败、
    # 路由注册中断、/zhule_studio 直接 404。
    # 正面提示词待重建索引时由 _make_record 重新写入；workflow 不落库。
    conn.execute(
        "UPDATE {0} SET prompt='' WHERE prompt LIKE '{{%'".format(GAL_IMG_TABLE)
    )


def _json_str_list(raw):
    """DB 中的 JSON 字符串（loras/tg）→ 字符串列表；异常/空返回 []。"""
    if not raw:
        return []
    try:
        val = json.loads(raw)
    except Exception:
        return []
    return [x for x in val if isinstance(x, str)] if isinstance(val, list) else []


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


def custom_tag_meta():
    """自定义标签字典 + 分组（取代原 gallery/meta.json 的 load 侧）。

    返回 {"tags": [{"name":..., "group":...}], "updatedAt": ""}，
    与 gallery._tag_groups 消费的结构保持一致。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            rows = conn.execute(
                "SELECT name, group_name FROM {0} WHERE name<>'' "
                "ORDER BY name, id".format(CUSTOM_TAG_TABLE)
            ).fetchall()
        finally:
            conn.close()
    seen, tags = set(), []
    for r in rows:
        n = r["name"]
        if n and n not in seen:
            seen.add(n)
            tags.append({"name": n, "group": r["group_name"] or "其他"})
    return {"tags": tags, "updatedAt": ""}


def custom_tag_set_group(name, group):
    """按名设置自定义标签的分组，不存在则新建（取代原 save_meta 侧）。

    返回 True 表示新建，False 表示更新了已有标签。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            now = _now()
            row = conn.execute(
                "SELECT id FROM {0} WHERE name=? AND parent_id IS NULL "
                "ORDER BY id LIMIT 1".format(CUSTOM_TAG_TABLE), (name,)
            ).fetchone()
            if row is None:
                cur = conn.execute(
                    "SELECT COALESCE(MAX(sort_order),0) FROM {0} "
                    "WHERE parent_id IS NULL".format(CUSTOM_TAG_TABLE)
                )
                conn.execute(
                    "INSERT INTO {0} (parent_id, name, group_name, sort_order, "
                    "created_at, updated_at) VALUES (NULL,?,?,?,?,?)".format(CUSTOM_TAG_TABLE),
                    (name, group, (cur.fetchone()[0] or 0) + 1, now, now),
                )
                created = True
            else:
                conn.execute(
                    "UPDATE {0} SET group_name=?, updated_at=? WHERE id=?".format(
                        CUSTOM_TAG_TABLE),
                    (group, now, row["id"]),
                )
                created = False
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    _bump()
    return created


def custom_tag_list():
    """全量 custom_tag 行（含父子层级），按父层/排序返回 list[dict]。"""
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            rows = conn.execute(
                "SELECT id, parent_id, name, sort_order, created_at, updated_at "
                "FROM {0} ORDER BY (parent_id IS NULL) DESC, sort_order, name, id".format(CUSTOM_TAG_TABLE)
            ).fetchall()
        finally:
            conn.close()
    return [dict(r) for r in rows]


def custom_tag_insert(parent_id, name, so=None):
    """新增自定义标签；parent_id=None 为顶层。sort_order 默认取同父 max+1。

    返回 (id, ok)。调用方应先做同级同名校验。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            if so is None:
                cur = conn.execute(
                    "SELECT COALESCE(MAX(sort_order),0) FROM {0} WHERE parent_id IS ?".format(CUSTOM_TAG_TABLE),
                    (parent_id,),
                )
                so = (cur.fetchone()[0] or 0) + 1
            now = _now()
            cur = conn.execute(
                "INSERT INTO {0} (parent_id, name, sort_order, created_at, updated_at) "
                "VALUES (?,?,?,?,?)".format(CUSTOM_TAG_TABLE),
                (parent_id, name, so, now, now),
            )
            conn.commit()
            _bump()
            return cur.lastrowid, True
        except sqlite3.Error:
            return None, False
        finally:
            conn.close()


def custom_tag_update(node_id, name=None, sort_order=None):
    """编辑自定义标签：可选更新 name / sort_order，并刷新 updated_at。"""
    with _lock:
        conn = connect()
        try:
            sets, vals = [], []
            if name is not None:
                sets.append("name=?")
                vals.append(name)
            if sort_order is not None:
                sets.append("sort_order=?")
                vals.append(sort_order)
            if not sets:
                return False
            sets.append("updated_at=?")
            vals.append(_now())
            vals.append(node_id)
            cur = conn.execute(
                "UPDATE {0} SET {1} WHERE id=?".format(CUSTOM_TAG_TABLE, ", ".join(sets)), vals
            )
            conn.commit()
            _bump()
            return cur.rowcount > 0
        except sqlite3.Error:
            return False
        finally:
            conn.close()


def custom_tag_delete_subtree(node_id):
    """递归删除自定义标签及全部子孙（BFS 收集后代后一次删除）。

    gallery_tag.custom_id 外键 ON DELETE CASCADE：关联图片标签一并删除。
    返回删除的 custom_tag 行数。
    """
    with _lock:
        conn = connect()
        try:
            _ensure_custom_tag_schema(conn)
            ids = [node_id]
            cur = [node_id]
            while True:
                ph = ",".join("?" * len(cur))
                rows = conn.execute(
                    "SELECT id FROM {0} WHERE parent_id IN ({1})".format(CUSTOM_TAG_TABLE, ph), cur
                ).fetchall()
                nxt = [r["id"] for r in rows]
                if not nxt:
                    break
                ids.extend(nxt)
                cur = nxt
            ph = ",".join("?" * len(ids))
            conn.execute("DELETE FROM {0} WHERE id IN ({1})".format(CUSTOM_TAG_TABLE, ph), ids)
            conn.commit()
            _bump()
            return len(ids)
        except sqlite3.Error:
            return 0
        finally:
            conn.close()



def gallery_load_records():
    """从 DB 加载图库全量记录（内部 records 格式）。

    返回 list[dict]，每条含：
    key/name/mtime/size/model/loras/tags/tagIds/customTagIds/prompt/hasPrompt。
    key 即 gallery_image.name（图库相对路径，与磁盘记录行为一致）；
    tags 为标签显示名数组（prompt 类经 id->name 反查，custom 类经 custom_id LEFT
    JOIN custom_tag 取名——不再读自存 name）；
    tagIds 为 prompt 类 name->prompt_id 映射；customTagIds 为 custom 类
    name->custom_id 映射（词条/自定义标签改名后按 id 不脱钩）；
    prompt 为图片 prompt 文本（DB 直读，避免每次读 PNG）；
    hasPrompt 由 prompt 非空推导。
    注：hasWF 已不落库（列表链路无消费者），真实值以详情接口
    get_gallery_detail 实时读 PNG workflow 推导为准。
    读取失败（表缺失等）返回 None（调用方按索引不可用处理）；空库返回 []。
    """
    id_name = {}
    for n, i in tag_id_index().items():
        id_name[i] = n
    cid_name = {}
    for n, i in custom_tag_id_index().items():
        cid_name[i] = n
    with _lock:
        conn = connect()
        try:
            _ensure_gallery_schema(conn)
            imgs = conn.execute(
                "SELECT id, name, mtime, size, model, loras, prompt "
                "FROM {0} ORDER BY id".format(GAL_IMG_TABLE)
            ).fetchall()
            tags = conn.execute(
                "SELECT gallery_id, prompt_id, custom_id FROM {0} ORDER BY id".format(GAL_TAG_TABLE)
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
    records = []
    for im in imgs:
        key = (im["name"] or "").strip()
        if not key:
            continue
        tag_names, ids, custom_ids = [], {}, {}
        custom_names = []
        for pid, cid in tag_map.get(im["id"], []):
            if pid is not None:
                nm = id_name.get(str(pid))
                if nm:
                    tag_names.append(nm)
                    ids[nm] = str(pid)
            elif cid is not None:
                nm = cid_name.get(str(cid))
                if nm and nm not in custom_ids:
                    tag_names.append(nm)
                    custom_ids[nm] = str(cid)
                    custom_names.append(nm)
        records.append({
            "key": key,
            "name": os.path.basename(key.replace("/", os.sep).replace("\\", os.sep)),
            "mtime": im["mtime"] or 0,
            "size": im["size"] or 0,
            "model": im["model"] or "",
            "loras": _json_str_list(im["loras"]),
            "tags": tag_names,
            "tagIds": ids,
            "customTags": custom_names,
            "customTagIds": custom_ids,
            # 反查回 id：行级 upsert 直接按 id 落库，不再次按名字猜
            "promptIds": list(ids.values()),
            "prompt": im["prompt"] or "",
            "hasPrompt": bool(im["prompt"]),
        })
    records.sort(key=lambda r: r["mtime"], reverse=True)
    return records


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
                    "(name, mtime, size, model, loras, prompt, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?)".format(GAL_IMG_TABLE),
                    (key, rec.get("mtime") or 0, rec.get("size") or 0,
                     rec.get("model") or "",
                     json.dumps(rec.get("loras") or [], ensure_ascii=False),
                     rec.get("prompt") or "",
                     created, now),
                )
                gid = cur.lastrowid
                _insert_gallery_tags(conn, gid, rec, custom_tag_id)

            conn.commit()
            _bump()
            return True
        except sqlite3.Error:
            return False
        finally:
            conn.close()


def _insert_gallery_tags(conn, gid, rec, custom_tag_id):
    """写入一张图的标签行（gallery_tag），两路来源各自去重。

    提示词标签走**词条 id**：rec["promptIds"] 直接落 prompt_id，**不做名字反查**
    （归属在 SaveImage 保存时就已确定，词条改名/移动后标签不脱钩）。
    自定义标签仍按名字 upsert custom_tag 字典表后落 custom_id。
    """
    seen = set()
    for raw in rec.get("promptIds") or []:
        s = str(raw or "").strip()
        if not s.isdigit() or s in seen:
            continue
        seen.add(s)
        # 词条已被删除时 id 在 prompt 表已不存在：跳过，不插脏 id
        row = conn.execute(
            "SELECT id FROM {0} WHERE id=? AND type='entry'".format(TABLE), (int(s),)
        ).fetchone()
        if row is None:
            continue
        conn.execute(
            "INSERT INTO {0} (gallery_id, prompt_id, custom_id) "
            "VALUES (?,?,NULL)".format(GAL_TAG_TABLE),
            (gid, int(s)),
        )
    for t in rec.get("customTags") or []:
        t = (t or "").strip()
        if not t or t in seen:
            continue
        seen.add(t)
        cid = custom_tag_id.get(t)
        if cid is None:
            cur2 = conn.execute(
                "SELECT COALESCE(MAX(sort_order),0) FROM {0} "
                "WHERE parent_id IS NULL".format(CUSTOM_TAG_TABLE)
            )
            max_so = cur2.fetchone()[0] or 0
            cnow = _now()
            cur3 = conn.execute(
                "INSERT INTO {0} (parent_id, name, sort_order, created_at, updated_at) "
                "VALUES (NULL,?,?,?,?)".format(CUSTOM_TAG_TABLE),
                (t, max_so + 1, cnow, cnow),
            )
            cid = str(cur3.lastrowid)
            custom_tag_id[t] = cid
        conn.execute(
            "INSERT INTO {0} (gallery_id, prompt_id, custom_id) "
            "VALUES (?,NULL,?)".format(GAL_TAG_TABLE),
            (gid, int(cid)),
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
                    cur = conn.execute(
                        "INSERT INTO {0} "
                        "(name, mtime, size, model, loras, prompt, created_at, updated_at) "
                        "VALUES (?,?,?,?,?,?,?,?)".format(GAL_IMG_TABLE),
                        (key, rec.get("mtime") or 0, rec.get("size") or 0,
                         rec.get("model") or "",
                         json.dumps(rec.get("loras") or [], ensure_ascii=False),
                         rec.get("prompt") or "", now, now),
                    )
                    gid = cur.lastrowid
                else:
                    gid = row["id"]
                    conn.execute(
                        "UPDATE {0} SET mtime=?, size=?, model=?, loras=?, prompt=?, updated_at=? "
                        "WHERE id=?".format(GAL_IMG_TABLE),
                        (rec.get("mtime") or 0, rec.get("size") or 0,
                         rec.get("model") or "",
                         json.dumps(rec.get("loras") or [], ensure_ascii=False),
                         rec.get("prompt") or "", now, gid),
                    )
                    # 标签整体重写：tag 行不随 UPDATE 级联，先清本图旧 tag
                    conn.execute(
                        "DELETE FROM {0} WHERE gallery_id=?".format(GAL_TAG_TABLE), (gid,)
                    )
                _insert_gallery_tags(conn, gid, rec, custom_tag_id)
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
