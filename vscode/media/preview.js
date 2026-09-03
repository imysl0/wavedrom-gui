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

  function beacon(div) {
    const port = div.dataset.port, token = div.dataset.token, k = div.dataset.k;
    if (!port || !k) return false;
    const img = new Image();
    img.src = 'http://127.0.0.1:' + port + '/edit?t=' + encodeURIComponent(token)
      + '&k=' + encodeURIComponent(k) + '&r=' + Math.random();
    return true;
  }

  function initBlock(div) {
    if (div.dataset.wdInit) return;
    div.dataset.wdInit = '1';

    let jsonText = '';
    try { jsonText = B64.dec(div.dataset.json || ''); } catch (e) { /* 保持为空 */ }
    const kind = div.dataset.wd; // fence | image

    const bar = el('div', 'wd-bar');
    const body = el('div', 'wd-body');
    const btns = {};
    let mode = 'svg'; // svg | source

    if (kind === 'fence') {
      const src = el('button', 'wd-btn', '源码');
      src.type = 'button';
      src.addEventListener('click', function () { mode = mode === 'source' ? 'svg' : 'source'; apply(); });
      bar.appendChild(src);
      btns.source = src;
    }
    const edit = el('button', 'wd-btn wd-edit', '✏ 编辑');
    edit.type = 'button';
    edit.addEventListener('click', function () { if (!beacon(div)) errNoBridge(); });
    bar.appendChild(edit);

    function errNoBridge() {
      vscodeToast('WaveDrom 桥未就绪，可用命令面板「WaveDrom: 编辑当前 Markdown 中的图表」');
    }
    function vscodeToast(msg) {
      const t = el('div', 'wd-toast', msg);
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 2600);
    }

    function apply() {
      Object.keys(btns).forEach(function (k) { btns[k].classList.remove('on'); });
      body.innerHTML = '';

      if (mode === 'source' && btns.source) {
        btns.source.classList.add('on');
        const pre = el('pre', 'wd-code');
        pre.textContent = jsonText;
        body.appendChild(pre);
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
        body.appendChild(pre);
      }
      if (holder.firstChild) body.appendChild(holder);
    }

    div.innerHTML = '';
    div.appendChild(bar);
    div.appendChild(body);
    apply();
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
