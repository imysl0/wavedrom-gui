# WaveDrom-Gui — VSCode 扩展

在 VS Code 内置 Markdown 预览中直接使用 wavedrom-gui 的能力。

## 功能

### 1. ```wavedrom 代码块 → 预览内渲染 + 编辑入口

Markdown 里用 ```` ```wavedrom ```` 围栏写的 WaveJSON，在内置预览（Ctrl+Shift+V）的**代码块位置**直接显示渲染出的现代主题波形。

进入编辑共三条入口，任选：

1. **在波形上右键 →「编辑波形」**（默认形式：预览里不加任何可见按钮，保持画面干净）；
2. **预览里的铅笔按钮**（设置成 `button`）或**点波形任意处**（设置成 `block`）；
3. **源码里每个 wavedrom 代码块上方的「编辑波形」CodeLens**（完全不经预览）。

点开后打开可视化编辑器（复用仓库根目录的 `index.html`，以 webview 面板加载）；**编辑结果实时写回 Markdown 中的这个代码块**，写回格式跟随编辑器的代码显示模式（舒缓 / 紧凑）。

铅笔按钮与 VS Code 工具栏图标同风格：单色描边、无边框无底色，常显 60% 不透明度，悬停浮现底色。WaveJSON 原文在 Markdown 源码里即可查看，预览内不再单独提供「源码」切换。

**默认的「严格」预览安全级别下三条都能用，不需要放宽任何安全设置。**

入口形式由设置 `wavedrom-gui.previewEditAffordance` 决定（`menu` / `button` / `block`，默认 `menu`）；三种形式下右键菜单都可用，见下方[设置](#设置)。

入口形式由设置 `wavedrom-gui.previewEditAffordance` 决定（`menu` / `button` / `block`，默认 `menu`）；三种形式下右键菜单都可用，见下方[设置](#设置)。

### 2. 内嵌 WaveJSON 的图片 → 同样的编辑入口

Markdown 里引用的 **PNG / SVG 图片**如果内嵌了 WaveJSON 元数据（由 wavedrom-gui 或 wavedrom-render skill 导出），预览会自动识别，编辑入口与代码块完全一致（同一套设置：默认同样是右键菜单，也可切成铅笔按钮或整块点击）：

- **编辑**：进入可视化编辑器；保存时**只更新图片文件里的元数据，像素不变**（PNG `iTXt` / SVG `<metadata>`）

## 设置

在哪儿改（三选一）：

1. **设置 UI**：`Ctrl+,` → 搜索框输入 `wavedrom`（或 `@ext:wavedrom-gui.wavedrom-gui-vscode`）→ 直接下拉选。左侧目录树的「扩展」分类下也会列出本扩展。
2. **扩展视图的齿轮**：`Ctrl+Shift+X` → 找到 WaveDrom-Gui → 齿轮 ⚙ →「设置」。这个入口**只有贡献了配置项的扩展才会出现**（VS Code 内部条件是 `extensionHasConfiguration`），所以装上旧版看不到。
3. **直接改 JSON**：命令面板 →「首选项: 打开用户设置(JSON)」，或写进项目的 `.vscode/settings.json`。两项设置都未声明 `scope`（默认 `window`），用户级与工作区/文件夹级都能设。

- **`wavedrom-gui.previewEditAffordance`** — 预览中进入可视化编辑器的入口形式：
  - `menu`（默认）：**预览里不加任何可见入口**，在波形上右键 →「编辑波形」。画面最干净，适合不想让波形上多出按钮/链接的情况
  - `button`：波形右上角显示铅笔图标按钮（单色描边、无边框无底色、常显 60% 不透明度、悬停浮现底色）
  - `block`：不显示按钮，**点击波形任意位置即进入编辑**。鼠标移到波形上会变成手型并有悬停提示；锚点原生可聚焦，键盘 `Tab` 聚焦后 `Enter` 即可激活。图与图之间没有多余留白

  三种形式下**右键菜单都可用**（它由块上的 `data-vscode-context` 驱动，与入口形式无关）。改动后扩展会尝试自动刷新预览（调用 `markdown.preview.refresh`）；若没变化，用 Ctrl+Shift+V 重开一次预览即可。

- **`wavedrom-gui.editorPanelPosition`** — 可视化编辑面板打开的位置：
  - `current`（默认）：在当前聚焦的编辑栏里作标签页——从预览点「编辑」时就是**与预览同栏**，用标签切换，不新增分栏
  - `beside`：在编辑区右侧新开一栏（VS Code 的默认行为）
  - `below`：在当前栏**下方**新开一栏，与该栏成上下关系——从预览点「编辑」即预览在上、编辑器在下
  - `newWindow`：编辑器搬到**独立的窗口**（走 VS Code 的「移动编辑器到新窗口」）

  `below` / `newWindow` 是复用 VS Code 自己的 `workbench.action.moveEditorToBelowGroup` / `workbench.action.moveEditorToNewWindow`：这两个命令作用于**当前活动编辑器**，扩展会先等面板取得焦点再执行，拿不到焦点就留在原地（避免把预览或别的编辑器搬走）。「下方」是相对**当前聚焦的编辑栏**——从预览点按钮时该栏就是预览所在的栏，所以是「预览在上、编辑在下」。

  ⚠️ **做不到「浮在预览窗口之上」**：VS Code 没有向扩展开放浮动/模态编辑器（公开的 `ViewColumn` 只有 `Active` / `Beside` / `1-9`）。想要别的摆法可以手动来：把编辑面板的标签拖到预览区的**下缘投放区**即上下排列；右键编辑器标签也有「移动编辑器到下方组 / 新窗口」。

- **`wavedrom-gui.showCodeLens`**（默认 `true`）— 在 Markdown **源码**里每个 ` ```wavedrom ` 代码块上方显示一行「编辑波形」CodeLens，点击直接进可视化编辑器。这条入口不经过预览，与预览安全级别无关，也不受 CSP 影响，是不想用预览按钮（或预览被限制）时的稳定入口。

- **`wavedrom-gui.editorViewMode`** — 可视化编辑器面板打开时用哪种布局：
  - `simple`（默认）：每次打开面板都把界面设为**简约模式**（手机版紧凑布局）。面板通常是一个窄分栏，简约布局更合用
  - `auto`：不干预，沿用编辑器界面自己记住的布局偏好

  面板里仍可临时切换视图模式（设置 →「视图模式」），只是下次从扩展打开时会回到这里设置的值。

- **`wavedrom-gui.editorSidePanel`** — 「通道与分组」左栏的初始显隐（只在简约/手机布局下生效，见上一项）：
  - `shown`（默认）：每次打开面板都**展开**它。编辑器界面自身的默认是隐藏，而面板里这一栏常要用（＋信号/时钟/总线/占位/分组、节点、图表都在这里）
  - `auto`：不干预，沿用编辑器界面里记住的显隐状态

## 语言与布局

- 扩展的界面文案**跟随 VS Code 的显示语言**，自带 **English** 与 **简体中文**：命令、设置项、消息提示、预览入口的悬停提示都按当前语言显示。中文需要 VS Code 1.73 及以上（`vscode.l10n`），更老的版本回退英文；除中英之外的语言也回退英文。
- 可视化编辑器面板（`index.html`）**有自己的语言菜单**（跟随系统 / 简体中文 / English，偏好持久化）。首次打开时按 VS Code 的显示语言初始化，之后以你在面板里选的语言为准，扩展不再覆盖。
- 编辑器面板的布局：`wavedrom-gui.editorViewMode` 默认 `simple`，**每次打开都是简约模式**（面板通常是窄分栏，简约布局更合用）；`wavedrom-gui.editorSidePanel` 默认 `shown`，**「通道与分组」左栏默认展开**（界面自身的默认是隐藏）。两项都可设成 `auto` 以沿用界面里记住的偏好，面板内也能临时切换。
- 想验证另一种语言：命令面板执行「Configure Display Language」切换 VS Code 语言后重开预览即可。

## 安装与调试

开发调试（推荐）：用 VS Code 打开本 `vscode/` 目录，按 **F5** 启动「扩展开发宿主」，在新窗口打开 `sample/sample.md` 并开启预览。

临时安装：命令面板执行「Extensions: Install from Location...」，选择本 `vscode/` 目录。
打包 VSIX：`npx @vscode/vsce package`（需网络）。

## 命令

- **WaveDrom: 编辑当前 Markdown 中的图表**（`wavedrom-gui.editActive`）：在当前 md 文件的代码块 / 带元数据图片中挑一个进入可视化编辑。命令面板里的兜底入口。
- **编辑波形**（`wavedrom-gui.editFromPreview`）：预览里右键菜单用，不进命令面板（`commandPalette` 的 `when` 为 `false`）。
- **`wavedrom-gui.editFence`**：源码 CodeLens 用（带围栏定位参数），同样不进命令面板。

## 工作原理

- `markdown.markdownItPlugins`：拦截 ```wavedrom / ```wavejson 围栏，替换为占位块；渲染期通过 markdown-it 的 `env.currentDocument` 拿到文档路径，同步读取本地 png/svg 并用 `lib/meta-embed.js` 提取内嵌 WaveJSON（命中才包编辑入口）
- `markdown.previewScripts`：`media/preview.js` 在预览内完成现代主题渲染（`render-modern.js` 的浏览器包装层），并挂接编辑入口
- **预览 → 扩展走产品 scheme 深链接**：预览里拿不到自己的消息通道（`acquireVsCodeApi` 已被内置预览脚本占用，`postMessage` 只会送到 markdown 扩展），`command:` 链接在预览里也被禁用；而早期的「127.0.0.1 图片信标」在默认的**严格**预览安全级别下会被 CSP 拦下（`img-src` 无 `http:`），还会弹出「放宽安全设置」的提示。现在把入口渲染成真锚点 `<a href="<vscode.env.uriScheme>://<扩展 id>/edit?k=…">`，点击经 `openerService` 交给扩展的 `registerUriHandler`（`package.json` 里声明了 `onUri` 激活事件）。全程不发 http 请求，因此不触发 `securitypolicyviolation`、**不需要用户改任何安全设置**；scheme 用 `vscode.env.uriScheme` 取（VSCodium 是 `vscodium`、Insiders 是 `vscode-insiders`），不能写死 `vscode`
- **右键菜单入口**：每个块上写 `data-vscode-context="{webviewSection:'wavedrom', k:…}"`，配合 `contributes.menus["webview/context"]` 在 `markdown.preview` 里给出「编辑波形」。VS Code 会把这段 JSON 作为命令的第一个参数传给 `wavedrom-gui.editFromPreview`（与 mermaid 扩展同一机制）。右键菜单不经过 CSP，所以这条既是点击入口的补充，也是深链接万一失效时的备用通道
- **本地化**：扩展宿主文案走 `vscode.l10n`（源语言英文，`l10n/bundle.l10n.zh-cn.json` 提供中文），`package.json` 的命令/设置文案走 `package.nls.json` + `package.nls.zh-cn.json` 占位符；预览是 webview、拿不到 `vscode.l10n`，所以那一小段文案（编辑入口的 `aria-label` 与悬停提示）由扩展按当前语言渲染进一个隐藏的 `#wd-i18n`，`preview.js` 读它的 `data-*`（缺失则回退英文）——翻译仍只有语言包一处
- `k` 是渲染时登记进内存表的不透明键，同时充当一次点击的授权凭据：表里没有的 `k` 一律拒绝，避免任意 markdown 构造链接就让扩展去打开任意文件；预览过期（扩展重载后没重开预览）时三条入口都会提示「已过期」，重开预览即可（源码里的 CodeLens 不受影响，它按需重新定位围栏）
- 编辑器面板：读取仓库根目录 `index.html` 注入 CSP、初始 JSON（`location.hash`）与保存轮询脚本后加载；轮询检测应用自动保存的文档变化，经 webview 消息回写。每个编辑目标用一份独立的 localStorage 键，多个编辑面板同时打开也不会互相串写
- 代码块写回定位：行号 + 内容双重要求（内容相同的重复代码块靠行号区分）→ 原文精确匹配 → 忽略空白差异匹配 → 让用户从文件现有代码块中指定目标；定位失败时不自动改写，写回保留原文件的换行风格
- 代码块写回格式：由编辑器界面按当前代码显示模式（紧凑 / 舒缓）给出文本，扩展只做等价性校验（解析出的 JSON 与状态一致才采用），对不上就退回默认 2 空格缩进——格式可以丢，内容不能错

## 限制

- 编辑器 webview 首选霞鹜文楷经 CDN 加载，离线时自动回退系统字体（与网页版一致）
- 图片「编辑保存」只改元数据，不重绘像素；如需更新画面，重新导出即可
- 预览里的编辑入口依赖产品 URL scheme 的深链接：桌面版（VS Code / VSCodium / Insiders）可用；web 版（vscode.dev）不支持 URI 处理器，那边请用源码里的 CodeLens
- 预览过期（例如扩展重载后没重开预览）时点入口会提示「已过期」，重开预览即可；源码里的 CodeLens 不受此影响
