(function () {
  'use strict';
  /* 本脚本不使用 acquireVsCodeApi：预览→扩展的「编辑」走回环信标（extension.js 内置桥） */

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

  function toast(msg) {
    const t = el('div', 'wd-toast', msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  /* 信标是发往扩展宿主 127.0.0.1 端口的一张图片，成功时毫秒级返回。三种失败要区分开：
     CSP 拦截会立刻 onerror；终端安全软件丢弃回环连接则表现为长时间不出结果（SYN 超时），
     因此另设一个短超时兜底提示——否则按钮点下去会安静二十来秒，像没反应。 */
  const FALLBACK = '可改用命令面板「WaveDrom: 编辑当前 Markdown 中的图表」';
  function beacon(div) {
    const port = div.dataset.port, token = div.dataset.token, k = div.dataset.k;
    if (!port || !k) return false;
    let settled = false;
    const img = new Image();
    const timer = setTimeout(function () {
      if (settled) return;
      toast('编辑请求未送达：本机到扩展宿主的回环连接疑似被安全软件拦截。' + FALLBACK);
    }, 2500);
    img.onload = function () { settled = true; clearTimeout(timer); };
    img.onerror = function () {
      settled = true; clearTimeout(timer);
      toast('编辑请求被预览安全策略拦截：请点预览右上角「…」→「允许不安全的本地内容」后重试；' + FALLBACK);
    };
    img.src = 'http://127.0.0.1:' + port + '/edit?t=' + encodeURIComponent(token)
      + '&k=' + encodeURIComponent(k) + '&r=' + Math.random();
    return true;
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

  function initBlock(div) {
    if (div.dataset.wdInit) return;
    div.dataset.wdInit = '1';

    let jsonText = '';
    try { jsonText = B64.dec(div.dataset.json || ''); } catch (e) { /* 保持为空 */ }

    function requestEdit() {
      if (!beacon(div)) {
        toast('WaveDrom 桥未就绪，可用命令面板「WaveDrom: 编辑当前 Markdown 中的图表」');
      }
    }

    /* 入口形式由扩展写在 data-edit-mode（设置项 wavedrom-gui.previewEditAffordance）：
       button = 右上角铅笔按钮（默认）；block = 不加按钮，点波形任意处即编辑 */
    const blockMode = div.dataset.editMode === 'block';

    /* .wd-figure 收缩到图形自身宽度（宽图仍是整栏宽），操作行因此贴着图形右上角，
       图窄时按钮不会孤零零漂到面板最右侧 */
    const figure = el('div', 'wd-figure');
    if (!blockMode) {
      const actions = el('div', 'wd-actions');
      const edit = el('button', 'wd-edit');
      edit.type = 'button';
      edit.title = '编辑（在可视化编辑器中打开）';
      edit.setAttribute('aria-label', '编辑');
      edit.innerHTML = EDIT_ICON;
      edit.addEventListener('click', requestEdit);
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
    div.appendChild(figure);

    if (blockMode) {
      /* 没有按钮，唯一入口就是波形本身：给指针与提示，键盘（Enter/Space）同样可用 */
      div.classList.add('wd-clickable');
      div.title = '编辑（在可视化编辑器中打开）';
      div.setAttribute('role', 'button');
      div.setAttribute('tabindex', '0');
      div.addEventListener('click', requestEdit);
      div.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
        ev.preventDefault();
        requestEdit();
      });
    }
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
