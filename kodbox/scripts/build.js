#!/usr/bin/env node
/* 随包构建：把仓库根的 index.html 复制成插件里的 static/app/editor.html。
 *
 * 编辑器本体一行都不改——宿主能力（取文件 / 解码内嵌 WaveJSON / 写回）全在
 * bridge.js 里，由 app.php 在 <body> 之后注入。这里做三件事：
 *   1. 打版本标记（顶栏徽标显示「插件版本 · 编辑器日期」，排错时能一眼看出用的是哪份）
 *   2. 校验注入点还在（app.php 依赖 'wdgui-doc-v1' 字面量与 topbar 结构）
 *   3. 同步图标的缓存串（见文件末尾）
 */
'use strict';
const fs = require('fs');
const path = require('path');

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
