#!/usr/bin/env node
/* 随包构建：把仓库根的 index.html 复制成插件里的 static/app/editor.html。
 *
 * 编辑器本体一行都不改——宿主能力（取文件 / 解码内嵌 WaveJSON / 写回）全在
 * bridge.js 里，由 app.php 在 <body> 之后注入。这里做四件事：
 *   1. 打版本标记（顶栏徽标显示「插件版本 · 编辑器日期」，排错时能一眼看出用的是哪份）
 *   2. 校验注入点还在（app.php 依赖 'wdgui-doc-v1' 字面量与 topbar 结构）
 *   3. 同步图标的缓存串（见文件中段）
 *   4. 可选 `--zip`：产出可分发的插件压缩包（见文件末尾）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pluginDir = path.resolve(__dirname, '..');          // kodbox/
const repoDir = path.resolve(pluginDir, '..');            // wavedrom-gui/
const src = path.join(repoDir, 'index.html');
const dst = path.join(pluginDir, 'static', 'app', 'editor.html');

const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
let html = fs.readFileSync(src, 'utf8');

['\nfunction applyDocJSON', '\nfunction parseLoose', '\nfunction fmtJSON', '\nfunction handleAct', "'wdgui-doc-v1'"]
  .forEach((needle) => {
    if (html.indexOf(needle) < 0) {
      console.error('[build] 编辑器缺少注入点：' + needle.trim() + '，请检查 index.html 是否改名');
      process.exit(1);
    }
  });

const editedAt = new Date(fs.statSync(src).mtimeMs).toISOString().slice(0, 10);
html = html.replace(
  /<meta name="app-version" content="[^"]*">/,
  '<meta name="app-version" content="' + pkg.version + ' · ' + editedAt + '">'
);

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, html);
console.log('[build] ' + path.relative(repoDir, src) + ' → ' + path.relative(repoDir, dst)
  + ' (' + (html.length / 1024).toFixed(0) + ' KB)');

/* 图标 URL 的缓存串：nginx 对图片发 max-age=30d，插件中心的卡片只认 package.json 里
   这个 URL，所以换图标必须换 URL。核心不展开 package.json 里的 {{package.version}}
   （只有 {{pluginHost}} / {{LNG…}} 会替换），版本号由这里按 version 自动回写，
   维护时只改 version 一处即可。 */
const pkgFile = path.join(pluginDir, 'package.json');
const pkgRaw = fs.readFileSync(pkgFile, 'utf8');
const want = '"icon":"{{pluginHost}}static/images/icon.svg?v=' + pkg.version + '"';
const patched = pkgRaw.replace(/"icon":"\{\{pluginHost\}\}static\/images\/icon\.svg(\?v=[^"]*)?"/, want);
if (patched === pkgRaw) {
  console.log('[build] source.icon 缓存串已是 v=' + pkg.version);
} else {
  fs.writeFileSync(pkgFile, patched);
  console.log('[build] source.icon 缓存串 → ?v=' + pkg.version);
}

/* `--zip 输出.zip`：把插件打成可直接解压到 plugins/ 的发行包。
   手写 zip 而不是调 `zip` 命令——发版镜像（node:20）不保证带 zip/python3，
   两端流水线因此可以跑完全同一条命令，产物也确定。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 构建期不需要跑的东西：打包脚本自身、以及任何可能混进来的本地目录
const ZIP_SKIP = new Set(['scripts', '.git', 'node_modules', '.DS_Store']);

function zipList(dir, rel, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ZIP_SKIP.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const name = rel + ent.name;
    if (ent.isDirectory()) zipList(full, name + '/', out);
    else if (ent.isFile()) out.push({ full, name });
  }
  return out;
}

function makeZip(dir, rootName) {
  const files = zipList(dir, '', []);
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach((f) => {
    const raw = fs.readFileSync(f.full);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const when = fs.statSync(f.full).mtime;
    const time = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xFFFF;
    const date = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xFFFF;
    const crc = crc32(raw);
    const name = Buffer.from(rootName + '/' + f.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);                       // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((3 << 8) | 20, 4);                 // 由 unix 系统制作
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(useDeflate ? 8 : 0, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE((0o100644 << 16) >>> 0, 38);        // 权限：644（左移后已越过 int32）
    head.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([head, name]));

    offset += local.length + name.length + body.length;
  });

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

const zipArg = process.argv.indexOf('--zip');
if (zipArg >= 0) {
  const outArg = process.argv[zipArg + 1];
  if (!outArg) {
    console.error('[build] --zip 后面要跟输出路径');
    process.exit(1);
  }
  const outPath = path.resolve(outArg);
  const buf = makeZip(pluginDir, pkg.id);
  fs.writeFileSync(outPath, buf);
  console.log('[build] 打包 → ' + path.relative(repoDir, outPath)
    + ' (' + (buf.length / 1024).toFixed(0) + ' KB)');
}
