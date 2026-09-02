---
name: wavedrom-render
description: >
  把 WaveDrom WaveJSON（AI 生成的或手写的）渲染成时序波形图，输出 SVG / PNG。
  默认「现代模式」——与 wavedrom-gui 编辑区完全一致的自绘风格（浅色主题、彩色分信号轨迹）；
  也支持「传统模式」——官方 WaveDrom v3.5.0 渲染库（黑白官方样式，支持 default / narrow 皮肤）。

  When the user gives WaveDrom / WaveJSON code (e.g. `{ "signal": [...] }`) and wants a
  waveform picture, timing diagram, 波形图, or to render/preview a signal as SVG/PNG,
  use this skill. Fully self-contained: needs only Node.js (+ a PNG rasterizer such as
  Python cairosvg). Does NOT need index.html or a browser.
---

# WaveDrom Render

把 WaveJSON 渲染为时序波形图片。所有依赖都在本目录内，**不需要 index.html、不需要浏览器**。

## 何时使用

- 用户给出一段 WaveDrom / WaveJSON（如 `{ "signal": [ { "name": "clk", "wave": "p..." } ] }`），想看成波形图 / 时序图 / 导出 SVG 或 PNG。
- 需要把 AI 生成的时序描述可视化检视。

## 前置条件

- **Node.js**（渲染 SVG，必需）。
- **PNG 光栅化器**（生成 PNG 时需要，三选一，按优先级自动探测）：
  1. Python + `cairosvg`（推荐）：`pip install cairosvg`
  2. `rsvg-convert`（librsvg）
  3. ImageMagick（`magick` / `convert`）
- **Python `fontTools`**（可选，用于「把字体内嵌进 SVG」）：`pip install fonttools`。见下方「字体」。
- **霞鹜文楷字体下载**（**推荐**，可选）：`node setup.js` 一次性下载到 `vendor/fonts/`（两套 TTF 各约 24MB），现代模式获得与 App 一致的字体外观、SVG 可内嵌自包含；**不下载也能正常渲染**（回退系统字体）。见下方「安装 / 初始化」。

只输出 SVG 且不内嵌字体时，只需 Node.js。

## 安装 / 初始化（推荐，可选，一次性）

现代模式默认想用**霞鹜文楷**（与原 App 一致）。首次使用可联网下载一次字体到本地：

```bash
node setup.js
```

- 从 GitHub Releases 下载 `LXGWWenKai-Regular.ttf` 与 `LXGWWenKaiMono-Regular.ttf` 到 `vendor/fonts/`（各约 24MB）。
- 渠道自动：先直连 GitHub，失败再走国内代理 `gh-proxy.org`；也可在 `fonts.config.json` 里把 `mirror` 固定为 `github` / `ghproxy`。
- 已下载则跳过。**下载失败不报错中断**——渲染会静默回退到系统字体名（中文仍显示，只是非霞鹜文楷外观）。
- 不跑这步也能正常渲染，只是拿不到霞鹜文楷外观。

## 用法

在本 skill 目录（`SKILL/wavedrom-render/`）下运行：

```bash
node render.js <input.json> [选项]
node render.js -              # 从 stdin 读取 WaveJSON
```

### 选项

| 选项 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `--mode` | `modern` \| `traditional` | `modern` | 渲染风格 |
| `--format` | `svg` \| `png` \| `both` | `png` | 输出格式 |
| `--out` | 路径 | 跟随输入名 | 输出路径（扩展名自动补） |
| `--scale` | 数字 | `2` | PNG 缩放倍数（2 = 2×，更清晰） |
| `--skin` | `default` \| `narrow` | `default` | **仅传统模式**：官方皮肤 |
| `--node-pos` | `lt tm rt lm c rm lb bm rb` | `lm` | **仅现代模式**：节点圆标位置 |
| `--node-scale` | 数字 | `1` | **仅现代模式**：节点圆标缩放 |

### 示例

```bash
# 现代模式（默认），生成 PNG
node render.js wave.json

# 现代模式，同时导出 SVG + PNG
node render.js wave.json --format both --out out/mywave

# 传统模式（官方引擎），narrow 皮肤，导出 SVG
node render.js wave.json --mode traditional --skin narrow --format svg

# 从 stdin 读入，写到指定 PNG，3× 清晰度
cat wave.json | node render.js - --out out/w.png --scale 3
```

## 两种模式的区别

- **现代模式（modern，默认）**：复刻 wavedrom-gui 编辑区的自绘 SVG —— 浅色主题、每条信号按调色板着色、数据框逐色（官方 2–9 配色）、节点圆标、`period/phase/hscale`、`hbounds` 裁剪、head/foot 文字与 tick 刻度、分组与占位行、节点箭头（`edge`）。几何逻辑逐字移植自 `index.html` 的 `laneSVG` 与网格布局，配色固定为浅色（与 App 的导出一致）。
- **传统模式（traditional）**：直接调用内嵌的**官方 WaveDrom v3.5.0** 渲染引擎（`vendor/` 内），产出官方黑白样式，支持 `default` / `narrow` 两套皮肤。

两种模式吃同一份 WaveJSON。输入既可是严格 JSON，也可是宽松的 JS 对象写法（不带引号的键、尾逗号、单引号——与 App 编辑器的容错一致）。

## 支持的 WaveJSON 语法

`signal`（含嵌套分组数组、`{}` 空白占位）、`wave`（全部状态字符 `01pnPNudUDxzhlHL=23456789|.` 与 `.` 延续、`<>` 子周期）、`data`、`node` + `edge`（覆盖全部官方箭头写法）、`head`/`foot`（`text`/`tick`/`tock`/`every`）、`config`（`hscale`/`skin`/`hbounds`）、`period`/`phase`。

## 字体与字号（可配置）

现代模式的字体栈与各处字号都在 **`fonts.config.json` 的 `appearance` 区**（与字体下载/内嵌配置同一个文件）。**想改就改这个 JSON，无需碰任何代码**：

```jsonc
"appearance": {
  "fontFamily": {
    "mono": "\"LXGW WenKai Mono\",\"Cascadia Code\",Consolas,...,monospace",
    "ui":   "\"LXGW WenKai\",\"LXGW WenKai Mono\",...,sans-serif"
  },
  "size": {
    "dataLabel": 14, "signalName": 16, "groupName": 16, "title": 16,
    "tick": 12, "spacer": 11.5, "ppBadge": 11, "node": 10, "edgeLabel": 11
  }
}
```

| 键 | 作用 | 默认字号 | 字体栈 |
|---|---|---|---|
| `fontFamily.mono` | 等宽字体栈 | — | 首选霞鹜文楷等宽 |
| `fontFamily.ui` | UI 字体栈 | — | 首选霞鹜文楷 |
| `size.dataLabel` | 数据框标签（0x18 / D0…） | **14** | mono |
| `size.signalName` | 信号名（clk / req…） | **16** | mono |
| `size.groupName` | 分组名（▸ ctrl） | **16** | ui |
| `size.title` | 标题 + head/foot 文字 | **16** | ui |
| `size.tick` | 时间轴刻度 / foot 刻度数字 | 12 | mono |
| `size.spacer` | 「空白占位」行 | 11.5 | ui |
| `size.ppBadge` | period/phase 徽标（×2 φ0.5） | 11 | mono |
| `size.node` | 节点圆标字母（再乘 `--node-scale`） | 10 | mono |
| `size.edgeLabel` | 边（箭头）标注 | 11 | mono |

说明：

- 改 `fonts.config.json` 后直接重跑渲染即可生效；配置缺失 / 某项没写 / 文件损坏时，自动回退到内置默认值，渲染不会中断。
- 字号单位为 SVG 用户单位（≈1× 时的 px）；PNG 里最终像素 = 字号 × `--scale`（默认 2×）；字号不随 `hscale` 变化（`hscale` 只放大横向格宽）。
- 名称列宽度、pp 徽标位置、数据标签换行判定都会随 `signalName`/`dataLabel` 自动缩放，改大字号不会截断。
- 分组行前的折叠三角（▸）是**画出来的 SVG 路径**，不依赖字体，任何渲染器都不会字形错乱。
- **字体内嵌（自包含 SVG）**：若装了 Python `fontTools`（`pip install fonttools`），渲染会把 `fonts.config.json` 中 `fonts` 列表里每个已就位的 TTF **按用到的字符子集化**后内嵌进 SVG —— SVG 自包含（任何机器打开都是同一字体外观），体积仅几百 KB。`fonts` 列表**不限字体**：默认是 `node setup.js` 下载的霞鹜文楷，换用/新增字体只需在 `fonts` 里加一条（`family` + `file`，可选 `github`/`ghproxy` 下载 URL 供 setup.js 下载）并把 TTF 放入 `dir`，同时把 `appearance.fontFamily` 首项改为该 `family`。**内嵌恒为子集化**：没装 fontTools 或子集化失败时**自动不内嵌**（回退字体名），绝不内嵌整份 TTF、不会产生几十 MB 的巨型 SVG。开关在 `fonts.config.json`（`enabled` / `embed` / `mirror` / `dir`）。
- 不内嵌时：SVG 只写字体名，**最终字形由渲染器（浏览器 / cairosvg）能否找到该字体决定**。字体栈末尾附带各平台常见中文字体（Windows 的 Microsoft YaHei、macOS 的 PingFang/Hiragino、Linux 的 Noto/文泉驿），中文一般都能正确回退；若本地已 `setup.js` 下载过霞鹜文楷，cairosvg 生成 PNG 时通常也能直接用上。要固定某字体，改 `appearance.fontFamily.mono` / `appearance.fontFamily.ui` 首项为本机已装字体即可。
- ⚠️ 已知：cairosvg 会静默丢弃**带 `stroke` 的 `<text>`**，故本渲染器所有文字均为纯 `fill`，需要衬底时用背景矩形而非描边光晕。

## 目录结构

```
wavedrom-render/
  render.js                 # 统一 CLI 入口
  setup.js                  # 一次性初始化：下载霞鹜文楷字体到 vendor/fonts/
  fonts.config.json         # 字体配置（可改：enabled / embed / mirror / dir / 下载 URL）
  lib/
    render-modern.js        # 现代模式渲染器（自绘 SVG，移植自 laneSVG + 网格布局）
    render-traditional.js   # 传统模式渲染器（驱动官方引擎，无需浏览器）
    svg-to-png.js           # SVG→PNG（cairosvg / rsvg-convert / ImageMagick 自动探测）
    font-embed.js           # 把子集化后的霞鹜文楷以 @font-face base64 内嵌进 SVG
  scripts/
    svg2png.py              # cairosvg 光栅化辅助脚本
    subset_font.py          # fontTools 字体子集化辅助脚本
  vendor/
    wavedrom.bundle.js      # 官方 WaveDrom v3.5.0 引擎（自 index.html 提取 + 两处补丁暴露 renderAny/stringify）
    waveskin.js             # 官方皮肤 default + narrow（自 index.html 提取）
    fonts/                  # setup.js 下载的霞鹜文楷 TTF（不随仓库提交）
```

## 实现说明

- 传统模式在 Node 里**无浏览器**运行：官方 browserify 包只在加载时触碰 `window`，用极小的全局垫片即可；渲染走 `renderAny()`（返回 JsonML 树）→ `onml.stringify()`（转 SVG 字符串），产出的 SVG 已内联皮肤 `<defs>`，自包含可独立打开。
- 现代模式不依赖官方引擎，纯字符串拼 SVG；`laneSVG` 的所有笔画几何（成对状态转换、半拍标记、时钟半砖融合、`x` 交叉阴影、数据框、`.`/`|` 重复器、`u/d/z` 曲线、节点与边）都按 `index.html` 语义复刻。
- 现代模式配色固定浅色主题（与 App 的 SVG/PNG 导出一致）。
