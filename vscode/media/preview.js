(function () {
  'use strict';
  /* 预览 → 扩展：用产品 scheme 的深链接（<a href="vscodium://…/edit?k=…">）。
     这里读不到我们自己的消息通道（acquireVsCodeApi 已被内置预览脚本占用），而回环
     图片信标在默认「严格」预览安全级别下会被 CSP 拦下并弹出放宽安全的提示，所以改由
     真实点击的锚点交给扩展的 URI 处理器。不发任何 http 请求，不产生 CSP 违规。 */

  const B64 = {
    enc: function (s) { return btoa(unescape(encodeURIComponent(s))); },
    dec: function (b) { return decodeURIComponent(escape(atob(b))); },
  };

  function stripXml(s) { return s.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/<!DOCTYPE[^>]*>\s*/i, ''); }

  function renderModern(jsonText) {
    const src = JSON.parse(jsonText);
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
     vscode.l10n），缺了就用英文兜底 */
  const i18n = (() => {
    const node = document.getElementById('wd-i18n');
    const d = (node && node.dataset) || {};
    return {
      edit: d.editLabel || 'Edit',
      editTitle: d.editTitle || 'Edit (opens in the visual editor)',
    };
  })();

  /* 铅笔图标与编辑器界面同风格（16 视框 / 1.4 描边 / 圆头），不依赖 emoji 字体：
     「✏」在 Windows、macOS 上会被渲染成彩色字形，与 VS Code 的单色图标不同调 */
  const EDIT_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<g transform="rotate(45 8 8)">'
    + '<rect x="6.6" y="2.2" width="2.8" height="8.6" rx=".6"/>'
    + '<path d="M6.6 11 8 13.6 9.4 11z"/>'
    + '<path d="M6.6 4.4h2.8"/>'
    + '</g></svg>';

  function initBlock(div) {
    if (div.dataset.wdInit) return;
    div.dataset.wdInit = '1';

    let jsonText = '';
    try { jsonText = B64.dec(div.dataset.json || ''); } catch (e) { /* 保持为空 */ }

    /* 深链接由扩展渲染时给出（含产品 scheme 与 k）。没有它说明这个块没有可写回的文件
       （例如未保存的 untitled 文档），此时不渲染任何入口，只渲染波形 */
    const editUri = div.dataset.editUri || '';

    /* 右键菜单的上下文：VS Code 会把这段 JSON 作为命令的第一个参数传给我们，
       扩展由此得知「右键的是哪一个块」。preventDefaultContextMenuItems 不设，
       预览原本的右键项（复制等）继续保留。 */
    if (editUri) {
      div.setAttribute('data-vscode-context', JSON.stringify({
        webviewSection: 'wavedrom',
        k: div.dataset.k || '',
      }));
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
      edit.title = i18n.editTitle;
      edit.setAttribute('aria-label', i18n.edit);
      edit.innerHTML = EDIT_ICON;
      actions.appendChild(edit);
      figure.appendChild(actions);
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

    div.innerHTML = '';
    if (blockMode && editUri) {
      /* 没有按钮，整块就是入口：锚点原生可聚焦、Enter 可激活，不必再手写键盘处理 */
      const link = el('a', 'wd-blocklink');
      link.setAttribute('href', editUri);
      link.title = i18n.editTitle;
      link.setAttribute('aria-label', i18n.edit);
      link.appendChild(figure);
      div.appendChild(link);
      return;
    }
    div.appendChild(figure);
  }

  function scan() {
    const blocks = document.querySelectorAll('.wavedrom-block:not([data-wd-init])');
    for (let i = 0; i < blocks.length; i++) {
      try { initBlock(blocks[i]); } catch (e) { /* 单块失败不影响其他 */ }
    }
  }

  scan();
  new MutationObserver(function () { scan(); }).observe(document.body, { childList: true, subtree: true });
})();
