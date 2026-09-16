(function () {
  'use strict';
  /* 预览 → 扩展：用产品 scheme 的深链接（<a href="vscodium://…/edit?k=…">）。
     这里读不到我们自己的消息通道（acquireVsCodeApi 已被内置预览脚本占用），而回环
     图片信标在默认「严格」预览安全级别下会被 CSP 拦下并弹出放宽安全的提示，所以改由
     真实点击的锚点交给扩展的 URI 处理器。不发任何 http 请求，不产生 CSP 违规。 */

  const B64 = {
    /* btoa/atob 只认 Latin-1：UTF-8 先过 encodeURIComponent 变成纯 ASCII 百分号编码，
       再把 %XX 序列还原成字节。与旧写法（已废弃的 unescape/escape）行为等价 */
    enc: function (s) {
      const bytes = encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
      return btoa(bytes);
    },
    dec: function (b) {
      const bytes = atob(b);
      const comp = bytes.replace(/[\x80-\xff]/g, ch => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
      return decodeURIComponent(comp);
    },
  };

  function stripXml(s) { return s.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/<!DOCTYPE[^>]*>\s*/i, ''); }

  /* 候选就绪事件：build.js 生成的渲染库在挂上 window.WaveDromModern 之后立即派发 */
  const RENDERER_READY = 'wavedrom-renderer-ready';

  function rendererReady() {
    return !!(window.WaveDromModern && typeof window.WaveDromModern.renderModern === 'function');
  }

  /* 渲染库就绪后回调；三种兜底：已经在 / 收到就绪事件 / load 事件（async 脚本到 load 时都已执行完） */
  function whenRendererReady(cb) {
    if (rendererReady()) { cb(); return; }
    let done = false;
    const run = function () { if (done) return; done = true; cb(); };
    window.addEventListener(RENDERER_READY, run);
    window.addEventListener('load', run);
    setTimeout(run, 3000);
  }

  /* 宽松 WaveJSON 解析（无求值）：CLI 与编辑器都接受宽松写法（// 与块注释、免引号键、
     单引号串、尾逗号），预览必须同一覆盖面，否则同一代码块在命令行能渲染、在预览里报错。
     这里不做字符串感知扫描之外的任何求值——预览跑的是文档内容，不能给恶意构造的
     代码执行机会（编辑器/CLI 的求值回退不适用于这个场景） */
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

  function renderModern(jsonText) {
    if (!rendererReady()) throw new Error(i18nText('noRenderer', 'Waveform renderer not loaded (reopen the preview)'));
    const src = parseLoose(jsonText);
    const r = window.WaveDromModern.renderModern(src, {});
    return { svg: stripXml(r.svg) };
  }

  function errSvg(msg) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="46">'
      + '<rect width="100%" height="100%" fill="#fff3f0"/><text x="10" y="28" font-size="13" fill="#b44">'
      + String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 52)
      + '</text></svg>';
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* 界面文案由扩展按 VS Code 的显示语言渲染进 #wd-i18n（这个 webview 里拿不到
     vscode.l10n），缺了就用英文兜底。每次读取现查：i18n 节点由扩展在文档渲染期插入，
     首屏可能还没有——此前只在脚本加载时捕获一次，之后插入的节点永远不生效 */
  function i18nText(key, fallback) {
    const node = document.getElementById('wd-i18n');
    const d = node && node.dataset;
    return (d && d[key]) || fallback;
  }

  /* 铅笔图标与编辑器界面同风格（16 视框 / 1.4 描边 / 圆头），不依赖 emoji 字体：
     「✏」在 Windows、macOS 上会被渲染成彩色字形，与 VS Code 的单色图标不同调 */
  const EDIT_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<g transform="rotate(45 8 8)">'
    + '<rect x="6.6" y="2.2" width="2.8" height="8.6" rx=".6"/>'
    + '<path d="M6.6 11 8 13.6 9.4 11z"/>'
    + '<path d="M6.6 4.4h2.8"/>'
    + '</g></svg>';

  /* 把 wavedrom 上下文烙到某个节点（通常是右键真正命中的 <img>）：与节点上已有的
     data-vscode-context 合并——保留预览自己写的键，覆盖上我们的 webviewSection/k，并删掉
     preventDefaultContextMenuItems（否则预览的「图片专属」右键菜单会吞掉「编辑波形」）。 */
  function stampWdContext(node, wdContext) {
    if (!node || !wdContext || typeof node.setAttribute !== 'function') return;
    let merged = {};
    try {
      const cur = node.getAttribute('data-vscode-context');
      if (cur) merged = JSON.parse(cur);
    } catch (e) { merged = {}; }
    try { Object.assign(merged, JSON.parse(wdContext)); } catch (e) { /* 保留已合并内容 */ }
    delete merged.preventDefaultContextMenuItems;
    node.setAttribute('data-vscode-context', JSON.stringify(merged));
  }

  /* 收尾：图形（.wd-figure）挂进块容器；block 模式下整块套一层深链接锚点，
     点任意处即进编辑器。fence 与 image 共用。 */
  function finalizeBlock(div, figure, blockMode, editUri) {
    div.innerHTML = '';
    if (blockMode && editUri) {
      /* 没有按钮，整块就是入口：锚点原生可聚焦、Enter 可激活，不必再手写键盘处理 */
      const link = el('a', 'wd-blocklink');
      link.setAttribute('href', editUri);
      link.title = i18nText('editTitle', 'Edit (opens in the visual editor)');
      link.setAttribute('aria-label', i18nText('editLabel', 'Edit'));
      link.appendChild(figure);
      div.appendChild(link);
      return;
    }
    div.appendChild(figure);
  }

  function initBlock(div) {
    if (div.dataset.wdInit) return;
    div.dataset.wdInit = '1';

    const isImage = div.dataset.wd === 'image';
    let jsonText = '';
    if (!isImage) {
      try { jsonText = B64.dec(div.dataset.json || ''); } catch (e) { /* 保持为空 */ }
    }

    /* 深链接由扩展渲染时给出（含产品 scheme 与 k）。没有它说明这个块没有可写回的文件
       （例如未保存的 untitled 文档），此时不渲染任何入口，只渲染波形 */
    const editUri = div.dataset.editUri || '';

    /* 右键菜单的上下文：VS Code 会把这段 JSON 作为命令的第一个参数传给我们，
       扩展由此得知「右键的是哪一个块」。preventDefaultContextMenuItems 不设，
       预览原本的右键项（复制等）继续保留。图片与代码块都要，故提到分支之前统一挂 */
    const wdContext = editUri
      ? JSON.stringify({ webviewSection: 'wavedrom', k: div.dataset.k || '' })
      : '';
    if (wdContext) {
      div.setAttribute('data-vscode-context', wdContext);
    }

    /* 入口形式由扩展写在 data-edit-mode（设置项 wavedrom-gui.previewEditAffordance）：
       menu = 不加可见入口、右键菜单进（默认）；button = 右上角铅笔按钮；
       block = 不加按钮，点波形任意处即编辑 */
    const blockMode = div.dataset.editMode === 'block';
    const buttonMode = div.dataset.editMode === 'button';

    /* .wd-figure 收缩到图形自身宽度（宽图仍是整栏宽），操作行因此贴着图形右上角，
       图窄时按钮不会孤零零漂到面板最右侧 */
    const figure = el('div', 'wd-figure');
    if (buttonMode && editUri) {
      const actions = el('div', 'wd-actions');
      /* 必须是真锚点：深链接要被浏览器当成用户手势下的链接点击，才能交给扩展的 URI 处理器 */
      const edit = el('a', 'wd-edit');
      edit.setAttribute('href', editUri);
      edit.title = i18nText('editTitle', 'Edit (opens in the visual editor)');
      edit.setAttribute('aria-label', i18nText('editLabel', 'Edit'));
      edit.innerHTML = EDIT_ICON;
      actions.appendChild(edit);
      figure.appendChild(actions);
    }

    /* 含 WaveJSON 的图片：直接显示扩展渲染的原图 <img>（保持导出时的原生主题），
       不拿元数据重绘。旧实现恒用现代渲染器重画，会把传统/官方风格的图在预览里改掉风格 */
    if (isImage) {
      const holder = el('div', 'wd-svg');
      const img = div.querySelector('img');
      if (img) {
        holder.appendChild(img);
        /* VS Code 对 <img> 的右键有专属处理，祖先块上的 data-vscode-context 不再驱动
           webview/context，故把上下文直接烙到实际命中目标的 <img> 上 */
        stampWdContext(img, wdContext);
      }
      if (holder.firstChild) figure.appendChild(holder);
      finalizeBlock(div, figure, blockMode, editUri);
      return;
    }

    const holder = el('div', 'wd-svg');
    try {
      const r = renderModern(jsonText);
      holder.innerHTML = r.svg;
    } catch (e) {
      holder.innerHTML = errSvg(e.message);
      const pre = el('pre', 'wd-code');
      pre.textContent = jsonText;
      figure.appendChild(pre);
    }
    if (holder.firstChild) figure.appendChild(holder);

    finalizeBlock(div, figure, blockMode, editUri);
  }

  function scan() {
    /* 渲染库还没到就先别动代码块（否则每块都会渲染成「渲染库未加载」），等就绪事件再扫。
       VS Code 用 <script async> 注入预览脚本，执行顺序不保证——这里必须能等。
       图片块不依赖渲染库（只显示原图），渲染库未就绪时也能先挂好编辑入口，不被卡住 */
    const ready = rendererReady();
    const blocks = document.querySelectorAll('.wavedrom-block:not([data-wd-init])');
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!ready && b.dataset.wd !== 'image') continue;
      try { initBlock(b); } catch (e) { /* 单块失败不影响其他 */ }
    }
  }

  scan();
  new MutationObserver(function () { scan(); }).observe(document.body, { childList: true, subtree: true });
  /* preview.js 先于渲染库跑完时（async 注入，顺序不保证）在这里补扫一次 */
  whenRendererReady(scan);

  /* 兜底：预览可能在右键瞬间往 <img> 上盖它自己的 data-vscode-context，冲掉我们那份。
     捕获阶段监听器在菜单构建前，从所属图片块读回上下文重新烙到命中目标上。
     只处理含 WaveJSON 的图片块；代码块走既有的祖先合并机制，无需干预。 */
  document.addEventListener('contextmenu', function (e) {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const block = t.closest('.wavedrom-block[data-wd="image"]');
    if (!block) return;
    stampWdContext(t, block.getAttribute('data-vscode-context'));
  }, true);
})();
