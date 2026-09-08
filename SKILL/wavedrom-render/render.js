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
 *   --no-meta                     skip embedding WaveJSON metadata into SVG/PNG
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
const { svgWithMeta, pngInsertITXt, WD_PNG_KEYWORD } = require('./lib/meta-embed.js');

function parseArgs(argv) {
  const o = { mode: 'modern', format: 'png', scale: 2, nodePos: 'lm', nodeScale: 1, nodeInset: 4, nodeMode: 'bare', noMeta: false };
  const pos = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { o.help = true; }
    else if (a === '--mode') o.mode = argv[++i];
    else if (a === '--format') o.format = argv[++i];
    else if (a === '--out' || a === '-o') o.out = argv[++i];
    else if (a === '--scale') o.scale = parseFloat(argv[++i]);
    else if (a === '--skin') o.skin = argv[++i];
    else if (a === '--node-pos') o.nodePos = argv[++i];
    else if (a === '--node-scale') o.nodeScale = parseFloat(argv[++i]);
    else if (a === '--node-inset') o.nodeInset = parseInt(argv[++i], 10);
    else if (a === '--node-mode') o.nodeMode = argv[++i];
    else if (a === '--no-meta') o.noMeta = true;
    else pos.push(a);
  }
  o.input = pos[0];
  return o;
}

const HELP = `WaveDrom render — WaveJSON -> waveform image

Usage:
  node render.js <input.json> [--mode modern|traditional] [--format svg|png|both]
                 [--out PATH] [--scale N] [--skin default|narrow]
                 [--node-pos lm|c|...] [--node-scale N] [--node-inset 0-9]
                 [--node-mode letter|bare|dot] [--no-meta]
  node render.js -   (read WaveJSON from stdin)

Modes:
  modern       (default) self-drawn look identical to the editor grid, light theme
  traditional  official WaveDrom v3.5.0 engine (supports --skin default|narrow)

Formats:
  png (default) | svg | both
`;

/* Loose WaveJSON parse: try strict JSON first, then evaluate as a JS object
 * literal in a sandbox-ish Function (matches the app's eva() leniency). */
function parseWaveJSON(text) {
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  try {
    // eslint-disable-next-line no-new-func
    return Function('"use strict";return (' + text + ')')();
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
  const source = parseWaveJSON(text);
  const jsonText = JSON.stringify(source, null, 2);

  if (!['modern', 'traditional'].includes(o.mode)) { console.error('unknown --mode: ' + o.mode); process.exit(1); }
  if (!['svg', 'png', 'both'].includes(o.format)) { console.error('unknown --format: ' + o.format); process.exit(1); }

  const res = o.mode === 'traditional'
    ? renderTraditional(source, { skin: o.skin })
    : renderModern(source, { nodePos: o.nodePos, nodeScale: o.nodeScale, nodeInset: o.nodeInset, nodeMode: o.nodeMode });

  // Resolve output base name. Default (no --out): same convention as the app —
  // wavdrom_gui_<title> if the chart has a head title, else
  // wavdrom_gui_<YYMMDD>_<N> where N continues the day's numbering in the CWD.
  let base;
  if (o.out) {
    base = o.out.replace(/\.(svg|png)$/i, '');
  } else {
    const title = String((source && source.head && source.head.text) || '').trim()
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

  const wrote = [];
  if (o.format === 'svg' || o.format === 'both') {
    const p = base + '.svg';
    fs.writeFileSync(p, o.noMeta ? res.svg : svgWithMeta(res.svg, jsonText));
    wrote.push(p);
  }
  if (o.format === 'png' || o.format === 'both') {
    const p = base + '.png';
    const conv = svgToPng(res.svg, p, { scale: o.scale });
    if (!o.noMeta) {
      const png = pngInsertITXt(fs.readFileSync(p), WD_PNG_KEYWORD, jsonText);
      fs.writeFileSync(p, png);
    }
    wrote.push(p + `  (${conv.tool}, ${o.scale}x)`);
  }

  const dim = res.width && res.height ? ` ${res.width}x${res.height}` : '';
  console.log(`Rendered [${o.mode}${o.mode === 'traditional' ? '/' + (res.skin || 'default') : ''}]${dim}:`);
  wrote.forEach(w => console.log('  ' + w));
}

try { main(); }
catch (e) { console.error('Error: ' + e.message); process.exit(1); }
