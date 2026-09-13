'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/* ---- 内存文档 + WorkspaceEdit：让 saveBack 能在纯 Node 下跑完整写回 ---- */
const fakeDocs = new Map(); // fsPath -> { text }
function posAt(text, off) {
  let line = 0, lineStart = 0;
  for (let i = 0; i < off && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  return { line, character: off - lineStart };
}
function offAt(text, pos) {
  let line = 0, off = 0;
  while (line < pos.line) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return text.length;
    off = nl + 1; line++;
  }
  return Math.min(off + pos.character, text.length);
}

/* ---- 伪 vscode 模块，让 extension.js 可在纯 Node 环境加载 ---- */
const fakeConfig = {}; // 单测里临时改设置用；键不存在时走扩展自己的默认值
const fakeCommands = []; // 记录 executeCommand 的调用
const fakePanels = []; // 记录 createWebviewPanel 的入参
const fakeMessages = []; // 记录 showWarningMessage / showErrorMessage
let fakeNewPanelActive = true; // 新建面板是否立即成为活动编辑器（用于测「始终没拿到焦点」）
let fakeUriHandler = null; // registerUriHandler 注册进来的处理器
let fakeCodeLensProvider = null;
let fakeCodeLensSelector = null;
const fakeRegisteredCommands = {}; // id -> handler
const fakeVscode = {
  Uri: { parse: s => ({ fsPath: s, scheme: 'file' }) },
  Range: class { constructor(start, end) { this.start = start; this.end = end; this.line = start; } },
  CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
  WorkspaceEdit: class { replace(uri, range, text) { this._uri = uri; this._range = range; this._text = text; } },
  env: { uriScheme: 'vscodium', language: 'en' },
  window: {
    showErrorMessage(m) { fakeMessages.push(['error', m]); },
    showWarningMessage(m) { fakeMessages.push(['warn', m]); },
    showInformationMessage(m) { fakeMessages.push(['info', m]); },
    setStatusBarMessage() {},
    showQuickPick: async p => p[0],
    registerUriHandler(handler) { fakeUriHandler = handler; return { dispose() {} }; },
    createWebviewPanel(viewType, title, column, options) {
      const panel = {
        viewType, title, column, options, active: fakeNewPanelActive, disposed: false, visible: true,
        webview: {
          html: '', _onMsg: null,
          onDidReceiveMessage(cb) { this._onMsg = cb; return { dispose() {} }; },
        },
        _disposeCbs: [], _viewStateCbs: [],
        onDidDispose(cb) { this._disposeCbs.push(cb); return { dispose() {} }; },
        onDidChangeViewState(cb) { this._viewStateCbs.push(cb); return { dispose() {} }; },
        fireViewState(visible) { this.visible = visible; this._viewStateCbs.forEach(cb => cb({ webviewPanel: this })); },
        dispose() { this.disposed = true; this._disposeCbs.forEach(cb => cb()); },
      };
      fakePanels.push(panel);
      return panel;
    },
  },
  languages: {
    registerCodeLensProvider(selector, provider) {
      fakeCodeLensSelector = selector;
      fakeCodeLensProvider = provider;
      return { dispose() {} };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, dflt) => (Object.prototype.hasOwnProperty.call(fakeConfig, key) ? fakeConfig[key] : dflt),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async p => {
      const rec = fakeDocs.get(p);
      if (!rec) throw new Error('单测未注册的文档: ' + p);
      return {
        uri: { fsPath: p, scheme: 'file' },
        getText: () => rec.text,
        positionAt: off => posAt(rec.text, off),
      };
    },
    applyEdit: async we => {
      const rec = fakeDocs.get(we._uri.fsPath);
      const s = offAt(rec.text, we._range.start), e = offAt(rec.text, we._range.end);
      rec.text = rec.text.slice(0, s) + we._text + rec.text.slice(e);
      return true;
    },
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  commands: {
    registerCommand: (id, fn) => { fakeRegisteredCommands[id] = fn; return { dispose() {} }; },
    executeCommand: async cmd => { fakeCommands.push(cmd); return undefined; },
  },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};

const meta = require('../lib/meta-embed.js');
const ext = require('../extension.js');
const { probeImagePath, makePlugin, findFence, FENCE_RE, saveBack } = ext.__test;

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
const dims = meta.pngGetSize(png1);
ok(dims && dims.width === 4 && dims.height === 4, 'pngGetSize 读出 IHDR 尺寸');
ok(meta.pngGetSize(Buffer.from('not a png')) === null, '非 PNG 返回 null');


const svg0 = '<svg xmlns="x" width="1"><rect/></svg>';
const svg1 = meta.svgWithMeta(svg0, json1);
const svg2 = meta.svgWithMeta(svg1, json2);
ok(meta.svgExtractWaveJSON(svg1) === json1, 'SVG 插入后可提取');
ok(meta.svgExtractWaveJSON(svg2) === json2 && (svg2.match(/data-wavedrom/g) || []).length === 1, 'SVG 重复嵌入自动替换为单个 metadata');
/* 导出来源标记与识别（wavedrom / editor） */
ok(meta.svgDetectExportKind(meta.svgWithMeta(svg0, json1, 'editor')) === 'editor', 'SVG data-export 标记：editor');
ok(meta.svgDetectExportKind(meta.svgWithMeta(svg0, json1, 'wavedrom')) === 'wavedrom', 'SVG data-export 标记：wavedrom');
ok(meta.svgWithMeta(svg0, json1).indexOf('data-export') < 0, '不带 kind 时维持旧格式（与 skill 导出互通）');
ok(meta.svgDetectExportKind('<svg><metadata data-wavedrom="1">eHg=</metadata><g id="waves_0"/></svg>') === 'wavedrom', '无标记旧 SVG：waves_0 指纹判官方渲染');
ok(meta.svgDetectExportKind('<svg xmlns:xlink="u"><metadata data-wavedrom="1">eHg=</metadata></svg>') === 'skill-modern', '无标记旧 SVG：xlink/style 归现代模式 skill 导出');
ok(meta.svgDetectExportKind('<svg data-editor-export="1"><metadata data-wavedrom="1">eHg=</metadata></svg>') === 'editor', '无标记旧 SVG：根元素 data-editor-export 指纹判编辑区');
ok(meta.svgDetectExportKind('<svg><metadata data-wavedrom="1">eHg=</metadata><rect/></svg>') === 'editor', '无标记旧 SVG：无任何官方特征判编辑区导出');
ok(meta.svgDetectExportKind(meta.svgWithMeta(svg0, json1, 'skill-modern')) === 'skill-modern', 'SVG data-export 标记：skill-modern');
const pngSm = meta.pngInsertITXt(png1, meta.WD_EXPORT_KEYWORD, 'export=skill-modern');
ok(meta.pngDetectExportKind(pngSm) === 'skill-modern', 'PNG WaveDromGui 标记：skill-modern');
const pngMark = meta.pngInsertITXt(meta.pngInsertITXt(skeleton, meta.WD_PNG_KEYWORD, json1), meta.WD_EXPORT_KEYWORD, 'export=editor');
ok(meta.pngDetectExportKind(pngMark) === 'editor', 'PNG WaveDromGui iTXt 标记可识别');
ok(meta.pngDetectExportKind(png1) === null, '无标记 PNG 返回 null（调用侧按 skill-modern 兜底）');
ok(meta.svgDetectExportKind('<svg/>') === 'skill-modern' && meta.svgDetectExportKind('<svg><metadata></metadata></svg>') === 'skill-modern', '标记与指纹全失败时兜底 skill-modern（无 WaveJSON 元数据等不可判定输入）');
const pngReplaced = meta.pngReplaceITXt(pngMark, meta.WD_PNG_KEYWORD, json2);


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

/* 3b. 标题里的 ```wavedrom 不得被误认成围栏开头（回归：曾导致写回错位） */
const trapMd = '## 标题（```wavedrom 围栏）\n\n```wavedrom\n{"signal":[{}]}\n```\n';
const trapHit = findFence(trapMd, ['{"signal":[{}]}']);
ok(trapHit && trapHit[1].trim() === '{"signal":[{}]}', '行首锚定：标题内反引号不再干扰围栏定位');
ok((trapMd.match(FENCE_RE) || []).length === 1, '锚定后仅匹配真实围栏');

/* ---- 4. markdown-it 集成（插件 + 真实 env） ---- */
(async function main() {
  const MarkdownIt = require('markdown-it');
  const ctx = {
    subscriptions: [],
    extensionUri: { fsPath: path.join(__dirname, '..') },
    extension: { id: 'wavedrom-gui.wavedrom-gui-vscode' },
  };
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

  /* ---- 4a. 预览 → 扩展改走产品 scheme 深链接（不再用回环 http 信标） ---- */
  const uriF = /data-edit-uri="([^"]+)"/.exec(htmlFence);
  ok(uriF, 'fence 携带 data-edit-uri');
  const parsedUri = new URL(uriF[1]);
  ok(parsedUri.protocol === 'vscodium:' && parsedUri.host === 'wavedrom-gui.wavedrom-gui-vscode', '深链接用产品 scheme（vscode.env.uriScheme）与扩展 id 作 authority');
  ok(parsedUri.pathname === '/edit' && /^[0-9a-f]{12}$/.test(parsedUri.searchParams.get('k') || ''), '深链接指向 /edit 且带不透明键 k');
  ok(!/data-port|data-token|data-doc=/.test(htmlFence), '渲染结果里不再有回环桥的端口/token/文档路径');

  /* ---- 4b. 编辑入口形式设置（wavedrom-gui.previewEditAffordance，默认 menu） ---- */
  const { editAffordance } = ext.__test;
  ok(/data-edit-mode="menu"/.test(htmlFence), '默认入口形式为 menu（右键菜单，不加可见入口）');
  fakeConfig.previewEditAffordance = 'block';
  ok(editAffordance() === 'block', '设置为 block 时读到 block');
  const htmlBlockMode = md.render('```wavedrom\n' + jsonSrc + '\n```\n', env);
  ok(/data-edit-mode="block"/.test(htmlBlockMode), 'block 设置写进渲染结果（点波形即编辑）');
  fakeConfig.previewEditAffordance = 'button';
  ok(/data-edit-mode="button"/.test(md.render('```wavedrom\n' + jsonSrc + '\n```\n', env)), 'button 设置写进渲染结果（右上角铅笔按钮）');
  fakeConfig.previewEditAffordance = '不认识的取值';
  ok(editAffordance() === 'menu' && /data-edit-mode="menu"/.test(md.render('```wavedrom\n' + jsonSrc + '\n```\n', env)), '取值非法时回退 menu');
  delete fakeConfig.previewEditAffordance;
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const prop = pkg.contributes.configuration.properties['wavedrom-gui.previewEditAffordance'];
  ok(prop && prop.default === 'menu' && prop.enum.join(',') === 'menu,button,block', 'package.json 声明了该设置，默认 menu、可选 menu/button/block');

  const htmlImg = md.render('![波形](./embedded.png)\n', env);
  ok(htmlImg.includes('data-wd="image"'), '带元数据图片被识别包装');
  ok(/data-edit-mode="menu"/.test(htmlImg), '图片块同样携带入口形式设置');
  ok(/data-edit-uri="vscodium:\/\/wavedrom-gui\.wavedrom-gui-vscode\/edit\?k=[0-9a-f]{12}"/.test(htmlImg), '图片块同样携带深链接');
  const mI = /data-json="([^"]+)"/.exec(htmlImg);
  ok(mI && Buffer.from(mI[1], 'base64').toString('utf8') === json2, '图片元数据 JSON 完整携带');

  /* ---- 4c. URI 处理器：深链接回来落到正确的编辑目标 ---- */
  const { editTargets, handleUri } = ext.__test;
  ok(typeof fakeUriHandler === 'object' && typeof fakeUriHandler.handleUri === 'function', 'activate 注册了 URI 处理器');
  /* 真机上扩展收到的是 vscode.Uri，关键字段是 path 与不带 ? 的 query */
  const uriOf = s => { const u = new URL(s); return { scheme: u.protocol.replace(':', ''), authority: u.host, path: u.pathname, query: u.search.replace(/^\?/, '') }; };
  const kFence = parsedUri.searchParams.get('k');
  ok(editTargets.get(kFence) && editTargets.get(kFence).docPath === docMd, '渲染时登记的 k 指向该文档');

  fakePanels.length = 0; fakeMessages.length = 0;
  fakeUriHandler.handleUri(uriOf(uriF[1]));
  ok(fakePanels.length === 1 && fakePanels[0].title.includes('doc.md'), '深链接命中：打开对应文件的可视化编辑器');

  fakePanels.length = 0; fakeMessages.length = 0;
  fakeUriHandler.handleUri(uriOf('vscodium://wavedrom-gui.wavedrom-gui-vscode/edit?k=deadbeef0123'));
  ok(fakePanels.length === 0 && /stale/.test(fakeMessages[0][1] || ''), 'k 不在注册表（预览过期 / 构造的链接）时只提示、不打开');

  fakePanels.length = 0; fakeMessages.length = 0;
  fakeUriHandler.handleUri(uriOf('vscodium://wavedrom-gui.wavedrom-gui-vscode/other?k=' + kFence));
  ok(fakePanels.length === 0 && fakeMessages.length === 0, '其它 path 一律忽略');
  fakeUriHandler.handleUri(uriOf('vscodium://wavedrom-gui.wavedrom-gui-vscode/edit'));
  ok(fakePanels.length === 0 && /stale/.test(fakeMessages[fakeMessages.length - 1][1] || ''), '缺少 k 时只提示、不打开');

  /* ---- 4d. 预览右键菜单「编辑波形」（webview/context，CSP-clean） ---- */
  const editFromPreview = fakeRegisteredCommands['wavedrom-gui.editFromPreview'];
  ok(typeof editFromPreview === 'function', 'activate 注册了右键菜单用的命令');
  const menuItem = pkg.contributes.menus['webview/context'][0];
  ok(menuItem.command === 'wavedrom-gui.editFromPreview' && /webviewSection == 'wavedrom'/.test(menuItem.when), '贡献了 webview/context 菜单项，条件是我们的块');
  ok(/webviewId == 'markdown\.preview'/.test(menuItem.when), '菜单项限定在内置 Markdown 预览里');
  ok(pkg.contributes.menus.commandPalette.some(m => m.command === 'wavedrom-gui.editFromPreview' && m.when === 'false'), '该命令不进命令面板');

  fakePanels.length = 0; fakeMessages.length = 0;
  editFromPreview({ webviewSection: 'wavedrom', k: kFence });   // 扩展收到的正是 data-vscode-context 的 JSON
  ok(fakePanels.length === 1 && fakePanels[0].title.includes('doc.md'), '右键菜单：命中 k 时打开对应文件的编辑器');
  fakePanels.length = 0; fakeMessages.length = 0;
  editFromPreview({ webviewSection: 'wavedrom', k: 'nope' });
  ok(fakePanels.length === 0 && /stale/.test(fakeMessages[0][1] || ''), '右键菜单：k 过期时只提示、不打开');
  fakePanels.length = 0; fakeMessages.length = 0;
  editFromPreview(undefined);
  ok(fakePanels.length === 0 && fakeMessages.length === 1, '右键菜单：上下文缺失时也只提示');

  const htmlPlain = md.render('![普通](./plain.png)\n', env);
  ok(!htmlPlain.includes('wavedrom-block'), '普通图片不被包装');

  const htmlJson = md.render('```json\n{"a":1}\n```\n', env);
  ok(!htmlJson.includes('wavedrom-block'), '普通 json 围栏不拦截');

  /* ---- 5. saveBack 写回（回归：闭合围栏粘连 / 重复块定位 / 大小写 / CRLF） ---- */
  const A = '{\n  "signal": [\n    { "name": "clk", "wave": "p..." }\n  ]\n}';
  const B = '{\n  "signal": [\n    { "name": "dat", "wave": "x.1." }\n  ]\n}';
  const A2 = '{"signal":[{"name":"clk","wave":"p......."}]}';
  const mdPath = path.join(tmp, 'writeback.md');
  const setDoc = t => { fakeDocs.set(mdPath, { text: t }); return t; };
  const getDoc = () => fakeDocs.get(mdPath).text;
  const fenceCount = t => { FENCE_RE.lastIndex = 0; return (t.match(FENCE_RE) || []).length; };
  const firstFenceBody = t => { FENCE_RE.lastIndex = 0; const m = FENCE_RE.exec(t); return m ? m[1].trim() : null; };

  setDoc('# t\n\n```wavedrom\n' + A + '\n```\n\n正文\n\n```wavedrom\n' + B + '\n```\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2);
  ok(fenceCount(getDoc()) === 2, '写回后仍是 2 个可闭合的 wavedrom 围栏块');
  ok(getDoc().includes('正文') && getDoc().includes(B), '写回未吞掉正文与后续代码块');
  let parsed = null;
  try { parsed = JSON.parse(firstFenceBody(getDoc())); } catch (e) { /* 留作断言失败 */ }
  ok(parsed && parsed.signal[0].wave === 'p.......', '写回后块内容是可解析的新 JSON');
  ok(/^ {0,3}```[ \t]*$/m.test(getDoc()), '闭合围栏独占一行（不再粘在 JSON 末行）');

  /* 5b. 内容相同的两个块：靠行号写到第二个，第一个不动 */
  setDoc('# t\n\n```wavedrom\n' + A + '\n```\n\n中间\n\n```wavedrom\n' + A + '\n```\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 12 }, A2);
  ok(getDoc().indexOf('p.......') > getDoc().indexOf('中间'), '重复内容块：改动落在第二个块');
  ok(getDoc().indexOf('p.......') === getDoc().lastIndexOf('p.......'), '重复内容块：第一个块保持不变');

  /* 5c. 大写围栏（预览认、旧版写回不认） */
  setDoc('# t\n\n```WaveDrom\n' + A + '\n```\n');
  ok(findFence(getDoc(), [A]) !== null, '大写 ```WaveDrom 也能定位');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2);
  ok(fenceCount(getDoc()) === 1 && getDoc().includes('p.......'), '大写围栏写回后仍闭合');

  /* 5d. CRLF 文件：换行风格保持，且围栏仍闭合 */
  setDoc('# t\r\n\r\n```wavedrom\r\n' + A.replace(/\n/g, '\r\n') + '\r\n```\r\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2);
  ok(!/(^|[^\r])\n/.test(getDoc()), 'CRLF 文件写回后不混入裸 LF');
  ok(fenceCount(getDoc()) === 1, 'CRLF 写回后围栏仍闭合');

  /* 5e. 空代码块：内容插到围栏内，闭合围栏保持独立行 */
  setDoc('# t\n\n```wavedrom\n```\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: '', line: 2 }, A2);
  ok(fenceCount(getDoc()) === 1 && getDoc().includes('p.......'), '空代码块写回后内容在围栏内且仍闭合');

  /* 5f. 定位失败时先问用户，不再自动改写唯一候选 */
  setDoc('# t\n\n```wavedrom\n' + A + '\n```\n');
  let asked = 0;
  const origPick = fakeVscode.window.showQuickPick;
  fakeVscode.window.showQuickPick = async () => { asked++; return undefined; }; // 用户取消
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: '完全对不上的内容', line: undefined }, A2);
  fakeVscode.window.showQuickPick = origPick;
  ok(asked === 1 && getDoc().includes(A), '定位失败时先询问用户，取消则不写回');

  /* 5g. FENCE_RE 的分块与 markdown-it 一致（粘连残骸下也不能停在下一块的开头围栏） */
  const glued = '```wavedrom\n' + A + '```\n\n正文\n\n```wavedrom\n' + B + '\n```\n';
  const mdFenceCount = t => new MarkdownIt({ html: false }).parse(t, {})
    .filter(tk => tk.type === 'fence' && /^wave(?:drom|json)\b/i.test((tk.info || '').trim())).length;
  ok(fenceCount(glued) === mdFenceCount(glued), '粘连文档下 FENCE_RE 分块数与 markdown-it 一致');
  ok(fenceCount('# t\n\n```wavedrom\n' + A + '\n```\n\n```wavedrom\n' + B + '\n```\n') === mdFenceCount('# t\n\n```wavedrom\n' + A + '\n```\n\n```wavedrom\n' + B + '\n```\n'), '正常文档下 FENCE_RE 分块数与 markdown-it 一致');

  /* ---- 5h. 写回文本跟随编辑器显示模式（紧凑模式不再被强制展开成 2 空格缩进） ---- */
  const { writeText } = ext.__test;
  const compactText = '{\n  "signal": [\n    { "name": "clk", "wave": "p......." }\n  ]\n}';
  const prettyText = JSON.stringify(JSON.parse(A2), null, 2);
  ok(compactText !== prettyText, '用例前提：紧凑文本与默认缩进不同');

  setDoc('# t\n\n```wavedrom\n' + A + '\n```\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2, compactText);
  ok(firstFenceBody(getDoc()) === compactText, '紧凑模式：写回内容按显示文本原样保留，不被展开');
  ok(fenceCount(getDoc()) === 1 && getDoc().includes('clk'), '紧凑模式：写回后围栏仍闭合且内容正确');

  setDoc('# t\n\n```wavedrom\n' + A + '\n```\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2);
  ok(firstFenceBody(getDoc()) === prettyText, '未提供显示文本时退回默认 2 空格缩进');

  setDoc('# t\n\n```wavedrom\n' + A + '\n```\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2, '{"signal":[{"name":"与状态不符"}]}');
  ok(firstFenceBody(getDoc()) === prettyText, '显示文本与状态 JSON 不一致时退回默认缩进（不写坏内容）');
  ok(firstFenceBody(getDoc()).includes('p.......'), '退回默认缩进时写的仍是新状态');

  setDoc('# t\n\n```wavedrom\n' + A + '\n```\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2, '这不是 JSON');
  ok(firstFenceBody(getDoc()) === prettyText, '显示文本不可解析时退回默认缩进');

  ok(writeText(A2, compactText) === compactText, 'writeText：显示文本与状态等价时采用显示文本');

  setDoc('# t\r\n\r\n```wavedrom\r\n' + A.replace(/\n/g, '\r\n') + '\r\n```\r\n');
  await saveBack({ kind: 'fence', docPath: mdPath, fenceRaw: A, line: 2 }, A2, compactText);
  ok(firstFenceBody(getDoc()) === compactText.replace(/\n/g, '\r\n'), 'CRLF 文件：紧凑文本按文件换行风格写回');
  ok(!/(^|[^\r])\n/.test(getDoc()), 'CRLF 文件：紧凑写回后不混入裸 LF');

  /* ---- 6. 编辑器面板：每个编辑目标独立的自动保存键（避免两个面板互相串写） ---- */
  const { buildEditorHtml, panelDocKey } = ext.__test;
  const tgtA = { kind: 'fence', docPath: '/tmp/x.md', fenceRaw: A, line: 2 };
  const tgtB = { kind: 'fence', docPath: '/tmp/x.md', fenceRaw: B, line: 12 };
  const keyA = panelDocKey(tgtA), keyB = panelDocKey(tgtB);
  const h1 = buildEditorHtml('{"signal":[]}', keyA);
  ok(/^wdgui-doc-v1:/.test(keyA) && keyA !== keyB, '同一文件不同代码块派生出不同的保存键');
  ok(panelDocKey(Object.assign({}, tgtA)) === keyA, '同一目标重复打开复用同一个键（不无限累积）');
  ok(!/localStorage\.(get|set)Item\('wdgui-doc-v1'\)/.test(h1), '注入的 index.html 不再读写共享键');
  ok(h1.includes(keyA) && /var KEY = /.test(h1), '轮询脚本使用该面板自己的键');
  ok(/location\.hash = "%7B%22signal/.test(h1), '初始文档仍经 location.hash 注入');
  ok(/window\.wdFormatDoc/.test(h1) && /postMessage\(\{ type: 'save', json: v, text: displayText\(v\) \}\)/.test(h1), '轮询脚本随文档带上显示模式的写回文本');
  ok(/try \{ JSON\.parse\(v\); \} catch \(e\) \{ return; \}/.test(h1), '写回文本丢失时不会连带丢掉 JSON 校验');

  /* ---- 6b. 界面钩子 × 轮询脚本对接：文档一变，消息文本即为当前显示模式的风格 ---- */
  const vm = require('vm');
  const editorSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const hookSrc = editorSrc.slice(editorSrc.indexOf('let codeCompact'), editorSrc.indexOf('function renderCode()'));
  const pollerSrc = /\(function \(\) \{\s*var vs = acquireVsCodeApi\(\);[\s\S]*?\}\)\(\);/.exec(h1);
  ok(pollerSrc, '能从面板 HTML 中取出轮询脚本');

  const openDoc = JSON.parse(A2);
  /* 带 data 数组的通道：紧凑模式下整条单行，舒缓模式下会展开——刚好区分两种模式 */
  const nextDoc = {
    signal: [{ name: 'clk', wave: 'p....' }, { name: 'bus', wave: 'x.=..', data: ['hdr', '1', '2', '3'] }],
  };
  /* 按指定显示模式跑一遍真实轮询脚本：armed() 模拟面板打开，tick() 模拟一次改动 */
  const runPoller = mode => {
    const store = { 'wdgui-code-compact': mode };
    let armed = null, tick = null;
    const posted = [];
    const sandbox = {
      window: {}, JSON, encodeURIComponent, decodeURIComponent, console,
      location: { hash: '' },
      /* index.html 的存储读写已统一走安全助手，沙箱里接到同一 store 上 */
      tryGet: k => (k in store ? store[k] : null),
      storeSet: (k, v) => { store[k] = v; },
      localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
      acquireVsCodeApi: () => ({ postMessage: m => posted.push(m) }),
      setTimeout: fn => { armed = fn; return 1; },
      setInterval: fn => { tick = fn; return 2; },
    };
    vm.createContext(sandbox);
    vm.runInContext(hookSrc, sandbox);
    vm.runInContext(pollerSrc[0], sandbox);
    if (typeof armed !== 'function' || typeof tick !== 'function') return { posted, ok: false };
    store[keyA] = JSON.stringify(openDoc);
    armed();                                   // 面板打开：记下初始文档，之后不回写
    store[keyA] = JSON.stringify(nextDoc);      // 用户改动
    tick();
    return { posted, ok: true };
  };

  const compactRun = runPoller('1');
  ok(compactRun.ok && compactRun.posted.length === 1 && compactRun.posted[0].type === 'save', '紧凑模式：改动后发出一封保存消息');
  ok(compactRun.posted[0].json === JSON.stringify(nextDoc), '消息仍带原始状态 JSON（供图片元数据与校验使用）');
  ok(compactRun.posted[0].text.split('\n').some(l => /^ +\{ "name": "bus", "wave": "x\.=\.\.", "data": \["hdr", "1", "2", "3"\] \},?$/.test(l)), '紧凑模式：通道对象连 data 保持单行');
  ok(JSON.stringify(JSON.parse(compactRun.posted[0].text)) === JSON.stringify(nextDoc), '紧凑模式：消息文本与状态 JSON 等价');

  const relaxRun = runPoller('0');
  ok(relaxRun.ok && relaxRun.posted.length === 1, '舒缓模式：改动后发出一封保存消息');
  ok(relaxRun.posted[0].text.split('\n').some(l => /^ +"name": "bus",$/.test(l)), '舒缓模式：对象展开为多行（写回风格确实跟随模式）');

  /* ---- 6c. 图片目标：轮询脚本把当前画面随 pixels 消息上报（PNG 按原图宽对齐比例） ---- */
  ok(/var IMG = null;/.test(h1), '代码块目标不注入画面上报（IMG = null）');
  ok(/var IMG = \{"ext":"png","pxW":150\};/.test(buildEditorHtml('{"signal":[]}', keyA, { ext: 'png', pxW: 150 })), 'PNG 目标注入 ext 与原图像素宽');
  ok(/var IMG = \{"ext":"svg"\};/.test(buildEditorHtml('{"signal":[]}', keyA, { ext: 'svg' })), 'SVG 目标注入 ext=svg');
  ok(/var IMG = \{"ext":"png","pxW":150,"kind":"editor"\};/.test(buildEditorHtml('{"signal":[]}', keyA, { ext: 'png', pxW: 150, kind: 'editor' })), 'IMG 注入携带 kind=editor');
  const smHtml = buildEditorHtml('{"signal":[]}', keyA, { ext: 'png', kind: 'skill-modern' });
  ok(/var IMG = \{"ext":"png","kind":"skill-modern"\};/.test(smHtml) && smHtml.includes('wavedrom-renderer-ready'), 'kind=skill-modern：面板内联无浏览器渲染器（含就绪事件广播）');
  ok(!buildEditorHtml('{"signal":[]}', keyA, { ext: 'png', kind: 'wavedrom' }).includes('wavedrom-renderer-ready'), '其它来源不内联渲染器（面板保持轻量）');

  const runPollerImg = (imgCfg, preview) => {
    const html = buildEditorHtml('{"signal":[]}', keyA, imgCfg);
    const src = /\(function \(\) \{\s*var vs = acquireVsCodeApi\(\);[\s\S]*?\}\)\(\);/.exec(html)[0];
    const store = {};
    const timers = [];
    const posted = [];
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect: () => { calls.fill++; }, drawImage() {} }), toBlob: cb => cb({}) };
    const calls = { getExportSvg: 0, buildEditorSvg: 0, fill: 0 };
    let tick = null;
    const sandbox = {
      JSON, Math, console,
      location: { hash: '' },
      localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
      acquireVsCodeApi: () => ({ postMessage: m => posted.push(m) }),
      setTimeout: fn => { timers.push(fn); return timers.length; },
      setInterval: fn => { tick = fn; return 2; },
      document: { querySelector: () => preview, createElement: () => canvas },
      getExportSvg: () => { calls.getExportSvg++; return { str: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', w: 100, h: 40 }; },
      buildEditorSvg: () => {
        calls.buildEditorSvg++;
        return { getAttribute: k => (k === 'width' ? 120 : k === 'height' ? 88 : null) };
      },
      XMLSerializer: class { serializeToString() { return '<svg data-editor-export="1"></svg>'; } },
      window: { WaveDromModern: { renderModern: () => ({ svg: '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"></svg>' }) } },
      cssVar: name => (name === '--bg' ? '#101418' : ''),
      Image: class { set src(v) { if (this.onload) this.onload(); } },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
      Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
      FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,QUJD'; this.onload && this.onload(); } },
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    timers.shift()();                            // 1200ms 的武装定时器
    store[keyA] = JSON.stringify(nextDoc);
    tick();                                      // 改动 → save 消息 + sendPixels
    while (timers.length) timers.shift()();      // 排队的宏任务（画面渲染的 setTimeout(0)）
    return { posted, canvas, calls };
  };

  const pxRun = runPollerImg({ ext: 'png', pxW: 150 }, {});
  ok(pxRun.posted.length === 2 && pxRun.posted[0].type === 'save', 'PNG 目标：改动先发 save，再上报画面');
  ok(pxRun.posted[1].type === 'pixels' && pxRun.posted[1].png === 'QUJD' && pxRun.posted[1].json === JSON.stringify(nextDoc), 'pixels 消息带 base64 PNG 与渲染完成后的文档 JSON');
  ok(pxRun.canvas.width === 150 && pxRun.canvas.height === 60, '栅格尺寸按原图宽对齐（100×40 → 150×60，1.5×）');
  ok(runPollerImg({ ext: 'png', pxW: 1000 }, {}).canvas.width === 400, '放大比例夹到上限 4×');
  ok(runPollerImg({ ext: 'png', pxW: 50 }, {}).canvas.width === 100, '缩到不足 1× 时夹到下限 1×（不渲染模糊图）');
  const pxDef = runPollerImg({ ext: 'png' }, {});
  ok(pxDef.canvas.width === 200 && pxDef.canvas.height === 80, '原图读不到宽度时退回默认 2×（与导出按钮一致）');
  const pxSvg = runPollerImg({ ext: 'svg' }, {});
  ok(pxSvg.posted.length === 2 && pxSvg.posted[1].svg === '<svg xmlns="http://www.w3.org/2000/svg"></svg>' && pxSvg.posted[1].png === undefined, 'SVG 目标：直接上报矢量文本，不经光栅化');
  ok(runPollerImg({ ext: 'png' }, null).posted.length === 1, '预览还没内容（空文档）时静默跳过，不误触 getExportSvg 的提示');

  /* 6c-2. 原图是哪种导出（wavedrom / editor）就按哪种重绘 */
  const edRun = runPollerImg({ ext: 'png', pxW: 150, kind: 'editor' }, {});
  ok(edRun.calls.buildEditorSvg === 1 && edRun.calls.getExportSvg === 0, 'kind=editor：走 buildEditorSvg（编辑区矢量重建），不碰官方渲染');
  ok(edRun.canvas.width === 150 && edRun.canvas.height === 110, '编辑区导出同样按原图宽对齐比例（120×88 → 150×110）');
  const edSvgRun = runPollerImg({ ext: 'svg', kind: 'editor' }, {});
  ok(edSvgRun.posted[1].svg === '<svg data-editor-export="1"></svg>', '编辑区导出的矢量文本来自 buildEditorSvg 序列化');
  const smRun = runPollerImg({ ext: 'png', pxW: 600, kind: 'skill-modern' }, {});
  ok(smRun.calls.getExportSvg === 0 && smRun.calls.buildEditorSvg === 0, 'kind=skill-modern：走内联的无浏览器渲染器，不碰另外两条路');
  ok(smRun.canvas.width === 600 && smRun.canvas.height === 300, 'skill-modern：尺寸从渲染输出的根属性解析（300×150 → 2× = 600×300）');
  ok(smRun.calls.fill === 0, 'skill-modern：保持透明底（原导出未经填充）');
  const smSvgRun = runPollerImg({ ext: 'svg', kind: 'skill-modern' }, {});
  ok(smSvgRun.posted[1].svg.indexOf('<svg xmlns="http://www.w3.org/2000/svg"') === 0, 'skill-modern SVG：上报时已剥掉 XML 声明');
  const smFallback = runPollerImg({ ext: 'png', kind: 'skill-modern' }, {});
  ok(smFallback.posted.length === 2, 'skill-modern：渲染器在时正常出图');

  const wdRun = runPollerImg({ ext: 'png', pxW: 150, kind: 'wavedrom' }, {});
  ok(wdRun.calls.getExportSvg === 1 && wdRun.calls.buildEditorSvg === 0, 'kind=wavedrom（默认）：维持官方渲染路径');

  /* ---- 7. 界面格式化钩子与打包副本同步（VSIX 里的 editor.html 由 index.html 拷贝而来） ---- */
  ok(/window\.wdFormatDoc = function \(jsonStr\)/.test(editorSrc), 'index.html 暴露写回格式化钩子（复用 fmtJSON）');
  ok(/fmtJSON\(JSON\.parse\(jsonStr\), 0, codeCompact\)/.test(editorSrc), '钩子跟随代码页紧凑/舒缓模式');
  const builtEditor = path.join(__dirname, '..', 'media', 'editor.html');
  if (fs.existsSync(builtEditor)) {
    ok(fs.readFileSync(builtEditor, 'utf8').includes('window.wdFormatDoc'), 'media/editor.html 已随 npm run build 同步');
  }

  /* ---- 8. 预览工具栏：无「源码」按钮，只有一个铅笔编辑按钮 ---- */
  const previewSrc = fs.readFileSync(path.join(__dirname, '..', 'media', 'preview.js'), 'utf8');
  const previewCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'preview.css'), 'utf8');
  ok(!/源码/.test(previewSrc) && !/源码/.test(previewCss), '源码按钮已从预览工具栏移除');
  ok(!/wd-bar|wd-btn/.test(previewCss), 'preview.css 不再残留源码按钮时代的样式');
  ok(/\.wd-figure/.test(previewCss) && /\.wd-actions/.test(previewCss) && /a\.wd-edit/.test(previewCss), 'preview.css 含图形容器、操作行与图标按钮样式');
  ok(/\.wd-figure\s*\{[^}]*display:\s*inline-block/.test(previewCss), '图形容器收缩到图形自身宽度（窄图时按钮贴图形右上角）');
  ok(/a\.wd-blocklink/.test(previewCss) && /text-decoration:\s*none/.test(previewCss), 'block 模式的整块链接有对应样式且去掉了下划线');
  ok(!/wd-toast/.test(previewCss) && !/beacon|data-port|127\.0\.0\.1/.test(previewSrc), '回环信标与其提示已彻底移除');
  const testUri = 'vscodium://wavedrom-gui.wavedrom-gui-vscode/edit?k=0123456789ab';

  /* 极简伪 DOM：只提供 preview.js 用到的那几个接口，把工具栏结构跑出来 */
  const fakeEl = tag => {
    const classes = new Set();
    const node = {
      tagName: tag.toUpperCase(), children: [], dataset: {}, attrs: {}, style: {}, listeners: {},
      className: '', textContent: '', title: '', _html: '',
      get firstChild() { return this.children[0] || null; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); this.children = v ? [fakeEl('svg')] : []; },
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle() {} },
      remove() {},
    };
    return node;
  };
  /* 收集整棵树上的文本（断言不再出现「源码」字样） */
  const texts = node => [node.textContent].concat(...node.children.map(texts));
  const find = (node, cls) => {
    if (node.className === cls) return node;
    for (const c of node.children) { const hit = find(c, cls); if (hit) return hit; }
    return null;
  };
  let fakeI18nNode = null; // 模拟扩展渲染进去的 #wd-i18n（null = 缺失，测英文回退）
  let lastWin = null; // 最近一次 runPreview 用的伪 window（用于触发就绪事件）
  /* 伪 window：带最小事件系统，模拟渲染库「稍后才到」的情况 */
  const makeWin = (renderModern, noRenderer) => {
    const listeners = {};
    const win = {
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      emit: t => (listeners[t] || []).forEach(fn => fn()),
    };
    if (!noRenderer) win.WaveDromModern = { renderModern };
    return win;
  };
  const runPreview = (renderModern, editMode, editUri, opts) => {
    const o = opts || {};
    const block = fakeEl('div');
    block.dataset.wd = 'fence';
    if (editMode) block.dataset.editMode = editMode;
    if (editUri !== null) {
      block.dataset.editUri = editUri === undefined ? testUri : editUri;
      block.dataset.k = testUri.replace(/^.*k=/, ''); // 真渲染里 data-k 与 data-edit-uri 同时存在
    }
    block.dataset.json = Buffer.from(JSON.stringify({ signal: [{ name: 'clk', wave: 'p...' }] }), 'utf8').toString('base64');
    const doc = {
      createElement: fakeEl,
      body: fakeEl('body'),
      getElementById: id => (id === 'wd-i18n' ? fakeI18nNode : null),
      querySelectorAll: sel => (String(sel).indexOf('.wavedrom-block') === 0 ? [block] : []),
    };
    lastWin = makeWin(renderModern, o.noRenderer);
    const ctx = {
      document: doc, window: lastWin, MutationObserver: class { observe() {} },
      setTimeout: () => 0, clearTimeout: () => {}, btoa, atob, unescape, escape, console,
    };
    vm.createContext(ctx);
    vm.runInContext(previewSrc, ctx);
    return block;
  };

  /* menu 模式（默认）：不渲染可见入口，但右键上下文照旧，波形照常渲染 */
  const menuBlock = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'menu');
  ok(!find(menuBlock, 'wd-edit') && !find(menuBlock, 'wd-actions') && !find(menuBlock, 'wd-blocklink'), 'menu 模式：不渲染任何可见入口');
  ok(find(menuBlock, 'wd-svg'), 'menu 模式：波形照常渲染');
  const menuCtx = menuBlock.getAttribute('data-vscode-context');
  ok(menuCtx && JSON.parse(menuCtx).webviewSection === 'wavedrom' && JSON.parse(menuCtx).k, 'menu 模式：右键菜单上下文仍在（这模式下唯一的预览入口）');
  ok(!menuBlock.listeners.click, 'menu 模式：块本身不带点击处理');

  const block = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'button');
  ok(block.children.length === 1 && block.children[0].className === 'wd-figure', '块内只有一层 .wd-figure');
  const figure = block.children[0];
  const actions = figure.children[0], holder = figure.children[1];
  ok(actions.className === 'wd-actions' && holder.className === 'wd-svg', 'button 模式：结构为 .wd-actions + .wd-svg');
  ok(actions.children.length === 1 && actions.children[0].className === 'wd-edit', '操作行内只有编辑入口');
  const edit = actions.children[0];
  ok(edit.tagName === 'A' && edit.getAttribute('href') === testUri, 'button 模式：入口是真锚点，href 即扩展给的深链接');  ok(edit.getAttribute('aria-label') === 'Edit' && /Edit/.test(edit.title || ''), '编辑入口有无障碍名与悬停提示（缺 i18n 元素时回退英文）');
  ok(!/<text|✏/.test(edit.innerHTML) && /<svg/.test(edit.innerHTML), '入口用内联描边图标，不用 emoji 字形');
  ok(texts(block).join(' ').indexOf('源码') < 0, '预览块内不再出现「源码」按钮文字');
  ok(!edit.listeners.click, '不再靠脚本点击事件（深链接要真实用户点击）');
  const ctxAttr = block.getAttribute('data-vscode-context');
  ok(ctxAttr && JSON.parse(ctxAttr).webviewSection === 'wavedrom' && JSON.parse(ctxAttr).k, '块上写了右键菜单上下文（webviewSection + k）');

  /* block 模式：无按钮，整块就是一个锚点 */
  const clickable = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'block');
  const blockLink = find(clickable, 'wd-blocklink');
  ok(blockLink && blockLink.tagName === 'A' && blockLink.getAttribute('href') === testUri, 'block 模式：整块包在一个指向深链接的锚点里');
  ok(!find(clickable, 'wd-edit') && !find(clickable, 'wd-actions'), 'block 模式：不渲染按钮，也不留空操作行');
  ok(find(blockLink, 'wd-figure') && find(blockLink, 'wd-svg'), 'block 模式：锚点里是完整的图形结构');
  ok(/Edit/.test(blockLink.title || ''), 'block 模式：有悬停提示说明可点');
  ok(!clickable.listeners.click && !clickable.listeners.keydown, 'block 模式：不需要手写点击/键盘处理（锚点原生支持）');

  /* 没有深链接（例如未保存的 untitled 文档）：不渲染任何入口 */
  const noUri = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'button', null);
  ok(!find(noUri, 'wd-edit') && !find(noUri, 'wd-actions') && find(noUri, 'wd-svg'), '无 data-edit-uri 时只渲染波形，不渲染入口');
  const noUriBlock = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'block', null);
  ok(!find(noUriBlock, 'wd-blocklink') && find(noUriBlock, 'wd-svg'), 'block 模式在无 data-edit-uri 时也不包锚点');

  const broken = runPreview(() => { throw new Error('坏 JSON'); }, 'button');
  ok(broken.children[0].children.some(c => c.className === 'wd-code'), '渲染失败时仍回退显示 WaveJSON 原文');

  /* ---- 8c. 回归：VS Code 用 <script async> 注入预览脚本，渲染库可能后到（曾报
     「Cannot read properties of undefined (reading 'renderModern')」） ---- */
  const svg = () => ({ svg: '<svg width="10" height="10"><g/></svg>' });
  const late = runPreview(svg, 'button', undefined, { noRenderer: true });
  ok(!find(late, 'wd-figure'), '渲染库未就绪：先不初始化块（不渲染成错误框）');
  ok(!late.dataset.wdInit, '渲染库未就绪：块未被标记为已初始化（就绪后会补扫）');
  lastWin.WaveDromModern = { renderModern: svg };
  lastWin.emit('wavedrom-renderer-ready');
  ok(find(late, 'wd-figure') && find(late, 'wd-svg') && !find(late, 'wd-code'), '渲染库就绪事件到达后补扫并正常渲染');

  /* load 事件兜底与「渲染库始终没到」的提示 */
  const late2 = runPreview(svg, 'button', undefined, { noRenderer: true });
  lastWin.WaveDromModern = { renderModern: svg };
  lastWin.emit('load');
  ok(find(late2, 'wd-figure'), 'load 事件也能补扫（async 脚本到 load 时都已执行完）');
  const never = runPreview(svg, 'button', undefined, { noRenderer: true });
  lastWin.emit('wavedrom-renderer-ready');   // 库始终没到，事件里也没有 renderer
  ok(!find(never, 'wd-figure') && !find(never, 'wd-code'), '渲染库始终没到：不渲染错误框，等下次事件');
  ok(/renderer-not-loaded|Waveform renderer not loaded/.test(previewSrc), '渲染库缺失时的提示文案是明确说明（不是原始 TypeError）');
  const builtRenderer = fs.readFileSync(path.join(__dirname, '..', 'media', 'modern-render.browser.js'), 'utf8');
  ok(/dispatchEvent\(new Event\('wavedrom-renderer-ready'\)\)/.test(builtRenderer), '渲染库构建产物会广播就绪事件（npm run build 已同步）');
  ok(/wavedrom-renderer-ready/.test(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build.js'), 'utf8')), 'build.js 里生成了就绪事件广播');

  /* ---- 8b. 编辑器 CodeLens：不经过预览的稳定入口 ---- */
  const { makeCodeLensProvider, editFenceCommand, editImageCommand } = ext.__test;
  ok(fakeCodeLensSelector && fakeCodeLensSelector.language === 'markdown', 'CodeLens 注册在 markdown 文档上');
  const lensDoc = {
    languageId: 'markdown',
    uri: { fsPath: mdPath },
    getText: () => '# t\n\n```wavedrom\n' + A2 + '\n```\n\n正文\n\n```wavedrom\n' + B + '\n```\n',
  };
  const lenses = makeCodeLensProvider().provideCodeLenses(lensDoc);
  ok(lenses.length === 2, '每个 wavedrom 围栏给一个 CodeLens');
  ok(lenses[0].range.line === 2 && lenses[1].range.line === 8, 'CodeLens 落在各围栏的首行');
  ok(lenses[0].command.title === 'Edit waveform' && lenses[0].command.command === 'wavedrom-gui.editFence', 'CodeLens 指向 editFence 命令（文案取自 l10n 源串）');
  ok(lenses[0].command.arguments[0].docPath === mdPath && lenses[0].command.arguments[0].line === 2, 'CodeLens 参数带文档路径与行号');
  ok(makeCodeLensProvider().provideCodeLenses({ languageId: 'markdown', uri: { fsPath: mdPath }, getText: () => '# 无围栏\n' }).length === 0, '没有 wavedrom 围栏时不给 CodeLens');
  fakeConfig.showCodeLens = false;
  ok(makeCodeLensProvider().provideCodeLenses(lensDoc).length === 0, 'showCodeLens=false 时不给 CodeLens');
  delete fakeConfig.showCodeLens;

  /* CodeLens 点击：行号漂了要能按内容兜底定位 */
  setDoc('# t\n\n前置段落\n\n```wavedrom\n' + A2 + '\n```\n');
  fakePanels.length = 0;
  await editFenceCommand({ kind: 'fence', docPath: mdPath, fenceRaw: A2, line: 2 });
  ok(fakePanels.length === 1, 'editFence：行号漂了仍按内容找到代码块并打开');
  setDoc('# t\n\n```wavedrom\n' + B + '\n```\n');
  fakePanels.length = 0; fakeMessages.length = 0;
  await editFenceCommand({ kind: 'fence', docPath: mdPath, fenceRaw: A2, line: 2 });
  ok(fakePanels.length === 0 && /Cannot find this code block/.test(fakeMessages[0][1] || ''), 'editFence：内容也对不上时提示而不是打开错块');

  /* 8b-2. 图片引用的 CodeLens：只有内嵌 WaveJSON 的图片才有 */
  const imgLensDoc = {
    languageId: 'markdown',
    uri: { fsPath: mdPath },
    getText: () => '# t\n\n![波形](./wave.png)\n\n![普通图](./plain.png)\n\n![远程](https://a.com/x.png)\n\n![带标题](./wave.svg "标题")\n',
  };
  const imgLenses = makeCodeLensProvider().provideCodeLenses(imgLensDoc);
  ok(imgLenses.length === 2, '图片引用：内嵌 WaveJSON 的 PNG 与 SVG 各给一个 CodeLens，普通图/远程图不给');
  ok(imgLenses[0].range.line === 2 && imgLenses[0].command.command === 'wavedrom-gui.editImage'
    && imgLenses[0].command.arguments[0].src === './wave.png', '图片 CodeLens 落在引用行，指向 editImage，参数带原始引用路径');
  ok(imgLenses[1].range.line === 8 && imgLenses[1].command.arguments[0].src === './wave.svg', '带 title 的 SVG 引用同样命中（路径取到空白为止）');

  /* CodeLens 点击：打开前重新探测，文件没了/元数据没了要提示而不是打开错图 */
  fakePanels.length = 0; fakeMessages.length = 0;
  await editImageCommand({ kind: 'image', docPath: mdPath, src: './wave.png' });
  ok(fakePanels.length === 1, 'editImage：命中内嵌 WaveJSON 时打开编辑器');
  fakePanels.length = 0; fakeMessages.length = 0;
  await editImageCommand({ kind: 'image', docPath: mdPath, src: './plain.png' });
  await editImageCommand({ kind: 'image', docPath: mdPath, src: './nofile.png' });
  await editImageCommand({ kind: 'fence', docPath: mdPath, fenceRaw: 'x' });
  ok(fakePanels.length === 0 && fakeMessages.length === 2, 'editImage：无元数据/文件不存在时提示，非法参数静默忽略');

  /* 8b-3. 引用式图片 CodeLens + 围栏内排除 */
  const refLensDoc = {
    languageId: 'markdown',
    uri: { fsPath: mdPath },
    getText: () => '# t\n\n![波形][pic]\n\n![别名][]\n\n```text\n![波形](./wave.png)\n```\n\n[pic]: ./wave.png\n[别名]: <./wave.svg> "标题"\n',
  };
  const refLenses = makeCodeLensProvider().provideCodeLenses(refLensDoc);
  ok(refLenses.length === 2, '引用式图片：完整式与折叠式各给一个 CodeLens，定义行与围栏内的行内引用不给');
  ok(refLenses[0].range.line === 2 && refLenses[0].command.arguments[0].src === './wave.png', '引用式：定义出现在使用之后也能解析（label 大小写/空白折叠）');
  ok(refLenses[1].range.line === 4 && refLenses[1].command.arguments[0].src === './wave.svg', '折叠式引用回退用 alt 作 label，<尖括号路径> 带标题的定义可解析');

  /* 8b-4. preview.js 宽松解析：与 CLI/编辑器同一覆盖面，且不做任何求值 */
  const previewSrcFull = fs.readFileSync(path.join(__dirname, '..', 'media', 'preview.js'), 'utf8');
  const looseSrc = /function parseLoose\(text\) \{[\s\S]*?return JSON\.parse\(out\);\n  \}/.exec(previewSrcFull);
  ok(looseSrc, 'preview.js 内置无求值的宽松解析器');
  const sb = { JSON };
  vm.createContext(sb);
  vm.runInContext(looseSrc[0], sb);
  const lenient = '{ // 行注释\n  /* 块注释 */\n  signal: [ // 行尾注释\n    { name: \'clk\', wave: \'p...\', },\n  ],\n}';
  ok(JSON.stringify(sb.parseLoose(lenient)) === JSON.stringify({ signal: [{ name: 'clk', wave: 'p...' }] }), '宽松解析：注释/免引号键/单引号/尾逗号与 CLI 同覆盖面');
  ok(sb.parseLoose('{"a": "http://x //b"}').a === 'http://x //b', '字符串内的 // 不当注释');
  ok(sb.parseLoose('{"a": "值, }"}').a === '值, }', '字符串内的「, }」不被当尾逗号');
  ok(sb.parseLoose("{a: 'x\"y'}").a === 'x"y', '单引号串转双引号时内部双引号补转义');
  ok((() => { try { sb.parseLoose('{a: process.mainModule.require("child_process")}'); return false; } catch (e) { return true; } })(), '宽松解析不求值：JS 表达式只会解析失败而非执行');

  /* 8b-5. P0 收敛：hash 链接与文件导入走无求值解析，eval 只留给用户亲手输入 */
  const editorSrcFull = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const edLoose = /function parseLoose\(text\) \{[\s\S]*?return JSON\.parse\(out\);\n\}/.exec(editorSrcFull);
  ok(edLoose, 'index.html 里有 parseLoose');
  /* 双副本逐字同步（去除全部空白后比较，兼容缩进差异） */
  const squash = x => x.replace(/\s+/g, '');
  ok(squash(edLoose[0]) === squash(looseSrc[0]), 'index.html 与 preview.js 的 parseLoose 逐字同步');
  const ldBody = /function loadDocFromHash\(\) \{[\s\S]*?\n\}/.exec(editorSrcFull)[0];
  ok(ldBody.includes('parseLoose(') && !ldBody.includes('parseWaveJSON('), 'hash 导入（含 #LZ 压缩链）只用 parseLoose，不触碰 eval');
  const imStart = editorSrcFull.indexOf('function importFile');
  const imCall = editorSrcFull.indexOf('applyDocJSON(', imStart);
  ok(imStart >= 0 && imCall > imStart && !editorSrcFull.slice(imStart, imCall).includes('parseWaveJSON('), '文件导入只用 parseLoose');
  ok((editorSrcFull.match(/parseWaveJSON\(/g) || []).length === 3, 'parseWaveJSON（求值）全库仅 3 处：定义 + 代码框 + 粘贴框');
  const sb2 = { JSON };
  vm.createContext(sb2);
  vm.runInContext(edLoose[0], sb2);
  ok(JSON.stringify(sb2.parseLoose("{ signal: [ { name: 'clk', wave: 'p...', }, ], } // 尾注")) === JSON.stringify({ signal: [{ name: 'clk', wave: 'p...' }] }), 'index.html 的 parseLoose 同样吃宽松写法');

  /* ---- 9. 编辑面板位置设置（wavedrom-gui.editorPanelPosition，默认 beside） ---- */
  const { editorPanelPosition, openEditor } = ext.__test;
  const openWith = async pos => {
    fakePanels.length = 0; fakeCommands.length = 0;
    if (pos === undefined) delete fakeConfig.editorPanelPosition;
    else fakeConfig.editorPanelPosition = pos;
    openEditor({ kind: 'fence', docPath: mdPath, fenceRaw: A2, line: 2 });
    await new Promise(r => setTimeout(r, 30)); // 等 placePanel 的异步判断
    const p = fakePanels[0];
    return { column: p && p.column, width: p && p.webview.html.length, commands: fakeCommands.slice() };
  };
  const MOVE_BELOW = 'workbench.action.moveEditorToBelowGroup';
  const MOVE_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';

  ok(editorPanelPosition() === 'current', '未配置时入口位置为 current');
  const def = await openWith(undefined);
  ok(def.column === fakeVscode.ViewColumn.Active && def.commands.length === 0, 'current（默认）：开在当前栏里作标签页，不新增分栏、不调用移动命令');
  ok(def.width > 1000, '默认位置：面板载入了编辑器界面');

  const beside = await openWith('beside');
  ok(beside.column === fakeVscode.ViewColumn.Beside && beside.commands.length === 0, 'beside：在右侧新开一栏，不调用任何移动命令');

  const below = await openWith('below');
  ok(below.column === fakeVscode.ViewColumn.Active, 'below：先落在当前栏');
  ok(below.commands.join(',') === MOVE_BELOW, 'below：随后交给「移动到下方组」命令（VS Code 会按需新建该组）');

  const win = await openWith('newWindow');
  ok(win.column === fakeVscode.ViewColumn.Active, 'newWindow：先落在当前栏');
  ok(win.commands.join(',') === MOVE_NEW_WINDOW, 'newWindow：随后交给「移动到新窗口」命令');

  fakeConfig.editorPanelPosition = '乱填的';
  const bad = await openWith('乱填的');
  ok(editorPanelPosition() === 'current' && bad.column === fakeVscode.ViewColumn.Active && bad.commands.length === 0, '取值非法时回退 current');
  delete fakeConfig.editorPanelPosition;

  /* 面板始终没拿到焦点时不许执行移动命令：那两个命令作用于活动编辑器，否则会把预览搬走 */
  fakePanels.length = 0; fakeCommands.length = 0;
  fakeConfig.editorPanelPosition = 'below';
  fakeNewPanelActive = false;
  openEditor({ kind: 'fence', docPath: mdPath, fenceRaw: A2, line: 2 });
  await new Promise(r => setTimeout(r, 700));
  fakeNewPanelActive = true;
  ok(fakeCommands.length === 0, '面板未取得焦点时不执行移动命令（不搬走别的编辑器）');
  delete fakeConfig.editorPanelPosition;

  const posProp = pkg.contributes.configuration.properties['wavedrom-gui.editorPanelPosition'];
  ok(posProp && posProp.default === 'current' && posProp.enum.join(',') === 'current,beside,below,newWindow', 'package.json 声明了面板位置设置，默认 current、四个可选值');

  /* ---- 9b. 图片像素写回：关闭/切走面板立即落盘，不同源的像素不写 ---- */
  const pxDoc1 = JSON.stringify({ signal: [{ name: 'p1', wave: '1.' }] });
  const pxDoc2 = JSON.stringify({ signal: [{ name: 'p2', wave: '0.' }] });
  const pxDoc3 = JSON.stringify({ signal: [{ name: 'p3', wave: '1.' }] });
  const pxPath = path.join(tmp, 'px.png');
  fs.writeFileSync(pxPath, png2); // 初始内容：png1 之外的像素 + json2 元数据
  const openImg = () => {
    fakePanels.length = 0; fakeCommands.length = 0;
    openEditor({ kind: 'image', docPath: docMd, imgPath: pxPath });
    return fakePanels[0];
  };

  /* 关闭面板：宿主手里的像素 + 最新元数据一次落盘，并刷新预览 */
  let pxPanel = openImg();
  pxPanel.webview._onMsg({ type: 'save', json: pxDoc1, text: null });
  ok(meta.pngExtractWaveJSON(fs.readFileSync(pxPath)) === pxDoc1, 'save 消息即时更新图片元数据（像素不动）');
  ok(pxPanel.webview.html.includes('"kind":"skill-modern"'), '无标记 PNG 打开即注入 skill-modern 渲染器（兜底默认）');
  pxPanel.webview._onMsg({ type: 'pixels', json: pxDoc1, png: png1.toString('base64') });
  pxPanel.dispose();
  ok(fs.readFileSync(pxPath).equals(meta.pngReplaceITXt(png1, meta.WD_PNG_KEYWORD, pxDoc1)), '关闭面板：像素按上报内容重写并嵌入最新元数据');
  ok(fakeCommands.includes('markdown.preview.refresh'), '像素落盘后主动刷新 Markdown 预览');
  ok(!fs.existsSync(pxPath + '.wdtmp'), '临时文件已清理（临时文件 + rename 原子写）');

  /* 像素与当前元数据不同源（渲染没跟上）时不写：保持「元数据新、像素旧」的现状语义 */
  pxPanel = openImg();
  pxPanel.webview._onMsg({ type: 'save', json: pxDoc2, text: null });
  const beforeStale = fs.readFileSync(pxPath);
  pxPanel.webview._onMsg({ type: 'pixels', json: pxDoc1, png: png1.toString('base64') });
  pxPanel.dispose();
  ok(fs.readFileSync(pxPath).equals(beforeStale), '不同源的迟到像素不落盘（不覆盖刚写回的新元数据）');

  /* 切走面板标签同样立即落盘（placePanel 搬动面板时 pendingPx 为空，自然跳过） */
  pxPanel = openImg();
  pxPanel.webview._onMsg({ type: 'save', json: pxDoc3, text: null });
  pxPanel.webview._onMsg({ type: 'pixels', json: pxDoc3, png: png1.toString('base64') });
  pxPanel.fireViewState(false);
  ok(fs.readFileSync(pxPath).equals(meta.pngReplaceITXt(png1, meta.WD_PNG_KEYWORD, pxDoc3)), '切走标签：像素立即落盘');
  ok(meta.pngExtractWaveJSON(fs.readFileSync(pxPath)) === pxDoc3, '落盘内容内嵌的元数据与像素同源');

  /* ---- 10. 中英双语：扩展宿主 l10n 包 + package.nls 包 ---- */
  const readJson = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  const l10nEn = readJson('l10n/bundle.l10n.json');
  const l10nZh = readJson('l10n/bundle.l10n.zh-cn.json');
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  /* 源语言是英文：从 extension.js 里把 t('…') 与 EXPIRED 用到的串全数抽出 */
  const tKeys = new Set([...extSrc.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]));
  const expiredKey = /const EXPIRED = '((?:[^'\\]|\\.)*)'/.exec(extSrc);
  if (expiredKey) tKeys.add(expiredKey[1]);
  ok(tKeys.size >= 18, '扩展里的运行时文案都走 t()（共 ' + tKeys.size + ' 条）');
  const missingZh = [...tKeys].filter(k => !(k in l10nZh));
  ok(missingZh.length === 0, 'zh 语言包覆盖全部运行时文案' + (missingZh.length ? '（缺：' + missingZh.join(' / ') + '）' : ''));
  const unusedZh = Object.keys(l10nZh).filter(k => !tKeys.has(k));
  ok(unusedZh.length === 0, 'zh 语言包没有多余键' + (unusedZh.length ? '（多：' + unusedZh.join(' / ') + '）' : ''));
  ok(Object.values(l10nZh).every(v => /[\u4e00-\u9fa5]/.test(v)), 'zh 语言包的值都是中文');
  ok(!Object.keys(l10nEn).length, '默认语言包为空（源语言即英文，无需翻译）');
  ok(l10nZh[expiredKey[1]] === 'WaveDrom: 预览里的图表已过期，重新打开预览后再试', '关键提示（预览过期）有中文译文');

  /* package.json 的贡献点用 %key% 占位符，两个 nls 包都要有 */
  const pkgRaw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const nlsKeys = [...new Set([...pkgRaw.matchAll(/%([a-zA-Z0-9._-]+)%/g)].map(m => m[1]))];
  const nlsEn = readJson('package.nls.json');
  const nlsZh = readJson('package.nls.zh-cn.json');
  ok(nlsKeys.length >= 12, '命令/设置文案改用 %key% 占位符（共 ' + nlsKeys.length + ' 个）');
  ok(nlsKeys.every(k => k in nlsEn && k in nlsZh), 'package.nls.json 与 zh-cn 覆盖全部占位符');
  ok(Object.keys(nlsEn).sort().join(',') === Object.keys(nlsZh).sort().join(','), 'en / zh 两份 nls 的键集合一致');
  ok(Object.values(nlsZh).every(v => /[\u4e00-\u9fa5]/.test(v)), 'nls zh 包的值都是中文');
  ok(Object.values(nlsEn).every(v => !/[\u4e00-\u9fa5]/.test(v)), 'nls en 包不含中文');
  ok(pkg.l10n === './l10n', 'package.json 声明了 l10n 目录');
  ok(!/[\u4e00-\u9fa5]/.test(pkg.contributes.commands.map(c => c.title).join('')), '命令标题里不再硬编码中文');

  /* zh 显示语言下，扩展宿主消息与预览里的文案都走中文包（webview 文案由扩展渲染进去） */
  fakeVscode.l10n = {
    t: (msg, ...args) => args.reduce((s, a, i) => s.replace('{' + i + '}', String(a)), l10nZh[msg] || msg),
  };
  const zhPreview = md.render('```wavedrom\n' + jsonSrc + '\n```\n', env);
  ok(/data-edit-label="编辑"/.test(zhPreview) && /data-edit-title="编辑（在可视化编辑器中打开）"/.test(zhPreview), 'zh：预览入口文案按语言渲染进 HTML');
  ok((zhPreview.match(/id="wd-i18n"/g) || []).length === 1, 'zh：文案元素每次渲染只插一份');
  ok(/data-edit-label="编辑"/.test(md.render('```wavedrom\n' + jsonSrc + '\n```\n', env)), 'zh：env 被复用时仍会插入文案元素（core 规则重置标记）');
  fakeMessages.length = 0;
  fakeUriHandler.handleUri(uriOf('vscodium://wavedrom-gui.wavedrom-gui-vscode/edit?k=deadbeef0123'));
  ok(/已过期/.test(fakeMessages[0][1] || ''), 'zh：宿主提示走中文语言包（带占位符替换）');
  fakeMessages.length = 0;
  await editFenceCommand({ kind: 'fence', docPath: mdPath, fenceRaw: '对不上的内容', line: 0 });
  ok(/找不到这个代码块/.test(fakeMessages[0][1] || ''), 'zh：错误消息同样翻译');
  delete fakeVscode.l10n;

  const enPreview = md.render('```wavedrom\n' + jsonSrc + '\n```\n', env);
  ok(/data-edit-label="Edit"/.test(enPreview), 'en：无语言包时预览入口文案为英文源串');

  /* preview.js：读到 zh 文案元素时用中文，缺失时回退英文 */
  fakeI18nNode = fakeEl('div');
  fakeI18nNode.dataset.editLabel = '编辑';
  fakeI18nNode.dataset.editTitle = '编辑（在可视化编辑器中打开）';
  const zhBtn = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'button');
  const zhEdit = find(zhBtn, 'wd-edit');
  ok(zhEdit.getAttribute('aria-label') === '编辑' && /编辑（在可视化编辑器中打开）/.test(zhEdit.title || ''), 'zh：预览按钮读扩展给的文案');
  fakeI18nNode = null;
  const enBtn = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'button');
  ok(find(enBtn, 'wd-edit').getAttribute('aria-label') === 'Edit', 'en：缺文案元素时回退英文');

  /* 编辑器面板（index.html）按 VS Code 语言初始化，且不覆盖用户选过的语言 */
  const zhPanel = buildEditorHtml('{"signal":[]}', 'k1');  ok(/localStorage\.getItem\('wdgui-lang'\)/.test(zhPanel) && /localStorage\.setItem\('wdgui-lang'/.test(zhPanel), '编辑器界面打开时按 VS Code 语言写入初始语言');
  ok(/localStorage\.getItem\('wdgui-lang'\)/.test(zhPanel) && zhPanel.indexOf("getItem('wdgui-lang')") < zhPanel.indexOf("setItem('wdgui-lang'"), '先判断是否已有语言偏好，有则不覆盖');

  /* ---- 11. 编辑器面板的视图模式（wavedrom-gui.editorViewMode，默认 simple） ---- */
  const { editorViewMode } = ext.__test;
  /* 只取扩展注入的那段初始化脚本——index.html 自己也有 wdgui-viewmode 字样，不能全串匹配 */
  const initScript = html => {
    const m = /<script>(try \{ if \(!localStorage\.getItem\('wdgui-lang'\)[\s\S]*?<\/script>)/.exec(html);
    return m ? m[1] : '';
  };
  ok(editorViewMode() === 'simple', '未配置时视图模式为 simple');
  const initDefault = initScript(buildEditorHtml('{"signal":[]}', 'k1'));
  ok(/setItem\('wdgui-viewmode', 'simple'\)/.test(initDefault), '默认：打开面板时在注入脚本里把视图模式写成简约模式');
  ok(initDefault.indexOf('hash = ') > initDefault.indexOf("setItem('wdgui-viewmode'"), '写入视图模式发生在界面按 hash 启动之前');
  fakeConfig.editorViewMode = 'auto';
  ok(editorViewMode() === 'auto' && !/wdgui-viewmode/.test(initScript(buildEditorHtml('{"signal":[]}', 'k1'))), 'auto：注入脚本里不碰视图模式，沿用界面自己的偏好');
  fakeConfig.editorViewMode = '乱填的';
  ok(editorViewMode() === 'simple' && /setItem\('wdgui-viewmode', 'simple'\)/.test(initScript(buildEditorHtml('{"signal":[]}', 'k1'))), '取值非法时回退 simple');
  delete fakeConfig.editorViewMode;
  const vmProp = pkg.contributes.configuration.properties['wavedrom-gui.editorViewMode'];
  ok(vmProp && vmProp.default === 'simple' && vmProp.enum.join(',') === 'simple,auto', 'package.json 声明了视图模式设置，默认 simple、可选 simple/auto');

  /* ---- 11b. 「通道与分组」左栏（wavedrom-gui.editorSidePanel，默认展开） ---- */
  const { editorSidePanel } = ext.__test;
  ok(editorSidePanel() === 'shown', '未配置时左栏为 shown');
  ok(/setItem\('wdgui-side-dock', '1'\)/.test(initScript(buildEditorHtml('{"signal":[]}', 'k1'))), '默认：打开面板时把「通道与分组」左栏写成展开（界面自身默认是隐藏）');
  fakeConfig.editorSidePanel = 'auto';
  ok(editorSidePanel() === 'auto' && !/wdgui-side-dock/.test(initScript(buildEditorHtml('{"signal":[]}', 'k1'))), 'auto：注入脚本里不碰左栏显隐，沿用界面偏好');
  fakeConfig.editorSidePanel = '乱填的';
  ok(editorSidePanel() === 'shown' && /setItem\('wdgui-side-dock', '1'\)/.test(initScript(buildEditorHtml('{"signal":[]}', 'k1'))), '取值非法时回退 shown');
  delete fakeConfig.editorSidePanel;
  const spProp = pkg.contributes.configuration.properties['wavedrom-gui.editorSidePanel'];
  ok(spProp && spProp.default === 'shown' && spProp.enum.join(',') === 'shown,auto', 'package.json 声明了左栏设置，默认 shown、可选 shown/auto');
  /* 两项面板布局偏好互不影响 */
  fakeConfig.editorSidePanel = 'auto';
  const onlyView = initScript(buildEditorHtml('{"signal":[]}', 'k1'));
  ok(/setItem\('wdgui-viewmode', 'simple'\)/.test(onlyView) && !/wdgui-side-dock/.test(onlyView), '视图模式与左栏两项设置各自独立生效');
  delete fakeConfig.editorSidePanel;

  /* ---- 12. 语言设置与中文保底（wavedrom-gui.language，默认 auto） ---- */
  const { languageSetting, uiLang, zhStrings, t } = ext.__test;
  ok(languageSetting() === 'auto' && uiLang() === 'en', '默认 language=auto（此断言时 env.language=en，故判定英文）');
  ok(Object.keys(zhStrings()).length >= 24, '自带中文表已从 l10n 包读入（' + Object.keys(zhStrings()).length + ' 条）');

  /* auto + 界面中文 + VS Code 本地化管道「什么都没翻出来」→ 仍走中文表（这就是用户报的故障场景） */
  fakeVscode.env.language = 'zh-cn';
  delete fakeVscode.l10n; // 模拟 l10n 缺失 / 管道静默返回源串
  ok(languageSetting() === 'auto' && uiLang() === 'zh', 'auto：env.language=zh-cn 判定为中文');
  ok(t('Edit waveform') === '编辑波形', 'auto + 中文界面 + 无 l10n：文案仍为中文（内置表兜底）');
  ok(t('WaveDrom: Failed to read the diagram — {0}', 'x') === 'WaveDrom: 读取图表失败 — x', '兜底路径下占位符替换正确');

  /* auto + 界面英文 → 英文源串 */
  fakeVscode.env.language = 'en-US';
  ok(uiLang() === 'en' && t('Edit waveform') === 'Edit waveform', 'auto：英文界面用英文源串');

  /* 语言信息拿不到 → 中文保底 */
  fakeVscode.env.language = '';
  ok(uiLang() === 'zh' && t('Edit waveform') === '编辑波形', 'auto：拿不到界面语言时中文保底');
  delete fakeVscode.env.language;
  ok(uiLang() === 'zh', 'auto：env.language 缺失同样中文保底');
  fakeVscode.env.language = 'en';

  /* 强制 zh / en 覆盖界面语言 */
  fakeConfig.language = 'zh';
  ok(uiLang() === 'zh' && t('Edit waveform') === '编辑波形', 'language=zh：英文界面下也强制中文');
  fakeVscode.l10n = { t: msg => msg }; // 管道只回源串，也不影响强制中文
  ok(t('Edit waveform') === '编辑波形', 'language=zh：不依赖 VS Code 管道');
  fakeConfig.language = 'en';
  fakeVscode.env.language = 'zh-cn';
  ok(uiLang() === 'en' && t('Edit waveform') === 'Edit waveform', 'language=en：中文界面下也强制英文');
  delete fakeVscode.l10n; delete fakeConfig.language;
  fakeVscode.env.language = 'en';

  /* 语言设置还会驱动编辑器界面的初始语言（两处一致） */
  fakeConfig.language = 'zh';
  ok(/setItem\('wdgui-lang', "zh"\)/.test(initScript(buildEditorHtml('{"signal":[]}', 'k1'))), 'language=zh：编辑器界面初始语言也写 zh');
  delete fakeConfig.language;

  const langProp = pkg.contributes.configuration.properties['wavedrom-gui.language'];
  ok(langProp && langProp.default === 'auto' && langProp.enum.join(',') === 'auto,zh,en', 'package.json 声明了语言设置，默认 auto、可选 auto/zh/en');

  /* zh-hans 兼容别名（万一宿主报的语言 id 不是 zh-cn） */
  const zhHansNls = readJson('package.nls.zh-hans.json');
  const zhHansBundle = readJson('l10n/bundle.l10n.zh-hans.json');
  ok(JSON.stringify(zhHansNls) === JSON.stringify(nlsZh), 'package.nls.zh-hans.json 与 zh-cn 内容一致');
  ok(JSON.stringify(zhHansBundle) === JSON.stringify(l10nZh), 'l10n/bundle.l10n.zh-hans.json 与 zh-cn 内容一致');

  console.log('\n全部 ' + passed + ' 项断言通过');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

