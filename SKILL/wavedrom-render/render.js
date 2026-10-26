#!/usr/bin/env node
'use strict';
/*
 * WaveDrom render CLI — turn WaveJSON into a waveform image.
 *
 *   node render.js <input.json> [options]
 *   node render.js -            (read WaveJSON from stdin)
 *
 * Options:
 *   --mode <modern|traditional>   default: modern
 *   --format <svg|png|both>       default: png
 *   --out <path>                  output path (extension inferred if omitted)
 *   --scale <n>                   PNG scale factor (default 2)
 *   --skin <default|narrow>       traditional mode only (default: from config/default)
 *   --node-pos <lt|tm|rt|lm|c|rm|lb|bm|rb>   modern node marker position (default lm)
 *   --node-scale <n>              modern node marker scale (default 1)
 *   --node-inset <0-9>            modern edge-anchored node inset in px (default 4)
 *   --node-mode <letter|bare|dot> modern node marker style (default bare)
 *   --bus-join <split|joined>     bus data boxes: separate rounded boxes (default)
 *                                 or official-style chamfered runs joined at the beat
 *   --auto-scale <on|off>         auto horizontal scale so wide bus labels fit
 *                                 (default: on)
 *   --auto-scale-max <n>          upper bound for auto scale (1-8, default 2);
 *                                 labels that still do not fit are elided
 *                                 ("AAAA…Z") instead of being squeezed
 *   --no-meta                     skip embedding WaveJSON metadata into SVG/PNG
 *   --strict                      strict JSON only (disable the lenient Function()
 *                                 fallback — use when rendering untrusted input)
 *   -h, --help
 *
 * SVG/PNG outputs embed the source WaveJSON by default (SVG <metadata> / PNG
 * iTXt chunk — same format as wavedrom-gui, invisible), so the image can be
 * re-imported by the app's "open file" dialog.
 *
 * WaveJSON input may be strict JSON or loose (JS-style: unquoted keys, trailing
 * commas, single quotes) — the same leniency the app's editor accepts.
 */
const fs = require('fs');
const path = require('path');
const { renderModern } = require('./lib/render-modern.js');
const { renderTraditional } = require('./lib/render-traditional.js');
const { svgToPng } = require('./lib/svg-to-png.js');
const { svgWithMeta, pngInsertITXt, WD_PNG_KEYWORD, WD_EXPORT_KEYWORD } = require('./lib/meta-embed.js');

function parseArgs(argv) {
  const o = { mode: 'modern', format: 'png', scale: 2, nodePos: 'lm', nodeScale: 1, nodeInset: 4, nodeMode: 'bare', noMeta: false, strict: false, autoScale: true, autoScaleMax: 2 };
  const pos = [];
  /* 取值型 flag 一律显式取值且拒绝以 -- 开头的「值」：`--out --no-meta` 这类连写以前会把
     flag 当成文件名、产出 '--no-meta.png' 且 noMeta 静默失效。未知 flag 以前会落进位置
     参数池被静默吞掉（`--formatt` 拼错 → 仍按默认 png 出图无任何提示），现在直接报错 */
  let i = 2;
  const takeVal = flag => {
    const v = argv[i + 1];
    if (v === undefined || /^--/.test(v)) { console.error('missing value for ' + flag); process.exit(1); }
    i++;
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { o.help = true; }
    else if (a === '--strict') o.strict = true; // 只接受严格 JSON：渲染不可信输入时禁用宽松求值回退
    else if (a === '--no-meta') o.noMeta = true;
    else if (a === '--no-auto-scale') o.autoScale = false;
    else if (a === '--mode') o.mode = takeVal(a);
    else if (a === '--format') o.format = takeVal(a);
    else if (a === '--out' || a === '-o') o.out = takeVal(a);
    else if (a === '--scale') o.scale = parseFloat(takeVal(a));
    else if (a === '--skin') o.skin = takeVal(a);
    else if (a === '--node-pos') o.nodePos = takeVal(a);
    else if (a === '--node-scale') o.nodeScale = parseFloat(takeVal(a));
    else if (a === '--node-inset') o.nodeInset = parseInt(takeVal(a), 10);
    else if (a === '--node-mode') o.nodeMode = takeVal(a);
    else if (a === '--bus-join') o.busJoin = takeVal(a);
    else if (a === '--auto-scale') o.autoScale = takeVal(a) !== 'off';
    else if (a === '--auto-scale-max') o.autoScaleMax = parseInt(takeVal(a), 10);
    else if (a === '-') pos.push(a);          // stdin 标记
    else if (/^-/.test(a)) { console.error('unknown option: ' + a + ' (see --help)'); process.exit(1); }
    else pos.push(a);
  }
  if (pos.length > 1) { console.error('unexpected extra argument: ' + pos[1]); process.exit(1); }
  if (!Number.isFinite(o.scale) || o.scale <= 0) { console.error('--scale must be a positive number'); process.exit(1); }
  if (!Number.isFinite(o.autoScaleMax) || o.autoScaleMax < 1) { console.error('--auto-scale-max must be a number >= 1'); process.exit(1); }
  if (o.skin && !['default', 'narrow'].includes(o.skin)) { console.error('unknown --skin: ' + o.skin); process.exit(1); }
  o.input = pos[0];
  return o;
}

const HELP = `WaveDrom render — WaveJSON -> waveform image

Usage:
  node render.js <input.json> [--mode modern|traditional] [--format svg|png|both]
                 [--out PATH] [--scale N] [--skin default|narrow]
                 [--node-pos lm|c|...] [--node-scale N] [--node-inset 0-9]
                 [--node-mode letter|bare|dot] [--auto-scale on|off]
                 [--auto-scale-max N] [--bus-join split|joined] [--no-meta] [--strict]
  node render.js -   (read WaveJSON from stdin)

Modes:
  modern       (default) self-drawn look identical to the editor grid, light theme
  traditional  official WaveDrom v3.5.0 engine (supports --skin default|narrow)

Formats:
  png (default) | svg | both

Auto scale (modern mode, on by default):
  The horizontal scale grows automatically so the widest bus label fits, stopping
  at --auto-scale-max (default 2). It never shrinks a hscale that the WaveJSON
  sets explicitly. Labels that still do not fit inside their cell are elided
  (start…last character) instead of being squeezed.

Bus join (modern mode only):
  "split" (default) draws every value as its own rounded box, with a hairline gap
  between neighbours; "joined" chamfers the two ends so they meet in an X on the
  beat boundary, the way official WaveDrom draws it. A busJoin key inside the
  WaveJSON config overrides --bus-join either way. Traditional mode is the
  official engine, which always draws the joined look.
`;

/* Loose WaveJSON parse: try strict JSON first, then evaluate as a JS object
 * literal via Function (matches the app's eva() leniency). Function evaluation
 * is NOT a sandbox: the input text can execute arbitrary code in this process.
 * Only feed trusted input to the lenient path, or pass --strict to disable it
 * when rendering untrusted files. */
function parseWaveJSON(text, strict) {
  if (strict) {
    try { return JSON.parse(text); }
    catch (e) { throw new Error('Could not parse WaveJSON input (strict mode): ' + e.message); }
  }
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  try {
    // eslint-disable-next-line no-new-func
    /* 首尾加换行：末行 // 注释否则会吞掉收尾的右括号（与编辑器的 eva 同一防坑） */
    return Function('"use strict";return (\n' + text + '\n)')();
  } catch (e) {
    throw new Error('Could not parse WaveJSON input: ' + e.message);
  }
}

function main() {
  const o = parseArgs(process.argv);
  if (o.help || !o.input) { process.stdout.write(HELP); process.exit(o.help ? 0 : 1); }

  let text;
  if (o.input === '-') text = fs.readFileSync(0, 'utf8');
  else text = fs.readFileSync(o.input, 'utf8');
  const source = parseWaveJSON(text, o.strict);
  const jsonText = JSON.stringify(source, null, 2);

  if (!['modern', 'traditional'].includes(o.mode)) { console.error('unknown --mode: ' + o.mode); process.exit(1); }
  if (!['svg', 'png', 'both'].includes(o.format)) { console.error('unknown --format: ' + o.format); process.exit(1); }

  const res = o.mode === 'traditional'
    ? renderTraditional(source, { skin: o.skin })
    : renderModern(source, { nodePos: o.nodePos, nodeScale: o.nodeScale, nodeInset: o.nodeInset, nodeMode: o.nodeMode, autoScale: o.autoScale, autoScaleMax: o.autoScaleMax, busJoin: o.busJoin });

  // Resolve output base name. Default (no --out): same convention as the app —
  // wavdrom_gui_<title> if the chart has a head title, else
  // wavdrom_gui_<YYMMDD>_<N> where N continues the day's numbering in the CWD.
  let base;
  if (o.out) {
    base = o.out.replace(/\.(svg|png)$/i, '');
  } else {
    const rawTitle = source && source.head && source.head.text;
    const title = (typeof rawTitle === 'string' ? rawTitle : '').trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ').slice(0, 40).trim().replace(/[. ]+$/, '');
    const d = new Date();
    const date = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    if (title) {
      base = 'wavdrom_gui_' + title;
    } else {
      let n = 0;
      try {
        for (const f of fs.readdirSync(process.cwd())) {
          const m = /^wavdrom_gui_(\d{6})_(\d+)\./.exec(f);
          if (m && m[1] === date) n = Math.max(n, +m[2]);
        }
      } catch (e) { /* unreadable dir -> start at 1 */ }
      base = 'wavdrom_gui_' + date + '_' + (n + 1);
    }
    if (o.input && o.input !== '-') base = path.join(path.dirname(path.resolve(o.input)), base);
  }

  /* 先在内存里备齐全部产物再落盘：--format both 时 PNG 失败不会留下只有 SVG 的残缺输出。
     写入走临时文件 + rename（原子替换），写一半崩溃不会截断既有文件 */
  /* 来源标记：VS Code 插件写回重绘时按同一种风格渲染（traditional 就是官方引擎，归 wavedrom） */
  const exportKind = o.mode === 'modern' ? 'skill-modern' : 'wavedrom';
  const staging = [];
  if (o.format === 'svg' || o.format === 'both') {
    staging.push({ p: base + '.svg', data: Buffer.from(o.noMeta ? res.svg : svgWithMeta(res.svg, jsonText, exportKind), 'utf8') });
  }
  let conv = null;
  if (o.format === 'png' || o.format === 'both') {
    const tmpPng = base + '.png.wdtmp';
    try {
      conv = svgToPng(res.svg, tmpPng, { scale: o.scale });
      let png = fs.readFileSync(tmpPng);
      if (!o.noMeta) {
        png = pngInsertITXt(png, WD_PNG_KEYWORD, jsonText);
        png = pngInsertITXt(png, WD_EXPORT_KEYWORD, 'export=' + exportKind);
      }
      staging.push({ p: base + '.png', data: png });
    } finally {
      try { fs.unlinkSync(tmpPng); } catch (e) { /* 已 rename 时本就不存在 */ }
    }
  }
  const wrote = [];
  for (const it of staging) {
    const tmp = it.p + '.part-' + process.pid;
    fs.writeFileSync(tmp, it.data);
    fs.renameSync(tmp, it.p);
    wrote.push(it.p + (conv && it.p.endsWith('.png') ? `  (${conv.tool}, ${o.scale}x)` : ''));
  }

  const dim = res.width && res.height ? ` ${res.width}x${res.height}` : '';
  console.log(`Rendered [${o.mode}${o.mode === 'traditional' ? '/' + (res.skin || 'default') : ''}]${dim}:`);
  wrote.forEach(w => console.log('  ' + w));
}

try { main(); }
catch (e) { console.error('Error: ' + e.message); process.exit(1); }
