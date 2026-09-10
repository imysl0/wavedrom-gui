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
let fakeNewPanelActive = true; // 新建面板是否立即成为活动编辑器（用于测「始终没拿到焦点」）
const fakeVscode = {
  Uri: { parse: s => ({ fsPath: s, scheme: 'file' }) },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  WorkspaceEdit: class { replace(uri, range, text) { this._uri = uri; this._range = range; this._text = text; } },
  window: {
    showErrorMessage() {}, showInformationMessage() {}, setStatusBarMessage() {},
    showQuickPick: async p => p[0],
    createWebviewPanel(viewType, title, column, options) {
      const panel = {
        viewType, title, column, options, active: fakeNewPanelActive, disposed: false,
        webview: { html: '', onDidReceiveMessage() { return { dispose() {} }; } },
        dispose() { this.disposed = true; },
      };
      fakePanels.push(panel);
      return panel;
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
    registerCommand: () => ({ dispose() {} }),
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

/* 3b. 标题里的 ```wavedrom 不得被误认成围栏开头（回归：曾导致写回错位） */
const trapMd = '## 标题（```wavedrom 围栏）\n\n```wavedrom\n{"signal":[{}]}\n```\n';
const trapHit = findFence(trapMd, ['{"signal":[{}]}']);
ok(trapHit && trapHit[1].trim() === '{"signal":[{}]}', '行首锚定：标题内反引号不再干扰围栏定位');
ok((trapMd.match(FENCE_RE) || []).length === 1, '锚定后仅匹配真实围栏');

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

  /* ---- 4b. 编辑入口形式设置（wavedrom-gui.previewEditAffordance，默认 button） ---- */
  const { editAffordance } = ext.__test;
  ok(/data-edit-mode="button"/.test(htmlFence), '默认入口形式为 button（右上角铅笔按钮）');
  fakeConfig.previewEditAffordance = 'block';
  ok(editAffordance() === 'block', '设置为 block 时读到 block');
  const htmlBlockMode = md.render('```wavedrom\n' + jsonSrc + '\n```\n', env);
  ok(/data-edit-mode="block"/.test(htmlBlockMode), 'block 设置写进渲染结果（点波形即编辑）');
  fakeConfig.previewEditAffordance = '不认识的取值';
  ok(editAffordance() === 'button' && /data-edit-mode="button"/.test(md.render('```wavedrom\n' + jsonSrc + '\n```\n', env)), '取值非法时回退 button');
  delete fakeConfig.previewEditAffordance;
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const prop = pkg.contributes.configuration.properties['wavedrom-gui.previewEditAffordance'];
  ok(prop && prop.default === 'button' && prop.enum.join(',') === 'button,block', 'package.json 声明了该设置，默认 button、可选 block');

  const htmlImg = md.render('![波形](./embedded.png)\n', env);
  ok(htmlImg.includes('data-wd="image"'), '带元数据图片被识别包装');
  ok(/data-edit-mode="button"/.test(htmlImg), '图片块同样携带入口形式设置');
  const mI = /data-json="([^"]+)"/.exec(htmlImg);
  ok(mI && Buffer.from(mI[1], 'base64').toString('utf8') === json2, '图片元数据 JSON 完整携带');

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
  ok(/\.wd-figure/.test(previewCss) && /\.wd-actions/.test(previewCss) && /button\.wd-edit/.test(previewCss), 'preview.css 含图形容器、操作行与图标按钮样式');
  ok(/\.wd-figure\s*\{[^}]*display:\s*inline-block/.test(previewCss), '图形容器收缩到图形自身宽度（窄图时按钮贴图形右上角）');

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
  const runPreview = (renderModern, editMode) => {
    const block = fakeEl('div');
    block.dataset.wd = 'fence';
    if (editMode) block.dataset.editMode = editMode;
    block.dataset.json = Buffer.from(JSON.stringify({ signal: [{ name: 'clk', wave: 'p...' }] }), 'utf8').toString('base64');
    const doc = {
      createElement: fakeEl,
      body: fakeEl('body'),
      querySelectorAll: sel => (String(sel).indexOf('.wavedrom-block') === 0 ? [block] : []),
    };
    const ctx = {
      document: doc, window: { WaveDromModern: { renderModern } }, MutationObserver: class { observe() {} },
      setTimeout, clearTimeout, Image: class {}, btoa, atob, unescape, escape, console,
    };
    vm.createContext(ctx);
    vm.runInContext(previewSrc, ctx);
    return block;
  };

  const block = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'button');
  ok(block.children.length === 1 && block.children[0].className === 'wd-figure', '块内只有一层 .wd-figure');
  const figure = block.children[0];
  const actions = figure.children[0], holder = figure.children[1];
  ok(actions.className === 'wd-actions' && holder.className === 'wd-svg', 'button 模式：结构为 .wd-actions + .wd-svg');
  ok(actions.children.length === 1 && actions.children[0].className === 'wd-edit', '操作行内只有编辑按钮');
  const edit = actions.children[0];
  ok(edit.getAttribute('aria-label') === '编辑' && /编辑/.test(edit.title || ''), '编辑按钮有无障碍名与悬停提示');
  ok(!/<text|✏/.test(edit.innerHTML) && /<svg/.test(edit.innerHTML), '按钮用内联描边图标，不用 emoji 字形');
  ok(texts(block).join(' ').indexOf('源码') < 0, '预览块内不再出现「源码」按钮文字');
  ok(typeof edit.listeners.click === 'object', '编辑按钮绑定了点击（回环信标）');
  ok(!block.classList.contains('wd-clickable'), 'button 模式：块本身不是点击目标');

  /* block 模式：无按钮，整块可点（含键盘） */
  const clickable = runPreview(() => ({ svg: '<svg width="10" height="10"><g/></svg>' }), 'block');
  ok(clickable.classList.contains('wd-clickable'), 'block 模式：块带可点标记（指针形状）');
  ok(!find(clickable, 'wd-edit') && !find(clickable, 'wd-actions'), 'block 模式：不渲染任何按钮，也不留空操作行');
  ok(clickable.getAttribute('role') === 'button' && clickable.getAttribute('tabindex') === '0', 'block 模式：块可聚焦、声明为按钮');
  ok(/编辑/.test(clickable.title || ''), 'block 模式：有悬停提示说明可点');
  ok(typeof clickable.listeners.click === 'object' && typeof clickable.listeners.keydown === 'object', 'block 模式：绑定点击与键盘（Enter/Space）');

  const broken = runPreview(() => { throw new Error('坏 JSON'); }, 'button');
  ok(broken.children[0].children.some(c => c.className === 'wd-code'), '渲染失败时仍回退显示 WaveJSON 原文');

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

  console.log('\n全部 ' + passed + ' 项断言通过');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

