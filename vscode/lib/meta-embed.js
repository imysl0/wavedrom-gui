'use strict';
/*
 * WaveJSON metadata embedding/extraction (Node, Buffer-based).
 * Same format as wavedrom-gui / wavedrom-render skill exports:
 *   SVG  — <metadata data-wavedrom="1">BASE64(JSON)</metadata>
 *   PNG  — uncompressed iTXt chunk, keyword "WaveJSON", before IEND
 * This copy additionally supports REPLACING existing metadata (used when
 * saving edits back into an image whose pixels must stay untouched).
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

const META_RE = /<metadata[^>]*data-wavedrom[^>]*>([\s\S]*?)<\/metadata>/;

function svgWithMeta(svgStr, json, kind) {
  try {
    /* kind：导出来源（'wavedrom'|'editor'|'skill-modern'），写进 data-export 供下次打开时识别 */
    const mark = (kind && ['editor', 'wavedrom', 'skill-modern'].includes(kind)) ? ` data-export="${kind}"` : '';
    const meta = `<metadata data-wavedrom="1"${mark}>` + Buffer.from(json, 'utf8').toString('base64') + '</metadata>';
    if (META_RE.test(svgStr)) return svgStr.replace(META_RE, meta); // 替换已有，避免重复
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
    return svgStr.slice(0, j + 1) + meta + svgStr.slice(j + 1);
  } catch (e) { return svgStr; }
}

function svgExtractWaveJSON(text) {
  const m = META_RE.exec(text);
  if (!m) return null;
  try { return Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'); }
  catch (e) { return null; }
}

/* 构造未压缩 iTXt 块。布局：关键字 \0 压缩标志0 压缩方法0 语言\0 翻译关键字\0 文本 */
function makeITXtChunk(keyword, text) {
  const kw = Buffer.from(keyword, 'latin1');
  const tx = Buffer.from(text, 'utf8');
  const data = Buffer.concat([kw, Buffer.alloc(5, 0), tx]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('iTXt', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/* Insert an uncompressed iTXt chunk right before IEND. Layout:
 * keyword \0 compressionFlag(0) compressionMethod(0) languageTag\0 translatedKeyword\0 text */
function pngInsertITXt(buf, keyword, text) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');
  const chunk = makeITXtChunk(keyword, text);
  let off = 8, insertAt = -1;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (buf.toString('latin1', off + 4, off + 8) === 'IEND') { insertAt = off; break; }
    off += 12 + len;
  }
  if (insertAt < 0) throw new Error('malformed PNG (no IEND chunk)');
  return Buffer.concat([buf.subarray(0, insertAt), chunk, buf.subarray(insertAt)]);
}

/* Drop every existing text chunk carrying `keyword`, then insert fresh text. */
function pngReplaceITXt(buf, keyword, text) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');
  const keep = [buf.subarray(0, 8)];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'IEND') {
      keep.push(makeITXtChunk(keyword, text));
      keep.push(buf.subarray(off));
      return Buffer.concat(keep);
    }
    let drop = false;
    if ((type === 'iTXt' || type === 'tEXt' || type === 'zTXt') && len > 0) {
      const body = buf.subarray(off + 8, off + 8 + len);
      const z = body.indexOf(0);
      if (z >= 0 && body.toString('latin1', 0, z) === keyword) drop = true;
    }
    if (!drop) keep.push(buf.subarray(off, off + 12 + len));
    off += 12 + len;
  }
  throw new Error('malformed PNG (no IEND chunk)');
}

/* 读 IHDR 里的像素尺寸（写回像素时按原图宽度定栅格化比例，避免文档布局跳动）。
   布局：签名(8) + 块长(4) + "IHDR"(4) + 宽(4) + 高(4) */
function pngGetSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  return (width > 0 && height > 0) ? { width, height } : null;
}

function pngExtractWaveJSON(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'IEND') break;
    if ((type === 'iTXt' || type === 'tEXt' || type === 'zTXt') && len > 0) {
      const body = buf.subarray(off + 8, off + 8 + len);
      const z = body.indexOf(0);
      if (z >= 0 && body.toString('latin1', 0, z) === WD_PNG_KEYWORD) {
        try {
          if (type === 'tEXt') return body.toString('utf8', z + 1);
          if (type === 'zTXt') {
            // keyword\0 compressionMethod(0) deflate(text)
            const zlib = require('zlib');
            return zlib.inflateSync(body.subarray(z + 2)).toString('utf8');
          }
          if (body[z + 1] !== 0) { /* compressed iTXt: fall through to zlib below */ }
          else {
            let p = z + 3;
            while (p < body.length && body[p] !== 0) p++; p++; /* language tag */
            while (p < body.length && body[p] !== 0) p++; p++; /* translated keyword */
            return body.toString('utf8', p);
          }
          const zlib = require('zlib');
          let p = z + 3;
          while (p < body.length && body[p] !== 0) p++; p++;
          while (p < body.length && body[p] !== 0) p++; p++;
          return zlib.inflateSync(body.subarray(p)).toString('utf8');
        } catch (e) { return null; }
      }
    }
    off += 12 + len;
  }
  return null;
}

/* 导出来源标记：编辑器导出时写入（SVG 是 metadata 上的 data-export 属性，PNG 是
   关键字 WaveDromGui 的 iTXt 块，内容 export=editor|wavedrom）。插件写回重绘时据此
   选同一种渲染。旧文件无标记时按 SVG 结构指纹兜底（官方渲染必带 waves_<n> 组） */
const WD_EXPORT_KEYWORD = 'WaveDromGui';

function svgDetectExportKind(text) {
  const m = /<metadata[^>]*data-export="(editor|wavedrom|skill-modern)"[^>]*>/.exec(text)
    || /<metadata[^>]*data-export="(editor|wavedrom|skill-modern)"[^>]*data-wavedrom[^>]*>/.exec(text);
  if (m) return m[1];
  if (/<metadata[^>]*data-wavedrom[^>]*>/.test(text)) {
    /* 无来源标记的旧文件：编辑区导出的根元素带 data-editor-export（若有） */
    const m2 = /<svg[^>]*data-editor-export="1"/.exec(text);
    if (m2) return 'editor';
    /* 官方渲染器（编辑器 WaveDrom 标签 / 传统模式 skill 导出）的 SVG 必带 waves_<n> 组 */
    if (/id="waves_\d+"/.test(text)) return 'wavedrom';
    /* 剩下的是无标记且无官方特征的旧 SVG：无 xlink 命名空间、无 <style> 的按编辑区导出
       认定（编辑区矢量重建没有这两样）；带 xlink/style 的无标记 SVG 是现代模式 skill 导出 */
    if (!/xmlns:xlink/.test(text) && !/<style[ >]/.test(text)) return 'editor';
    return 'skill-modern';
  }
  /* 标记与指纹都识别失败（含 PNG 无标记）→ 按现代风格兜底：
     新工具链默认导出即 modern，识别不出来时按它重绘最接近原图 */
  return 'skill-modern';
}

function pngDetectExportKind(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'IEND') break;
    if ((type === 'iTXt' || type === 'tEXt' || type === 'zTXt') && len > 0) {
      const body = buf.subarray(off + 8, off + 8 + len);
      const z = body.indexOf(0);
      if (z > 0 && body.toString('latin1', 0, z) === WD_EXPORT_KEYWORD) {
        const val = body.toString('latin1', z + 1);
        const m = /export=(editor|wavedrom|skill-modern)/.exec(val);
        if (m) return m[1];
      }
    }
    off += 12 + len;
  }
  return null;
}

module.exports = {
  svgWithMeta, svgExtractWaveJSON,
  pngInsertITXt, pngReplaceITXt, pngExtractWaveJSON, pngGetSize,
  svgDetectExportKind, pngDetectExportKind,
  pngMakeFenceSkeleton,
  WD_PNG_KEYWORD, WD_EXPORT_KEYWORD, crc32,
};

/* 测试辅助：构造仅含 IHDR+IEND 的最小合法 PNG */
function pngMakeFenceSkeleton() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const c = Buffer.alloc(12 + data.length);
    c.writeUInt32BE(data.length, 0);
    t.copy(c, 4);
    data.copy(c, 8);
    c.writeUInt32BE(crc32(c.subarray(4, 8 + data.length)), 8 + data.length);
    return c;
  };
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}
