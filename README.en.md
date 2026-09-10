# WaveDrom-Gui

[简体中文](./README.md) | **English**

A WaveDrom timing-diagram toolkit with three products: a click-to-edit **web visual editor**, a browser-free **command-line rendering Skill**, and a **VS Code extension** (in development). They are wired together through image metadata — **SVGs/PNGs exported by the Skill embed the WaveJSON, and the web editor's "Open file" restores them into an editable diagram**. Zero build, works offline. The code was written in collaboration with GLM-5.3-flash, Qwen3.8-max, deepseek-v4-flash-exp, mimo-v25-pro and claude-opus-4.8 — a spare-time project. Feel free to use it, file issues, send PRs, or star it!

![Screenshot](./images/wavedrom-gui.png)

## Product 1: WaveDrom web editor

A single-file HTML app (~300 KB): click and drag to edit WaveDrom timing diagrams, with the official engine rendering live on the right and WaveJSON generated in sync. Open `index.html` directly in a browser (works over `file://`, no server needed), or use the [demo site](https://wave.rtlyes.cn/) (free hosting, availability not guaranteed).

Highlights:

- **Point-and-click + brushes**: 20 waveform states, paint by dragging, drag right to hold, right-click to erase; the brush bar folds through five layouts and supports direct keyboard shortcuts
- **Official engine, live preview**: ships WaveDrom v3.5.0 with the default/narrow skins — what you see is what you get
- **Groups, nodes and arrows**: nested groups with synchronized collapse, every official arrow notation, full period/phase/hscale/hbounds support
- **Import/export loop**: exported SVG/PNG embed WaveJSON metadata (re-import the image to restore the diagram; interoperable with the Skill), lenient WaveJSON parsing (`//` comments, unquoted keys, matching the official editor), JSON / kroki snippet / share link
- **Deeply configurable**: light/dark themes, draggable split layout, independent UI and code fonts, 100-step undo/redo, all preferences persisted
- **Bilingual UI**: follows your system language by default (Chinese or English), switchable from the globe button in the top bar

👉 Detailed feature guide: [EDITOR.en.md](./EDITOR.en.md).

## Product 2: wavedrom-render Skill

A command-line tool that renders WaveJSON (AI-generated or hand-written) into timing diagrams as SVG / PNG, designed for AI agents and scripts: **no browser, no index.html** — just Node.js (PNG output needs any rasterizer).

- **Modern mode** (default): the same self-drawn style as the web editor — light theme, colored per-signal traces, node arrows, full period/phase/hscale/hbounds support; the geometry is ported line by line from `index.html`
- **Traditional mode**: drives the official WaveDrom v3.5.0 engine directly, producing the official black-and-white style with the default / narrow skins
- **Embeddable fonts**: optionally downloads LXGW WenKai, subsets it per character and embeds it in the SVG via `@font-face` — self-contained, only a few hundred KB
- **Interoperates with the web editor**: exported SVG/PNG embed WaveJSON metadata (without affecting display); open them in wavedrom-gui to restore and keep editing; `--no-meta` turns this off
- **Built-in generation guide**: SKILL.md includes a "WaveJSON generation guide" (hold rules, no data-frame characters on single-bit lanes, basic syntax cheat sheet) so an AI can produce well-formed code

```bash
cd SKILL/wavedrom-render
node render.js wave.json                                            # modern mode PNG
node render.js wave.json --mode traditional --skin narrow --format svg   # traditional mode SVG
```

👉 Full usage and the "WaveJSON generation guide": [SKILL/wavedrom-render/SKILL.md](./SKILL/wavedrom-render/SKILL.md) (Chinese).

## Product 3: VS Code extension (in development)

> ⚠️ Early stage, not usable yet — PRs welcome.

Brings wavedrom-gui into VS Code: render ```` ```wavedrom ```` code blocks and images with embedded WaveJSON (modern theme) right inside the built-in Markdown preview, jump into the visual editor with one click, and write the result back to the source file.

- **Preview rendering**: turns wavedrom code blocks and SVG/PNG images with embedded WaveJSON into waveform diagrams in the Markdown preview, with a pencil button at the top-right corner to edit (the `wavedrom-gui.previewEditAffordance` setting switches it to "click the diagram to edit")
- **Visual editing, written back**: the pencil button reuses the `index.html` editor; on save the fence content is written back for code blocks, while images keep their pixels and only have the embedded WaveJSON metadata updated
- **Interoperable with the other two**: same WaveJSON metadata spec, so images exported by the Skill/editor are recognized and editable here

👉 See [vscode/README.md](./vscode/README.md) (Chinese).

## Technical notes

- Embeds the official [WaveDrom](https://wavedrom.com/) v3.5.0 renderer with the default/narrow skins (sourced from wavedrom.com)
- The editor's mini waveforms are self-drawn SVG; the generation logic follows the official sources (`gen-wave-brick.js` etc.): paired state transitions, half-cycle transition marks, level-clock half-brick fusion (xclude table), `.`/`|` repeaters, period/phase/hscale scaling — all per official semantics
- Exported images embed WaveJSON metadata: SVG `<metadata>` / PNG `iTXt` text chunk (pure JS, zero dependencies, hand-written CRC32); import sniffs the file header and reads it back automatically, without affecting how the image displays
- Fonts: LXGW WenKai Mono is loaded on demand in slices from the npmmirror CDN (fast in mainland China), with automatic fallback to system fonts offline; exported SVG/PNG are unaffected by UI font and theme

## Credits

- [WaveDrom](https://wavedrom.com/) — the official rendering engine, skins and examples
- [LXGW WenKai](https://github.com/lxgw/LxgwWenKai) — default UI and code font
- [npmmirror](https://npmmirror.com/) — font CDN slices
- The entire codebase was written in collaboration with AI: GLM-5.3-flash, Qwen3.8-max, deepseek-v4-flash-exp, mimo-v25-pro, claude-opus-4.8

## Contact & support

Follow me on Xiaohongshu (RED):
![Xiaohongshu](./images/xhs.png)

If you find it useful, a WeChat tip is welcome — but the tool is free and open source either way. Enjoy!

![WeChat tip](./images/wxzsm.png)
