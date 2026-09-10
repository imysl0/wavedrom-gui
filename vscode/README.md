# WaveDrom-Gui — VSCode 扩展

在 VS Code 内置 Markdown 预览中直接使用 wavedrom-gui 的能力。

## 功能

### 1. ```wavedrom 代码块 → 预览内渲染 + 工具栏

Markdown 里用 ```` ```wavedrom ```` 围栏写的 WaveJSON，在内置预览（Ctrl+Shift+V）的**代码块位置**直接显示渲染出的现代主题波形，并带一个小工具栏：

- **源码**：查看该块 WaveJSON 原文
- **✏ 编辑**：打开可视化编辑器（复用仓库根目录的 `index.html`，以 webview 面板加载）；**编辑结果实时写回 Markdown 中的这个代码块**，写回格式跟随编辑器的代码显示模式（舒缓 / 紧凑）

### 2. 内嵌 WaveJSON 的图片 → 同样的工具栏

Markdown 里引用的 **PNG / SVG 图片**如果内嵌了 WaveJSON 元数据（由 wavedrom-gui 或 wavedrom-render skill 导出），预览会自动识别并在图片上方出现工具栏：

- **原图**：切回图片原内容
- **✏ 编辑**：进入可视化编辑器；保存时**只更新图片文件里的元数据，像素不变**（PNG `iTXt` / SVG `<metadata>`）

## 安装与调试

开发调试（推荐）：用 VS Code 打开本 `vscode/` 目录，按 **F5** 启动「扩展开发宿主」，在新窗口打开 `sample/sample.md` 并开启预览。

临时安装：命令面板执行「Extensions: Install from Location...」，选择本 `vscode/` 目录。
打包 VSIX：`npx @vscode/vsce package`（需网络）。

## 命令

- **WaveDrom: 编辑当前 Markdown 中的图表**（`wavedrom-gui.editActive`）：在当前 md 文件的代码块 / 带元数据图片中挑一个进入可视化编辑。作为预览工具栏「编辑」按钮不可用时的兜底入口。

## 工作原理

- `markdown.markdownItPlugins`：拦截 ```wavedrom / ```wavejson 围栏，替换为占位块；渲染期通过 markdown-it 的 `env.currentDocument` 拿到文档路径，同步读取本地 png/svg 并用 `lib/meta-embed.js` 提取内嵌 WaveJSON（命中才包工具栏）
- `markdown.previewScripts`：`media/preview.js` 在预览内完成现代主题渲染（`render-modern.js` 的浏览器包装层），并挂接工具栏
- 预览 CSP 不允许脚本外联、也不存在公开的预览→扩展消息通道，因此「编辑」按钮通过 **127.0.0.1 随机端口 + 随机 token 的图片信标** 通知扩展（`extension.js` 内置回环桥）
- 编辑器面板：读取仓库根目录 `index.html` 注入 CSP、初始 JSON（`location.hash`）与保存轮询脚本后加载；轮询检测应用自动保存的文档变化，经 webview 消息回写。每个编辑目标用一份独立的 localStorage 键，多个编辑面板同时打开也不会互相串写
- 代码块写回定位：行号 + 内容双重要求（内容相同的重复代码块靠行号区分）→ 原文精确匹配 → 忽略空白差异匹配 → 让用户从文件现有代码块中指定目标；定位失败时不自动改写，写回保留原文件的换行风格
- 代码块写回格式：由编辑器界面按当前代码显示模式（紧凑 / 舒缓）给出文本，扩展只做等价性校验（解析出的 JSON 与状态一致才采用），对不上就退回默认 2 空格缩进——格式可以丢，内容不能错

## 限制

- 编辑器 webview 首选霞鹜文楷经 CDN 加载，离线时自动回退系统字体（与网页版一致）
- 图片「编辑保存」只改元数据，不重绘像素；如需更新画面，重新导出即可
- 预览工具栏的「编辑」依赖本机回环桥；如被安全策略阻断，请使用命令面板兜底入口
