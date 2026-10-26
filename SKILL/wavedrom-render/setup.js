#!/usr/bin/env node
'use strict';
/*
 * One-time font setup for the modern renderer.
 *
 *   node setup.js
 *
 * Reads fonts.config.json and downloads the configured TTF fonts (LXGW WenKai /
 * WenKai Mono) into <dir> (default vendor/fonts/). Files already present are
 * skipped. Download source follows config.mirror:
 *   auto     — try GitHub direct, fall back to gh-proxy
 *   github   — GitHub only
 *   ghproxy  — gh-proxy only
 *
 * Failure is non-fatal: rendering falls back to plain font-family names +
 * system CJK fonts. This mirrors the "silent fallback" behavior.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const CONFIG = path.join(ROOT, 'fonts.config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch (e) { console.error('无法读取 fonts.config.json：' + e.message); process.exit(1); }
}

/* TTF magic：0x00010000 / 'true' / 'OTTO'。已存在的文件也要验——坏文件（以前只查大小
   落盘的代理错误页）才有机会在重跑时被重新下载自愈 */
function ttfMagicOk(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    return magic.readUInt32BE(0) === 0x00010000 || magic.toString('latin1') === 'true' || magic.toString('latin1') === 'OTTO';
  } catch (e) { return false; }
}

// Download a URL to a file. Follows redirects (GitHub releases redirect to a CDN).
function download(url, dest, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'wavedrom-render-setup' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        /* 校验按注释的承诺来：前 4 字节 TTF magic + 体积非琐碎。gh-proxy 这类中转可能
           回一个 10KB+ 的错误页——只查大小时它照样落盘成正式字体，之后子集化静默跳过、
           外观悄悄回退，且重跑因「已存在」永不自愈 */
        try {
          const size = fs.statSync(tmp).size;
          if (size < 10000 || !ttfMagicOk(tmp)) {
            fs.unlinkSync(tmp);
            return reject(new Error('downloaded file is not a valid TTF (size=' + size + 'B)'));
          }
          fs.renameSync(tmp, dest);
          resolve(size);
        } catch (err) { try { fs.unlinkSync(tmp); } catch (e) {} reject(err); }
      }));
      out.on('error', err => { try { fs.unlinkSync(tmp); } catch (e) {} reject(err); });
    });
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function tryDownload(font, mirror, destDir) {
  const dest = path.join(destDir, font.file);
  const order = mirror === 'github' ? ['github']
    : mirror === 'ghproxy' ? ['ghproxy']
    : ['github', 'ghproxy']; // auto
  let lastErr;
  for (const src of order) {
    const url = font[src];
    if (!url) continue;
    process.stdout.write(`  ↓ ${font.family}  [${src}] … `);
    try {
      const size = await download(url, dest);
      console.log(`OK (${(size / 1024 / 1024).toFixed(2)} MB)`);
      return true;
    } catch (e) {
      console.log('失败：' + e.message);
      lastErr = e;
    }
  }
  return false;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.enabled) { console.log('fonts.config.json: enabled=false，跳过字体下载。'); return; }
  const destDir = path.isAbsolute(cfg.dir) ? cfg.dir : path.join(ROOT, cfg.dir || 'vendor/fonts');
  fs.mkdirSync(destDir, { recursive: true });
  console.log('字体目录：' + destDir);
  console.log('渠道：' + (cfg.mirror || 'auto'));

  let ok = 0, skip = 0, fail = 0;
  for (const font of cfg.fonts || []) {
    const dest = path.join(destDir, font.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10000 && ttfMagicOk(dest)) {
      console.log(`  ✓ ${font.family}  已存在，跳过`);
      skip++; continue;
    }
    const done = await tryDownload(font, cfg.mirror || 'auto', destDir);
    if (done) ok++; else fail++;
  }

  console.log(`\n完成：新下载 ${ok}，已存在 ${skip}，失败 ${fail}。`);
  if (fail) {
    console.log('提示：部分字体未下载成功。渲染会静默回退到系统字体名（中文仍可显示，只是非霞鹜文楷外观）。');
    console.log('可稍后重跑 `node setup.js`，或在 fonts.config.json 里把 mirror 改为 "ghproxy" 再试。');
  }
}

main().catch(e => { console.error('setup 出错：' + e.message); process.exit(1); });
