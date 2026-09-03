'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/* ---- 伪 vscode 模块，让 extension.js 可在纯 Node 环境加载 ---- */
const fakeVscode = {
  Uri: { parse: s => ({ fsPath: s, scheme: 'file' }) },
  window: {
    showErrorMessage() {}, showInformationMessage() {}, setStatusBarMessage() {},
    showQuickPick: async p => p[0],
    createWebviewPanel() { throw new Error('createWebviewPanel 在单测中不可用'); },
  },
  workspace: {
    getConfiguration: () => ({ get: () => 'modern' }),
    openTextDocument: async () => { throw new Error('单测不打开真实文档'); },
    applyEdit: async () => true,
  },
  ViewColumn: { Beside: 2 },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};

const meta = require('../lib/meta-embed.js');
const ext = require('../extension.js');
const { probeImagePath, makePlugin, findFence, FENCE_RE } = ext.__test;

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label);
  passed++;
  console.log('  ✓ ' + label);
}

/* ---- 1. 元数据：插入 / 提取 / 替换 ---- */
const skeleton = meta.pngMakeFenceSkeleton();
const json1 = JSON.stringify({ signal: [{ name: 'clk', wave: 'p...' }] });
const json2 = JSON.stringify({ signal: [{ name: '数据·中文 <>&', wave: 'x.1.' }] });

const png1 = meta.pngInsertITXt(skeleton, meta.WD_PNG_KEYWORD, json1);
ok(meta.pngExtractWaveJSON(png1) === json1, 'PNG 插入后可提取');
const png2 = meta.pngReplaceITXt(png1, meta.WD_PNG_KEYWORD, json2);
ok(meta.pngExtractWaveJSON(png2) === json2, 'PNG 替换后提取到新值');
let count = 0, off = 8;
while (off + 8 <= png2.length) {
  const len = png2.readUInt32BE(off);
  const type = png2.toString('latin1', off + 4, off + 8);
  if (type === 'IEND') break;
  if (type === 'iTXt' && png2.toString('latin1', off + 8, off + 8 + meta.WD_PNG_KEYWORD.length) === meta.WD_PNG_KEYWORD) count++;
  off += 12 + len;
}
ok(count === 1, '替换后仅剩一个 WaveJSON 文本块');
ok(meta.pngExtractWaveJSON(skeleton) === null, '无元数据 PNG 提取为 null');

const svg0 = '<svg xmlns="x" width="1"><rect/></svg>';
const svg1 = meta.svgWithMeta(svg0, json1);
const svg2 = meta.svgWithMeta(svg1, json2);
ok(meta.svgExtractWaveJSON(svg1) === json1, 'SVG 插入后可提取');
ok(meta.svgExtractWaveJSON(svg2) === json2 && (svg2.match(/data-wavedrom/g) || []).length === 1, 'SVG 重复嵌入自动替换为单个 metadata');

/* ---- 2. probeImagePath ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wdvscode-'));
fs.writeFileSync(path.join(tmp, 'wave.png'), png2);
fs.writeFileSync(path.join(tmp, 'plain.png'), skeleton);
fs.writeFileSync(path.join(tmp, 'wave.svg'), svg2);

const docFs = path.join(tmp, 'doc.md'); // 探测以文档所在目录解析相对路径
const probe1 = probeImagePath(docFs, './wave.png');
ok(probe1 && probe1.text === json2, '相对路径探测 PNG 元数据');
ok(probeImagePath(docFs, './plain.png') === null, '无元数据图片返回 null');
ok(probeImagePath(docFs, 'https://a.com/x.png') === null, '跳过 http 图片');
ok(probeImagePath(docFs, './nofile.png') === null, '不存在的文件返回 null');
const probeSvg = probeImagePath(docFs, 'wave.svg');
ok(probeSvg && probeSvg.text === json2, 'SVG 探测');

/* ---- 3. findFence（写回定位） ---- */
const mdText = '# t\n\n```wavedrom\n{"signal":[{}]}\n```\n\ntext\n\n```wavedrom\n{"signal":[{"name":"b","wave":"1."}]}\n```\n';
const second = '{"signal":[{"name":"b","wave":"1."}]}';
const hit = findFence(mdText, [second]);
ok(hit && hit[1].trim() === second, '按内容定位到第二个代码块');
ok(findFence(mdText, ['不存在的']) === null, '匹配不到返回 null');
FENCE_RE.lastIndex = 0;
ok(mdText.match(FENCE_RE).length >= 1, 'FENCE_RE 可用');

/* ---- 4. markdown-it 集成（插件 + 真实 env） ---- */
(async function main() {
  const MarkdownIt = require('markdown-it');
  const ctx = { subscriptions: [], extensionUri: { fsPath: path.join(__dirname, '..') } };
  const api = await require('../extension.js').activate(ctx);
  const md = api.extendMarkdownIt(new MarkdownIt({ html: false }));
  ok(typeof md.render === 'function', 'extendMarkdownIt 返回正常');

  const docMd = path.join(tmp, 'doc.md');
  const jsonSrc = '{ "signal": [ { "name": "clk", "wave": "p..." } ] }';
  fs.writeFileSync(path.join(tmp, 'embedded.png'), png2);
  const env = { currentDocument: { fsPath: docMd } };

  const htmlFence = md.render('```wavedrom\n' + jsonSrc + '\n```\n', env);
  ok(htmlFence.includes('class="wavedrom-block"'), 'fence 渲染为 wavedrom 块');
  const mF = /data-json="([^"]+)"/.exec(htmlFence);
  ok(mF && Buffer.from(mF[1], 'base64').toString('utf8') === jsonSrc, 'fence JSON 完整携带');
  ok(/data-port="\d+"/.test(htmlFence), 'fence 携带回环桥端口');

  const htmlImg = md.render('![波形](./embedded.png)\n', env);
  ok(htmlImg.includes('data-wd="image"'), '带元数据图片被识别包装');
  const mI = /data-json="([^"]+)"/.exec(htmlImg);
  ok(mI && Buffer.from(mI[1], 'base64').toString('utf8') === json2, '图片元数据 JSON 完整携带');

  const htmlPlain = md.render('![普通](./plain.png)\n', env);
  ok(!htmlPlain.includes('wavedrom-block'), '普通图片不被包装');

  const htmlJson = md.render('```json\n{"a":1}\n```\n', env);
  ok(!htmlJson.includes('wavedrom-block'), '普通 json 围栏不拦截');

  console.log('\n全部 ' + passed + ' 项断言通过');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
