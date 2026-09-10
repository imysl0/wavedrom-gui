# WaveDrom-Gui VSCode 扩展示例

在 Markdown 预览中观察：

## 1. 代码块渲染（wavedrom 围栏）

预览会在此位置直接显示渲染出的波形，键盘图标按钮在波形右上角——点它进入可视化编辑器（编辑结果实时写回本代码块）。不想要按钮的话，把设置 `wavedrom-gui.previewEditAffordance` 改成 `block`，即可点波形任意处进入编辑。

```wavedrom
{ "signal": [
  { "name": "clk",  "wave": "p.........", "node": ".a........" },
  { "name": "req",  "wave": "0.1.....0.", "node": "..b......." },
  { "name": "data", "wave": "x.==..x...", "data": ["D0", "D1"] }
] }
```

## 2. 内嵌 WaveJSON 的图片

下面这张 PNG 的元数据里带着 WaveJSON（由 wavedrom-render skill 生成）——
预览会识别它，图片右上角出现同样的铅笔按钮；**编辑保存只更新图片里的元数据，像素不变**。

图片的编辑面板位置用设置 `wavedrom-gui.editorPanelPosition` 控制：`current`（默认，与预览同栏、标签切换）/ `beside`（右侧新开一栏）/ `below`（预览在上、编辑在下）/ `newWindow`（独立窗口）。

![内嵌 WaveJSON 的示例图](./assets/embedded.png)

## 3. 不会被打扰的普通内容

```json
{ "this": "普通 json 围栏不会被拦截" }
```
