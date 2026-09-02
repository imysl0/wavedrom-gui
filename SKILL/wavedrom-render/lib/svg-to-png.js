'use strict';
/*
 * SVG -> PNG conversion.
 *
 * Rasterizes an SVG string to PNG bytes without a browser. Strategy, in order:
 *   1) Python + cairosvg  (via scripts/svg2png.py)   -- primary, cross-platform
 *   2) rsvg-convert                                   -- if present on PATH
 *   3) ImageMagick (magick / convert)                 -- last resort
 *
 * `scale` multiplies the intrinsic SVG pixel size (e.g. 2 = 2x for crisp PNG).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function which(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { encoding: 'utf8' })
    : spawnSync('which', [cmd], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim().split(/\r?\n/)[0] : null;
}

function pythonCmd() {
  for (const c of ['python', 'python3']) {
    const r = spawnSync(c, ['-c', 'import cairosvg'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

/**
 * @param {string} svg     SVG document string
 * @param {string} outPng  destination .png path
 * @param {object} [opts]
 * @param {number} [opts.scale=2]
 * @param {number} [opts.width]   explicit output width in px (overrides scale)
 * @param {number} [opts.height]
 * @returns {{ tool: string }}
 */
function svgToPng(svg, outPng, opts = {}) {
  const scale = opts.scale || 2;
  const tmp = path.join(os.tmpdir(), `wdr_${process.pid}_${Date.now()}.svg`);
  fs.writeFileSync(tmp, svg);
  try {
    // 1) cairosvg
    const py = pythonCmd();
    if (py) {
      const helper = path.join(__dirname, '..', 'scripts', 'svg2png.py');
      const args = [helper, tmp, outPng, String(scale)];
      if (opts.width) args.push('--width', String(opts.width));
      if (opts.height) args.push('--height', String(opts.height));
      const r = spawnSync(py, args, { encoding: 'utf8' });
      if (r.status === 0 && fs.existsSync(outPng)) return { tool: 'cairosvg' };
      // fall through with captured error for diagnostics
      var pyErr = (r.stderr || r.stdout || '').trim();
    }
    // 2) rsvg-convert
    if (which('rsvg-convert')) {
      const args = ['-f', 'png', '-o', outPng];
      if (opts.width) { args.push('-w', String(opts.width)); if (opts.height) args.push('-h', String(opts.height)); }
      else { args.push('-z', String(scale)); }
      args.push(tmp);
      const r = spawnSync('rsvg-convert', args, { encoding: 'utf8' });
      if (r.status === 0 && fs.existsSync(outPng)) return { tool: 'rsvg-convert' };
    }
    // 3) ImageMagick
    const im = which('magick') ? 'magick' : (which('convert') ? 'convert' : null);
    if (im) {
      const density = Math.round(96 * scale);
      const args = im === 'magick' ? ['-density', String(density), tmp, outPng] : ['-density', String(density), tmp, outPng];
      const r = spawnSync(im, args, { encoding: 'utf8' });
      if (r.status === 0 && fs.existsSync(outPng)) return { tool: im };
    }
    throw new Error(
      'No SVG->PNG rasterizer available. Install one of:\n' +
      '  - Python cairosvg:  pip install cairosvg   (recommended)\n' +
      '  - rsvg-convert (librsvg)\n' +
      '  - ImageMagick (magick / convert)\n' +
      (typeof pyErr === 'string' && pyErr ? '\ncairosvg attempt said:\n' + pyErr : '')
    );
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

module.exports = { svgToPng };
