'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  svgWithMeta, svgExtractWaveJSON,
  pngReplaceITXt, pngExtractWaveJSON, pngGetSize,
  svgDetectExportKind, pngDetectExportKind,
} = require('./lib/meta-embed.js');

/* 界面文案：源语言英文，中文表自带一份（l10n/bundle.l10n.zh-cn.json）。
   为什么不只靠 vscode.l10n：那是 VS Code 的本地化管道，bundle 解析不到时会**静默回退英文**
   （且需要 1.73+），实测在装 VSIX 的环境里出现过界面中文、扩展英文的情况。所以自己读一份
   中文表，语言判断失败时按中文保底——本项目以中文为主。 */
let zhTable = null;
function zhStrings() {
  if (zhTable) return zhTable;
  zhTable = {};
  /* zh-cn 是 VS Code 的标准 id；zh-hans / zh 兼容其它写法 */
  for (const f of ['bundle.l10n.zh-cn.json', 'bundle.l10n.zh-hans.json', 'bundle.l10n.zh.json']) {
    try {
      const p = path.join(_ctx.extensionUri.fsPath, 'l10n', f);
      if (fs.existsSync(p)) { Object.assign(zhTable, JSON.parse(fs.readFileSync(p, 'utf8'))); break; }
    } catch (e) { /* 读不到就继续找下一个 */ }
  }
  return zhTable;
}

/* 语言设置（wavedrom-gui.language）：auto = 跟随 VS Code（默认），zh / en = 固定 */
function languageSetting() {
  try {
    const v = vscode.workspace.getConfiguration('wavedrom-gui').get('language');
    return (v === 'zh' || v === 'en') ? v : 'auto';
  } catch (e) { return 'auto'; }
}

/* 最终生效的语言：auto 时看 VS Code 的显示语言；拿不到语言信息就按中文保底 */
function uiLang() {
  const s = languageSetting();
  if (s === 'zh' || s === 'en') return s;
  let host = '';
  try { host = String(vscode.env.language || '').toLowerCase(); } catch (e) { host = ''; }
  if (host.startsWith('zh')) return 'zh';
  if (host) return 'en';
  return 'zh'; // 语言不确定 → 中文保底
}

function t(message, ...args) {
  const fill = s => args.reduce((x, a, i) => x.replace('{' + i + '}', String(a)), s);
  const lang = uiLang();
  if (lang === 'zh') {
    const table = zhStrings();
    if (table[message]) return fill(table[message]);
  }
  const l10n = vscode.l10n;
  if (l10n && typeof l10n.t === 'function') {
    try {
      const out = l10n.t(message, ...args);
      if (out && out !== message) return out;   // VS Code 管道翻出来了就用它
    } catch (e) { /* 管道出错：继续走下面的兜底 */ }
  }
  return fill(message);
}

/* 围栏两端都要锚定：开头必须行首（0-3 空格缩进，与 markdown-it 一致），否则正文里
   的 ```wavedrom 字样（如小标题）会被误认成围栏开头，导致定位/写回错位；结尾必须
   整行只有反引号（可带尾随空白），否则下一个块的开头围栏会被当成闭合围栏，一次匹配
   横跨两块。大小写与预览侧 isWaveFence 一致（i），避免预览认、写回不认。 */
const FENCE_RE = /^(?: {0,3})```+[ \t]*wave(?:drom|json)\b[^\n]*\n([\s\S]*?)^ {0,3}```[ \t]*(?:\r?\n|$)/gmi;
/* 正文图片引用：![alt](path.png|svg)，允许尾随 "title"。路径取到空白或右括号为止；
   预览侧由 markdown-it 的 image token 解析（带 title 也命中），这里保持同一覆盖面 */
const IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+\.(?:png|svg))(?:[ \t]+[^)]*)?\)/gi;
const editTargets = new Map(); // k -> { kind:'fence'|'image', docPath, fenceRaw, line, imgPath }

function registerKey(info) {
  /* 淘汰最旧的一半；整表清空会让已渲染预览里的「编辑」入口集体失效 */
  if (editTargets.size > 800) {
    let drop = editTargets.size - 400;
    for (const key of editTargets.keys()) { if (drop-- <= 0) break; editTargets.delete(key); }
  }
  const k = crypto.createHash('sha1').update(JSON.stringify(info)).digest('hex').slice(0, 12);
  editTargets.set(k, info);
  return k;
}

/* ---------------- 预览 → 扩展：产品 scheme 深链接 ----------------
 * 预览 webview 里读不到我们自己的消息通道（acquireVsCodeApi 已被内置预览脚本占用，
 * postMessage 只会送到 markdown 扩展），command: 链接在预览里也被禁用；而回环图片信标
 * （http://127.0.0.1）在默认的「严格」预览安全级别下会被 CSP 拦下，还会弹出「放宽安全
 * 设置」的提示，普通用户不该被迫改这个设置。
 *
 * 改成由预览里的 <a href="<uriScheme>://<扩展 id>/edit?k=…"> 深链接回来：webview 的链接
 * 白名单接受产品自己的 urlProtocol（VSCodium 是 vscodium、Insiders 是 vscode-insiders，
 * 所以用 vscode.env.uriScheme，不能写死 vscode），点击经 openerService 交给下面的
 * registerUriHandler。全程不发 http 请求，因此不产生 CSP 违规、也不再有那个安全提示。
 *
 * k 是不透明键，同时也是一次点击的授权凭据：注册表里没有的 k 一律拒绝，避免任意
 * markdown 构造一条链接就让扩展去打开任意文件。 */
function editLink(k) {
  return `${vscode.env.uriScheme}://${_ctx.extension.id}/edit?k=${encodeURIComponent(k)}`;
}

const EXPIRED = 'WaveDrom: This diagram in the preview is stale — reopen the preview and try again';

/* 按 k 打开编辑面板；k 不在注册表里（预览过期、扩展重载过、或别人构造的链接）就只提示 */
function openTargetByKey(k) {
  const target = (typeof k === 'string' && k) ? editTargets.get(k) : null;
  if (!target) { vscode.window.showWarningMessage(t(EXPIRED)); return; }
  openEditor(target);
}

function handleUri(uri) {
  if (uri.path !== '/edit') return;
  openTargetByKey(new URLSearchParams(uri.query || '').get('k'));
}

/* 预览里右键菜单「编辑波形」的命令：webview/context 会把 data-vscode-context 的 JSON
   作为第一个参数传进来（与 mermaid 扩展同一机制）。浏览器里的右键菜单不经过 CSP，
   所以这条既是点击入口的补充，也是深链接万一被拦时的备用通道。 */
function editFromPreviewCommand(context) {
  openTargetByKey(context && context.k);
}

/* ---------------- markdown-it 插件 ---------------- */

/* 预览工具栏里的文案：webview 里拿不到 vscode.l10n，所以由扩展按当前语言渲染进 HTML
   （每个文档渲染一次，preview.js 读它的 data-*）。文案同样走 t()，翻译只此一处 */
function previewI18nHtml() {
  return `<div id="wd-i18n" hidden data-edit-label="${escapeAttr(t('Edit'))}"`
    + ` data-edit-title="${escapeAttr(t('Edit (opens in the visual editor)'))}"`
    + ` data-no-renderer="${escapeAttr(t('Waveform renderer not loaded — reopen the preview'))}"></div>\n`;
}

/* 预览里的编辑入口形式（wavedrom-gui.previewEditAffordance）：
   menu = 不加任何可见入口，在波形上右键 →「编辑波形」（默认）；
   button = 波形右上角铅笔按钮；block = 不显示按钮、点波形任意处即编辑。
   三种形式都会写 data-vscode-context，所以右键菜单在任何模式下都可用。
   取不到或取值非法时一律按 menu——渲染结果会烙进 HTML，容错比抛错重要 */
function editAffordance() {
  try {
    const v = vscode.workspace.getConfiguration('wavedrom-gui').get('previewEditAffordance');
    return (v === 'button' || v === 'block') ? v : 'menu';
  } catch (e) { return 'menu'; }
}

function makePlugin() {
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  const isWaveFence = info => /^wave(?:drom|json)\b/i.test((info || '').trim());

  return function (md) {
    /* env 对象可能在多次渲染间复用（VS Code 的预览也会），每次渲染前重置「文案已插入」标记 */
    md.core.ruler.push('wavedrom_gui_i18n_reset', state => {
      if (state.env) state.env.__wdI18nDone = false;
    });
    const prevFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (!isWaveFence(token.info)) {
        return prevFence ? prevFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      }
      const raw = (token.content || '').trim();
      const docFs = docFsPath(env);
      let editAttr = '';
      if (docFs) {
        /* 记下围栏所在行：内容相同的多个代码块只能靠行号区分，否则编辑第二个会写回第一个 */
        const line = token.map ? token.map[0] : null;
        const k = registerKey({ kind: 'fence', docPath: docFs, fenceRaw: raw, line });
        editAttr = ` data-k="${k}" data-edit-uri="${escapeAttr(editLink(k))}"`;
      }
      /* 文案元素每次渲染只插一份，挂在第一个 wave 块前面 */
      const i18n = env && env.__wdI18nDone ? '' : (env.__wdI18nDone = true, previewI18nHtml());
      return `${i18n}<div class="wavedrom-block" data-wd="fence" data-json="${b64(raw)}" data-edit-mode="${editAffordance()}"${editAttr}></div>\n`;
    };

    const prevImage = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const imgHtml = prevImage
        ? prevImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
      const docFs = docFsPath(env);
      if (!docFs) return imgHtml;
      const probe = probeImagePath(docFs, token.attrGet('src'));
      if (!probe) return imgHtml;
      const k = registerKey({ kind: 'image', docPath: docFs, imgPath: probe.absPath });
      return `<span class="wavedrom-block" data-wd="image" data-json="${b64(probe.text)}" data-edit-mode="${editAffordance()}" data-k="${k}" data-edit-uri="${escapeAttr(editLink(k))}">${imgHtml}</span>\n`;
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

/* 图片探测结果按 mtime+size 缓存：CodeLens 在每次击键后都会重跑，逐图同步读文件
   在图多的文档里会拖慢输入。文件没变（mtime+size 相同）就不重复读盘；
   负结果（无元数据）同样缓存——文件没变就不会突然有元数据 */
const probeCache = new Map(); // absPath -> { key: mtimeMs:size, text }
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
    const st = fs.statSync(abs);
    const key = st.mtimeMs + ':' + st.size;
    const hit = probeCache.get(abs);
    if (hit && hit.key === key) return hit.text ? { absPath: abs, relSrc: src, text: hit.text } : null;
    const bytes = fs.readFileSync(abs);
    const text = /\.svg$/i.test(abs)
      ? svgExtractWaveJSON(bytes.toString('utf8'))
      : pngExtractWaveJSON(bytes);
    if (probeCache.size > 400) probeCache.clear();
    probeCache.set(abs, { key, text });
    return text ? { absPath: abs, relSrc: src, text } : null;
  } catch (e) { return null; }
}

/* ---------------- 可视化编辑面板（复用 index.html） ---------------- */

/* 编辑面板落在哪儿（wavedrom-gui.editorPanelPosition）：
   current = 当前聚焦的编辑栏里作标签页（默认）——从预览点「编辑」时即与预览同栏，
     用标签切换，不再多出一栏；
   beside = 当前栏右侧新开一栏；below = 当前栏下方新开一栏，与该栏成上下关系；
   newWindow = 搬到独立的编辑器窗口。
   取值非法或读不到配置时一律按 current */
function editorPanelPosition() {
  try {
    const v = vscode.workspace.getConfiguration('wavedrom-gui').get('editorPanelPosition');
    return (v === 'beside' || v === 'below' || v === 'newWindow') ? v : 'current';
  } catch (e) { return 'current'; }
}

/* below / newWindow 靠 VS Code 自己的两个命令实现：它们作用于**活动编辑器**（不是整栏），
   且目标组不存在时会新建（workbench 里是 findGroup(...direction) || addGroup(...)）。面板
   刚创建时焦点未必已经切过来，若此刻执行就会把预览或别的编辑器搬走，所以先等面板真的成为
   活动编辑器再执行；始终没拿到焦点就什么都不做——宁可停在原地，也不能搬错窗口。 */
async function placePanel(panel, cmd) {
  for (let i = 0; i < 12 && !panel.active; i++) await new Promise(r => setTimeout(r, 40));
  if (!panel.active) return;
  try { await vscode.commands.executeCommand(cmd); } catch (e) { /* 命令不存在：留在原地 */ }
}

function openEditor(target) {
  let jsonText, imgPxW = null, imgKind = null;
  try {
    if (target.kind === 'fence') jsonText = target.fenceRaw;
    else {
      const bytes = fs.readFileSync(target.imgPath);
      const isSvg = /\.svg$/i.test(target.imgPath);
      jsonText = isSvg
        ? svgExtractWaveJSON(bytes.toString('utf8'))
        : pngExtractWaveJSON(bytes);
      /* 原图像素宽：像素写回时按它定栅格化比例，避免重绘后 Markdown 里的布局跳动 */
      if (!isSvg) { const dim = pngGetSize(bytes); imgPxW = dim ? dim.width : null; }
      /* 原图的导出来源（wavedrom 官方渲染 / editor 编辑区矢量重建）：
         写回重绘时选同一种，编辑区导出的图才不会在保存后被重绘成官方样式 */
      imgKind = (isSvg ? svgDetectExportKind(bytes.toString('utf8')) : pngDetectExportKind(bytes)) || 'wavedrom';
    }
  } catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Failed to read the diagram — {0}', e.message)); return; }
  if (!jsonText) { vscode.window.showErrorMessage(t('WaveDrom: No editable WaveJSON in this target')); return; }

  /* 先备好 HTML 再建面板：界面读不到时直接报错返回，不留下一个空白面板 */
  let html;
  try {
    html = buildEditorHtml(jsonText, panelDocKey(target), target.kind === 'image' && {
      ext: /\.svg$/i.test(target.imgPath) ? 'svg' : 'png',
      pxW: imgPxW,
      kind: imgKind || 'wavedrom',
    });
  }
  catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Failed to load the editor UI — {0}', e.message)); return; }

  const pos = editorPanelPosition();
  const name = path.basename(target.kind === 'fence' ? target.docPath : target.imgPath);
  const panel = vscode.window.createWebviewPanel(
    'wavedromGuiEditor', t('WaveDrom Editor — {0}', name),
    /* below / newWindow 都先落在当前栏再交给命令搬走：先 Beside 会多出一栏、搬走后又收起，
       中间白闪一下 */
    pos === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = html;
  if (pos === 'below') placePanel(panel, 'workbench.action.moveEditorToBelowGroup');
  else if (pos === 'newWindow') placePanel(panel, 'workbench.action.moveEditorToNewWindow');

  const saveTarget = Object.assign({}, target); // fenceRaw 会随每次保存演进
  const isImage = saveTarget.kind === 'image';
  /* 图片目标的像素写回：webview 在轮询里把当前画面光栅化后随 pixels 消息上报，这里
     暂存内存，停手 5s 或面板关闭/切走时落盘。webview 销毁后就渲染不出新图了，所以
     「关闭即写回」依赖宿主手里始终有最新一份像素——这正是渲染提前到轮询里的原因。 */
  let pendingPx = null;   // { png?: Buffer, svg?: string, json } —— 与像素同源的文档 JSON
  let flushTimer = null;

  const flushPixels = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    /* 只写与当前元数据同源的像素；渲染没跟上时宁可维持「元数据新、像素旧」的现状语义，
       也不能把旧画面连同旧 JSON 一起盖掉刚写回的元数据 */
    if (!pendingPx || pendingPx.json !== saveTarget.lastSaved) { pendingPx = null; return; }
    const px = pendingPx; pendingPx = null;
    try {
      /* SVG 写回时把来源标记一并重新嵌入（webview 上报的矢量文本不含 metadata），
         下次打开才能继续按同一种导出风格重绘 */
      const out = px.svg != null
        ? Buffer.from(svgWithMeta(px.svg, saveTarget.lastSaved, imgKind), 'utf8')
        : pngReplaceITXt(px.png, 'WaveJSON', saveTarget.lastSaved);
      /* 写临时文件再改名：整文件重写像素后，半途崩溃不能再留下坏图 */
      const tmp = saveTarget.imgPath + '.wdtmp';
      try { fs.writeFileSync(tmp, out); fs.renameSync(tmp, saveTarget.imgPath); }
      finally { try { fs.unlinkSync(tmp); } catch (e) { /* 改名成功后本就不存在 */ } }
      vscode.window.setStatusBarMessage(t('WaveDrom: Image re-rendered and saved'), 3000);
      try { Promise.resolve(vscode.commands.executeCommand('markdown.preview.refresh')).catch(() => {}); }
      catch (e) { /* 预览没开或命令不可用：重开预览即可 */ }
    } catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Image write-back failed — {0}', e.message)); }
  };
  const armFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; flushPixels(); }, 5000);
  };

  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'save' && msg.json) {
      saveBack(saveTarget, msg.json, msg.text);
      if (isImage) armFlush();
    } else if (msg.type === 'pixels' && isImage && msg.json) {
      pendingPx = {
        json: msg.json,
        svg: typeof msg.svg === 'string' ? msg.svg : null,
        png: typeof msg.png === 'string' ? Buffer.from(msg.png, 'base64') : null,
      };
      armFlush();
    }
  });
  /* 切走面板标签：先把画面落盘，回来时预览就是新的（placePanel 搬动面板也会触发，
     此时 pendingPx 多半为空，自然跳过） */
  panel.onDidChangeViewState(ev => { if (!ev.webviewPanel.visible) flushPixels(); });
  /* 关闭面板：onDidDispose 时 webview 已销毁，落盘宿主手里的最后一份像素 */
  panel.onDidDispose(() => flushPixels());
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

/* 编辑器面板的视图模式（wavedrom-gui.editorViewMode）：
   simple = 每次打开面板都把界面的视图模式设为「简约模式」（默认）；
   auto = 不干预，沿用编辑器界面里记住的偏好。取值非法或读不到时按 simple */
function editorViewMode() {
  try {
    const v = vscode.workspace.getConfiguration('wavedrom-gui').get('editorViewMode');
    return v === 'auto' ? 'auto' : 'simple';
  } catch (e) { return 'simple'; }
}

/* 「通道与分组」左栏（wavedrom-gui.editorSidePanel）：
   shown = 每次打开面板都展开它（默认，界面里的默认是隐藏）；
   auto = 不干预，沿用界面里记住的偏好。取值非法或读不到时按 shown。
   注意它只在手机布局（含简约模式）下生效，界面自己会判断，写进去在宽布局下无副作用 */
function editorSidePanel() {
  try {
    const v = vscode.workspace.getConfiguration('wavedrom-gui').get('editorSidePanel');
    return v === 'auto' ? 'auto' : 'shown';
  } catch (e) { return 'shown'; }
}

/* 编辑器界面来源：仓库内调试时 extensionUri 就是 vscode/，同级 ../index.html 是正在改的
   实时界面（F5 下改动立即生效，无需先构建）；装了 VSIX 之后同级没有 index.html，回退到
   随包安装的 media/editor.html（scripts/build.js 从仓库根 index.html 拷入）。 */
function editorShellPath() {
  const live = path.join(_ctx.extensionUri.fsPath, '..', 'index.html');
  if (fs.existsSync(live)) return live;
  return path.join(_ctx.extensionUri.fsPath, 'media', 'editor.html');
}

function buildEditorHtml(initialJson, docKey = 'wdgui-doc-v1', imageTarget = null) {
  let html = fs.readFileSync(editorShellPath(), 'utf8');
  html = html.replace(/'wdgui-doc-v1'/g, `'${docKey}'`);
  /* img-src 必须含 blob:——编辑器导出 PNG 时把 SVG 包成 blob URL 再交给 new Image()，
     少了它导出会卡在 onload 永不触发（预览/画布的 data: 路径不受影响） */
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; `
    + `style-src 'unsafe-inline' https://registry.npmmirror.com https://fonts.googleapis.com; `
    + `font-src https://registry.npmmirror.com https://fonts.gstatic.com data:; img-src data: blob: https:;">`;
  html = html.replace(/(<meta charset="utf-8">)/i, `$1\n${csp}`);
  /* 编辑器界面自己的偏好（都在 localStorage，界面启动时读）：
     - 语言（wdgui-lang，菜单里 auto/zh/en）：只在没设置过时按 VS Code 的显示语言写一份，
       之后用户在界面里选过的语言优先；界面的 auto 本来就会跟随系统/宿主语言，不覆盖也对。
     - 视图模式（wdgui-viewmode，菜单里 auto/simple）与「通道与分组」左栏
       （wdgui-side-dock，1=显示 / 0=隐藏，界面默认隐藏）：这两项扩展要的是稳定可用的
       面板布局（面板通常很窄，简约布局 + 展开左栏更好用），所以每次打开都按设置写；
       设成 auto 则不碰、沿用界面里记住的偏好。面板内仍可临时切换（下次打开回到设置值）。 */
  const init = `<script>try { if (!localStorage.getItem('wdgui-lang')) localStorage.setItem('wdgui-lang', ${JSON.stringify(uiLang())});`
    + (editorViewMode() === 'simple' ? ` localStorage.setItem('wdgui-viewmode', 'simple');` : '')
    + (editorSidePanel() === 'shown' ? ` localStorage.setItem('wdgui-side-dock', '1');` : '')
    + ` } catch (e) {}`
    + `location.hash = ${JSON.stringify(encodeURIComponent(initialJson))};</script>\n`;
  html = html.replace(/(<body[^>]*>)/i, `$1\n${init}`);
  const poller = `<script>
(function () {
  var vs = acquireVsCodeApi();
  var KEY = ${JSON.stringify(docKey)};
  /* 图片目标才上报画面：{ext:'png',pxW:原图像素宽} / {ext:'svg'} / null（代码块目标） */
  var IMG = ${JSON.stringify(imageTarget || null)};
  var last = null, armed = false;
  /* 写回风格跟随代码页当前的显示模式（紧凑/舒缓）：界面里的格式化器认得该模式，
     这里只取它的结果；取不到时扩展侧退回默认缩进，不影响写回内容 */
  function displayText(v) {
    try {
      if (typeof window.wdFormatDoc === 'function') return window.wdFormatDoc(v);
    } catch (e) {}
    return null;
  }
  /* ---- 图片目标：把当前画面交给扩展（宿主拿到字节后自行决定何时落盘） ----
     渲染提前到轮询里、落盘交给宿主去抖，是因为面板关闭时 webview 先被销毁，
     之后没人能再渲染出画面；扩展手里必须始终有最新一份像素才能做到「关闭即写回」 */
  var busy = false, dirty = false;
  function postPixels(extra) {
    /* 渲染完成后回读 KEY：localStorage 与画面由同一次 update() 同步写出，
       上报的 json 因此一定与像素对应，宿主据此判断像素能不能落盘 */
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) {}
    if (v) vs.postMessage(Object.assign({ type: 'pixels', json: v }, extra));
  }
  function rasterDone() {
    busy = false;
    if (dirty) { dirty = false; sendPixels(); }
  }
  function sendPixels() {
    if (!IMG || busy) { if (IMG) dirty = true; return; }
    busy = true;
    setTimeout(function () { /* 让出本轮：先把已到手的编辑渲染完，再取画面 */
      try {
        if (!document.querySelector('#wv0 svg')) { rasterDone(); return; } /* 空文档无预览，直接跳过（getExportSvg 会弹提示） */
        /* 原图是哪种导出就按哪种重绘：编辑区导出走 buildEditorSvg（矢量重建，所见即所得），
           其余（默认）走 getExportSvg（官方 WaveDrom 渲染）。编辑区版本无 w/h 返回值，
           从序列化前的元素属性上取 */
        var ex = null;
        if (IMG.kind === 'editor' && typeof buildEditorSvg === 'function') {
          var es = buildEditorSvg();
          if (es) ex = { str: new XMLSerializer().serializeToString(es), w: +es.getAttribute('width'), h: +es.getAttribute('height') };
        } else {
          ex = getExportSvg();
        }
        if (!ex) { rasterDone(); return; }
        if (IMG.ext === 'svg') { postPixels({ svg: ex.str }); rasterDone(); return; }
        /* PNG 尺寸对齐原图宽度：比例 = 原图宽 ÷ 当前自然宽，夹在 1–4 之间。
           原图读不到就退回 2×（与导出按钮一致） */
        var scale = IMG.pxW ? IMG.pxW / ex.w : 2;
        if (!(scale > 0)) scale = 2;
        scale = Math.min(4, Math.max(1, scale));
        var url = URL.createObjectURL(new Blob([ex.str], { type: 'image/svg+xml' }));
        var img = new Image();
        img.onload = function () {
          try {
            var cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(ex.w * scale));
            cv.height = Math.max(1, Math.round(ex.h * scale));
            var ctx = cv.getContext('2d');
            /* 编辑区导出的底色随主题（cssVar('--bg')），官方渲染维持白底（与导出按钮一致） */
            var fill = '#ffffff';
            try { if (IMG.kind === 'editor') { var bg = cssVar('--bg'); if (bg) fill = bg; } } catch (e) {}
            ctx.fillStyle = fill; ctx.fillRect(0, 0, cv.width, cv.height);
            ctx.drawImage(img, 0, 0, cv.width, cv.height);
            cv.toBlob(function (b) {
              try {
                URL.revokeObjectURL(url);
                if (!b) { rasterDone(); return; }
                var fr = new FileReader();
                fr.onload = function () {
                  try {
                    var s = String(fr.result || '');
                    if (s.indexOf(',') > 0) postPixels({ png: s.slice(s.indexOf(',') + 1) });
                  } catch (e) { /* 读不出就放弃这一帧，等下一次改动 */ }
                  rasterDone();
                };
                fr.onerror = function () { rasterDone(); };
                fr.readAsDataURL(b);
              } catch (e) { rasterDone(); }
            }, 'image/png');
          } catch (e) { try { URL.revokeObjectURL(url); } catch (e2) {} rasterDone(); }
        };
        img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} rasterDone(); };
        img.src = url;
      } catch (e) { rasterDone(); }
    }, 0);
  }
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
      try { JSON.parse(v); } catch (e) { return; }
      vs.postMessage({ type: 'save', json: v, text: displayText(v) });
      if (IMG) sendPixels();
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

/* 写回文本：优先用编辑器界面给出的显示文本（跟随紧凑/舒缓模式），但它必须与状态 JSON
   等价——写回直接改用户文件，格式可以丢，内容不能错，对不上就退回默认的 2 空格缩进 */
function writeText(json, displayText) {
  const parsed = JSON.parse(json);
  if (typeof displayText === 'string' && displayText.trim()) {
    let shown = null;
    try { shown = JSON.parse(displayText); } catch (e) { shown = null; }
    if (shown && JSON.stringify(shown) === JSON.stringify(parsed)) return displayText;
  }
  return JSON.stringify(parsed, null, 2);
}

async function saveBack(target, json, displayText) {
  let text;
  try { text = writeText(json, displayText); }
  catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Invalid JSON, save skipped')); return; }

  if (target.kind === 'fence') {
    try {
      const doc = await vscode.workspace.openTextDocument(target.docPath);
      let hit = findFence(doc.getText(), [target.fenceRaw, target.lastSaved], target.line);
      if (!hit) {
        /* 兜底：精确与规范化都匹配不到（文件被大改）时，列出全部 wavedrom
           代码块让用户指定写回目标，避免直接报错卡死 */
        const docText = doc.getText();
        FENCE_RE.lastIndex = 0;
        const cands = [];
        let m;
        while ((m = FENCE_RE.exec(docText))) {
          cands.push({
            label: t('``` code block {0}', cands.length + 1),
            description: (m[1].trim().split('\n')[0] || '').slice(0, 60),
            match: m,
          });
        }
        if (!cands.length) { vscode.window.showErrorMessage(t('WaveDrom: No wavedrom code blocks left in this file')); return; }
        /* 一律让用户确认：唯一候选也自动写回的话，定位失败时会静默改错块甚至吞掉正文 */
        const pick = await vscode.window.showQuickPick(cands, { placeHolder: t('Cannot find the original code block — pick the one to write back to') });
        if (!pick) return;
        hit = pick.match;
      }
      const startOff = hit.index + hit[0].indexOf('\n') + 1;
      const body = hit[1];
      /* 闭合围栏前那个换行也在捕获内容里，必须原样补回——否则闭合围栏会被粘到
         JSON 最后一行，代码块不再闭合，后续正文和代码块都会被吞进去 */
      const tailNl = /(\r?\n)$/.exec(body);
      const nl = tailNl ? tailNl[1] : (/\r?\n/.exec(hit[0]) || ['\n'])[0];
      const insert = nl === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
      const endOff = startOff + body.length;
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(doc.positionAt(startOff), doc.positionAt(endOff)), insert + nl);
      await vscode.workspace.applyEdit(we);
      target.lastSaved = insert;
      vscode.window.setStatusBarMessage(t('WaveDrom: Code block updated (press Ctrl+S to save the file)'), 3000);
    } catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Write-back failed — {0}', e.message)); }
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
    vscode.window.setStatusBarMessage(t('WaveDrom: Embedded WaveJSON in the image updated'), 3000);
  } catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Image write-back failed — {0}', e.message)); }
}

/* ---------------- 兜底入口：命令面板 + 编辑器里的 CodeLens ----------------
 * 这条完全不经预览，所以与预览安全级别、CSP 都无关；给不习惯/不方便用预览按钮的人
 * 一个稳定入口（设置 wavedrom-gui.showCodeLens 可关掉 CodeLens）。 */
async function editActiveCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    vscode.window.showInformationMessage(t('Open a Markdown file first')); return;
  }
  const docFs = editor.document.uri.fsPath;
  const text = editor.document.getText();
  const picks = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text))) {
    picks.push({
      label: t('``` code block'),
      description: (m[1].trim().split('\n')[0] || '').slice(0, 60),
      target: { kind: 'fence', docPath: docFs, fenceRaw: m[1], line: lineOfIndex(text, m.index) },
    });
  }
  const imgRe = IMG_RE;
  imgRe.lastIndex = 0;
  while ((m = imgRe.exec(text))) {
    const probe = probeImagePath(docFs, m[1]);
    if (probe) picks.push({ label: t('🖼 Image'), description: path.basename(probe.absPath), target: { kind: 'image', docPath: docFs, imgPath: probe.absPath } });
  }
  if (!picks.length) { vscode.window.showInformationMessage(t('No WaveDrom code blocks or images with embedded WaveJSON in this file')); return; }
  const pick = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks, { placeHolder: t('Pick the WaveDrom diagram to edit') });
  if (pick) openEditor(pick.target);
}

function showCodeLens() {
  try { return vscode.workspace.getConfiguration('wavedrom-gui').get('showCodeLens') !== false; }
  catch (e) { return true; }
}

/* CodeLens 参数直接带上文档路径 + 行号 + 原始内容，不依赖内存里的 editTargets：
   CodeLens 会在编辑器里长期显示，扩展重启后仍应可用。行号漂了就按内容兜底定位。 */
async function editFenceCommand(target) {
  if (!target || target.kind !== 'fence') return;
  try {
    const doc = await vscode.workspace.openTextDocument(target.docPath);
    const hit = findFence(doc.getText(), [target.fenceRaw], target.line);
    if (!hit) { vscode.window.showErrorMessage(t('WaveDrom: Cannot find this code block (has the document changed?)')); return; }
    openEditor({
      kind: 'fence',
      docPath: target.docPath,
      fenceRaw: hit[1],
      line: lineOfIndex(doc.getText(), hit.index),
    });
  } catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Failed to open the editor — {0}', e.message)); }
}

/* 图片 CodeLens 的落点：参数带文档路径 + 原始引用路径（同 editFence，不依赖内存注册表，
   扩展重启后仍可用）。打开前重新探测一次：文件可能被移动、元数据可能已被去掉 */
async function editImageCommand(target) {
  if (!target || target.kind !== 'image') return;
  const probe = probeImagePath(target.docPath, target.src);
  if (!probe) {
    vscode.window.showErrorMessage(t('WaveDrom: Cannot read this image (has it moved, or lost its embedded WaveJSON?)'));
    return;
  }
  openEditor({ kind: 'image', docPath: target.docPath, imgPath: probe.absPath });
}

function makeCodeLensProvider() {
  return {
    provideCodeLenses(doc) {
      if (!showCodeLens() || doc.languageId !== 'markdown') return [];
      const text = doc.getText();
      const lenses = [];
      FENCE_RE.lastIndex = 0;
      let m;
      while ((m = FENCE_RE.exec(text))) {
        const line = lineOfIndex(text, m.index);
        lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: t('Edit waveform'),
          command: 'wavedrom-gui.editFence',
          arguments: [{ kind: 'fence', docPath: doc.uri.fsPath, fenceRaw: m[1], line }],
        }));
      }
      /* 图片引用同样给入口：行内 ![a](x.png) 与引用式 ![a][def]。逐行扫描并跳过
         代码围栏内的行——围栏里的示例文本不是真的图（预览侧 markdown-it 也不渲染）；
         引用式需要先收集全部定义，定义可以出现在使用之后 */
      const lines = text.split(/\r?\n/);
      const fenceLines = new Array(lines.length).fill(false);
      let fencing = false;
      for (let i = 0; i < lines.length; i++) {
        fenceLines[i] = fencing;
        if (/^ {0,3}(```|~~~)/.test(lines[i])) { fencing = !fencing; fenceLines[i] = true; }
      }
      const defs = new Map(); // label（小写、空白折叠）-> 路径，markdown 引用定义不区分大小写
      lines.forEach((line, i) => {
        if (fenceLines[i]) return;
        const dm = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\s]*)>|([^\s]+))/.exec(line);
        if (dm) defs.set(dm[1].trim().replace(/\s+/g, ' ').toLowerCase(), (dm[2] || dm[3] || '').trim());
      });
      const pushImageLens = (i, src) => {
        const probe = probeImagePath(doc.uri.fsPath, src);
        if (!probe) return;
        lenses.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
          title: t('Edit waveform'),
          command: 'wavedrom-gui.editImage',
          arguments: [{ kind: 'image', docPath: doc.uri.fsPath, src }],
        }));
      };
      lines.forEach((line, i) => {
        if (fenceLines[i]) return;
        IMG_RE.lastIndex = 0;
        let im;
        while ((im = IMG_RE.exec(line))) pushImageLens(i, im[1]);
        const refRe = /!\[([^\]]*)\]\s?\[([^\]]*)\]/g;
        let rm;
        while ((rm = refRe.exec(line))) {
          const label = (rm[2].trim() || rm[1].trim()).replace(/\s+/g, ' ').toLowerCase();
          const target = label && defs.get(label);
          if (target) pushImageLens(i, target);
        }
      });
      return lenses;
    },
  };
}

/* ---------------- activate ---------------- */
let _ctx = null;

async function activate(ctx) {
  _ctx = ctx;
  /* 排查语言问题用的一行日志：Output → Extension Host 里能看到扩展实际采用的语言与来源 */
  try {
    console.log('[wavedrom-gui] i18n', JSON.stringify({
      setting: languageSetting(), envLanguage: vscode.env.language, effective: uiLang(),
      l10nApi: !!(vscode.l10n && vscode.l10n.t), zhTableKeys: Object.keys(zhStrings()).length,
    }));
  } catch (e) { /* 日志失败无所谓 */ }
  ctx.subscriptions.push(vscode.commands.registerCommand('wavedrom-gui.editActive', editActiveCommand));
  ctx.subscriptions.push(vscode.commands.registerCommand('wavedrom-gui.editFence', editFenceCommand));
  ctx.subscriptions.push(vscode.commands.registerCommand('wavedrom-gui.editImage', editImageCommand));
  ctx.subscriptions.push(vscode.commands.registerCommand('wavedrom-gui.editFromPreview', editFromPreviewCommand));
  ctx.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'markdown' }, makeCodeLensProvider()));
  /* 入口形式烙在渲染出的 HTML 里，改设置后必须重渲染预览才生效；markdown 预览不会因为
     别的扩展的设置变化自动刷新，这里主动刷一次。命令不存在也不该影响设置本身 */
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(ev => {
    if (!ev.affectsConfiguration('wavedrom-gui.previewEditAffordance')) return;
    try { Promise.resolve(vscode.commands.executeCommand('markdown.preview.refresh')).catch(() => {}); }
    catch (e) { /* 命令不可用：用户重开预览即可 */ }
  }));
  return {
    extendMarkdownIt(md) {
      md.use(makePlugin());
      return md;
    },
  };
}

function deactivate() { /* 无后台资源需要释放 */ }

module.exports = {
  activate,
  deactivate,
  __test: {
    FENCE_RE, probeImagePath, editAffordance, editorPanelPosition, editorViewMode, editorSidePanel,
    languageSetting, uiLang, zhStrings, t, editLink, handleUri,
    editFromPreviewCommand, makePlugin, makeCodeLensProvider, editFenceCommand, editImageCommand, editTargets, registerKey,
    findFence, saveBack, writeText, openEditor, lineOfIndex, buildEditorHtml, panelDocKey,
  },
};

