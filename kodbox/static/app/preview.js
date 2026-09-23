/* wavedrom-gui × kodbox —— 预览页(由 app.php 的 preview / index 路由输出)
 *
 * 只做一件事：把文件当图画出来。
 *   .wave.png / .wave.svg —— 盘上已经是渲染结果，直接摆原文件；
 *   .wave                 —— 源码没有现成的图，起一个隐藏 iframe 装载编辑器渲一次，
 *                            取回 SVG 再销毁。iframe 走 app.php 的 render 路由，
 *                            bridge.js 在该模式下只出图、不写盘。
 * 两条路都把图交给 <img>：SVG 用 blob URL 走 img，里面的脚本不会被执行。
 */
(function () {
  'use strict';

  var node = document.getElementById('wd-config');
  var C = {};
  try { C = JSON.parse(node && node.textContent) || {}; } catch (e) {}
  var L = function (k) { return (C.lng && C.lng[k]) || k; };

  var stage = document.getElementById('wdStage');
  var btn = document.getElementById('wdEdit');
  var tipEl = document.getElementById('wdTip');
  var nameEl = document.getElementById('wdName');

  nameEl.textContent = C.fileName || '';
  document.title = C.fileName || 'Waveform';
  btn.textContent = L('edit');

  var tipTimer = null;
  function tip(text) {
    // 能借到宿主的消息条就借（看着和网盘自己的提示一致），独立开窗口时才用页内气泡
    try {
      var T = window.parent && window.parent.Tips;
      if (T && T.tips) { T.tips(text, 'warning'); return; }
    } catch (e) {}
    tipEl.textContent = text;
    tipEl.classList.add('on');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { tipEl.classList.remove('on'); }, 2400);
  }

  /* ---------- 编辑入口 ---------- */
  function installEdit() {
    if (C.canWrite && C.editUrl) {
      btn.onclick = function () { location.href = C.editUrl; };
      return;
    }
    btn.classList.add('off');
    btn.setAttribute('aria-disabled', 'true');
    btn.onclick = function () { tip(L('readonly')); };
  }

  /* ---------- 画面 ---------- */
  function clear() { stage.innerHTML = ''; }

  function state(text, spin, err) {
    clear();
    var box = document.createElement('div');
    box.className = 'wd-state' + (err ? ' err' : '');
    if (spin) {
      box.innerHTML = '<svg class="wd-spin" width="18" height="18" viewBox="0 0 22 22" fill="none" aria-hidden="true">'
        + '<path d="M1 14h4V6h4v10h4V6h4v8h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    var s = document.createElement('span');
    s.textContent = text;
    box.appendChild(s);
    stage.appendChild(box);
  }

  function picture(url, revoke) {
    var card = document.createElement('div');
    card.className = 'wd-card';
    var img = document.createElement('img');
    img.alt = C.fileName || '';
    img.onload = function () { if (revoke) setTimeout(function () { URL.revokeObjectURL(url); }, 4000); };
    img.onerror = function () {
      if (revoke) URL.revokeObjectURL(url);
      showSource();
    };
    img.src = url;
    card.appendChild(img);
    clear();
    stage.appendChild(card);
  }

  function filePic() {
    var url = C.fileUrl + (C.fileUrl.indexOf('?') >= 0 ? '&' : '?') + '_wv=' + encodeURIComponent(C.ver || '');
    picture(url);
  }

  /* 渲染不成(源码解不出波形、iframe 挂了)时至少让用户看见文件里写了什么 */
  function showSource(msg) {
    var x = new XMLHttpRequest();
    x.open('GET', C.fileUrl + (C.fileUrl.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(), true);
    x.onload = function () {
      clear();
      var pre = document.createElement('pre');
      pre.className = 'wd-src';
      pre.textContent = String(x.responseText || '');
      stage.appendChild(pre);
      if (msg) tip(msg);
    };
    x.onerror = function () { state(msg || L('fail'), false, true); };
    x.send();
  }

  /* ---------- .wave：借编辑器渲一张 SVG ---------- */
  function renderViaEditor() {
    if (!C.renderUrl) return state(L('noFile'), false, true);
    state(L('loading'), true);
    var frame = document.createElement('iframe');
    frame.className = 'wd-render';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.src = C.renderUrl;
    document.body.appendChild(frame);

    var settled = false;
    var kill = function () {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    };
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      kill();
      showSource(L('fail'));
    }, 20000);

    function ask() {
      try { frame.contentWindow.postMessage({ type: 'wd-render' }, window.location.origin); }
      catch (e) { settled = true; kill(); showSource(L('fail')); }
    }
    function onMessage(ev) {
      if (ev.source !== frame.contentWindow) return;
      var d = ev.data;
      if (!d || !d.app) return;
      if (d.type === 'wd-ready') return ask();
      if (d.type !== 'wd-svg') return;
      if (settled) return;
      settled = true;
      kill();
      if (d.error) return showSource(d.error === 'no-meta' ? L('noMeta') : L('fail'));
      var url = URL.createObjectURL(new Blob([String(d.svg || '')], { type: 'image/svg+xml;charset=utf-8' }));
      picture(url, true);
    }
    window.addEventListener('message', onMessage);
  }

  /* ---------- 启动 ---------- */
  installEdit();
  if (!C.fileUrl) { state(L('noFile'), false, true); return; }
  if (C.kind === 'json') renderViaEditor();
  else filePic();
})();
