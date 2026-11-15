' ============================================================
' Zhule 硬链接菜单 - 无窗口启动器
' 由 wscript.exe 调起，用 WScript.Shell.Run 的窗口样式 0 把
' powershell.exe 完全隐藏，避免点击右键菜单时闪出命令行黑框。
' 用法（由注册表 command 传入）：
'   wscript.exe //B "paste_launch.vbs" "%V"
' ============================================================
Option Explicit

Dim fso, sh, here, ps1, target, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "paste_hardlink.ps1")

If Not fso.FileExists(ps1) Then
    WScript.Quit 1
End If

target = ""
If WScript.Arguments.Count > 0 Then target = WScript.Arguments(0)

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass" & _
      " -WindowStyle Hidden -File " & Chr(34) & ps1 & Chr(34) & _
      " " & Chr(34) & target & Chr(34) & " -Quiet"

' 第二个参数 0 = 窗口隐藏，第三个参数 True = 等 PowerShell 跑完再退出（全程无窗口）
sh.Run cmd, 0, True
