'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  svgWithMeta, svgExtractWaveJSON,
  pngReplaceITXt, pngInsertITXt, pngExtractWaveJSON, pngGetSize,
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
      const renderImg = () => prevImage
        ? prevImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
      const docFs = docFsPath(env);
      const src = token.attrGet('src');
      if (!docFs || !src) return renderImg();
      const probe = probeImagePath(docFs, src);
      if (!probe) return renderImg();
      /* 含 WaveJSON 的图片：预览直接显示图片本身（保持导出时的原生主题），编辑走右键/深链接；
         不再塞 data-json、也不再拿元数据重绘（旧实现恒用现代渲染器，会把传统图改风格）。
         编辑写回后靠 markdown.preview.refresh 重取图，但 webview 按 URI 缓存像素，故给命中的
         图 URL 追加随 mtime 变化的版本参数，确保刷新拿到新像素。 */
      const k = registerKey({ kind: 'image', docPath: docFs, imgPath: probe.absPath });
      const busted = withCacheBust(src, probe.mtimeMs);
      if (busted !== src) token.attrSet('src', busted);
      const imgHtml = renderImg();
      if (busted !== src) token.attrSet('src', src); // 复原，避免影响该 token 的后续渲染
      return `<span class="wavedrom-block" data-wd="image" data-edit-mode="${editAffordance()}" data-k="${k}" data-edit-uri="${escapeAttr(editLink(k))}">${imgHtml}</span>\n`;
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

/* 给命中的图片 URL 追加随文件 mtime 变化的版本参数。编辑写回后靠 markdown.preview.refresh
   重取图片，但 webview 按 URI 缓存像素，src 不带区分时刷新可能仍拿到旧图，故用它破除缓存。
   幂等（已有 wdv= 就不再动），并保留结尾 #fragment。 */
function withCacheBust(src, mtimeMs) {
  if (typeof src !== 'string' || !src) return src;
  if (/[?&]wdv=/i.test(src)) return src;
  const hashIdx = src.indexOf('#');
  const hash = hashIdx >= 0 ? src.slice(hashIdx) : '';
  const base = hashIdx >= 0 ? src.slice(0, hashIdx) : src;
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  return base + sep + 'wdv=' + Math.round(mtimeMs || 0) + hash;
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
    if (hit && hit.key === key) return hit.text ? { absPath: abs, relSrc: src, text: hit.text, mtimeMs: hit.mtimeMs } : null;
    const bytes = fs.readFileSync(abs);
    const text = /\.svg$/i.test(abs)
      ? svgExtractWaveJSON(bytes.toString('utf8'))
      : pngExtractWaveJSON(bytes);
    if (probeCache.size > 400) probeCache.clear();
    probeCache.set(abs, { key, text, mtimeMs: st.mtimeMs });
    return text ? { absPath: abs, relSrc: src, text, mtimeMs: st.mtimeMs } : null;
  } catch (e) { return null; }
}

/* ---------------- 宿主侧波形渲染（hover 悬浮预览 / 预览面板共用） ---------------- */

/* 宽松解析：与 media/preview.js 的 parseLoose 保持同一覆盖面（// 与块注释、免引号键、
   单引号串、尾逗号），否则同一代码块预览里能渲染、悬浮预览里报错。纯字符串扫描，
   不做任何求值——解析对象是文档内容，不能给恶意构造的代码执行机会。 */
function parseLoose(text) {
  let out = '';
  let expectKey = false; // 刚出现 { 或 ,（且非尾逗号）：接下来允许隔着空白/注释出现对象键
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      /* 字符串整体消费：单引号转双引号，内部未转义的双引号补转义 */
      out += '"';
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] || ''); i += 2; continue; }
        out += text[i] === '"' ? '\\"' : text[i];
        i++;
      }
      out += '"';
      i++;
      expectKey = false;
      continue;
    }
    if (c === ',') {
      /* 尾逗号：向后只跳空白，直接跟 } / ] 即丢弃（不跨字符串，无误伤） */
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
      out += c;
      i++;
      expectKey = true;
      continue;
    }
    if (c === '{' || c === '[') {
      out += c;
      i++;
      if (c === '{') expectKey = true; // [ 之后是元素不是键
      continue;
    }
    if (expectKey && /[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*\s*:/.exec(text.slice(i, i + 128));
      if (m) {
        out += '"' + m[0].replace(/\s*:/, '') + '":';
        i += m[0].length;
        expectKey = false;
        continue;
      }
    }
    /* 空白不驱散键期待（{ 换行 key 的写法）；其它字符视为值的一部分 */
    expectKey = expectKey && /\s/.test(c);
    out += c;
    i++;
  }
  return JSON.parse(out);
}

/* render-modern.js 是 SKILL/wavedrom-render 里的无 DOM 渲染器（纯 SVG 字符串输出，
   Node 可直接 require）。仓库内开发时读源文件（改动即时生效）；VSIX 打包范围不含
   SKILL/，装包后回退到 scripts/build.js 拷入的 media/render-modern.js。 */
let _rendererMod = undefined; // undefined=未探测，false=不可用
function rendererModule() {
  if (_rendererMod !== undefined) return _rendererMod;
  const candidates = _ctx ? [
    path.join(_ctx.extensionUri.fsPath, '..', 'SKILL', 'wavedrom-render', 'lib', 'render-modern.js'),
    path.join(_ctx.extensionUri.fsPath, 'media', 'render-modern.js'),
  ] : [];
  for (const p of candidates) {
    try { _rendererMod = require(p); return _rendererMod; } catch (e) { /* 试下一个来源 */ }
  }
  _rendererMod = false;
  return _rendererMod;
}

function renderSvg(jsonText) {
  const mod = rendererModule();
  if (!mod || typeof mod.renderModern !== 'function') return { err: t('WaveDrom: renderer not available') };
  let doc;
  try { doc = parseLoose(jsonText); }
  catch (e) { return { err: t('WaveDrom: Failed to parse WaveJSON — {0}', e.message) }; }
  try {
    const r = mod.renderModern(doc, {});
    const svg = String((r && r.svg) || '').replace(/^<\?xml[^>]*\?>\s*/, '');
    return svg ? { svg } : { err: t('WaveDrom: Failed to render — {0}', 'empty output') };
  } catch (e) { return { err: t('WaveDrom: Failed to render — {0}', e.message) }; }
}

/* hover 会在同一段代码上反复触发：按围栏内容缓存渲染结果，免得每次鼠标停留都重算 */
const svgCache = new Map(); // fenceRaw -> { svg } | { err }
function renderSvgCached(jsonText) {
  const hit = svgCache.get(jsonText);
  if (hit) return hit;
  const out = renderSvg(jsonText);
  if (svgCache.size > 200) svgCache.clear();
  svgCache.set(jsonText, out);
  return out;
}

/* 按围栏起始行定位（hover 与预览镜头只有行号，没有内容；行号由 provideXxx 在
   同一次渲染里给出，漂移风险与 editFence 的行号兜底一致） */
function findFenceAtLine(text, line) {
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text))) {
    if (lineOfIndex(text, m.index) === line) return m;
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

/* 读图片目标的内嵌 WaveJSON 与写回所需的元信息；不含可编辑数据时返回 null */
function readImageTarget(imgPath) {
  const bytes = fs.readFileSync(imgPath);
  const isSvg = /\.svg$/i.test(imgPath);
  const jsonText = isSvg
    ? svgExtractWaveJSON(bytes.toString('utf8'))
    : pngExtractWaveJSON(bytes);
  if (!jsonText) return null;
  /* 原图像素宽：像素写回时按它定栅格化比例，避免重绘后 Markdown 里的布局跳动 */
  let pxW = null;
  if (!isSvg) { const dim = pngGetSize(bytes); pxW = dim ? dim.width : null; }
  /* 原图的导出来源（wavedrom 官方渲染 / editor 编辑区矢量重建 / skill-modern）：
     写回重绘时选同一种，编辑区导出的图才不会在保存后被重绘成官方样式 */
  const kind = (isSvg ? svgDetectExportKind(bytes.toString('utf8')) : pngDetectExportKind(bytes)) || 'skill-modern';
  return { jsonText, pxW, kind };
}

/* 编辑面板的全部行为：初始化界面、自动写回（代码块 / 图片元数据）、图片像素重绘落盘。
   openEditor（CodeLens / hover / 命令）与「打开方式」自定义编辑器共用，保证两条入口
   的编辑与保存行为完全一致。 */
/* 「图片输出主题」（wavedrom-gui.imageExportTheme）：编辑保存时像素按什么风格重绘。
   auto = 原风格保真（默认）：按打开时检测的导出来源（editor/skill-modern/wavedrom）
   重绘同一种风格；modern / traditional = 无视来源，一律按现代 / 官方传统重绘。
   取值非法或读不到时按 auto。覆盖点在面板建立时改写 imgKind，重绘与来源标记
   （SVG 的 data-editor-export）都会跟着走，风格不会在编辑迭代中漂移。 */
function imageExportTheme() {
  try {
    const v = vscode.workspace.getConfiguration('wavedrom-gui').get('imageExportTheme');
    return (v === 'modern' || v === 'traditional') ? v : 'auto';
  } catch (e) { return 'auto'; }
}

/* 像素落盘时把来源标记重新嵌入 PNG（与 SVG 路径的 svgWithMeta 对称）：
   webview 光栅化的 PNG 是 canvas 全新编码，不含原文件任何 iTXt——只写 WaveJSON
   会把 export= 标记弄丢，下次打开兜底判成 skill-modern，传统风格的图编辑第二轮
   就漂成现代（实测踩过）。imgKind 缺失时跳过标记（保持旧行为）。 */
function reembedPngMarker(rasterized, imgKind, jsonText) {
  if (!imgKind) return pngReplaceITXt(rasterized, 'WaveJSON', jsonText);
  return pngReplaceITXt(
    pngInsertITXt(rasterized, 'WaveDromGui', 'export=' + imgKind),
    'WaveJSON', jsonText,
  );
}

function setupEditorPanel(panel, target, jsonText, imgPxW = null, imgKind = null) {
  if (target.kind === 'image') {
    const theme = imageExportTheme();
    if (theme === 'modern') imgKind = 'skill-modern';
    else if (theme === 'traditional') imgKind = 'wavedrom';
  }
  /* 先备好 HTML：界面读不到时直接报错返回，不留下一个空白面板 */
  try {
    panel.webview.html = buildEditorHtml(jsonText, panelDocKey(target), target.kind === 'image' && {
      ext: /\.svg$/i.test(target.imgPath) ? 'svg' : 'png',
      pxW: imgPxW,
      kind: imgKind || 'skill-modern',
    });
  }
  catch (e) {
    vscode.window.showErrorMessage(t('WaveDrom: Failed to load the editor UI — {0}', e.message));
    panel.dispose();
    return;
  }

  const saveTarget = Object.assign({}, target); // fenceRaw 会随每次保存演进
  const isImage = saveTarget.kind === 'image';
  /* 图片目标的像素写回：webview 在轮询里把当前画面光栅化后随 pixels 消息上报，这里
     暂存内存，停手约 1s 或面板关闭/切走时落盘。webview 销毁后就渲染不出新图了，所以
     「关闭即写回」依赖宿主手里始终有最新一份像素——这正是渲染提前到轮询里的原因。
     1s 是「编辑手感近实时」与「别在拖拽时每帧刷盘」的折中：每来一帧新像素就重置计时，
     连续改动期间不落盘，停手 1s 后写一次（hover / md 预览随即能读到新图）。 */
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
        : reembedPngMarker(px.png, imgKind, saveTarget.lastSaved);
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
    flushTimer = setTimeout(() => { flushTimer = null; flushPixels(); }, 1000);
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
    } else if (msg.type === 'export' && msg.name && typeof msg.b64 === 'string') {
      exportFromPanel(saveTarget, msg.name, msg.b64);
    }
  });
  /* 切走面板标签：先把画面落盘，回来时预览就是新的（placePanel 搬动面板也会触发，
     此时 pendingPx 多半为空，自然跳过） */
  panel.onDidChangeViewState(ev => { if (!ev.webviewPanel.visible) flushPixels(); });
  /* 关闭面板：onDidDispose 时 webview 已销毁，落盘宿主手里的最后一份像素 */
  panel.onDidDispose(() => flushPixels());
}

/* 面板导出的落盘：系统保存框默认定位到来源文件所在目录（图片 = 原图路径，
   代码块 = markdown 文档路径），默认文件名沿用编辑器给出的导出名。 */
async function exportFromPanel(saveTarget, name, b64) {
  const anchor = saveTarget.kind === 'image' ? saveTarget.imgPath : saveTarget.docPath;
  const extMatch = /\.([a-z0-9]+)$/i.exec(name);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
  try {
    const picked = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(anchor), path.basename(name))),
      filters: { [ext.toUpperCase()]: [ext] },
    });
    if (!picked) return; // 用户取消
    fs.writeFileSync(picked.fsPath, Buffer.from(b64, 'base64'));
    vscode.window.setStatusBarMessage(t('WaveDrom: Exported to {0}', picked.fsPath), 4000);
  } catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Export failed — {0}', e.message)); }
}

function openEditor(target) {
  let jsonText, imgPxW = null, imgKind = null;
  try {
    if (target.kind === 'fence') jsonText = target.fenceRaw;
    else {
      const img = readImageTarget(target.imgPath);
      if (!img) { vscode.window.showErrorMessage(t('WaveDrom: No editable WaveJSON in this target')); return; }
      jsonText = img.jsonText; imgPxW = img.pxW; imgKind = img.kind;
    }
  } catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Failed to read the diagram — {0}', e.message)); return; }

  const pos = editorPanelPosition();
  const name = path.basename(target.kind === 'fence' ? target.docPath : target.imgPath);
  const panel = vscode.window.createWebviewPanel(
    'wavedromGuiEditor', t('WaveDrom Editor — {0}', name),
    /* below / newWindow 都先落在当前栏再交给命令搬走：先 Beside 会多出一栏、搬走后又收起，
       中间白闪一下 */
    pos === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  setupEditorPanel(panel, target, jsonText, imgPxW, imgKind);
  if (pos === 'below') placePanel(panel, 'workbench.action.moveEditorToBelowGroup');
  else if (pos === 'newWindow') placePanel(panel, 'workbench.action.moveEditorToNewWindow');
}

/* ---------------- 资源管理器右键：「使用 WaveDrom-Gui 编辑器打开」 ----------------
 * PNG / SVG 的右键菜单入口。打开前先探测内嵌 WaveJSON（与「编辑波形」同一套
 * readImageTarget）：有 → 走与 md 预览「编辑波形」完全相同的 openEditor 临时面板
 * （那条路径在真实环境验证最充分，不走自定义编辑器，规避其 webview 初始化时序差异）；
 * 无 → 一次性警告提示，不打开任何面板。 */
async function openImageCommand(uri) {
  const fsPath = uri && uri.fsPath;
  if (!fsPath) return;
  let img = null;
  try { img = readImageTarget(fsPath); } catch (e) { /* 读不到/解析失败都按无数据处理 */ }
  if (!img) {
    vscode.window.showWarningMessage(t('WaveDrom: No WaveDrom waveform data embedded in this image'));
    return;
  }
  openEditor({ kind: 'image', docPath: fsPath, imgPath: fsPath });
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
/* 编辑器面板的视图模式（wavedrom-gui.editorViewMode）：
   auto = 默认：不干预布局偏好，沿用界面里记住的设置；同时把「实时预览 / WaveJSON
          代码」右侧窗默认收起——编辑面板通常是一个窄分栏，右侧窗只会挤占空间，
          需要时可从编辑器设置 → 视图 → 窗口显示里恢复；
   simple = 每次打开面板都把界面设为简约模式（手机版紧凑布局），右侧窗显隐不碰
   （手机布局下 right-col 本就收起，由底部按钮切换）。
   取值非法或读不到时按 auto */
function editorViewMode() {
  try {
    const v = vscode.workspace.getConfiguration('wavedrom-gui').get('editorViewMode');
    return (v === 'simple' || v === 'auto') ? v : 'auto';
  } catch (e) { return 'auto'; }
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
     - 视图模式（wdgui-viewmode）：simple = 每次打开都强制简约布局（面板通常很窄更合用）；
       auto（默认）= 不碰布局偏好，但把「实时预览 / WaveJSON 代码」右侧窗写成收起
       （wdgui-show-preview / wdgui-show-code = 0，编辑器两个都关时整个右栏隐藏）——
       窄面板里右侧窗只会挤占空间，需要时面板内从编辑器设置 → 视图 → 窗口显示恢复。
       simple 布局下右栏本就收起（底部按钮切换），不碰这两个键。面板内仍可临时切换。 */
  const init = `<script>try { if (!localStorage.getItem('wdgui-lang')) localStorage.setItem('wdgui-lang', ${JSON.stringify(uiLang())});`
    + (editorViewMode() === 'simple' ? ` localStorage.setItem('wdgui-viewmode', 'simple');` : '')
    + (editorViewMode() === 'auto' ? ` localStorage.setItem('wdgui-show-preview', '0'); localStorage.setItem('wdgui-show-code', '0');` : '')
    + (editorSidePanel() === 'shown' ? ` localStorage.setItem('wdgui-side-dock', '1');` : '')
    + ` } catch (e) {}`
    + `location.hash = ${JSON.stringify(encodeURIComponent(initialJson))};</script>\n`;
  html = html.replace(/(<body[^>]*>)/i, `$1\n${init}`);
  /* skill-modern 来源的图要用同一渲染器忠实重绘：把无浏览器渲染器内联进面板
     （打包自带 media/modern-render.browser.js，CSP 允许 inline script；
     文件缺失时轮询自动退回官方渲染路径） */
  let rendererInline = '';
  if (imageTarget && imageTarget.kind === 'skill-modern') {
    try {
      const rsrc = fs.readFileSync(path.join(_ctx.extensionUri.fsPath, 'media', 'modern-render.browser.js'), 'utf8');
      if (!rsrc.includes('</script')) rendererInline = '<script>' + rsrc + '</script>\n';
    } catch (e) { /* 读不到：退回官方渲染 */ }
  }
  const poller = `<script>
(function () {
  var vs = acquireVsCodeApi();
  var KEY = ${JSON.stringify(docKey)};
  /* 图片目标才上报画面：{ext:'png',pxW:原图像素宽} / {ext:'svg'} / null（代码块目标） */
  var IMG = ${JSON.stringify(imageTarget || null)};
  var last = null, armed = false;
  /* ---- 导出钩子：编辑器界面的 download() 在面板里把产物交给宿主 ----
     宿主能弹出定位到原图 / md 文档所在目录的系统保存框，比浏览器式下载的
     未知路径友好（默认目录与默认文件名都来自来源文件）。 */
  window.__wdDownloadHook = function (name, blob) {
    try {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        if (s.indexOf(',') > 0) vs.postMessage({ type: 'export', name: name, b64: s.slice(s.indexOf(',') + 1) });
      };
      fr.readAsDataURL(blob);
    } catch (e) { /* blob 不可读：放弃本次导出 */ }
  };
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
        /* 原图是哪种导出就按哪种重绘：editor 走 buildEditorSvg（矢量重建，所见即所得）；
           skill-modern 走随面板内联的无浏览器渲染器（与 skill 导出同一渲染）；其余（默认）
           走 getExportSvg（官方 WaveDrom 渲染）。后两者无 w/h 返回值，从 SVG 文本上解析 */
        var ex = null;
        if (IMG.kind === 'editor' && typeof buildEditorSvg === 'function') {
          var es = buildEditorSvg();
          if (es) ex = { str: new XMLSerializer().serializeToString(es), w: +es.getAttribute('width'), h: +es.getAttribute('height') };
        }
        if (ex === null && IMG.kind === 'skill-modern' && window.WaveDromModern && typeof window.WaveDromModern.renderModern === 'function') {
          try {
            var srcDoc = JSON.parse(localStorage.getItem(KEY) || 'null');
            var rr = window.WaveDromModern.renderModern(srcDoc, {});
            /* 模板字符串里的正则：\s \d 必须双写反斜杠，否则转义被模板吃掉变成字面量 */
            var mstr = String(rr.svg).replace(/^<\\?xml[^>]*\\?>\\s*/, '');
            var mw = parseInt((mstr.match(/<svg[^>]*\\swidth="([\\d.]+)"/) || [])[1], 10);
            var mh = parseInt((mstr.match(/<svg[^>]*\\sheight="([\\d.]+)"/) || [])[1], 10);
            if (mw > 0 && mh > 0) ex = { str: mstr, w: mw, h: mh, transparent: true };
          } catch (e) { /* 渲染失败退回官方渲染 */ }
        }
        if (ex === null) ex = getExportSvg();
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
            /* 编辑区导出的底色随主题（cssVar('--bg')），官方渲染维持白底（与导出按钮一致）；
               skill-modern 的原导出未经填充（透明底），写回保持透明 */
            if (!ex.transparent) {
              var fill = '#ffffff';
              try { if (IMG.kind === 'editor') { var bg = cssVar('--bg'); if (bg) fill = bg; } } catch (e) {}
              ctx.fillStyle = fill; ctx.fillRect(0, 0, cv.width, cv.height);
            }
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
  }, 250);
})();
</script>
`;
  html = html.replace(/<\/body>/i, rendererInline + poller + '</body>');
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
     则内容对不上，自动退回按内容匹配。list 为空（hover 链接只带行号，不带内容——
     command URI 里塞整段 JSON 会超长）时行号即唯一依据 */
  if (typeof lineHint === 'number' && lineHint >= 0) {
    const at = all.find(c => lineOfIndex(text, c.index) === lineHint && (list.length === 0 || hitContent(c) || hitLoose(c)));
    if (at) return at;
  }
  if (list.length) return all.find(hitContent) || all.find(hitLoose) || null;
  return null;
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
    const isSvg = /\.svg$/i.test(target.imgPath);
    /* SVG 要把检测到的来源标记一并写回：svgWithMeta 不带 kind 会重写整个 metadata
       块、剥掉 data-export——标记丢失后只能靠指纹兜底（skill-modern 的指纹较弱），
       与像素路径（flushPixels 的 svgWithMeta 带标记）保持同一策略 */
    const out = isSvg
      ? Buffer.from(svgWithMeta(bytes.toString('utf8'), json,
          svgDetectExportKind(bytes.toString('utf8')) || 'skill-modern'), 'utf8')
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

/* ---------------- 预览镜头的侧边预览面板（「钉住」的悬浮预览） ----------------
 * VS Code 没有悬浮窗 API，悬浮形态只有 hover（不可交互、不可钉住）。所以点击
 * CodeLens「预览」开的是 Beside 分栏的轻量只读面板：不遮挡代码，再点同一条镜头
 * 关闭，面板里也有关闭按钮；编辑写回引起的文档变更会自动刷新这里的渲染。 */
let pinnedPreview = null; // { key, docPath, line, fenceRaw, panel, timer }
const previewKey = (docPath, line) => docPath + '#' + line;

async function previewFenceCommand(target) {
  if (!target || target.kind !== 'fence') return;
  const key = previewKey(target.docPath, target.line);
  if (pinnedPreview && pinnedPreview.key === key) { pinnedPreview.panel.dispose(); return; }
  if (pinnedPreview) pinnedPreview.panel.dispose(); // 换一块：旧面板让位（onDidDispose 清指针）
  await openPinnedPreview(target);
}

async function openPinnedPreview(target) {
  let doc;
  try { doc = await vscode.workspace.openTextDocument(target.docPath); }
  catch (e) { vscode.window.showErrorMessage(t('WaveDrom: Failed to open the editor — {0}', e.message)); return; }
  const hit = findFenceAtLine(doc.getText(), target.line);
  if (!hit) { vscode.window.showErrorMessage(t('WaveDrom: Cannot find this code block (has the document changed?)')); return; }
  const panel = vscode.window.createWebviewPanel(
    'wavedromPreview',
    t('WaveDrom Preview — {0}', 'L' + (target.line + 1)),
    vscode.ViewColumn.Beside,
    { enableScripts: true },
  );
  pinnedPreview = { key: previewKey(target.docPath, target.line), docPath: target.docPath, line: target.line, fenceRaw: hit[1], panel, timer: null };
  panel.webview.html = previewWebviewHtml(renderSvg(hit[1]));
  panel.webview.onDidReceiveMessage(msg => { if (msg && msg.type === 'close') panel.dispose(); });
  panel.onDidDispose(() => { if (pinnedPreview && pinnedPreview.panel === panel) pinnedPreview = null; });
}

/* 编辑写回 → 文档变更 → 这里重建面板 HTML。debounce 与编辑面板的连续保存节奏对齐，
   避免逐键重渲染。定位走「行号优先、内容兜底」（findFence，与 editFence 同策略）：
   文档前部插行导致行号漂移时，按打开时记录的围栏内容跟随到新位置，定位成功后把
   行号/内容/key 演进到最新，链条持续；行号与内容都对不上（块被改得面目全非）才
   如实提示，绝不按旧行号硬渲染造成静默错位 */
function pinRefresh() {
  if (!pinnedPreview) return;
  if (pinnedPreview.timer) clearTimeout(pinnedPreview.timer);
  pinnedPreview.timer = setTimeout(async () => {
    const pin = pinnedPreview;
    if (!pin) return;
    pin.timer = null;
    try {
      const doc = await vscode.workspace.openTextDocument(pin.docPath);
      const text = doc.getText();
      const hit = findFence(text, [pin.fenceRaw].filter(Boolean), pin.line);
      if (!hit) {
        pin.panel.webview.html = previewWebviewHtml({ err: t('WaveDrom: Cannot find this code block (has the document changed?)') });
        return;
      }
      pin.fenceRaw = hit[1];
      pin.line = lineOfIndex(text, hit.index);
      pin.key = previewKey(pin.docPath, pin.line);
      pin.panel.webview.html = previewWebviewHtml(renderSvgCached(hit[1]));
    } catch (e) { /* 文档已关闭等：留着旧画面 */ }
  }, 250);
}

function previewWebviewHtml(res) {
  const body = res.svg
    ? `<img alt="WaveDrom preview" src="data:image/svg+xml;base64,${Buffer.from(res.svg, 'utf8').toString('base64')}">`
    : `<div class="err">${escapeHtml(res.err || '')}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; background: #EEF1F6; }
  body { display: flex; flex-direction: column; }
  .bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
         border-bottom: 1px solid #CBD5E4; font: 12px/1.4 sans-serif; color: #54637F; }
  .bar button { margin-left: auto; border: 1px solid #CBD5E4; border-radius: 6px; background: #fff;
                color: #1B2536; font: 12px/1 sans-serif; padding: 4px 10px; cursor: pointer; }
  .bar button:hover { border-color: #0E9F6E; color: #0B7A55; }
  .stage { flex: 1; overflow: auto; padding: 10px; }
  .stage img { display: block; max-width: none; }
  .err { font: 12px/1.6 sans-serif; color: #B44; padding: 8px; }
</style></head><body>
<div class="bar"><span>${escapeHtml(t('WaveDrom Preview'))}</span><button onclick="acquireVsCodeApi().postMessage({type:'close'})">${escapeHtml(t('Close'))}</button></div>
<div class="stage">${body}</div>
</body></html>`;
}

/* ---------------- hover 悬浮预览（临时形态：离开自动关闭） ----------------
 * VS Code 的 hover 只能挂在文档文本上，CodeLens 那条带不触发 hover——所以悬停
 * 预览落在围栏起始行（```wavedrom，即 CodeLens 正下方）：鼠标从镜头下移即入，
 * 移开自动关闭是 hover 的原生行为。位置（下方/上方）由 VS Code 按空间自动选。 */
function makeHoverProvider() {
  return {
    provideHover(doc, pos) {
      if (doc.languageId !== 'markdown') return null;
      const hit = findFenceAtLine(doc.getText(), pos.line);
      if (!hit) return null;
      const line = lineOfIndex(doc.getText(), hit.index);
      const res = renderSvgCached(hit[1]);
      const md = new vscode.MarkdownString();
      md.isTrusted = true; // 允许 command 链接（固定预览 / 编辑入口）
      md.supportHtml = false;
      if (res.svg) {
        md.appendMarkdown(`![waveform](data:image/svg+xml;base64,${Buffer.from(res.svg, 'utf8').toString('base64')})\n\n`);
      } else {
        md.appendMarkdown(res.err + '\n\n');
      }
      /* 链接只带 docPath+line：command URI 里塞整段 JSON 会超长；两个命令内部都按行号重新定位 */
      const args = encodeURIComponent(JSON.stringify([{ kind: 'fence', docPath: doc.uri.fsPath, line }]));
      md.appendMarkdown(`[${t('Pin preview (opens beside)')}](command:wavedrom-gui.previewFence?${args})`);
      return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, 0));
    },
  };
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
        /* 预览镜头在前：看波形是高频动作；点击开侧边预览面板，再点同一条关闭 */
        lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: t('Preview'),
          command: 'wavedrom-gui.previewFence',
          arguments: [{ kind: 'fence', docPath: doc.uri.fsPath, line }],
        }));
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
  ctx.subscriptions.push(vscode.commands.registerCommand('wavedrom-gui.previewFence', previewFenceCommand));
  ctx.subscriptions.push(vscode.commands.registerCommand('wavedrom-gui.openImage', openImageCommand));
  ctx.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'markdown' }, makeCodeLensProvider()));
  ctx.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'markdown' }, makeHoverProvider()));
  /* 预览面板开着时跟随文档变更（编辑面板写回、手改代码都会走到这里） */
  ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument(ev => {
    if (pinnedPreview && ev.document.uri.fsPath === pinnedPreview.docPath) pinRefresh();
  }));
  /* 入口形式烙在渲染出的 HTML 里，改设置后必须重渲染预览才生效；markdown 预览不会因为
     别的扩展的设置变化自动刷新，这里主动刷一次。命令不存在也不该影响设置本身 */
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(ev => {
    if (ev.affectsConfiguration('wavedrom-gui.imageExportTheme')) {
      /* 图片输出主题在面板建立时生效：已打开的编辑面板拿着旧 kind，提示重开 */
      vscode.window.showInformationMessage(t('WaveDrom: image export theme applies to editor panels opened from now on'));
    }
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
    withCacheBust,
    languageSetting, uiLang, zhStrings, t, editLink, handleUri,
    editFromPreviewCommand, makePlugin, makeCodeLensProvider, editFenceCommand, editImageCommand, editTargets, registerKey,
    findFence, findFenceAtLine, saveBack, writeText, openEditor, lineOfIndex, buildEditorHtml, panelDocKey,
    parseLoose, rendererModule, renderSvg, previewFenceCommand, makeHoverProvider, previewWebviewHtml,
    readImageTarget, setupEditorPanel, openImageCommand, imageExportTheme, pinRefresh,
  },
};

