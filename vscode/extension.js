'use strict';
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  svgWithMeta, svgExtractWaveJSON,
  pngReplaceITXt, pngExtractWaveJSON,
} = require('./lib/meta-embed.js');

/* 围栏两端都要锚定：开头必须行首（0-3 空格缩进，与 markdown-it 一致），否则正文里
   的 ```wavedrom 字样（如小标题）会被误认成围栏开头，导致定位/写回错位；结尾必须
   整行只有反引号（可带尾随空白），否则下一个块的开头围栏会被当成闭合围栏，一次匹配
   横跨两块。大小写与预览侧 isWaveFence 一致（i），避免预览认、写回不认。 */
const FENCE_RE = /^(?: {0,3})```+[ \t]*wave(?:drom|json)\b[^\n]*\n([\s\S]*?)^ {0,3}```[ \t]*(?:\r?\n|$)/gmi;
const bridgeRegistry = new Map(); // k -> { kind:'fence'|'image', docPath, fenceRaw, line, imgPath }

/* ---------------- 回环桥：预览 webview 的「编辑」按钮经图片信标到达扩展主进程 ----------------
 * 预览 CSP 允许 img-src http:，但 script/connect 均被禁，且没有公开的预览→扩展消息通道，
 * 因此用 127.0.0.1 上的一次性端口 + 随机 token 的 GET 图片信标最为稳妥。 */
let bridge = null;
let bridgeStarting = null;

function ensureBridge() {
  if (bridge) return Promise.resolve(bridge);
  if (bridgeStarting) return bridgeStarting;
  const token = crypto.randomBytes(12).toString('hex');
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (bridge && u.searchParams.get('t') === bridge.token && u.pathname === '/edit') {
        const target = bridgeRegistry.get(u.searchParams.get('k'));
        if (target) openEditor(target);
      }
    } catch (e) { /* 忽略桥上的一切错误 */ }
  });
  bridgeStarting = new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      bridge = { port: server.address().port, token, server };
      if (_ctx) _ctx.subscriptions.push({ dispose: () => { try { server.close(); } catch (e) { /* noop */ } } });
      resolve(bridge);
    });
  });
  return bridgeStarting;
}

function registerKey(info) {
  /* 淘汰最旧的一半；整表清空会让已渲染预览里的「编辑」按钮集体失效 */
  if (bridgeRegistry.size > 800) {
    let drop = bridgeRegistry.size - 400;
    for (const key of bridgeRegistry.keys()) { if (drop-- <= 0) break; bridgeRegistry.delete(key); }
  }
  const k = crypto.createHash('sha1').update(JSON.stringify(info)).digest('hex').slice(0, 12);
  bridgeRegistry.set(k, info);
  return k;
}

/* ---------------- markdown-it 插件 ---------------- */
function makePlugin() {
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  const isWaveFence = info => /^wave(?:drom|json)\b/i.test((info || '').trim());

  return function (md) {
    const prevFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (!isWaveFence(token.info)) {
        return prevFence ? prevFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      }
      const raw = (token.content || '').trim();
      const docFs = docFsPath(env);
      let editAttr = '';
      if (docFs && bridge) {
        /* 记下围栏所在行：内容相同的多个代码块只能靠行号区分，否则编辑第二个会写回第一个 */
        const line = token.map ? token.map[0] : null;
        const k = registerKey({ kind: 'fence', docPath: docFs, fenceRaw: raw, line });
        editAttr = ` data-k="${k}" data-doc="${escapeAttr(docFs)}" data-port="${bridge.port}" data-token="${bridge.token}"`;
      }
      return `<div class="wavedrom-block" data-wd="fence" data-json="${b64(raw)}"${editAttr}></div>\n`;
    };

    const prevImage = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const imgHtml = prevImage
        ? prevImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
      const docFs = docFsPath(env);
      if (!docFs || !bridge) return imgHtml;
      const probe = probeImagePath(docFs, token.attrGet('src'));
      if (!probe) return imgHtml;
      const k = registerKey({ kind: 'image', docPath: docFs, imgPath: probe.absPath });
      return `<span class="wavedrom-block" data-wd="image" data-json="${b64(probe.text)}" data-img="${escapeAttr(probe.relSrc)}" data-k="${k}" data-doc="${escapeAttr(docFs)}" data-port="${bridge.port}" data-token="${bridge.token}">${imgHtml}</span>\n`;
    };
  };
}

function docFsPath(env) {
  const u = env && env.currentDocument;
  if (!u) return null;
  try { return u.fsPath || (typeof u === 'string' ? vscode.Uri.parse(u).fsPath : null); }
  catch (e) { return null; }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 解析图片相对路径并读取内嵌 WaveJSON；无内嵌或读不到时返回 null */
function probeImagePath(docFs, src) {
  if (!src) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(src);
  if (hasScheme && !/^[a-z]:[\\/]/i.test(src)) return null; // http:/data: 等协议跳过（Windows 盘符除外）
  if (src.startsWith('#') || src.startsWith('//')) return null;
  let p = src;
  try { p = decodeURIComponent(src); } catch (e) { /* 保留原样 */ }
  const abs = path.isAbsolute(p) ? p : path.join(path.dirname(docFs), p);
  if (!/\.(png|svg)$/i.test(abs)) return null;
  try {
    const bytes = fs.readFileSync(abs);
    const text = /\.svg$/i.test(abs)
      ? svgExtractWaveJSON(bytes.toString('utf8'))
      : pngExtractWaveJSON(bytes);
    return text ? { absPath: abs, relSrc: src, text } : null;
  } catch (e) { return null; }
}

/* ---------------- 可视化编辑面板（复用 index.html） ---------------- */
function openEditor(target) {
  let jsonText;
  try {
    if (target.kind === 'fence') jsonText = target.fenceRaw;
    else {
      const bytes = fs.readFileSync(target.imgPath);
      jsonText = /\.svg$/i.test(target.imgPath)
        ? svgExtractWaveJSON(bytes.toString('utf8'))
        : pngExtractWaveJSON(bytes);
    }
  } catch (e) { vscode.window.showErrorMessage('WaveDrom: 读取图表失败 — ' + e.message); return; }
  if (!jsonText) { vscode.window.showErrorMessage('WaveDrom: 该目标中没有可编辑的 WaveJSON'); return; }

  /* 先备好 HTML 再建面板：界面读不到时直接报错返回，不留下一个空白面板 */
  let html;
  try { html = buildEditorHtml(jsonText, panelDocKey(target)); }
  catch (e) { vscode.window.showErrorMessage('WaveDrom: 编辑器界面加载失败 — ' + e.message); return; }

  const name = path.basename(target.kind === 'fence' ? target.docPath : target.imgPath);
  const panel = vscode.window.createWebviewPanel(
    'wavedromGuiEditor', 'WaveDrom 编辑 — ' + name,
    vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = html;

  const saveTarget = Object.assign({}, target); // fenceRaw 会随每次保存演进
  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'save' && msg.json) saveBack(saveTarget, msg.json);
  });
}

/* 每个编辑目标一份独立的自动保存键：webview 之间共享 localStorage，若都用 wdgui-doc-v1，
   另一个面板的改动会被本面板的轮询当成自己的文档写回，导致 A 块被 B 的内容覆盖。
   按目标（文件 + 行号 / 图片路径）派生，同一块复用同一个键，条目数不会无限增长 */
function panelDocKey(target) {
  const id = target.kind === 'fence'
    ? target.docPath + '#' + (target.line == null ? (target.fenceRaw || '') : target.line)
    : target.imgPath;
  return 'wdgui-doc-v1:' + crypto.createHash('sha1').update(id).digest('hex').slice(0, 12);
}

/* 编辑器界面来源：仓库内调试时 extensionUri 就是 vscode/，同级 ../index.html 是正在改的
   实时界面（F5 下改动立即生效，无需先构建）；装了 VSIX 之后同级没有 index.html，回退到
   随包安装的 media/editor.html（scripts/build.js 从仓库根 index.html 拷入）。 */
function editorShellPath() {
  const live = path.join(_ctx.extensionUri.fsPath, '..', 'index.html');
  if (fs.existsSync(live)) return live;
  return path.join(_ctx.extensionUri.fsPath, 'media', 'editor.html');
}

function buildEditorHtml(initialJson, docKey = 'wdgui-doc-v1') {
  let html = fs.readFileSync(editorShellPath(), 'utf8');
  html = html.replace(/'wdgui-doc-v1'/g, `'${docKey}'`);
  /* img-src 必须含 blob:——编辑器导出 PNG 时把 SVG 包成 blob URL 再交给 new Image()，
     少了它导出会卡在 onload 永不触发（预览/画布的 data: 路径不受影响） */
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; `
    + `style-src 'unsafe-inline' https://registry.npmmirror.com https://fonts.googleapis.com; `
    + `font-src https://registry.npmmirror.com https://fonts.gstatic.com data:; img-src data: blob: https:;">`;
  html = html.replace(/(<meta charset="utf-8">)/i, `$1\n${csp}`);
  const init = `<script>location.hash = ${JSON.stringify(encodeURIComponent(initialJson))};</script>\n`;
  html = html.replace(/(<body[^>]*>)/i, `$1\n${init}`);
  const poller = `<script>
(function () {
  var vs = acquireVsCodeApi();
  var KEY = ${JSON.stringify(docKey)};
  var last = null, armed = false;
  setTimeout(function () {
    try { last = localStorage.getItem(KEY); } catch (e) {}
    armed = true;
    try {
      var h = decodeURIComponent(location.hash.slice(1));
      if (h && h !== last) last = h; // 打开时的初始文档不回写
    } catch (e) {}
  }, 1200);
  setInterval(function () {
    if (!armed) return;
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) { return; }
    if (v && v !== last) {
      last = v;
      try { JSON.parse(v); vs.postMessage({ type: 'save', json: v }); } catch (e) {}
    }
  }, 500);
})();
</script>
`;
  html = html.replace(/<\/body>/i, poller + '</body>');
  return html;
}

function lineOfIndex(text, index) {
  let line = 0;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function findFence(text, wanted, lineHint) {
  const list = wanted.filter(s => s && s.trim());
  const norm = s => String(s).replace(/\s+/g, '');
  const wantNorm = list.map(norm);
  const hitContent = m => list.some(w => m[1].trim() === w.trim());
  /* 兜底：忽略全部空白差异再比（CRLF / 缩进 / 空格风格漂移都会命中） */
  const hitLoose = m => wantNorm.includes(norm(m[1]));

  const all = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text))) all.push(m);

  /* 行号 + 内容双重要求：内容相同的重复块只有行号能区分；行号漂了（文件被改过）
     则内容对不上，自动退回按内容匹配 */
  if (typeof lineHint === 'number' && lineHint >= 0) {
    const at = all.find(c => lineOfIndex(text, c.index) === lineHint && (hitContent(c) || hitLoose(c)));
    if (at) return at;
  }
  return all.find(hitContent) || all.find(hitLoose) || null;
}

async function saveBack(target, json) {
  let pretty;
  try { pretty = JSON.stringify(JSON.parse(json), null, 2); }
  catch (e) { vscode.window.showErrorMessage('WaveDrom: JSON 无效，已跳过保存'); return; }

  if (target.kind === 'fence') {
    try {
      const doc = await vscode.workspace.openTextDocument(target.docPath);
      let hit = findFence(doc.getText(), [target.fenceRaw, target.lastSaved], target.line);
      if (!hit) {
        /* 兜底：精确与规范化都匹配不到（文件被大改）时，列出全部 wavedrom
           代码块让用户指定写回目标，避免直接报错卡死 */
        const text = doc.getText();
        FENCE_RE.lastIndex = 0;
        const cands = [];
        let m;
        while ((m = FENCE_RE.exec(text))) {
          cands.push({
            label: '``` 代码块 ' + (cands.length + 1),
            description: (m[1].trim().split('\n')[0] || '').slice(0, 60),
            match: m,
          });
        }
        if (!cands.length) { vscode.window.showErrorMessage('WaveDrom: 文件中已没有 wavedrom 代码块'); return; }
        /* 一律让用户确认：唯一候选也自动写回的话，定位失败时会静默改错块甚至吞掉正文 */
        const pick = await vscode.window.showQuickPick(cands, { placeHolder: '找不到原代码块——请选择要写回的代码块' });
        if (!pick) return;
        hit = pick.match;
      }
      const startOff = hit.index + hit[0].indexOf('\n') + 1;
      const body = hit[1];
      /* 闭合围栏前那个换行也在捕获内容里，必须原样补回——否则闭合围栏会被粘到
         JSON 最后一行，代码块不再闭合，后续正文和代码块都会被吞进去 */
      const tailNl = /(\r?\n)$/.exec(body);
      const nl = tailNl ? tailNl[1] : (/\r?\n/.exec(hit[0]) || ['\n'])[0];
      const insert = nl === '\r\n' ? pretty.replace(/\n/g, '\r\n') : pretty;
      const endOff = startOff + body.length;
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(doc.positionAt(startOff), doc.positionAt(endOff)), insert + nl);
      await vscode.workspace.applyEdit(we);
      target.lastSaved = insert;
      vscode.window.setStatusBarMessage('WaveDrom: 已写回代码块（Ctrl+S 保存文件）', 3000);
    } catch (e) { vscode.window.showErrorMessage('WaveDrom: 写回失败 — ' + e.message); }
    return;
  }

  // image：像素不动，只替换内嵌元数据
  try {
    const bytes = fs.readFileSync(target.imgPath);
    const out = /\.svg$/i.test(target.imgPath)
      ? Buffer.from(svgWithMeta(bytes.toString('utf8'), json), 'utf8')
      : pngReplaceITXt(bytes, 'WaveJSON', json);
    fs.writeFileSync(target.imgPath, out);
    target.lastSaved = json;
    vscode.window.setStatusBarMessage('WaveDrom: 已更新图片内嵌 WaveJSON', 3000);
  } catch (e) { vscode.window.showErrorMessage('WaveDrom: 图片写回失败 — ' + e.message); }
}

/* ---------------- 手动兜底命令（预览桥不可用时） ---------------- */
async function editActiveCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    vscode.window.showInformationMessage('请先打开一个 Markdown 文件'); return;
  }
  const docFs = editor.document.uri.fsPath;
  const text = editor.document.getText();
  const picks = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text))) {
    picks.push({
      label: '``` 代码块',
      description: (m[1].trim().split('\n')[0] || '').slice(0, 60),
      target: { kind: 'fence', docPath: docFs, fenceRaw: m[1], line: lineOfIndex(text, m.index) },
    });
  }
  const imgRe = /!\[[^\]]*\]\(([^)]+\.png|[^)]+\.svg)\)/gi;
  while ((m = imgRe.exec(text))) {
    const probe = probeImagePath(docFs, m[1]);
    if (probe) picks.push({ label: '🖼 图片', description: path.basename(probe.absPath), target: { kind: 'image', docPath: docFs, imgPath: probe.absPath } });
  }
  if (!picks.length) { vscode.window.showInformationMessage('当前文件中没有 WaveDrom 代码块或内嵌 WaveJSON 的图片'); return; }
  const pick = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks, { placeHolder: '选择要编辑的 WaveDrom 图表' });
  if (pick) openEditor(pick.target);
}

/* ---------------- activate ---------------- */
let _ctx = null;

async function activate(ctx) {
  _ctx = ctx;
  await ensureBridge();
  ctx.subscriptions.push(vscode.commands.registerCommand('wavedrom-gui.editActive', editActiveCommand));
  return {
    extendMarkdownIt(md) {
      md.use(makePlugin());
      return md;
    },
  };
}

function deactivate() { if (bridge) { try { bridge.server.close(); } catch (e) { /* noop */ } } }

module.exports = { activate, deactivate, __test: { FENCE_RE, probeImagePath, makePlugin, bridgeRegistry, findFence, saveBack, lineOfIndex, buildEditorHtml, panelDocKey } };
