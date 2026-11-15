param(
    [string]$TargetDir = "",
    [string]$SourceList = "",
    [switch]$TestMode,
    # 静默模式（右键菜单走这里）：成功 / 回退复制不弹框，只有真正出错才提示
    [switch]$Quiet,
    # 兜底：老版本注册表命令可能还带 -Mode hardlink，这里吸收掉不报错（副本模式已取消）
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Show-Info([string]$text, [string]$title = 'Zhule 硬链接', [string]$icon = 'Information', [switch]$Always) {
    if ($TestMode) {
        Write-Host "[$title] $text"
        return
    }
    # 静默模式：默认一律不弹，只有明确标 -Always 的（真出错 / 剪贴板为空）才提示，否则点完菜单毫无反馈
    if ($Quiet -and -not $Always) { return }
    [void][System.Windows.Forms.MessageBox]::Show($text, $title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}

function Get-UniqueDest([string]$dir, [string]$name) {
    $dest = Join-Path $dir $name
    if (-not (Test-Path -LiteralPath $dest)) { return $dest }
    $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
    $ext = [System.IO.Path]::GetExtension($name)
    for ($i = 1; $i -lt 1000; $i++) {
        $cand = Join-Path $dir ("{0}({1}){2}" -f $base, $i, $ext)
        if (-not (Test-Path -LiteralPath $cand)) { return $cand }
    }
    $tag = [guid]::NewGuid().ToString('N').Substring(0, 6)
    return (Join-Path $dir ("{0}({1}){2}" -f $base, $tag, $ext))
}

try {
    if ([string]::IsNullOrWhiteSpace($TargetDir)) { $TargetDir = (Get-Location).Path }
    $TargetDir = $TargetDir.Trim('"').Trim()
    # 保留磁盘根目录形式（D:\），仅去掉子目录末尾的分隔符
    if ($TargetDir.Length -gt 3) { $TargetDir = $TargetDir.TrimEnd('\') }
    if (-not (Test-Path -LiteralPath $TargetDir -PathType Container)) {
        Show-Info "目标文件夹不存在：`n$TargetDir" 'Zhule 硬链接 - 错误' 'Error' -Always
        exit 1
    }

    $srcs = @()
    if (-not [string]::IsNullOrWhiteSpace($SourceList)) {
        # 手动指定源文件（用 | 分隔），用于测试或命令行调用
        $srcs = @($SourceList -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    } else {
        try {
            # Windows PowerShell 5.1 的 Get-Clipboard -Format FileDropList 返回一个 List 包装，
            # 直接 @(...) 包裹会把整批文件当成「一项」（多个路径被空格拼成一条，Get-Item 必然失败），
            # 必须遍历展开，逐个取 FileInfo.FullName。
            $srcs = @()
            foreach ($one in (Get-Clipboard -Format FileDropList -ErrorAction Stop)) {
                if ($one -is [System.IO.FileSystemInfo]) {
                    if ($one.FullName) { $srcs += $one.FullName }
                } elseif ($one) {
                    $srcs += [string]$one
                }
            }
        } catch {
            $srcs = @()
        }
    }
    $srcs = @($srcs | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)

    if ($srcs.Count -eq 0) {
        Show-Info ("剪贴板里没有文件。`n`n请先在资源管理器里选中图片并 Ctrl+C，`n再到目标文件夹右键使用本菜单。") `
            'Zhule 硬链接 - 提示' 'Warning' -Always
        exit 2
    }

    $linked = 0
    $copied = 0
    $failed = New-Object System.Collections.ArrayList

    foreach ($src in $srcs) {
        try {
            $item = Get-Item -LiteralPath $src -Force
            if ($item.PSIsContainer) {
                [void]$failed.Add("$($item.Name)  是文件夹，本菜单只处理文件")
                continue
            }

            $srcRoot = ([System.IO.Path]::GetPathRoot($src)).TrimEnd('\')
            $dstRoot = ([System.IO.Path]::GetPathRoot($TargetDir)).TrimEnd('\')
            $sameVolume = ($srcRoot -ieq $dstRoot)

            $dest = Get-UniqueDest $TargetDir $item.Name

            if ($sameVolume) {
                try {
                    New-Item -ItemType HardLink -Path $dest -Target $src -ErrorAction Stop | Out-Null
                    $linked++
                    continue
                } catch {
                    # 同卷但文件系统不支持硬链接（如 exFAT / FAT32），回退为真实复制
                }
            }
            Copy-Item -LiteralPath $src -Destination $dest -ErrorAction Stop
            $copied++
        } catch {
            [void]$failed.Add("$(Split-Path -Leaf $src)  $($_.Exception.Message)")
        }
    }

    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("目标文件夹：$TargetDir")
    [void]$lines.Add('')
    [void]$lines.Add("硬链接成功：$linked 个（零额外空间占用，元数据保留）")
    if ($copied -gt 0) {
        [void]$lines.Add("回退为复制：$copied 个（跨卷或文件系统不支持硬链接）")
    }
    if ($failed.Count -gt 0) {
        [void]$lines.Add("失败：$($failed.Count) 个")
        [void]$lines.Add('')
        foreach ($f in $failed) { [void]$lines.Add("  · $f") }
    }

    $doneTitle = 'Zhule 硬链接 - 完成'
    # 完全成功（含跨卷回退复制）静默落地；只有出现失败文件才弹框告知
    if ($failed.Count -gt 0) {
        Show-Info ($lines -join "`n") $doneTitle 'Warning' -Always
    } else {
        Show-Info ($lines -join "`n") $doneTitle 'Information'
    }
    exit 0
} catch {
    Show-Info "发生未预期错误：`n$($_.Exception.Message)" 'Zhule 硬链接 - 错误' 'Error' -Always
    exit 3
}
