'use strict';
/*
 * Font embedding for the modern renderer.
 *
 * Builds an SVG <style> block with @font-face rules whose src is a base64
 * data: URI of the LXGW WenKai TTFs downloaded by setup.js. This makes the SVG
 * self-contained: any viewer / rasterizer renders LXGW WenKai without the font
 * being installed.
 *
 * IMPORTANT — embedding is ALWAYS subsetted to the glyphs actually used, so the
 * SVG stays small (~hundreds of KB, not tens of MB). Subsetting needs Python
 * fontTools (optional: `pip install fonttools`). Therefore:
 *
 *   fonts.config enabled=false / embed=false  -> no embed (return '')
 *   fontTools NOT installed                   -> no embed (return '')  [silent]
 *   a font TTF not downloaded (setup not run)  -> that font skipped
 *   subsetting a font fails                    -> that font skipped     [silent]
 *
 * When nothing is embedded, rendering falls back to plain font-family names
 * (+ system CJK fonts) and, for PNG, cairosvg still uses any local TTF it finds.
 * We never embed a full (non-subset) TTF — that would produce a ~65MB SVG.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'fonts.config.json'), 'utf8')); }
  catch (e) { return null; }
}

function pythonWithFontTools() {
  for (const c of ['python', 'python3']) {
    const r = spawnSync(c, ['-c', 'import fontTools'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

const b64 = buf => Buffer.from(buf).toString('base64');

/**
 * @param {string} usedChars  concatenation of all text drawn in the SVG (for subsetting)
 * @returns {string} an SVG <style> string with @font-face rules, or '' if nothing embedded
 */
function buildFontStyle(usedChars) {
  const cfg = loadConfig();
  if (!cfg || cfg.enabled === false || cfg.embed === false) return '';

  // Embedding requires subsetting, which requires fontTools. No fontTools => no embed.
  const py = pythonWithFontTools();
  if (!py) return '';

  const dir = path.isAbsolute(cfg.dir) ? cfg.dir : path.join(ROOT, cfg.dir || 'vendor/fonts');
  const fonts = Array.isArray(cfg.fonts) ? cfg.fonts : [];

  const charsFile = path.join(os.tmpdir(), `wdr_chars_${process.pid}_${Date.now()}.txt`);
  fs.writeFileSync(charsFile, usedChars || '', 'utf8');

  const faces = [];
  try {
    for (const f of fonts) {
      const ttf = path.join(dir, f.file);
      if (!fs.existsSync(ttf) || fs.statSync(ttf).size < 10000) continue; // not downloaded

      const outTtf = path.join(os.tmpdir(), `wdr_sub_${process.pid}_${Date.now()}_${f.file}`);
      const r = spawnSync(py, [path.join(ROOT, 'scripts', 'subset_font.py'), ttf, outTtf, charsFile], { encoding: 'utf8' });
      if (r.status === 0 && fs.existsSync(outTtf)) {
        const data = fs.readFileSync(outTtf);
        try { fs.unlinkSync(outTtf); } catch (e) {}
        faces.push(
          `@font-face{font-family:"${f.family}";font-style:normal;font-weight:400;` +
          `src:url(data:font/ttf;base64,${b64(data)}) format("truetype");}`
        );
      }
      // subset failed for this font -> skip it silently
    }
  } finally {
    try { fs.unlinkSync(charsFile); } catch (e) {}
  }

  if (!faces.length) return '';
  return `<style type="text/css">${faces.join('')}</style>`;
}

module.exports = { buildFontStyle };
