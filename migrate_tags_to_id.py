# -*- coding: utf-8 -*-
"""一次性迁移：把图库 PNG 里的 zhule_prompt_tags 从「中文词条名」改写成「词条 id」。

背景
----
ID 化改造只落到了 zhule.db，存量 PNG 里躺的仍是中文名；而详情接口是直读 PNG 的，
所以之前只能在读取侧兼容老格式。本脚本从数据上根治：把名字一次性换成 id。

用法
----
    python migrate_tags_to_id.py            # 干跑：只统计，不动盘
    python migrate_tags_to_id.py --apply    # 真正回写

安全策略
--------
1. 默认干跑，必须显式 --apply 才写盘；
2. 词库里查不到 id 的名字一律原样保留，绝不丢数据；
3. 复用 png_text.write_png_text —— 原子写（tmp + os.replace）且保留原 mtime；
4. 每张写完立刻复读校验，发现不一致立即停止。

注意：写盘保留了原 mtime，所以服务端内存缓存不会自动失效，跑完请重启 ComfyUI。
"""
import os
import sys
import json
import importlib.util

# Windows 控制台默认 GBK，词条名可能含 • 等无法编码的字符，强制 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.join(HERE, "modules", "studio")

# 图库图片根目录：ComfyUI/output/zhule_studio/zhule_img
IMG_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "output", "zhule_studio", "zhule_img"))

KEY = "zhule_prompt_tags"


def _load(name, filename):
    """按文件路径加载模块，绕开包 __init__，避免拉起 ComfyUI 依赖。"""
    spec = importlib.util.spec_from_file_location(name, os.path.join(STUDIO, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


db = _load("_zhule_db", "db.py")
png_text = _load("_zhule_png_text", "png_text.py")


def _tag_list(raw):
    """字段可能是 JSON 数组字符串，也可能已是列表；非法值一律当空。"""
    if isinstance(raw, list):
        return raw
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except Exception:
        return []
    return v if isinstance(v, list) else []


def main():
    apply = "--apply" in sys.argv

    name2id = db.tag_id_index()
    print("词库 name->id 索引：%d 条" % len(name2id))
    print("图库目录：%s" % IMG_DIR)
    if not os.path.isdir(IMG_DIR):
        print("!! 找不到图库目录，终止")
        return 1

    pngs = []
    for root, dirs, files in os.walk(IMG_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.lower().endswith(".png"):
                pngs.append(os.path.join(root, f))
    pngs.sort()
    print("待处理图片：%d 张" % len(pngs))
    print("模式：%s\n" % ("写盘 --apply" if apply else "干跑（不改动任何文件）"))

    stat = {"no_key": 0, "already_id": 0, "changed": 0, "fail": 0}
    unresolved = {}
    preview = []

    for n, path in enumerate(pngs, 1):
        if n % 500 == 0:
            print("  ...已处理 %d/%d" % (n, len(pngs)))
        try:
            vals = _tag_list(png_text.read_png_text(path).get(KEY))
        except Exception as e:
            stat["fail"] += 1
            print("  读取失败：%s (%s)" % (path, e))
            continue

        if not vals:
            stat["no_key"] += 1
            continue

        ids, names = [], []
        for v in vals:
            s = str(v).strip()
            if not s:
                continue
            if s.isdigit():
                if s not in ids:
                    ids.append(s)
            elif s not in names:
                names.append(s)

        # 纯 id，无需处理
        if not names:
            stat["already_id"] += 1
            continue

        # 名字 -> id；查不到的保留原名
        final = list(ids)
        missing = []
        for nm in names:
            i = name2id.get(nm)
            if i:
                if i not in final:
                    final.append(i)
            else:
                missing.append(nm)
                unresolved[nm] = unresolved.get(nm, 0) + 1
        for nm in missing:
            if nm not in final:
                final.append(nm)

        if len(preview) < 3:
            preview.append((os.path.basename(path), list(vals), final))

        if not apply:
            stat["changed"] += 1
            continue

        new_val = json.dumps(final, ensure_ascii=False)
        try:
            if not png_text.write_png_text(path, {KEY: new_val}):
                stat["fail"] += 1
                print("  写入失败：%s" % path)
                continue
            back = _tag_list(png_text.read_png_text(path).get(KEY))
        except Exception as e:
            stat["fail"] += 1
            print("  异常：%s (%s)" % (path, e))
            continue

        if [str(x).strip() for x in back] != [str(x).strip() for x in final]:
            stat["fail"] += 1
            print("  校验不一致，已停止：%s" % path)
            return 1
        stat["changed"] += 1

    print("\n========== 结果 ==========")
    print("本就是 id / 无需改：%d 张" % stat["already_id"])
    print("字段为空或不存在  ：%d 张" % stat["no_key"])
    print("需要迁移          ：%d 张" % stat["changed"])
    print("失败              ：%d 张" % stat["fail"])
    if unresolved:
        print("\n词库里查不到 id、已原样保留的名字（共 %d 个）：" % len(unresolved))
        for nm, c in sorted(unresolved.items(), key=lambda x: -x[1])[:20]:
            print("  %s  x%d" % (nm, c))
    if preview:
        print("\n样例：")
        for fn, before, after in preview:
            print("  %s" % fn)
            print("    改前：%s" % json.dumps(before, ensure_ascii=False))
            print("    改后：%s" % json.dumps(after, ensure_ascii=False))
    if not apply:
        print("\n这是干跑。确认无误后加 --apply 执行写盘。")
    else:
        print("\n迁移完成。请重启 ComfyUI（写盘保留了原 mtime，内存缓存需重启才会失效）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
