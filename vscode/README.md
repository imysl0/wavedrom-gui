# WaveDrom-Gui VS Code 扩展

**简体中文** · [English ↓](#wavedrom-gui-vs-code-extension)

在 VS Code 内置 Markdown 预览里直接使用 wavedrom-gui：` ```wavedrom ` 代码块与内嵌 WaveJSON 的 PNG / SVG 图片都会在预览里**就地显示波形图**（代码块用现代渲染器重画，图片直接显示原图以保持导出时的风格），一键进入可视化编辑器，改动写回原文件。

本文件是使用指南（中文在前、英文在后，上方链接可直达英文部分）。实现原理、内部机制与排错方法见 [design.md](https://cnb.cool/linshi-2026/wavedrom-gui/-/blob/main/vscode/design.md)。

## 快速上手

1. **安装**：从 [Releases](https://cnb.cool/linshi-2026/wavedrom-gui/-/releases) 下载 `wavedrom-gui-vscode.vsix`，命令面板执行「Extensions: Install from VSIX...」选中它（VS Code / VSCodium 均可）；也可以本仓库调试或自行打包，见[安装与调试](#安装与调试)。
2. **写图**：在 Markdown 里写 ` ```wavedrom ` 代码块（内容是 WaveJSON），或插入一张由 wavedrom-gui / wavedrom-render skill 导出的、内嵌 WaveJSON 的 PNG / SVG。
3. **看效果**：`Ctrl+Shift+V` 打开内置预览，波形就渲染在代码块 / 图片原来的位置。
4. **改图**：在波形上**右键 →「编辑波形」**进入可视化编辑器；画布实时重绘，但**默认不碰磁盘**——点编辑面板标签栏的保存图标（或面板聚焦时按 `Ctrl+S`）才写回文件。想改回「改一下就写盘」见[设置](#设置)里的 `wavedrom-gui.saveMode`。

默认的「严格」预览安全级别下全部功能可用，**不需要放宽任何安全设置**。

## 功能

### 1. ```` ```wavedrom ```` 代码块 → 预览内渲染 + 编辑入口

进入编辑共三条入口，任选：

1. **在波形上右键 →「编辑波形」**（默认形式：预览里不加任何可见按钮，保持画面干净）；
2. **预览里的铅笔按钮**（设置成 `button`）或**点波形任意处**（设置成 `block`）；
3. **源码里每个 wavedrom 代码块上方的 CodeLens**（`预览` + `编辑波形` 两颗，完全不经预览）。

点开后是可视化编辑器（面板里加载的就是这个单文件编辑器界面：仓库内调试时直接读 `../index.html`，装 VSIX 后读随包安装的构建拷贝 `media/editor.html`，两者内容一致）；**改动写回 Markdown 中的这个代码块**，写回格式跟随编辑器的代码显示模式（舒缓 / 紧凑）。什么时候写回由 `wavedrom-gui.saveMode` 决定（默认**手动保存**：改动先攒在面板里，点标签栏那颗保存图标或按 `Ctrl+S` 提交；也可选**自动实时保存**），详见[设置](#设置)。

手动保存档下「有改动没提交」有三处提示：面板**标题前多一个 `●`**、**波形顶栏浮出**「有改动没写进文件 · Ctrl+S 提交」、**标签栏那颗保存图标亮起**（干净时淡显但位置不动，免得标签跳）。

铅笔按钮与 VS Code 工具栏图标同风格：单色描边、无边框无底色，常显 60% 不透明度，悬停浮现底色。

入口形式由设置 `wavedrom-gui.previewEditAffordance` 决定（`menu` / `button` / `block`，默认 `menu`）；三种形式下右键菜单都可用，见[设置](#设置)。

**源码侧入口**（不依赖 Markdown 预览是否已打开）：CodeLens 有**两颗镜头**——`预览`（在侧边打开该图的预览面板，再点同一颗收起，即「固定预览」）与`编辑波形`（直接进可视化编辑器），同受 `wavedrom-gui.showCodeLens` 开关控制；把鼠标停在 ```` ```wavedrom ```` 起始行上还会浮出**内联预览**（当行渲染的波形 +「固定预览（在侧边打开）」链接），不点任何东西也能先看一眼结果。

### 2. 内嵌 WaveJSON 的图片 → 同样的编辑入口

Markdown 里引用的 **PNG / SVG 图片**如果内嵌了 WaveJSON 元数据，预览会自动识别，编辑入口与代码块完全一致（同一套设置：默认同样是右键菜单，也可切成铅笔按钮或整块点击）：

- **编辑**：进入可视化编辑器；写回分两层——**元数据**（PNG `iTXt` / SVG `<metadata>` 里的 WaveJSON）与**画面**（编辑器重绘的像素 / 矢量），两层由 `wavedrom-gui.saveMode` 决定什么时候落盘：
  - **手动保存**（默认）：两层一起等你提交——点标签栏的保存图标或 `Ctrl+S`，**一步写完**（顺序是先元数据、紧接同一帧画面），提交前文件保持原样
  - **自动实时保存**：改一下就写回，元数据先落（界面停手约 0.4 秒后写 localStorage，再经最多 250ms 轮询写回文件），画面随后（重绘 + 250ms 去抖，端到端约 1 秒），关闭面板或切走面板标签时立即落盘
- **原图是哪种导出就按哪种重绘**：编辑器导出菜单里的「下载 WaveDrom SVG / PNG（2×）」与「下载编辑区 SVG / PNG（2×）」两种来源都会被识别，保存写回时保持同一种风格（编辑区导出的图不会被重绘成官方渲染样式）；出自 wavedrom-render skill 的现代 / 传统导出同样认得出。检测与兜底规则见 [design.md](https://cnb.cool/linshi-2026/wavedrom-gui/-/blob/main/vscode/design.md)
- **PNG** 按原图像素宽对齐重绘（比例 = 原图宽 ÷ 当前自然宽，夹在 1×–4×，原图读不到时退回 2×），避免重绘后 Markdown 里的布局跳动；编辑区来源的底色随当前主题，官方渲染保持白底；**SVG 整文件重绘**（文件里手工做的图形改动会被覆盖）；需要别的尺寸用编辑器自己的导出按钮
- 像素落盘只采用与最新元数据**同源**的画面（渲染没跟上时维持「元数据新、像素旧」），写入走临时文件 + rename，半途崩溃不会留下坏图
- **源码入口**：图片引用上方同样有「编辑波形」CodeLens（与代码块共用 `wavedrom-gui.showCodeLens` 开关），完全不经预览；每次点击前都会重新探测文件，图被移动或元数据被去掉时会提示而不是打开错图。行内写法与引用式定义（`![说明][标签]`，标签定义写在引用之后也行）都识别

### 3. 资源管理器里的 PNG / SVG →「使用 WaveDrom-Gui 编辑器打开」

在资源管理器里右键任意 `.png` / `.svg` 文件即可用波形编辑器打开——**不限于 Markdown 里引用的图片**，磁盘上任意位置的波形图都可以。

打开前会先探测该图内嵌的 WaveJSON：**有** → 走与 Markdown 预览「编辑波形」完全相同的编辑面板；**没有** → 只弹一条警告「这张图片没有内嵌 WaveDrom 波形数据，无法用波形编辑器打开」，**不打开任何面板**——不会给一张普通截图弹出空白编辑器。

这条命令不进命令面板，只能从右键菜单进。

## 设置

在哪儿改（三选一）：

1. **设置 UI**：`Ctrl+,` → 搜索框输入 `wavedrom`（或 `@ext:wavedrom-gui.wavedrom-gui-vscode`）→ 直接下拉选。
2. **扩展视图的齿轮**：`Ctrl+Shift+X` → 找到 WaveDrom-Gui → 齿轮 ⚙ →「设置」。这个入口**只有贡献了配置项的扩展才会出现**，所以装上旧版看不到。
3. **直接改 JSON**：命令面板 →「首选项: 打开用户设置(JSON)」，或写进项目的 `.vscode/settings.json`。**八项设置**都未声明 `scope`（默认 `window`），用户级与工作区 / 文件夹级都能设。

- **`wavedrom-gui.previewEditAffordance`** — 预览中进入可视化编辑器的入口形式：
  - `menu`（默认）：**预览里不加任何可见入口**，在波形上右键 →「编辑波形」。画面最干净
  - `button`：波形右上角显示铅笔图标按钮
  - `block`：不显示按钮，**点击波形任意位置即进入编辑**（键盘 `Tab` 聚焦后 `Enter` 也可激活）

- **`wavedrom-gui.editorPanelPosition`** — 可视化编辑面板打开的位置：
  - `current`（默认）：在当前聚焦的编辑栏里作标签页——从预览点「编辑」时就是**与预览同栏**，用标签切换
  - `beside`：在编辑区右侧新开一栏（VS Code 的默认行为）
  - `below`：在当前栏**下方**新开一栏——从预览点「编辑」即预览在上、编辑器在下
  - `newWindow`：编辑器搬到**独立的窗口**

  ⚠️ **做不到「浮在预览窗口之上」**：VS Code 没有向扩展开放浮动 / 模态编辑器。想要别的摆法可以手动来：把编辑面板的标签拖到预览区的**下缘投放区**即上下排列；右键编辑器标签也有「移动编辑器到下方组 / 新窗口」。

- **`wavedrom-gui.showCodeLens`**（默认 `true`）— 在 Markdown **源码**里每个 ```` ```wavedrom ```` 代码块上方显示 CodeLens（`预览` + `编辑波形`）。这条入口不经过预览，与预览安全级别无关，是不想用预览按钮（或预览被限制）时的稳定入口。

- **`wavedrom-gui.editorViewMode`** — 编辑器面板打开时用哪种布局，以及右侧「实时预览 / WaveJSON 代码」窗口的初始显隐：
  - `simple`：每次打开面板都把界面设为**简约模式**（手机版紧凑布局）
  - `auto`（默认）：**沿用编辑器界面自己记住的布局偏好**；同时把右侧两个窗口默认**收起**——编辑面板通常是一个窄分栏，右侧窗只会挤占空间。需要看预览时在面板内从编辑器设置 → 视图 → 窗口显示恢复；另外与这一项无关：面板视口高度不足 600px（或宽度 ≤800px）时，界面会自动按简约布局排布

- **`wavedrom-gui.editorSidePanel`** — 「通道与分组」左栏的初始显隐（只在简约 / 手机布局下生效）：
  - `shown`（默认）：每次打开面板都**展开**它。编辑器界面自身的默认是隐藏，而面板里这一栏常要用（＋信号/时钟/总线/占位/分组、节点、图表都在这里）
  - `auto`：不干预，沿用编辑器界面里记住的显隐状态

- **`wavedrom-gui.imageExportTheme`** — 编辑波形图片**保存时**像素用哪种风格重绘（内嵌 WaveJSON 无论选哪档都会更新）：
  - `auto`（默认）：**原风格保真**——编辑器导出的图保持编辑器风格，现代渲染的图保持现代，官方渲染的图保持官方传统
  - `modern`：一律按**现代渲染**重绘，无论图片来源
  - `traditional`：一律按 **WaveDrom 官方（传统）**渲染重绘，无论图片来源

  覆盖点在编辑面板打开时生效：改设置后面板会提示重开；已打开的面板保持原来的风格。右键菜单入口与预览入口都受它控制。

- **`wavedrom-gui.saveMode`** — 编辑器面板什么时候把改动写回目标（磁盘 / 文档）：
  - `button` = **手动保存**（默认）：改动只攒在面板里，画布与面板内的预览照常实时重绘，但**不碰磁盘**；点编辑面板**标签栏的保存图标**、或面板聚焦时按 `Ctrl+S`（macOS `Cmd+S`）才提交
  - `live` = **自动实时保存**：改一下就立刻写回，和可道云插件的「自动保存」一致，也是本扩展此前的行为

  提交之后**标题的 `●`、顶栏提示、标签栏按钮三处同时消掉**，一眼能看出「已经落盘」。markdown 代码块还多一层安全处理：提交时改动先写进已打开的文档，**只有那份文档当时没有你自己的未保存编辑**才顺手把文件也保存；否则只应用改动并提示你按 `Ctrl+S`——免得把你没保存的内容一起落盘。这一项**在面板打开时读一次**，已打开的面板保持它开始时的档位（改设置后会提示）。
  ⚠️ 手动档下直接关面板：VS Code 不给 webview 面板「关闭前否决」的钩子，只能事后补救——最后一份改动与画面仍在扩展宿主内存里，通知点「仍然保存」照常落盘，点「丢弃」或关掉通知就丢弃，**绝不会悄悄写文件**。
  （选项名「手动保存 / 自动实时保存」由 VS Code 的 `enumItemTitles` 渲染，需要 1.85 及以上；更早的宿主下拉列表里显示 `button` / `live`，中文说明仍跟在选项后面。）

- **`wavedrom-gui.language`** — 扩展界面的语言：
  - `auto`（默认）：跟随 VS Code 的显示语言；判断不出语言时按中文
  - `zh`：固定简体中文；`en`：固定英文

  只影响扩展自己能控制的部分（消息、CodeLens、预览入口文案、编辑器界面初始语言）；命令标题与设置说明是 VS Code 的清单本地化，运行时无法覆盖。

## 语言与布局

- 扩展的界面文案自带 **English** 与 **简体中文** 两份，由设置 **`wavedrom-gui.language`** 决定：`auto`（默认）跟随 VS Code 显示语言、判断不出时按中文；`zh` / `en` 固定其一。
- 生效范围：消息提示、QuickPick 文案、状态栏、编辑器面板标题、CodeLens、预览里入口的悬停提示，以及编辑器界面的初始语言。
- 编辑器面板（`index.html`）**有自己的语言菜单**（跟随系统 / 简体中文 / English，偏好持久化），初始值取 `wavedrom-gui.language` 的结果，之后以你在面板里选的语言为准。
- 编辑器面板的布局：`wavedrom-gui.editorViewMode` 默认 `auto`——沿用界面记住的布局偏好，且「实时预览 / WaveJSON」右侧窗默认收起（面板内可恢复）；`wavedrom-gui.editorSidePanel` 默认 `shown`，**「通道与分组」左栏默认展开**（界面自身的默认是隐藏）。两项都可调整，面板内也能临时切换。
- ⚠️ 用 **F5 扩展开发宿主**调试时，**命令标题与设置说明会显示英文**（VS Code 开发模式会跳过清单本地化文件），这是宿主行为；想看完整中文界面请装 VSIX 后再测。原因与排查方法见 [design.md](https://cnb.cool/linshi-2026/wavedrom-gui/-/blob/main/vscode/design.md)。

## 安装与调试

- **正式安装**：从 [Releases](https://cnb.cool/linshi-2026/wavedrom-gui/-/releases) 下载 `wavedrom-gui-vscode.vsix`，命令面板执行「Extensions: Install from VSIX...」。
- **开发调试（推荐）**：用 VS Code 打开本 `vscode/` 目录，按 **F5** 启动「扩展开发宿主」，在新窗口打开 `sample/sample.md` 并开启预览。
- **临时安装**：命令面板执行「Extensions: Install from Location...」，选择本 `vscode/` 目录。
- **打包 VSIX**：`cd vscode && npx @vscode/vsce package`（需网络）。README 里没有相对链接 / 图片，裸打包即可；发布流水线额外带上 `--baseContentUrl …/-/blob/main/vscode` 与 `--baseImagesUrl …/-/raw/main/vscode`（有相对链接时 vsce 用它们把链接改写成绝对地址，否则会因「链接会失效」直接报错、不产出 VSIX）。

## 命令

- **WaveDrom: 编辑当前 Markdown 中的图表**（`wavedrom-gui.editActive`）：在当前 md 文件的代码块 / 带元数据图片中挑一个进入可视化编辑。命令面板里的兜底入口。
- **编辑波形**（`wavedrom-gui.editFromPreview`）：预览里右键菜单用，不进命令面板。
- **使用 WaveDrom-Gui 编辑器打开**（`wavedrom-gui.openImage`）：资源管理器里 PNG / SVG 的右键菜单用，打开前先探测内嵌 WaveJSON，同样不进命令面板。
- **保存波形改动**（`wavedrom-gui.savePanel`）：编辑面板**标签栏的保存图标**，面板聚焦时 `Ctrl+S` / macOS `Cmd+S` 走同一条命令；不进命令面板。手动保存档下它提交攒着的改动；自动实时保存档下面板永远不会脏，那颗图标一直淡显，此时 `Ctrl+S` 只做一件顺手的事——把已经改动的 markdown 文档保存掉（文件本来干净就什么都不做）。
- **`wavedrom-gui.previewFence`**：源码 CodeLens 的「预览」与悬停里的「固定预览」用。
- **`wavedrom-gui.editFence`** / **`wavedrom-gui.editImage`**：源码 CodeLens 用（分别对应代码块与图片引用）。

## 限制

- 编辑器 webview 首选霞鹜文楷经 CDN 加载，离线时自动回退系统字体（与网页版一致）。
- 图片重绘写回的是「编辑器当前状态」的重新导出：SVG 整文件重绘会覆盖文件里手工做的图形改动；PNG 重绘比例夹在 1×–4×。
- **手动保存**档下，提交前的改动只在扩展宿主的内存里：关面板后靠通知「仍然保存」补救，但通知没点就随宿主退出一起丢了（重开面板以文件内容为准）。
- **自动实时保存**档下，像素落盘发生在停手约 1 秒后（界面自动保存 0.4 秒 + 轮询 ≤250ms + 重绘 + 250ms 去抖；去抖窗口内继续改则整体后移，不会逐次写盘）：期间强杀 VS Code 的话像素保持上次落盘版本（元数据最多落后约 0.65 秒 = 界面 400ms 自动保存去抖 + 250ms 轮询，未写回文件的那部分编辑会丢——面板重开时以文件内容为准）；正常关闭面板不受影响。
- 预览里的编辑入口依赖产品 URL scheme 的深链接：桌面版（VS Code / VSCodium / Insiders）可用；web 版（vscode.dev）不支持 URI 处理器，那边请用源码里的 CodeLens。
- 预览过期（例如扩展重载后没重开预览）时点入口会提示「已过期」，重开预览即可；源码里的 CodeLens 不受此影响。

---

# WaveDrom-Gui VS Code extension

**English** · [中文 ↑](#wavedrom-gui-vs-code-扩展)

Use wavedrom-gui right inside VS Code's built-in Markdown preview: ` ```wavedrom ` code blocks and PNG / SVG images with embedded WaveJSON **show the waveform in place** (code blocks are redrawn with the modern renderer, images are shown as-is to keep the exported style), with one click into the visual editor and edits written back to the source file.

This file is the user guide (Chinese first, English after — the link above jumps straight to the Chinese part). Implementation notes, internals and troubleshooting live in [design.md](https://cnb.cool/linshi-2026/wavedrom-gui/-/blob/main/vscode/design.md) (Chinese).

## Quick start

1. **Install**: download `wavedrom-gui-vscode.vsix` from [Releases](https://cnb.cool/linshi-2026/wavedrom-gui/-/releases) and run "Extensions: Install from VSIX..." from the Command Palette (VS Code / VSCodium). You can also debug it from this repository or package it yourself — see [Install and debug](#install-and-debug).
2. **Write**: add a ` ```wavedrom ` code block (containing WaveJSON) to a Markdown file, or insert a PNG / SVG image exported by wavedrom-gui / the wavedrom-render skill (it carries embedded WaveJSON).
3. **Look**: press `Ctrl+Shift+V` to open the built-in preview — the waveform appears exactly where the code block or image is.
4. **Edit**: **right-click the waveform → "Edit waveform"** to open the visual editor; the canvas redraws live but **nothing touches the disk** — click the save icon in the editor panel's tab bar (or press `Ctrl+S` while the panel is focused) to write the changes back. Switch to write-as-you-go with the `wavedrom-gui.saveMode` setting, see [Settings](#settings).

Everything works under the default *Strict* preview security level — **no security setting has to be relaxed**.

## Features

### 1. ```` ```wavedrom ```` code blocks → rendered in the preview + edit entry points

Three ways into the editor — pick any:

1. **Right-click the waveform → "Edit waveform"** (the default: nothing visible is added to the preview, so the picture stays clean);
2. **The pencil button inside the preview** (with the setting on `button`) or **clicking anywhere on the waveform** (with `block`);
3. **The CodeLens above every wavedrom code block in the source** (`Preview` + `Edit waveform`, bypassing the preview entirely).

Clicking through opens the visual editor (the panel loads that single-file editor UI: inside the repo it reads `../index.html` directly, and with the installed VSIX it reads the packaged copy `media/editor.html` — same content); **edits are written back into that Markdown code block**, in the code display mode the editor is using (comfortable / compact). *When* they are written back is decided by `wavedrom-gui.saveMode` (**Manual save** by default — edits pile up in the panel until you click the save icon in its tab or press `Ctrl+S`; **Automatic live save** writes each change as it happens), see [Settings](#settings).

In Manual save mode three things tell you that something is still uncommitted: a **`●` in front of the panel title**, a **"Not saved yet · Ctrl+S to commit" pill in the waveform's top bar**, and the **save icon in the tab bar lighting up** (it greys out when clean but never moves, so tabs don't jump).

The pencil button matches VS Code's own toolbar icons: monochrome stroke, no border or background, 60% opacity at rest and a background on hover.

Which entry point is shown is decided by the `wavedrom-gui.previewEditAffordance` setting (`menu` / `button` / `block`, default `menu`); the right-click menu works in all three modes — see [Settings](#settings).

**Source-side entry point** (it does not need the Markdown preview to be open): the CodeLens has **two lenses** — `Preview` (opens a preview panel for that diagram beside the editor; click the same lens again to close it, i.e. "pin preview") and `Edit waveform` (straight into the visual editor); both are controlled by `wavedrom-gui.showCodeLens`. Hovering the ```` ```wavedrom ```` opening line also pops up an **inline preview** (the rendered waveform plus a "Pin preview (opens beside)" link), so you can glance at the result without clicking anything.

### 2. Images with embedded WaveJSON → the same edit entry points

If a **PNG / SVG image** referenced from Markdown has WaveJSON metadata embedded, the preview recognizes it automatically, and the entry points are exactly the same as for code blocks (same settings: right-click menu by default, switchable to the pencil button or click-the-image):

- **Editing**: opens the visual editor; write-back has two layers — the **metadata** (WaveJSON in the PNG `iTXt` / SVG `<metadata>`) and the **picture** (the editor's redrawn pixels or vectors) — and `wavedrom-gui.saveMode` decides when they hit the disk:
  - **Manual save** (default): both layers wait for you to commit — click the save icon in the panel's tab bar or press `Ctrl+S` — and are written **in one step** (metadata first, the matching frame right after); until then the file stays as it was
  - **Automatic live save**: every change is written back as it happens — metadata first (the UI persists it about 0.4 s after you stop, then the ≤250 ms poll writes it to the file), the picture right after (redraw + 250 ms debounce, about 1 s end to end), or immediately when the panel closes or its tab loses focus
- **An image is redrawn in the style it was exported with**: both sources in the editor's export menu — "Download WaveDrom SVG / PNG (2×)" and "Download editor SVG / PNG (2×)" — are recognized, and write-back keeps the same style (an editor-exported image is never redrawn in the official style); modern / traditional exports from the wavedrom-render skill are recognized too. Detection and fallback rules: see [design.md](https://cnb.cool/linshi-2026/wavedrom-gui/-/blob/main/vscode/design.md)
- **PNG** is redrawn at the original image's pixel width (ratio = original width ÷ current natural width, clamped to 1×–4×, falling back to 2× when the width cannot be read), so the Markdown layout does not jump after a redraw; editor-sourced images take the current theme's background while official renders stay white; **SVG is redrawn as a whole file** (hand-made graphic edits in the file are overwritten) — for other sizes use the editor's own export buttons
- Pixels are only flushed when they come from the **same revision** as the latest metadata (if rendering lags, "new metadata, old pixels" is kept); writes go through a temp file + rename, so a crash mid-way never leaves a corrupt image
- **Source entry point**: image references also get an "Edit waveform" CodeLens above them (sharing the `wavedrom-gui.showCodeLens` switch), entirely without the preview; every click re-probes the file first, so a moved image or removed metadata produces a message instead of opening the wrong file. Both inline images and reference-style definitions (`![alt][label]`, with the label defined after the reference) are recognized

### 3. PNG / SVG in the Explorer → "Open with WaveDrom-Gui Editor"

Right-click any `.png` / `.svg` file in the Explorer to open it in the waveform editor — **not limited to images referenced from Markdown**; any waveform image on disk works.

Before opening, the embedded WaveJSON is probed: **found** → the exact same editor panel as the Markdown preview's "Edit waveform"; **not found** → a single warning ("WaveDrom: No WaveDrom waveform data embedded in this image") and **no panel is opened** — a plain screenshot never gets a blank editor.

This command is not listed in the Command Palette; it is only reachable from the context menu.

## Settings

Where to change them (three options):

1. **Settings UI**: `Ctrl+,` → type `wavedrom` in the search box (or `@ext:wavedrom-gui.wavedrom-gui-vscode`) → pick from the dropdowns.
2. **The gear icon in the Extensions view**: `Ctrl+Shift+X` → find WaveDrom-Gui → gear ⚙ → "Settings". This entry point **only appears for extensions that contribute configuration**, which is why it is missing on older versions.
3. **Editing JSON directly**: Command Palette → "Preferences: Open User Settings (JSON)", or write into the project's `.vscode/settings.json`. **All eight settings** declare no `scope` (so they default to `window`) and can be set at user, workspace or folder level.

- **`wavedrom-gui.previewEditAffordance`** — how to enter the visual editor from the preview:
  - `menu` (default): **no visible entry point in the preview** — right-click the waveform → "Edit waveform". The cleanest picture
  - `button`: shows a pencil icon button at the waveform's top-right corner
  - `block`: no button; **clicking anywhere on the waveform opens the editor** (or `Tab` to focus it and `Enter`)

- **`wavedrom-gui.editorPanelPosition`** — where the visual editor panel opens:
  - `current` (default): as a tab in the focused editor group — clicked from the preview it **shares that group**, switching by tab
  - `beside`: a new column to the right of the editor area (VS Code's default behaviour)
  - `below`: a new column **below** the current one — from the preview that means preview on top, editor underneath
  - `newWindow`: moves the editor into a **separate window**

  ⚠️ **Floating the panel on top of the preview is not possible**: VS Code does not expose floating/modal editors to extensions. For other arrangements, do it by hand: drag the editor panel's tab onto the preview area's **bottom drop zone** to stack them, or right-click the editor tab for "Move Editor to Below Group / New Window".

- **`wavedrom-gui.showCodeLens`** (default `true`) — shows a CodeLens (`Preview` + `Edit waveform`) above every ```` ```wavedrom ```` code block in the Markdown **source**. This entry point bypasses the preview, is independent of the preview security level, and is a stable fallback when you do not want the preview buttons (or the preview is restricted).

- **`wavedrom-gui.editorViewMode`** — which layout the editor panel opens with, and the initial visibility of the right-side "Live preview / WaveJSON" windows:
  - `simple`: sets the UI to **simplified mode** (the compact mobile layout) every time the panel opens
  - `auto` (default): **uses the editor UI's own remembered layout preference**; at the same time the two right-side windows start **hidden** — the panel is usually a narrow column and those windows only crowd it. Restore them inside the panel via the editor's settings → view → window visibility; also, independently of this setting, the UI lays itself out compactly when its viewport is under 600px tall (or 800px wide or less)

- **`wavedrom-gui.editorSidePanel`** — the initial visibility of the "Lanes & groups" left column (only takes effect in the simplified/mobile layout):
  - `shown` (default): **expands** it every time the panel opens. The editor UI itself hides it by default, yet this column is used constantly inside the panel (＋signal/clock/bus/spacer/group, nodes, chart all live there)
  - `auto`: does not touch it; keeps whatever visibility the editor UI remembered

- **`wavedrom-gui.imageExportTheme`** — which style the pixels are redrawn in when an edited waveform image is **saved** (the embedded WaveJSON is updated either way):
  - `auto` (default): **faithful to each image's own style** — editor-exported images stay in the editor style, modern renders stay modern, official renders stay official-traditional
  - `modern`: always redraw in the **modern** style, whatever the image's origin
  - `traditional`: always redraw in the **official WaveDrom (traditional)** style, whatever the image's origin

  The override applies when the editor panel is opened: after changing the setting the panel offers to reopen, and panels already open keep their original style. Both the context-menu entry and the preview entry are covered by it.

- **`wavedrom-gui.saveMode`** — when the editor panel writes its changes back to the target (file / document):
  - `button` = **Manual save** (default): edits stay inside the panel — the canvas and the panel's own preview keep redrawing live, but **nothing touches the disk** until you click the **save icon in the editor panel's tab bar** or press `Ctrl+S` (macOS `Cmd+S`) with the panel focused
  - `live` = **Automatic live save**: every change is written back as it happens, like the "autosave" switch in the kodbox plugin — which is also this extension's previous behaviour

  Committing clears **the `●` in the title, the top-bar hint and the tab-bar icon all at once**, so it is obvious the change has landed. A Markdown code block gets one extra safety step: committing applies the edit to the open document, and the file itself is saved too **only when that document had no unsaved edits of its own**; otherwise the extension only applies the edit and tells you to press `Ctrl+S` — so your own uncommitted typing never ends up on disk by accident. This setting is read **once when a panel opens**; panels already open keep the mode they started with (changing it shows a notice).
  ⚠️ Closing the panel while Manual save still has uncommitted edits: VS Code gives a webview panel no "veto before dispose" hook, so this can only be a post-hoc remedy — the last document and the last frame are still in the extension host's memory, and the notification's "Save anyway" writes them to disk; choosing "Discard" or dismissing the notification drops them. It **never writes the file silently**.
  (The "Manual save / Automatic live save" labels come from VS Code's `enumItemTitles`, which needs 1.85 or newer; on older hosts the dropdown shows `button` / `live` with the description text after each option.)

- **`wavedrom-gui.language`** — the language of the extension's own UI:
  - `auto` (default): follows VS Code's display language; when it cannot be determined, Chinese is used
  - `zh`: always Simplified Chinese; `en`: always English

  It only affects what the extension controls (messages, CodeLens, preview entry-point texts, the editor UI's initial language); command titles and settings descriptions come from VS Code's manifest localization and cannot be overridden at runtime.

## Language and layout

- The extension ships its UI texts in **English** and **Simplified Chinese**, decided by the **`wavedrom-gui.language`** setting: `auto` (default) follows VS Code's display language and falls back to Chinese when it cannot be determined; `zh` / `en` pin one of them.
- Scope: messages, QuickPick texts, the status bar, the editor panel title, CodeLens, the hover tooltips of the preview entry points, and the editor UI's initial language.
- The editor panel (`index.html`) has **its own language menu** (follow system / Simplified Chinese / English, persisted). Its initial value comes from `wavedrom-gui.language`; after that, whatever you pick inside the panel wins.
- Editor panel layout: `wavedrom-gui.editorViewMode` defaults to `auto` — the editor UI's remembered layout, with the right-side "Live preview / WaveJSON" windows hidden (restorable from inside the panel); `wavedrom-gui.editorSidePanel` defaults to `shown`, i.e. **the "Lanes & groups" column starts expanded** (the UI itself hides it by default). Both are adjustable, and both can be toggled temporarily inside the panel.
- ⚠️ When debugging with **F5's Extension Development Host**, **command titles and settings descriptions show up in English** (VS Code skips the manifest localization files in development mode). That is host behaviour; install the VSIX to see the full Chinese UI. Why, and how to check: see [design.md](https://cnb.cool/linshi-2026/wavedrom-gui/-/blob/main/vscode/design.md).

## Install and debug

- **Normal install**: download `wavedrom-gui-vscode.vsix` from [Releases](https://cnb.cool/linshi-2026/wavedrom-gui/-/releases) and run "Extensions: Install from VSIX...".
- **Developing (recommended)**: open this `vscode/` directory in VS Code, press **F5** to launch the "Extension Development Host", then open `sample/sample.md` in the new window and turn the preview on.
- **Temporary install**: run "Extensions: Install from Location..." from the Command Palette and pick this `vscode/` directory.
- **Packaging a VSIX**: `cd vscode && npx @vscode/vsce package` (needs network). The README contains no relative links or images, so plain packaging works; the release pipeline additionally passes `--baseContentUrl …/-/blob/main/vscode` and `--baseImagesUrl …/-/raw/main/vscode` (vsce uses them to rewrite relative links into absolute URLs — without them it fails outright because the links "will be broken" and produces no VSIX).

## Commands

- **WaveDrom: Edit a diagram in the current Markdown file** (`wavedrom-gui.editActive`): picks one of the code blocks / metadata-bearing images in the current Markdown file and opens it in the visual editor. The Command Palette fallback.
- **Edit waveform** (`wavedrom-gui.editFromPreview`): used by the preview's context menu; not in the Command Palette.
- **Open with WaveDrom-Gui Editor** (`wavedrom-gui.openImage`): used by the Explorer context menu for PNG / SVG; probes the embedded WaveJSON before opening; also not in the Command Palette.
- **Save Waveform Changes** (`wavedrom-gui.savePanel`): the save icon in the editor panel's tab bar, and the same command `Ctrl+S` / macOS `Cmd+S` runs when the panel is focused; not in the Command Palette. In Manual save mode it commits what the panel has piled up; under Automatic live save the panel never becomes dirty, so the icon stays greyed out and `Ctrl+S` only does the handy thing instead — saving the Markdown document that was just edited (and nothing at all when the file is already clean).
- **`wavedrom-gui.previewFence`**: used by the source CodeLens's "Preview" and the hover's "Pin preview".
- **`wavedrom-gui.editFence`** / **`wavedrom-gui.editImage`**: used by the source CodeLens (for code blocks and image references respectively).

## Limitations

- The editor webview prefers LXGW WenKai, loaded from a CDN, and falls back to system fonts offline (same as the web app).
- Image redraws write back a re-export of "the editor's current state": an SVG is redrawn as a whole file, overwriting hand-made graphic edits; PNG redraw ratios are clamped to 1×–4×.
- Under **Manual save**, uncommitted edits live only in the extension host's memory: closing the panel offers the "Save anyway" remedy, but if that notification is never clicked the edits go away with the host (a reopened panel takes the file as the source of truth).
- Under **Automatic live save**, pixel flushing happens about 1 s after you stop (UI autosave 0.4 s + poll ≤250 ms + redraw + 250 ms debounce; further edits inside that debounce window push the whole write back rather than writing once per change): killing VS Code during that window leaves the last flushed pixels (metadata lags at most ~0.65 s = the UI's 400 ms autosave debounce + the 250 ms poll; edits not yet written back to the file are lost, since a reopened panel takes the file as the source of truth). Closing the panel normally is unaffected.
- The preview entry points rely on the product URL scheme's deep links: available on desktop (VS Code / VSCodium / Insiders); the web version (vscode.dev) has no URI handler, so use the source CodeLens there.
- When the preview is stale (e.g. after an extension reload without reopening it), clicking an entry point reports "stale" — reopen the preview; the source CodeLens is unaffected.
