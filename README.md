# WaveDrom-Gui

WaveDrom 时序图工具集，目前包含两个产品：一个鼠标点选即可编辑的 **Web 可视化编辑器**，和一个无浏览器的 **命令行渲染 Skill**。两者通过图片元数据打通——**Skill 导出的 SVG/PNG 内嵌 WaveJSON，Web 编辑器「打开文件」即可直接还原成可编辑的图表**。零构建、离线可用。代码完全由 GLM-5.3-flash、Qwen3.8-max、deepseek-v4-flash-exp、mimo-v25-pro、claude-opus-4.8 协作完成，工作之余写的，欢迎大家使用、提 issue、PR、关注！

![整体截图](./images/wavedrom-gui.png)

## 产品一：WaveDrom Web 编辑器

单文件 HTML 应用（约 300+ KB）：用鼠标点击/拖拽编辑 WaveDrom 时序图，右侧官方引擎实时渲染，左侧同步生成 WaveJSON 代码，兼容大部分 WaveDrom 常用语法。直接用浏览器打开 `index.html` 即可（file:// 协议可用，无需服务器），也可使用 [demo站点](https://wave.rtlyes.cn/)（免费服务，不保证可用）。

核心亮点：

- **点选 + 笔刷编辑**：20 种波形状态点选即改，笔刷涂抹、向右拖动延续、右键清除；笔刷栏五种形态折叠切换，支持键盘直切
- **官方引擎实时预览**：内嵌 WaveDrom v3.5.0 与 default/narrow 两套皮肤，所见即所得
- **分组、节点与箭头**：嵌套分组折叠同步，覆盖全部官方箭头写法，period/phase/hscale/hbounds 完整支持
- **导入导出闭环**：导出的 SVG/PNG 内嵌 WaveJSON 元数据（图片可直接再导入还原图表，与 Skill 导出互通），宽松 WaveJSON 解析（`//` 注释、免引号键等，与官方编辑器一致），JSON / kroki 代码块 / 分享链接
- **深度可调**：深浅双主题、可拖拽分割条布局、界面与代码字体独立选择、100 步撤销重做，偏好全部持久化

👉 详细功能说明见 [EDITOR.md](./EDITOR.md)。

## 产品二：wavedrom-render Skill

把 WaveJSON（AI 生成的或手写的）渲染成时序波形图、输出 SVG / PNG 的命令行工具，专为 AI agent 与脚本场景设计：**无需浏览器、无需 index.html**，只要 Node.js（出 PNG 需任一光栅化器）。

- **现代模式**（默认）：与 Web 编辑器完全一致的自绘风格——浅色主题、彩色分信号轨迹、节点箭头、period/phase/hscale/hbounds 全支持，几何逐字移植自 index.html
- **传统模式**：直接驱动官方 WaveDrom v3.5.0 引擎，产出官方黑白样式，支持 default / narrow 皮肤
- **字体可内嵌**：可选下载霞鹜文楷，按字符子集化后以 @font-face 内嵌进 SVG，自包含、体积仅几百 KB
- **与 Web 编辑器互通**：导出的 SVG/PNG 内嵌 WaveJSON 元数据（不影响显示），在 wavedrom-gui「打开文件」即可还原图表继续编辑；`--no-meta` 可关闭
- **内置生成指南**：SKILL.md 附「WaveJSON 生成指南」（延续符规则、单 bit 禁用数据框字符、基础语法速查），AI 读取后即可产出规范代码

```bash
cd SKILL/wavedrom-render
node render.js wave.json                                            # 现代模式 PNG
node render.js wave.json --mode traditional --skin narrow --format svg   # 传统模式 SVG
```

👉 完整用法与「WaveJSON 生成指南」见 [SKILL/wavedrom-render/SKILL.md](./SKILL/wavedrom-render/SKILL.md)。

## 技术说明

- 内嵌官方 [WaveDrom](https://wavedrom.com/) v3.5.0 渲染库与 default/narrow 两套皮肤（来源 wavedrom.com）
- 编辑区迷你波形为自绘 SVG，生成逻辑对照官方源码（`gen-wave-brick.js` 等）实现：成对状态转换、半拍转换标记、电平-时钟半砖融合（xclude 表）、`.`/`|` 重复器、period/phase/hscale 缩放等均按官方语义
- 导出图片内嵌 WaveJSON 元数据：SVG `<metadata>` / PNG `iTXt` 文本块（纯 JS 零依赖实现，CRC32 手写），导入按文件头嗅探自动回读，不影响图片显示
- 字体：霞鹜文楷等宽经 npmmirror CDN 分片按需加载（国内直连），离线自动回退系统字体；导出 SVG/PNG 不受界面字体与主题影响

## 致谢

- [WaveDrom](https://wavedrom.com/) —— 官方渲染引擎与皮肤
- [霞鹜文楷 LXGW WenKai](https://github.com/lxgw/LxgwWenKai) —— 默认界面与代码字体
- [npmmirror](https://npmmirror.com/) —— 字体 CDN 分片直连
- 本仓库代码完全由 AI 协作完成：GLM-5.3-flash、Qwen3.8-max、deepseek-v4-flash-exp、mimo-v25-pro、claude-opus-4.8

## 联系与赞赏

欢迎关注我的小红书：
![小红书](./images/xhs.png)

如果觉得有用，也欢迎微信赞赏，无论是否赞赏，工具都是开源免费的，愉快的用起来！

![微信赞赏](./images/wxzsm.png)
