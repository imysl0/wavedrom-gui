'use strict';
/*
 * WaveJSON metadata embedding/extraction — same format as wavedrom-gui's own
 * exports, so images round-trip between this CLI and the app's image import:
 *   SVG  — <metadata data-wavedrom="1">BASE64(JSON)</metadata> right after the
 *          opening <svg> tag (ignored by every renderer).
 *   PNG  — an uncompressed iTXt chunk with keyword "WaveJSON" inserted before
 *          IEND (ignored by every viewer).
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WD_PNG_KEYWORD = 'WaveJSON';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function svgWithMeta(svgStr, json, kind) {
  try {
    const i = svgStr.indexOf('<svg');
    if (i < 0) return svgStr;
    let j = i + 4, q = null;
    while (j < svgStr.length) { /* find the tag's real '>' (skip quoted attribute values) */
      const ch = svgStr[j];
      if (q) { if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') break;
      j++;
    }
    /* kind：导出来源（'skill-modern' | 'wavedrom'），写进 data-export 供 VS Code 插件
       写回重绘时识别；不带 kind 时维持旧格式（与 wavedrom-gui 旧版互通） */
    const mark = (kind && ['editor', 'wavedrom', 'skill-modern'].includes(kind)) ? ` data-export="${kind}"` : '';
    const meta = `<metadata data-wavedrom="1"${mark}>` + Buffer.from(json, 'utf8').toString('base64') + '</metadata>';
    return svgStr.slice(0, j + 1) + meta + svgStr.slice(j + 1);
  } catch (e) { return svgStr; }
}

function svgExtractWaveJSON(text) {
  const m = /<metadata[^>]*data-wavedrom[^>]*>([\s\S]*?)<\/metadata>/.exec(text);
  if (!m) return null;
  try { return Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'); }
  catch (e) { return null; }
}

/* Insert an uncompressed iTXt chunk right before IEND. Layout:
 * keyword \0 compressionFlag(0) compressionMethod(0) languageTag\0 translatedKeyword\0 text */
function pngInsertITXt(buf, keyword, text) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');
  const kw = Buffer.from(keyword, 'latin1');
  const tx = Buffer.from(text, 'utf8');
  const data = Buffer.concat([kw, Buffer.alloc(5, 0), tx]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('iTXt', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  let off = 8, insertAt = -1;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (buf.toString('latin1', off + 4, off + 8) === 'IEND') { insertAt = off; break; }
    off += 12 + len;
  }
  if (insertAt < 0) throw new Error('malformed PNG (no IEND chunk)');
  return Buffer.concat([buf.subarray(0, insertAt), chunk, buf.subarray(insertAt)]);
}

function pngExtractWaveJSON(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'IEND') break;
    if ((type === 'iTXt' || type === 'tEXt') && len > 0) {
      const body = buf.subarray(off + 8, off + 8 + len);
      const z = body.indexOf(0);
      if (z >= 0 && body.toString('latin1', 0, z) === WD_PNG_KEYWORD) {
        try {
          if (type === 'tEXt') return body.toString('utf8', z + 1);
          if (body[z + 1] !== 0) return null; /* this tool only writes uncompressed */
          let p = z + 3;
          while (p < body.length && body[p] !== 0) p++; p++; /* language tag */
          while (p < body.length && body[p] !== 0) p++; p++; /* translated keyword */
          return body.toString('utf8', p);
        } catch (e) { return null; }
      }
    }
    off += 12 + len;
  }
  return null;
}

const WD_EXPORT_KEYWORD = 'WaveDromGui';

module.exports = { svgWithMeta, svgExtractWaveJSON, pngInsertITXt, pngExtractWaveJSON, WD_PNG_KEYWORD, WD_EXPORT_KEYWORD };
