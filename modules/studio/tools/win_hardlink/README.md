---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: f31316edd1bc287d4516025481a71e55_aa3c5218e05011f18c5752540024e231
    ReservedCode1: l2uvVKTAcFqphIDqW6CTgxw6VzUXQ+Z3IcWdQxqibnLJSxQU39G0M2o/1nfzcVtHYrj37QvrfoI8+l9dX6Qpr12/fCfKah7LIMyNJmddWjxdsRueCmZdHEG8Xo6j6214eehWoXtsSXSM6d9OB3e4zDaHRxjDgTyLMzxD5A7R6JNXg4bZQAWR32f7q7w=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: f31316edd1bc287d4516025481a71e55_aa3c5218e05011f18c5752540024e231
    ReservedCode2: l2uvVKTAcFqphIDqW6CTgxw6VzUXQ+Z3IcWdQxqibnLJSxQU39G0M2o/1nfzcVtHYrj37QvrfoI8+l9dX6Qpr12/fCfKah7LIMyNJmddWjxdsRueCmZdHEG8Xo6j6214eehWoXtsSXSM6d9OB3e4zDaHRxjDgTyLMzxD5A7R6JNXg4bZQAWR32f7q7w=
---

# 硬链接右键菜单（Windows）

给 Zhule Studio 图库导出的补充工具：把「复制 → 粘贴」这一套操作，在**资源管理器里**变成一个「粘贴为硬链接」菜单项。

- 零额外磁盘占用（同一分区内）、保留 PNG 元数据（workflow / prompt 文本块）
- 不依赖 ComfyUI、不依赖浏览器，插件关掉也能用
- 只写当前用户注册表（HKCU），**不需要管理员权限**，不碰 HKLM

---

## 零、网页内注册 / 卸载（不用碰文件）

Zhule Studio → 右上角齿轮「设置」 → **通用设置** → 「右键粘贴菜单」：

- 状态由后端实时读 HKCU：`未注册` / `3/3 已注册` / `3/3 已注册，但指向已失效`（插件目录搬过家，点「注册菜单」覆盖修复）
- 注册项 = 3 个位置（文件夹空白处 / 文件夹右键 / 磁盘根目录）× 1 个菜单项（粘贴为硬链接）= 3 项
- 点「注册菜单」= 双击 `install_menu.bat`；点「卸载菜单」= 双击 `uninstall_menu.bat`
- 接口：`GET /zhule_studio/api/hardlink-menu/status`、`POST /zhule_studio/api/hardlink-menu/install`、`POST /zhule_studio/api/hardlink-menu/uninstall`（后端 `modules/studio/hardlink.py`）
- 改了后端代码需**重启 ComfyUI** 才生效；只改前端 Ctrl+F5 即可

---

## 一、安装（一键）

双击本目录下的 **`install_menu.bat`** 即可完成注册。看到「安装完成」后立刻生效，无需重启资源管理器。

如果要卸载：双击 **`uninstall_menu.bat`**，立刻清除全部注册项，无残留。

命令行方式（供高级用户 / 批量部署）：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File menu_install.ps1 -Action install
powershell -NoProfile -ExecutionPolicy Bypass -File menu_install.ps1 -Action uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File menu_install.ps1 -Action status
```

---

## 二、使用

1. 资源管理器里选中一张或多张图片，**Ctrl+C**（和平时复制完全一样）；或 Zhule Studio 图库卡片右键「复制图片硬链接」
2. 到目标文件夹，**空白处右键 →「Zhule 粘贴为硬链接」**：零额外占用，与原图共用同一份数据（同分区且 NTFS 才成立）
3. **Windows 11 注意**：默认的新式右键菜单不展示注册表静态项，点菜单最下面「显示更多选项」或直接按 **Shift+右键** 才能看到这一项
4. **全程无黑框、无完成弹框**：文件直接静默落地，粘贴完就没有任何打扰。只有两种情况会提示——剪贴板里没有文件、或个别文件失败

直接 Ctrl+V 也能落地，但那是系统自带的普通副本（占空间、改一边不影响另一边），不需要也不该由本工具重复造一遍。

菜单在三个位置都会出现：文件夹空白处右键、选中文件夹右键、磁盘根目录右键。

---

## 三、行为规则

| 情况 | 行为 |
|---|---|
| 源文件与目标在**同一分区** | 建硬链接，零拷贝 |
| 源文件与目标在**不同分区** | 自动回退为真实复制（`Copy-Item`），并在结果里标注「回退为复制」 |
| 同分区但文件系统不支持硬链接（exFAT / FAT32） | 自动回退为真实复制 |
| 目标目录已有同名文件 | 自动改名 `xxx(1).png`、`xxx(2).png`，**绝不覆盖** |
| 剪贴板里不是文件（网页复制的图、截图位图） | 弹提示「剪贴板里没有文件」，不做任何操作 |
| 剪贴板里是文件夹 | 跳过并在结果里说明「只处理文件」 |

---

## 四、原理

1. 本工具向 `HKCU\Software\Classes\Directory\Background\shell\` 等三处注册**一个顶级菜单项** `ZhuleHardlinkPaste`，调用本目录的 `paste_launch.vbs`（无窗口启动器），再由它以隐藏窗口方式拉起 `paste_hardlink.ps1`。早期版本还注册过 `ZhuleCopyPaste`（粘贴为副本），因其与原生 Ctrl+V 等价已取消，安装 / 卸载时会自动清理该遗留键。不用级联子菜单（Win11 里要多展开一层，且部分版本对后台类级联渲染不显示）
2. 你点击菜单时，Windows Shell 把**当前文件夹路径**（`%V`）作为参数传给启动器，启动器转交给脚本，并以 `-Quiet` 静默运行
3. 脚本用 `Get-Clipboard -Format FileDropList` 读取剪贴板中的**源文件绝对路径**，再用 `New-Item -ItemType HardLink` 在目标目录建链

剪贴板里始终是文件路径列表（CF_HDROP），不是文件内容，也不是命令。

---

## 五、已知限制

- **插件目录搬家 / 盘符变化后菜单失效**：注册表里记录的是 `paste_launch.vbs` 的绝对路径。移动插件后重新双击 `install_menu.bat` 覆盖一次即可。
- **卸载残留**：直接删除插件目录不会自动清除注册表项，请在删除前先运行 `uninstall_menu.bat`。
- **无法替换原生 Ctrl+V**：资源管理器的原生粘贴由 Explorer 实现，注册表方法无法改写。要做到完全等同 Ctrl+V 只能写 Shell 扩展 DLL（需编译、杀软敏感），本工具不采用。
- **部分安全软件提示**：菜单经 `wscript.exe` 拉起隐藏窗口的 `powershell.exe` 完成操作，个别安全软件可能弹一次确认，属正常现象，可加白名单。
- **粘贴完没反应？** 正常情况下就是没提示的（设计如此）。去目标文件夹看文件是否已出现即可；若想让脚本把过程打印出来，用 `-TestMode` 手动跑。

---

## 六、故障排查

| 现象 | 原因 / 解决 |
|---|---|
| 右键没有这一项 | 先按 **Shift+右键** 或点「显示更多选项」（Win11 默认折叠静态项）；仍没有则重跑 `menu_install.bat`，或 `-Action status` 查看注册状态 |
| 设置页显示「指向已失效」 | 插件目录搬过家 → 点「注册菜单」覆盖修复 |
| 点了菜单没反应 | 多半是插件目录搬家导致路径失效 → 重跑 `install_menu.bat` |
| 弹「剪贴板里没有文件」 | 请用资源管理器 Ctrl+C 复制**文件**；网页/微信里复制的位图没有源路径 |
| 结果里全是「回退为复制」 | 源和目标不在同一分区，或分区不是 NTFS |

---

## 七、自测

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File paste_hardlink.ps1 -TargetDir "D:\测试" -SourceList "D:\a.png|D:\b.png" -TestMode
```

`-TestMode` 只把结果打到控制台，不弹窗；`-SourceList` 用 `|` 分隔指定源文件，绕开剪贴板。
*（内容由AI生成，仅供参考）*
