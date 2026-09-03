(function () {
  'use strict';
  /* 本脚本不使用 acquireVsCodeApi：预览→扩展的「编辑」走回环信标（extension.js 内置桥） */

  const B64 = {
    enc: function (s) { return btoa(unescape(encodeURIComponent(s))); },
    dec: function (b) { return decodeURIComponent(escape(atob(b))); },
  };

  let lastTheme = null; // 用户最近一次点选的主题，新块默认跟随

  function stripXml(s) { return s.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/<!DOCTYPE[^>]*>\s*/i, ''); }

  function renderModern(jsonText) {
    const src = JSON.parse(jsonText);
    const r = window.WaveDromModern.renderModern(src, {});
    return { svg: stripXml(r.svg) };
  }

  function renderTraditional(jsonText) {
    const src = JSON.parse(JSON.stringify(JSON.parse(jsonText)));
    let skinName = (src.config && src.config.skin) || 'default';
    if (!window.WaveSkin[skinName]) skinName = 'default';
    if (skinName !== 'default') src.config = Object.assign({}, src.config, { skin: skinName });
    const tree = window.WaveDrom.renderAny(0, src, window.WaveSkin);
    return { svg: stripXml(window.WaveDrom.stringify(tree)) };
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
    if (div.dataset.theme && !lastTheme) lastTheme = div.dataset.theme;
    let theme = (lastTheme && lastTheme !== 'source') ? lastTheme : (div.dataset.theme || 'modern');
    let showSource = false;

    const originalImg = kind === 'image' ? div.querySelector('img') : null;

    const bar = el('div', 'wd-bar');
    const body = el('div', 'wd-body');

    const themes = [['modern', '现代'], ['traditional', '传统']];
    const btns = {};
    themes.forEach(function (p) {
      const b = el('button', 'wd-btn', p[1]);
      b.type = 'button';
      b.addEventListener('click', function () { theme = p[1]; lastTheme = p[1]; showSource = false; apply(); });
      bar.appendChild(b);
      btns[p[0]] = b;
    });
    if (kind === 'fence') {
      const src = el('button', 'wd-btn', '源码');
      src.type = 'button';
      src.addEventListener('click', function () { showSource = !showSource; apply(); });
      bar.appendChild(src);
      btns.source = src;
    }
    if (originalImg) {
      const orig = el('button', 'wd-btn', '原图');
      orig.type = 'button';
      orig.addEventListener('click', function () { theme = 'original'; apply(); });
      bar.appendChild(orig);
      btns.original = orig;
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

      if (showSource && btns.source) {
        btns.source.classList.add('on');
        const pre = el('pre', 'wd-code');
        pre.textContent = jsonText;
        body.appendChild(pre);
        return;
      }
      if (theme === 'original' && originalImg) {
        btns.original.classList.add('on');
        body.appendChild(originalImg);
        return;
      }
      const key = theme === 'traditional' ? 'traditional' : 'modern';
      btns[key].classList.add('on');
      const holder = el('div', 'wd-svg');
      try {
        const r = key === 'traditional' ? renderTraditional(jsonText) : renderModern(jsonText);
        holder.innerHTML = r.svg;
      } catch (e) {
        holder.innerHTML = errSvg(e.message);
        const pre = el('pre', 'wd-code');
        pre.textContent = jsonText;
        body.appendChild(pre);
      }
      if (holder.firstChild) body.appendChild(holder);
      if (originalImg && originalImg.parentNode !== div) { /* 原图节点始终保底挂在 div 上 */ }
    }

    div.innerHTML = '';
    div.appendChild(bar);
    if (originalImg) div.appendChild(originalImg); // 先挂上保底，apply 时再移动
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
