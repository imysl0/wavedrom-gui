# 实现说明（design）

面向维护者：功能与用法见 [README.md](./README.md)，这份文档只讲背后的机制、取舍与排错。

## 1. 预览渲染管线

- `markdown.markdownItPlugins`：拦截 ` ```wavedrom ` / ` ```wavejson ` 围栏，替换为占位块；渲染期通过 markdown-it 的 `env.currentDocument` 拿到文档路径，同步读取本地 png/svg 并用 `lib/meta-embed.js` 提取内嵌 WaveJSON（命中才包编辑入口）。
- 图片走 `md.renderer.rules.image` 包装：先调原生渲染拿到 `<img>`，再用 `probeImagePath` 判断引用目标——跳过 `http:` / `data:` / `#` / `//` 等协议与非 `.png`/`.svg` 扩展名，解析相对路径与 URL 转义，最后读文件提取元数据。探测结果按 `mtime + size` 缓存（含**否定结果**：CodeLens 每次击键都会重跑，不缓存会让多图文档卡输入）。
- 命中的图片**不塞 `data-json`、也不重绘**：预览里直接显示原图 `<img>`，保持导出时的主题与配色（早期实现恒用现代渲染器按元数据重画，会把传统/官方风格的图在预览里改掉风格）。编辑入口照旧（右键 / 铅笔 / 整块点击），要改内容进可视化编辑器改。
- 写回后要让预览拿到**新像素**：`markdown.preview.refresh` 会重渲染整篇，但 webview 按 URI 缓存图片，所以给命中图片的 `src` 追加随 mtime 变化的 `?wdv=<mtimeMs>` 破除缓存（幂等，保留 `#fragment`）。这条链路是安全的：VS Code 的 image 规则只在 `file:` / 工作区根 `/` 开头时才改写成 webview URI，相对路径原样保留；预览用 `<base href="asWebviewUri(文档 uri)">` 解析相对图；webview 的 service worker 以**含 query 的完整 URL** 作 Cache API 键、并把 query 透传给宿主读文件——既破缓存，也不会 404，CSP 的 `img-src … https:` 同样命中。
- `markdown.previewScripts`：`media/preview.js` 在预览内对**代码块**做现代主题渲染（`render-modern.js` 的浏览器包装层 `media/modern-render.browser.js`），并给两类块挂编辑入口；图片块只做入口与上下文，不渲染（因此渲染库未就绪时也能先挂好，`scan()` 对图片块不等就绪）。

## 2. 预览 → 扩展：产品 scheme 深链接

预览里拿不到自己的消息通道（`acquireVsCodeApi` 已被内置预览脚本占用，`postMessage` 只会送到 markdown 扩展），`command:` 链接在预览里也被禁用；早期的「127.0.0.1 图片信标」在默认的**严格**预览安全级别下会被 CSP 拦下（`img-src` 无 `http:`），还会弹出「放宽安全设置」的提示。

现在把入口渲染成真锚点 `<a href="<vscode.env.uriScheme>://<扩展 id>/edit?k=…">`，点击经 `openerService` 交给扩展的 `registerUriHandler`（`package.json` 里声明了 `onUri` 激活事件）。全程不发 http 请求，因此不触发 `securitypolicyviolation`、**不需要用户改任何安全设置**；scheme 用 `vscode.env.uriScheme` 取（VSCodium 是 `vscodium`、Insiders 是 `vscode-insiders`），不能写死 `vscode`。

## 3. 右键菜单入口

每个块上写 `data-vscode-context`（含 `k`），配合 `contributes.menus["webview/context"]`（`when` 限定 `markdown.preview` / 新版 markdown 编辑器）给出「编辑波形」。VS Code 会把这段 JSON 作为命令的第一个参数传给 `wavedrom-gui.editFromPreview`（只读 `context.k`，与 mermaid 扩展同一机制）。右键菜单不经过 CSP，所以这条既是点击入口的补充，也是深链接万一失效时的备用通道。

**两种键，别混用**：代码块写 `webviewSection: 'wavedrom'`；**图片写 `wdImage: '1'`**。原因是 webview 侧收集上下文的方式——从命中元素起沿祖先链 `context = {...该元素的 JSON, ...已合并的}`，**近者覆盖、且是键的并集**：

- 预览脚本会给每个 `<img>` 写 `{webviewSection: 'localImage'|'image', id, preventDefaultContextMenuItems: true, resource, imageSource}`（按 `data-src` 判本地/远程）。若我们把它覆盖成 `wavedrom`，VS Code 自带的**「复制图片」**（`when: webviewSection == 'image' || 'localImage'`）与**「打开图片」**（`== 'localImage'`）立刻失配消失；而 `preventDefaultContextMenuItems` 只 gating 内置的剪切/复制/粘贴三项，跟「编辑波形」出不出无关——所以它要**原样保留**（早期实现删掉它，结果是图片右键多出三项没用的剪贴板项、同时丢掉上面两项）。
- 因此图片用自有键 `wdImage: '1'`（菜单 `when` 用 `wdImage == '1'` 显式比较，别用裸键名赌 `has()` 语义），图片块**从 span 到 img 都不出现 `webviewSection`**——合并是并集，祖先带上它同样会顶掉预览的 `localImage`。
- 结果：图片右键 = 编辑波形 + 复制图片 + 打开图片；代码块右键 = 编辑波形（代码块上不设 `preventDefaultContextMenuItems`，渲染失败回退时 `<pre>` 里的 WaveJSON 原文要能右键复制）。

`media/preview.js` 会把这段上下文同时烙到**实际命中的 `<img>`** 上，并在捕获阶段（VS Code 自己的监听器在 window 冒泡阶段，晚于我们）补烙一次：预览脚本初始化时会重写 `<img>` 的该属性，可能落在我们之后。菜单项其实靠块上的键就能命中，这两处是让命中目标自洽、不依赖「祖先合并」这条实现细节的保险。

## 4. 授权键 `k` 与「预览过期」

`k` 是渲染时登记进内存表的不透明键，同时充当一次点击的授权凭据：表里没有的 `k` 一律拒绝，避免任意 Markdown 构造链接就让扩展去打开任意文件。预览过期（扩展重载后没重开预览）时三条入口都会提示「预览里的图表已过期，重新打开预览后再试」；源码里的 CodeLens 不受影响，它按需重新定位围栏。

## 5. 本地化

- 扩展宿主文案走 `vscode.l10n`（源语言英文，`l10n/bundle.l10n.zh-cn.json` 提供中文），`package.json` 的命令 / 设置文案走 `package.nls.json` + `package.nls.zh-cn.json` 占位符。
- **不单纯依赖本地化管道**：`vscode.l10n` 在 bundle 解析不到时会静默回退英文（实测在装 VSIX 的环境里出现过「宿主界面中文、扩展英文」），所以扩展自己读一份中文表（另备 `zh-hans` 别名）作为兜底；`auto` + 中文界面时必定显示中文。
- 预览是 webview、拿不到 `vscode.l10n`，所以那一小段文案（编辑入口的 `aria-label` 与悬停提示）由扩展按当前语言渲染进一个隐藏的 `#wd-i18n`，`preview.js` 读它的 `data-*`（缺失则回退英文）——翻译仍只有语言包一处。
- 命令标题与设置说明属于 VS Code 的**清单本地化**，由宿主在加载时替换，运行时改不了。
- 排查：Output 面板选 **Extension Host**，激活时会打印一行
  `[wavedrom-gui] i18n {"setting":"auto","envLanguage":"zh-cn","effective":"zh","l10nApi":true,"zhTableKeys":24}`。
- ⚠️ **F5 扩展开发宿主下命令标题与设置说明显示英文**：VS Code 在开发模式下直接跳过 `package.nls.<locale>.json`（工作台代码里是 `if (t.devMode || t.pseudo || !t.language) return { localized: package.nls.json }`），这是宿主行为、扩展无法绕过；消息、CodeLens 与预览文案不受此限。

## 6. 编辑器面板的加载与隔离

- `editorShellPath()`：仓库内调试时 `extensionUri` 就是 `vscode/`，同级 `../index.html` 是正在改的实时界面（F5 下改动立即生效）；装了 VSIX 之后同级没有 `index.html`，回退到随包安装的 `media/editor.html`（`scripts/build.js` 从仓库根 `index.html` 拷入）。
- 面板 HTML 由 `buildEditorHtml()` 注入：CSP、初始 WaveJSON（`location.hash`）、保存轮询脚本、界面语言、视图模式 / 左栏显隐、以及（图片目标时）`IMG = {ext, pxW, kind}`。
- 每个编辑目标一份独立的 localStorage 键（`panelDocKey`：文档路径 + 行号 / 图片路径的 sha1 摘要）：webview 之间共享 localStorage，若都用同一个键，另一个面板的改动会被本面板的轮询当成自己的文档写回，导致 A 块被 B 的内容覆盖；按目标派生后条目数也不会无限增长。
- 面板位置（`wavedrom-gui.editorPanelPosition`）里 `below` / `newWindow` 复用 VS Code 自己的 `workbench.action.moveEditorToBelowGroup` / `workbench.action.moveEditorToNewWindow`：这两个命令作用于**当前活动编辑器**，扩展先等面板真的取得焦点（最多 12 × 40ms）再执行，拿不到焦点就留在原地（宁可停住，也不能把预览或别的编辑器搬走）。VS Code 没有向扩展开放浮动 / 模态编辑器（公开的 `ViewColumn` 只有 `Active` / `Beside` / `1-9`），所以「浮在预览之上」做不到。

## 7. 面板内导出

编辑器里的导出按钮不落浏览器式下载：注入脚本装上 `window.__wdDownloadHook`，把产物读成 base64 后以 `{type:'export', name, b64}` 交给宿主；宿主弹**系统保存框**，`defaultUri` = 来源文件所在目录（代码块目标 = 该 Markdown 文件，图片目标 = 原图路径）+ 编辑器给出的文件名（有标题 `wavdrom_gui_标题`，否则 `wavdrom_gui_日期_序号`）。取消则不落盘，成功后状态栏提示落盘路径。

## 8. 源码侧预览入口

CodeLens 的「预览」与悬停里的「固定预览」都走 `wavedrom-gui.previewFence`（在侧边开 / 关预览面板）；悬停内容用 `renderSvgCached` 以 `data:image/svg+xml;base64` 内联渲染结果，并按行号重新定位围栏——因此参数里只带 `docPath + line`，整段 JSON 不必塞进命令 URI。

## 9. 图片来源识别与像素写回

**来源识别**（`lib/meta-embed.js`）：

- SVG：优先读 `<metadata data-export="…">` 显式标记；无标记的旧文件按结构指纹判断——根元素 `data-editor-export="1"` 判编辑区导出，`id="waves_<n>"` 判官方渲染，无 `xmlns:xlink` 且无 `<style>` 的判编辑区，其余判现代 skill 导出。
- PNG：扫 `iTXt` / `tEXt` / `zTXt` 块里关键字 `WaveDromGui` 的 `export=<kind>`。
- 标记与指纹都识别不出来时（如无标记的旧 PNG）按 **skill-modern** 兜底——新工具链默认导出的就是现代风格。
- `wavedrom-gui.imageExportTheme` 在面板建立时覆盖这个结论：`modern` → `skill-modern`、`traditional` → `wavedrom`。

**像素写回**：轮询脚本在图片目标上按来源分派渲染——官方渲染走 `getExportSvg`、编辑区导出走 `buildEditorSvg`、skill-modern 走面板内联的无浏览器渲染器；PNG 走 canvas 光栅化（比例 = 原图宽 ÷ 当前自然宽，夹在 1×–4×，读不到宽度退回 2×，skill-modern 保持透明底），SVG 直接上报矢量文本（剥掉 XML 声明）。消息里除 `k` 之外新增 `pixels`（含 base64 PNG 或 SVG 文本 + 渲染完成后的文档 JSON），宿主暂存内存。

**落盘时机与延迟预算**（写回分两条路，各自的预算不同）：

- **元数据路径**（`save` 消息 → `saveBack` 写图里的 JSON）：编辑器界面自己先去抖——所有改动汇到 `update()`，它不直接落盘，而是 `clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400)`，所以**连续编辑/拖动期间一次都不写 localStorage**，停手 400ms 才写；面板再按 250ms 网格轮询到变化才发 `save`。合起来：停手后约 0.4～0.65 秒文件里的元数据更新（`hover` / CodeLens 读到的是上一次停手时的 JSON，不是实时的）。
- **像素路径**（`pixels` 消息 → `flushPixels` 写图，`FLUSH_MS = 250`）：停手 250ms、面板关闭（`onDidDispose`）或切走标签（`onDidChangeViewState`）落盘。端到端 ≈ **界面去抖(400ms) + 轮询(≤250ms) + 光栅化 + 去抖(250ms)** ≈ 1 秒。
  - 宿主侧去抖只需 250ms：**「用户停手了吗」上游已经判断过了**（元数据路径那条 400ms 去抖），到达宿主的改动天生就是「停手之后」的，连续拖动期间根本不会有消息；宿主这里只是把「光栅化还没回来的那轮 `save`」与随后的 `pixels` 合并成一次写盘（每条新消息重置计时器，突发编辑自然合并），并略大于一次光栅化往返，避免计时器先于最后一帧像素到期——先到期也不会写坏（同源校验把这轮丢掉），只是把写盘推迟到下一轮。
  - 光栅化是 webview 按变化帧重画，慢时由 `busy`/`dirty` 合并成「始终追最新一帧」，不会叠加。
  - 历史：去抖先是 5 秒、后改成 1 秒，当时的假设是「拖动时每帧都会上报像素，必须靠去抖压住」——这个假设不成立（连续拖动被上游 400ms 去抖挡在门外，宿主根本收不到消息），故降到 250ms。
- 状态栏提示只在切走 / 关闭那次弹：面板可见时画面自身就在变，提示是噪音。

写盘前校验**同源**：只采用与最新元数据同一份 JSON 的画面（渲染没跟上时维持「元数据新、像素旧」），然后走临时文件 + rename 原子替换。渲染之所以提前到轮询里做，是因为面板关闭时 webview 先被销毁、之后没人能再渲染画面——宿主手里必须始终有最新一份像素，「关闭即写回」才成立。

**来源标记的保持**：PNG 光栅化产物是 canvas 全新编码、不含原文件任何 iTXt，所以落盘时用 `reembedPngMarker` 重新插入 `WaveDromGui = export=<kind>`（只写 WaveJSON 会把标记弄丢，下次打开兜底判成 skill-modern，传统风格的图编辑第二轮就漂成现代）；SVG 路径同理，元数据重写时带上检测到的 kind，避免剥掉 `data-export`。

## 10. 代码块写回：定位与格式校验

- 定位：行号 + 内容双重要求（内容相同的重复代码块靠行号区分）→ 原文精确匹配 → 忽略空白差异匹配 → 让用户从文件现有代码块中指定目标；定位失败时不自动改写，写回保留原文件的换行风格。
- 格式：由编辑器界面按当前代码显示模式（紧凑 / 舒缓）给出文本，扩展只做等价性校验（解析出的 JSON 与状态一致才采用），对不上就退回默认 2 空格缩进——格式可以丢，内容不能错。

## 11. 打包与发布

- `scripts/build.js` 在 `vscode:prepublish` 时跑（零依赖）：把 skill 的 `lib/render-modern.js` 包成浏览器 IIFE 到 `media/modern-render.browser.js`，把仓库根 `index.html` 拷成 `media/editor.html`，并把 `package.json` 的 version 按最新 git tag（`vYYMMDD.N` → `YYMMDD.N.0`）对齐。清理检出即可打包，无需 `npm install`。
- 发布流水线（`.cnb.yml` 的 tag_push 与 `.github/workflows/release.yml`）在打 tag 后写版本号、打包 VSIX、发 Release 附件。
- `vsce package` 的 `--baseContentUrl`（内容链接基址）应为 `…/-/blob/main/vscode`，`--baseImagesUrl`（图片）为 `…/-/raw/main/vscode`：README 里一旦出现**相对链接**，不带这两个参数且仓库无法自动识别时 vsce 会因「链接会失效」**直接报错、不产出 VSIX**；带上则会把相对链接改写成绝对地址。本仓库的 README 目前用的都是绝对链接，因此裸 `vsce package` 也能过。
- 别在会被 vsce 打包扫描的文档（README 等）里放**字面量图片示例**：vsce 会把它当成坏图解析并导致打包失败。
