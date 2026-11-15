# ============================================================
# Zhule 右键粘贴菜单（硬链接）—— 安装 / 卸载 / 状态
# 用法：
#   powershell -ExecutionPolicy Bypass -File menu_install.ps1 -Action install
#   powershell -ExecutionPolicy Bypass -File menu_install.ps1 -Action uninstall
#   powershell -ExecutionPolicy Bypass -File menu_install.ps1 -Action status
# 只写 HKCU（当前用户），不需要管理员权限，不写 HKLM。
#
# 结构说明：注册的是单个「顶级」菜单项——只做硬链接，不做「粘贴为副本」
#   · 副本与资源管理器自带 Ctrl+V 完全等价，多一项只是噪音
#   · 不用级联子菜单：Windows 11 经典菜单里级联要多展开一层，且部分版本对
#     Directory\Background 下的级联渲染不显示
# 静态注册项在 Windows 11 默认新菜单里可能被折叠，需点「显示更多选项」或 Shift+右键。
# ============================================================
param(
    [ValidateSet('install', 'uninstall', 'status')]
    [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'

$menuIcon = '%SystemRoot%\System32\shell32.dll,167'

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pasteScript = Join-Path $here 'paste_hardlink.ps1'
# 无窗口启动器：由 wscript.exe 以隐藏窗口方式调起 PowerShell，点菜单不再闪黑框
$launcher = Join-Path $here 'paste_launch.vbs'

# 单个菜单项，调 paste_hardlink.ps1
$menus = @(
    @{ Id = 'ZhuleHardlinkPaste'; Label = 'Zhule 粘贴为硬链接(&L)'; Tip = '零额外占用，与原图共用同一份数据' }
)

# 早期版本注册过「粘贴为副本」，现在取消；安装/卸载时都要把它清掉，避免残留
$legacyIds = @('ZhuleCopyPaste')

# 三个注册点：文件夹空白处 / 选中的文件夹 / 磁盘根目录
$roots = @(
    @{ Where = '文件夹空白处'; Root = 'HKCU:\Software\Classes\Directory\Background\shell' },
    @{ Where = '文件夹右键';   Root = 'HKCU:\Software\Classes\Directory\shell' },
    @{ Where = '磁盘根目录';   Root = 'HKCU:\Software\Classes\Drive\shell' }
)

function Write-Line([string]$text, [string]$color = 'Gray') {
    Write-Host $text -ForegroundColor $color
}

switch ($Action) {

    'install' {
        if (-not (Test-Path -LiteralPath $pasteScript)) {
            Write-Line '安装失败：同目录下找不到 paste_hardlink.ps1' 'Red'
            exit 1
        }
        if (-not (Test-Path -LiteralPath $launcher)) {
            Write-Line '安装失败：同目录下找不到 paste_launch.vbs（无窗口启动器）' 'Red'
            exit 1
        }

        $commandTpl = 'wscript.exe //B "{0}" "%V"'

        # 取消「粘贴为副本」后，老用户机器上可能还留着 ZhuleCopyPaste，安装时一并清掉
        foreach ($r in $roots) {
            foreach ($lid in $legacyIds) {
                $lk = Join-Path $r.Root $lid
                if (Test-Path $lk) { Remove-Item -Path $lk -Recurse -Force }
            }
        }

        foreach ($r in $roots) {
            foreach ($m in $menus) {
                $key = Join-Path $r.Root $m.Id
                # 先清旧键（含早期单层 / 级联结构），避免父项点击时跑到旧命令
                if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
                New-Item -Path $key -Force | Out-Null
                New-ItemProperty -Path $key -Name 'MUIVerb' -Value $m.Label -PropertyType String -Force | Out-Null
                New-ItemProperty -Path $key -Name 'Icon' -Value $menuIcon -PropertyType String -Force | Out-Null
                $cmdKey = Join-Path $key 'command'
                New-Item -Path $cmdKey -Force | Out-Null
                Set-ItemProperty -Path $cmdKey -Name '(default)' -Value ($commandTpl -f $launcher)
            }
        }

        Write-Line ''
        Write-Line '  安装完成（3 处 × 1 项 = 3 个注册项）' 'Green'
        Write-Line ''
        Write-Line '  已注册的位置：'
        foreach ($r in $roots) { Write-Line "    · $($r.Where)" }
        Write-Line ''
        Write-Line '  菜单项：' 'Cyan'
        foreach ($m in $menus) { Write-Line "    · $($m.Label)  --  $($m.Tip)" }
        Write-Line ''
        Write-Line '  使用方式：Zhule Studio 图库卡片右键「复制图片硬链接」，到目标文件夹右键 →「Zhule 粘贴为硬链接」' 'Cyan'
        Write-Line '  （资源管理器里选中图片 Ctrl+C 后用它粘贴，同样走硬链接；直接 Ctrl+V 则是普通副本）' 'DarkGray'
        Write-Line '  （全程无窗口、无弹框：成功就静默认落地，只有剪贴板为空或出错才弹提示）' 'DarkGray'
        Write-Line '  Windows 11 提示：默认新式菜单里看不到，点菜单最下面「显示更多选项」或按 Shift+右键 才会列出。' 'Yellow'
        Write-Line ''
        Write-Line "  脚本路径：$pasteScript"
        Write-Line '  卸载方式：双击 uninstall_menu.bat，或在 Zhule Studio 设置页点「卸载菜单」'
        Write-Line ''
    }

    'uninstall' {
        $removed = 0
        foreach ($r in $roots) {
            foreach ($m in $menus) {
                $key = Join-Path $r.Root $m.Id
                if (Test-Path $key) {
                    Remove-Item -Path $key -Recurse -Force
                    $removed++
                }
            }
            # 取消「粘贴为副本」前注册的 ZhuleCopyPaste，一并清掉
            foreach ($lid in $legacyIds) {
                $lk = Join-Path $r.Root $lid
                if (Test-Path $lk) {
                    Remove-Item -Path $lk -Recurse -Force
                    $removed++
                }
            }
        }
        # 兜底：清掉早期版本可能遗留的级联子项键
        foreach ($r in $roots) {
            $legacy = Join-Path $r.Root 'ZhulePasteMenu'
            if (Test-Path $legacy) { Remove-Item -Path $legacy -Recurse -Force; $removed++ }
        }
        Write-Line ''
        Write-Line "卸载完成：已移除 $removed 个右键菜单注册项" 'Green'
        Write-Line ''
    }

    'status' {
        Write-Line ''
        Write-Line '  Zhule 右键粘贴菜单 —— 当前状态' 'Cyan'
        Write-Line ''
        foreach ($r in $roots) {
            foreach ($m in $menus) {
                $key = Join-Path $r.Root $m.Id
                $label = "$($r.Where)"
                if (Test-Path $key) {
                    $cmd = ''
                    try { $cmd = (Get-ItemProperty -Path (Join-Path $key 'command') -ErrorAction Stop).'(default)' } catch { }
                    $okPath = $cmd -and ($cmd -like "*$here*")
                    $flag = if ($okPath) { '已安装' } else { '已安装(路径失效)' }
                    $color = if ($okPath) { 'Green' } else { 'Red' }
                    Write-Line "  [$flag] $label" $color
                    if ($cmd) { Write-Line "           $cmd" 'DarkGray' }
                } else {
                    Write-Line "  [未安装] $label" 'DarkGray'
                }
            }
        }
        Write-Line ''
        if (Test-Path -LiteralPath $pasteScript) {
            Write-Line "  执行脚本存在：$pasteScript" 'Green'
        } else {
            Write-Line '  警告：paste_hardlink.ps1 缺失，菜单会点了没反应' 'Red'
        }
        if (Test-Path -LiteralPath $launcher) {
            Write-Line "  无窗口启动器存在：$launcher" 'Green'
        } else {
            Write-Line '  警告：paste_launch.vbs 缺失，菜单会点了没反应' 'Red'
        }
        Write-Line '  Windows 11 提示：静态菜单项在「显示更多选项」/ Shift+右键 里。' 'Yellow'
        Write-Line ''
    }
}
