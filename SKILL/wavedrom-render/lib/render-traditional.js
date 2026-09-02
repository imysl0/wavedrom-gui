'use strict';
/*
 * Traditional-mode renderer.
 *
 * Renders WaveJSON with the official WaveDrom v3.5.0 engine (the same library
 * embedded in index.html), producing a self-contained SVG string — no browser
 * and no DOM required.
 *
 * How it works: the browserify bundle's entry module was patched (see
 * vendor/wavedrom.bundle.js) to expose two internal functions on window.WaveDrom:
 *   - renderAny(index, source, waveSkin)  -> a JsonML tree (nested arrays)
 *   - stringify(jsonmlTree)               -> an SVG string
 * The bundle only touches `window` at load time, so a tiny global shim is enough.
 * The produced SVG already embeds the skin <defs>, so it is fully standalone.
 */

let _WaveDrom = null;

function loadEngine() {
  if (_WaveDrom) return _WaveDrom;

  // Minimal shim: the bundle references window/self/navigator/document only at
  // load time (module 34 assigns window.WaveDrom = ...). renderAny + stringify
  // never touch the DOM, so a stub document is enough to satisfy module load.
  const g = globalThis;
  if (!g.window) g.window = g;
  if (!g.self) g.self = g;
  if (!g.navigator) g.navigator = { userAgent: 'node' };
  if (!g.document) {
    g.document = {
      getElementById() { throw new Error('traditional renderer: DOM getElementById is not available in Node'); },
      createElement() { return {}; },
    };
  }

  // WaveSkin must be on window before the engine module loads.
  g.window.WaveSkin = require('../vendor/waveskin.js');

  // Loading the bundle assigns window.WaveDrom (and returns it via module.exports).
  const WaveDrom = require('../vendor/wavedrom.bundle.js') || g.window.WaveDrom;
  if (!WaveDrom || typeof WaveDrom.renderAny !== 'function' || typeof WaveDrom.stringify !== 'function') {
    throw new Error('traditional renderer: WaveDrom engine failed to expose renderAny/stringify');
  }
  _WaveDrom = WaveDrom;
  return WaveDrom;
}

/**
 * @param {object} source  parsed WaveJSON object
 * @param {object} [opts]
 * @param {'default'|'narrow'} [opts.skin]  overrides source.config.skin
 * @returns {{ svg: string, width: number, height: number, engineVersion: string }}
 */
function renderTraditional(source, opts = {}) {
  const WaveDrom = loadEngine();
  const skins = require('../vendor/waveskin.js');

  // Deep clone: renderAny mutates its source argument.
  const src = JSON.parse(JSON.stringify(source || {}));

  // Resolve skin. WaveDrom reads the skin name from source.config.skin and
  // looks it up inside the skin CONTAINER object ({default, narrow}), so we
  // pass the whole container and set config.skin rather than a specific array.
  let skinName = opts.skin || (src.config && src.config.skin) || 'default';
  if (!skins[skinName]) skinName = 'default';
  if (skinName !== 'default') {
    src.config = Object.assign({}, src.config, { skin: skinName });
  }

  const tree = WaveDrom.renderAny(0, src, skins);
  let svg = WaveDrom.stringify(tree);

  // Pull width/height off the root <svg> for downstream PNG sizing.
  const wm = /\bwidth="(\d+(?:\.\d+)?)"/.exec(svg);
  const hm = /\bheight="(\d+(?:\.\d+)?)"/.exec(svg);
  const width = wm ? Math.round(parseFloat(wm[1])) : 0;
  const height = hm ? Math.round(parseFloat(hm[1])) : 0;

  // Ensure a standalone, declared SVG document.
  if (!/^<\?xml/.test(svg)) {
    svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg;
  }

  return { svg, width, height, engineVersion: WaveDrom.version || '3.5.0', skin: skinName };
}

module.exports = { renderTraditional };
