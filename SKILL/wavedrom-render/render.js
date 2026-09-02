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
 *   -h, --help
 *
 * WaveJSON input may be strict JSON or loose (JS-style: unquoted keys, trailing
 * commas, single quotes) — the same leniency the app's editor accepts.
 */
const fs = require('fs');
const path = require('path');
const { renderModern } = require('./lib/render-modern.js');
const { renderTraditional } = require('./lib/render-traditional.js');
const { svgToPng } = require('./lib/svg-to-png.js');

function parseArgs(argv) {
  const o = { mode: 'modern', format: 'png', scale: 2, nodePos: 'lm', nodeScale: 1 };
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
    else pos.push(a);
  }
  o.input = pos[0];
  return o;
}

const HELP = `WaveDrom render — WaveJSON -> waveform image

Usage:
  node render.js <input.json> [--mode modern|traditional] [--format svg|png|both]
                 [--out PATH] [--scale N] [--skin default|narrow]
                 [--node-pos lm|c|...] [--node-scale N]
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

  if (!['modern', 'traditional'].includes(o.mode)) { console.error('unknown --mode: ' + o.mode); process.exit(1); }
  if (!['svg', 'png', 'both'].includes(o.format)) { console.error('unknown --format: ' + o.format); process.exit(1); }

  const res = o.mode === 'traditional'
    ? renderTraditional(source, { skin: o.skin })
    : renderModern(source, { nodePos: o.nodePos, nodeScale: o.nodeScale });

  // Resolve output base name.
  let base;
  if (o.out) base = o.out.replace(/\.(svg|png)$/i, '');
  else if (o.input && o.input !== '-') base = o.input.replace(/\.[^.]+$/, '') + '.' + o.mode;
  else base = path.join(process.cwd(), 'wavedrom.' + o.mode);

  const wrote = [];
  if (o.format === 'svg' || o.format === 'both') {
    const p = base + '.svg';
    fs.writeFileSync(p, res.svg);
    wrote.push(p);
  }
  if (o.format === 'png' || o.format === 'both') {
    const p = base + '.png';
    const conv = svgToPng(res.svg, p, { scale: o.scale });
    wrote.push(p + `  (${conv.tool}, ${o.scale}x)`);
  }

  const dim = res.width && res.height ? ` ${res.width}x${res.height}` : '';
  console.log(`Rendered [${o.mode}${o.mode === 'traditional' ? '/' + (res.skin || 'default') : ''}]${dim}:`);
  wrote.forEach(w => console.log('  ' + w));
}

try { main(); }
catch (e) { console.error('Error: ' + e.message); process.exit(1); }
