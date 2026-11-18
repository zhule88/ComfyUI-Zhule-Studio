"""硬链接右键菜单：网页内注册 / 卸载 / 状态查询。

实际写盘动作交给 tools/win_hardlink/menu_install.ps1（只写 HKCU，不需要管理员），
本模块只负责：探测三处注册表键的真实状态、按需调起 PowerShell、把结果回给前端。
"""
import asyncio
import os
import subprocess

from aiohttp import web

_STUDIO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 注册 / 卸载脚本位置（_probe 与 _run_ps 都要用）
PS1_PATH = os.path.join(_STUDIO_DIR, 'tools', 'win_hardlink', 'menu_install.ps1')
# 只做硬链接：「粘贴为副本」与资源管理器自带 Ctrl+V 完全等价，已取消
MENU_ITEMS = [
    'ZhuleHardlinkPaste',
]
ROOTS = [
    ('文件夹空白处', 'Software\\Classes\\Directory\\Background\\shell'),
    ('文件夹右键', 'Software\\Classes\\Directory\\shell'),
    ('磁盘根目录', 'Software\\Classes\\Drive\\shell'),
]
# 3 个位置 × 1 个菜单项 = 3 个注册项，与 menu_install.ps1 里的 $roots × $menus 保持一致
TARGETS = [
    (where, root + '\\' + menu_id)
    for where, root in ROOTS
    for menu_id in MENU_ITEMS
]

def _decode(raw):
    if not raw:
        return ''
    for enc in ('gbk', 'utf-8'):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', 'replace')


def _probe():
    """只读注册表：逐个检查 3 个注册项是否已注册、命令是否仍指向当前插件目录。"""
    if os.name != 'nt':
        return {'supported': False, 'entries': [], 'installed': 0, 'total': len(TARGETS),
                'path_ok': False}
    import winreg
    entries = []
    for label, rel in TARGETS:
        item = {'where': label, 'installed': False, 'command': '', 'path_ok': False}
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rel) as key:
                item['installed'] = True
                try:
                    with winreg.OpenKey(key, 'command') as cmdkey:
                        item['command'] = str(winreg.QueryValueEx(cmdkey, '')[0])
                except OSError:
                    pass
        except OSError:
            pass
        entries.append(item)
    want = os.path.normcase(os.path.dirname(PS1_PATH))
    for e in entries:
        e['path_ok'] = bool(e['command']) and want in os.path.normcase(e['command'])
    installed = sum(1 for e in entries if e['installed'])
    path_ok = installed == len(TARGETS) and all(e['path_ok'] for e in entries)
    return {'supported': True, 'entries': entries, 'installed': installed,
            'total': len(TARGETS), 'path_ok': path_ok}

def _run_ps(action):
    if os.name != 'nt':
        raise RuntimeError('该功能仅支持 Windows')
    if not os.path.isfile(PS1_PATH):
        raise RuntimeError('安装脚本缺失：' + PS1_PATH)
    cmd = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
           '-File', PS1_PATH, '-Action', action]
    proc = subprocess.run(cmd, capture_output=True, timeout=120,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    out = (_decode(proc.stdout) + _decode(proc.stderr)).strip()
    return proc.returncode, out


async def get_hardlink_menu_status(request):
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _probe)
    return web.json_response(dict(ok=True, **data))


async def _do_action(request, action):
    loop = asyncio.get_event_loop()
    try:
        code, out = await loop.run_in_executor(None, _run_ps, action)
    except Exception as exc:  # 脚本缺失 / 超时 / 非 Windows
        return web.json_response({'ok': False, 'error': str(exc)}, status=500)
    data = await loop.run_in_executor(None, _probe)
    return web.json_response({
        'ok': code == 0,
        'action': action,
        'returncode': code,
        'output': out,
        'error': '' if code == 0 else (out or '脚本返回非 0 退出码'),
        'status': data,
    })


async def post_hardlink_menu_install(request):
    return await _do_action(request, 'install')


async def post_hardlink_menu_uninstall(request):
    return await _do_action(request, 'uninstall')
