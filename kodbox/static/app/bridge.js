/* wavedrom-gui × kodbox —— 编辑器宿主桥接
 *
 * index.html 一行不改：这里只负责「把文件取进来 → 解出内嵌 WaveJSON → 交给编辑器 →
 * 把编辑器的导出写回原文件」。保存走编辑器自己的导出流程(handleAct('export-*') +
 * 拦截 download())，所以落盘的内容与用户手动点「导出」完全一致(含 WaveJSON 元数据)。
 * 用到的 applyDocJSON / parseLoose / fmtJSON / handleAct / toast 都是编辑器的顶层函数。
 */
(function () {
  'use strict';
  var H = window.WD_HOST;
  if (!H || !H.docKey) return;

  var L = function (k) { return (H.lng && H.lng[k]) || k; };
  var KIND = H.kind || 'json';                 // png | svg | json；「另存为」换目标后会跟着改
  var SEED = { signal: [{ name: 'clk', wave: 'p....' }] };   // 新建文件的起点：一拍时钟

  var srcKind = '', baseline = null, dirty = false, busy = false, capture = null, autoTimer = null;
  var picking = false;                         // 「另存为」弹窗开着
  var el = {};

  /* ---------- 遮罩：编辑器启动会先恢复本地自动保存的图表，取到文件前别让用户看见那一瞬 ---------- */
  var css = document.createElement('style');
  css.textContent = '@keyframes wdHostSpin{to{transform:rotate(360deg)}}'
    + '#wdHostMask{position:fixed;left:0;right:0;top:0;bottom:0;z-index:99999;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:14px;background:var(--bg);color:var(--muted);font-size:13px;transition:opacity .2s}'
    + '#wdHostMask.out{opacity:0;pointer-events:none}'
    + '.wd-host{display:flex;align-items:center;gap:8px}'
    + '.wd-host-status{font-size:12px;color:var(--muted);white-space:nowrap}'
    + '.wd-host-status.warn{color:var(--amber)}.wd-host-status.err{color:var(--danger)}'
    + '@media (max-width:860px){.wd-host-status{display:none}}';
  document.head.appendChild(css);

  var mask = document.createElement('div');
  mask.id = 'wdHostMask';
  mask.innerHTML = '<svg width="28" height="28" viewBox="0 0 22 22" fill="none" aria-hidden="true" style="color:var(--acc);animation:wdHostSpin 1.1s linear infinite">'
    + '<path d="M1 14h4V6h4v10h4V6h4v8h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var maskText = document.createElement('span');
  maskText.textContent = L('loading');
  mask.appendChild(maskText);
  document.body.appendChild(mask);

  function hideMask(text) {
    if (!mask || !mask.parentNode) return;
    if (text) { maskText.textContent = text; setTimeout(function () { drop(); }, 1200); }
    else drop();
    function drop() {
      mask.classList.add('out');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); mask = null; }, 260);
    }
  }
  function notify(msg, err) { try { toast(msg, err); } catch (e) {} }
  function setStatus(text, cls) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.className = 'wd-host-status' + (cls ? ' ' + cls : '');
  }

  /* ---------- 顶栏：保存按钮 + 状态 ---------- */
  function installBar() {
    var bar = document.querySelector('.topbar');
    if (!bar) return;
    var wrap = document.createElement('div');
    wrap.className = 'wd-host';
    el.status = document.createElement('span');
    el.status.className = 'wd-host-status';
    el.btn = document.createElement('button');
    el.btn.type = 'button';
    el.btn.className = 'btn';
    el.btn.textContent = L('save');
    el.btn.title = 'Ctrl+S';
    el.btn.addEventListener('click', function () { save(true); });
    wrap.appendChild(el.status);
    wrap.appendChild(el.btn);
    var anchor = bar.querySelector('.spacer');
    if (anchor) anchor.insertAdjacentElement('afterend', wrap);
    else bar.appendChild(wrap);
    if (!saveable()) {
      el.btn.disabled = true;
      setStatus(H.fileUrl ? L('readonly') : L('noFile'), 'warn');
    }
  }

  /* ---------- 读文件 ---------- */
  function readFile(cb) {
    if (!H.fileUrl) return cb(new Error('no-file'));
    var url = H.fileUrl + (H.fileUrl.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.responseType = 'arraybuffer';
    x.onload = function () {
      if (x.status && x.status >= 400) return cb(new Error('HTTP ' + x.status));
      cb(null, new Uint8Array(x.response || []));
    };
    x.onerror = function () { cb(new Error('network')); };
    x.send();
  }

  function utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return ''; }
  }
  /* PNG 的文本块：编辑器只会写未压缩 iTXt，但 tEXt 也认（与外部工具产出的图兼容） */
  function pngKeyword(bytes, keyword) {
    var sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (var i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder('utf-8');
    for (var off = 8; off + 8 <= bytes.length; ) {
      var len = dv.getUint32(off);
      var type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (type === 'IEND') break;
      if (len > 0 && (type === 'iTXt' || type === 'tEXt')) {
        var body = bytes.subarray(off + 8, off + 8 + len), z = body.indexOf(0);
        if (z >= 0 && dec.decode(body.subarray(0, z)) === keyword) {
          if (type === 'tEXt') return dec.decode(body.subarray(z + 1));
          var p = z + 3;                                   // 跳过压缩标志与压缩方法
          while (p < body.length && body[p] !== 0) p++; p++;  // 语言标签
          while (p < body.length && body[p] !== 0) p++; p++;  // 翻译关键字
          return dec.decode(body.subarray(p));
        }
      }
      off += 12 + len;
    }
    return null;
  }

  /* 文件 → WaveJSON 文本 + 原图导出来源；解不出返回 null（空文件 / 普通图片改名 / 手写内容坏掉） */
  function decodeFile(bytes) {
    srcKind = '';
    if (!bytes || !bytes.length) return { empty: true, json: null };
    if (KIND === 'png') {
      srcKind = (pngKeyword(bytes, 'WaveDromGui') || '').replace(/^export=/, '');
      return { json: pngKeyword(bytes, 'WaveJSON') };
    }
    var text = utf8(bytes).replace(/^\ufeff/, '');
    if (KIND === 'svg') {
      var m = /<metadata[^>]*data-export="([a-z-]+)"/i.exec(text);
      srcKind = m ? m[1] : '';
      try { return { json: svgExtractWaveJSON(text) }; } catch (e) { return { json: null }; }
    }
    return { json: text };
  }

  function loadIntoEditor(json) {
    try { applyDocJSON(json ? parseLoose(json) : JSON.parse(JSON.stringify(SEED))); }
    catch (e) { try { applyDocJSON(JSON.parse(JSON.stringify(SEED))); } catch (e2) {} }
  }

  /* ---------- 写回 ---------- */
  function codeCompactOn() { try { return !!codeCompact; } catch (e) { return false; } }
  function docText() { return fmtJSON(buildJSON(), 0, codeCompactOn()); }

  /* 原图是哪种导出就按哪种重绘：官方渲染（wavedrom）保持官方，其余走编辑区矢量重建。
     认不出来源（新建的空文件、被别的工具剥掉元数据的图）兜底编辑区风格——与屏幕上
     看到的预览一致，也与 VSCode 插件 extension.js 里 `|| 'skill-modern'` 的兜底同调。 */
  function exportAction() {
    var editorStyle = (srcKind !== 'wavedrom');
    if (KIND === 'svg') return editorStyle ? 'export-editor-svg' : 'export-svg';
    return editorStyle ? 'export-editor-png' : 'export-png';
  }

  /* 导出按钮的产物交给浏览器下载；宿主模式下截下来落盘。
     没有截获任务在跑时(用户手动点顶栏「导出」)仍按原样下载。 */
  window.__wdDownloadHook = function (name, blob) {
    if (capture) { var cb = capture; capture = null; cb(null, blob); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  };
  function captureExport(act, cb) {
    if (!document.querySelector('#wv0 svg')) {      // 预览面板可能被切走了，导出的正是它的画面
      var tab = document.querySelector('.right-tabs .tab[data-tab="preview"]');
      if (tab) tab.click();
    }
    var timer = setTimeout(function () {
      if (capture) { capture = null; cb(new Error('render-timeout')); }
    }, 20000);
    capture = function (err, blob) {
      clearTimeout(timer);
      if (!err) try { persist(); } catch (e) {}
      cb(err, blob);
    };
    try { handleAct(act); }
    catch (e) { clearTimeout(timer); if (capture) { capture = null; cb(e); } }
  }

  function blobToBase64(blob, cb) {
    var rd = new FileReader();
    rd.onload = function () { cb(null, String(rd.result || '').replace(/^[^,]*,/, '')); };
    rd.onerror = function () { cb(new Error('blob-read')); };
    rd.readAsDataURL(blob);
  }

  function send(content, isBase64, cb) {
    var body = 'path=' + encodeURIComponent(H.savePath)
      + '&content=' + encodeURIComponent(content)
      + (isBase64 ? '&base64=1' : '')
      + (H.csrfToken ? '&CSRF_TOKEN=' + encodeURIComponent(H.csrfToken) : '');
    var x = new XMLHttpRequest();
    x.open('POST', H.saveApi, true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8');
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) {}
      if (r && r.code === true) return cb(null);
      cb(new Error((r && r.data) || ('HTTP ' + x.status)));
    };
    x.onerror = function () { cb(new Error('network')); };
    x.send(body);
  }

  /* ---------- 「另存为」：没有落盘目标时(侧栏菜单打开的空白图表)，保存才选位置 ---------- */
  /* 对话框用的是宿主核心自己的另存为(kodbox pathAction.FileApi, type:'createFile')——
     一棵目录树 + 一个可改的全名输入框，标题、重名处理、权限校验都是核心现成的。
     编辑器在 iframe 里，弹窗画在父窗口；类由 main.js 在浏览器视图还在时存到 kodApp 上
     (侧栏入口是整页应用，会把浏览器视图顶掉)。 */
  function host() {
    try {
      var p = window.parent;
      if (!p || p === window || !p.kodApp) return null;
      var api = p.kodApp.__wavedromFileApi || (p.kodApp.pathAction && p.kodApp.pathAction.FileApi);
      return api ? { w: p, api: api } : null;
    } catch (e) { return null; }
  }
  function saveable() { return !!H.canWrite || (!H.savePath && !!host()); }

  function kindOfName(name) {
    name = String(name || '').toLowerCase();
    if (/\.wave\.png$/.test(name)) return 'png';
    if (/\.wave\.svg$/.test(name)) return 'svg';
    if (/\.wave$/.test(name)) return 'json';
    return '';
  }

  /* 把新文件认成当前目标：后缀决定按哪种格式重绘，之后 Ctrl+S 直接覆盖不再弹窗。
     换了格式就无从继承「原图风格」，退回编辑区(现代)出图。 */
  function adopt(info) {
    var one = (info && info.path) ? info : (info && info.length ? info[0] : null);
    var kind = kindOfName(one && one.name);
    if (!one || !kind) return false;
    if (kind !== KIND) srcKind = '';
    KIND = kind;
    H.savePath = one.path;
    H.canWrite = true;
    return true;
  }

  function saveAs() {
    var h = host();
    if (!h || picking) return;
    var w = h.w;
    picking = true;
    setStatus(L('saveAs'));
    new h.api({
      type: 'createFile',
      createFile: { name: L('newDefault') + '.wave.png' },
      callback: function (info) {
        picking = false;
        if (!adopt(info)) { setStatus(L('badName'), 'err'); notify(L('badName'), true); return; }
        save(true);
      }
    });
    /* 取消弹窗没有任何回调，只能盯着它还在不在，否则保存按钮一直卡在「选择保存位置」 */
    var timer = w.setInterval(function () {
      if (w.$(w.document).find('.pathSelectApi:visible').length) return;
      w.clearInterval(timer);
      if (!picking) return;
      picking = false;
      setStatus(H.canWrite ? '' : (H.fileUrl ? L('readonly') : L('noFile')), 'warn');
    }, 500);
  }

  function save(manual) {
    if (busy) return;
    if (!H.canWrite) {
      if (!H.savePath) { if (manual) saveAs(); return; }   // 自动保存不该弹窗，manual 才走
      if (manual) notify(L('readonly'), true);
      return;
    }
    busy = true;
    setStatus(L('saving'));
    finish(function (err, payload) {
      if (err) { busy = false; setStatus(err.message || L('saveFail'), 'err'); notify(L('saveFail') + '：' + (err.message || err), true); return; }
      send(payload.text, payload.base64, function (e2, msg) {
        busy = false;
        if (e2) { setStatus(e2.message || L('saveFail'), 'err'); notify(L('saveFail') + '：' + e2.message, true); return; }
        syncBaseline();
        setStatus(L('saved'));
        notify(L('saved'));
      });
    });
  }

  /* 生成要写盘的内容：源码文件写 JSON 文本，图片让编辑器按原风格导出一份再落盘 */
  function finish(done) {
    if (KIND === 'json') return done(null, { text: docText() });
    captureExport(exportAction(), function (err, blob) {
      if (err) return done(err);
      if (KIND === 'svg') {
        var rd = new FileReader();
        rd.onload = function () { done(null, { text: rd.result }); };
        rd.onerror = function () { done(new Error('blob-read')); };
        rd.readAsText(blob);
        return;
      }
      blobToBase64(blob, function (e, b64) {
        if (e) return done(e);
        done(null, { text: b64, base64: true });
      });
    });
  }

  /* ---------- 脏检测：编辑器每次改动都会防抖写入本文件的自动保存键 ---------- */
  function stored() { try { return localStorage.getItem(H.docKey); } catch (e) { return null; } }
  function syncBaseline() {
    try { persist(); } catch (e) {}
    baseline = stored();
    dirty = false;
  }
  function watchTick() {
    var v = stored();
    if (v === null || baseline === null) return;
    if (v === baseline) return;
    if (!dirty) { dirty = true; if (saveable()) setStatus(L('dirty'), 'warn'); }
    if (H.autoSave && H.canWrite) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () { save(false); }, 1200);
    }
  }

  document.addEventListener('keydown', function (ev) {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
    if (ev.key !== 's' && ev.key !== 'S') return;
    ev.preventDefault(); ev.stopPropagation();
    save(true);
  }, true);
  window.addEventListener('beforeunload', function (ev) {
    if (!dirty || busy) return;
    ev.preventDefault();
    ev.returnValue = L('dirty');
  });

  /* ---------- 启动 ---------- */
  function start() {
    if (typeof window.applyDocJSON !== 'function' || typeof window.handleAct !== 'function') {
      if ((start.tries = (start.tries || 0) + 1) < 200) return setTimeout(start, 50);
      hideMask(L('loadFail'));
      return;
    }
    if (!H.fileUrl) {                          // 从左侧菜单直接打开：保存时选位置，或「导出」下载到本地
      hideMask();
      if (!saveable() && el.btn) el.btn.disabled = true;
      setStatus(L('noFile'), 'warn');
      syncBaseline(); setInterval(watchTick, 300);
      return;
    }
    readFile(function (err, bytes) {
      if (err) { hideMask(); setStatus(L('loadFail'), 'err'); notify(L('loadFail'), true); return; }
      var out = decodeFile(bytes);
      var fresh = !!H.fresh || !!out.empty;         // 新建(或被截断的空文件)：先渲染一份合法内容落盘
      loadIntoEditor(out.json);
      if (!out.json && !out.empty) notify(L('noMeta'), true);
      setTimeout(function () {                       // 等编辑器的防抖自动保存落地，再取脏检测基线
        syncBaseline();
        setInterval(watchTick, 300);
        hideMask();
        if (fresh && H.canWrite) { setStatus(L('saving')); save(false); }
        else if (out.json && H.canWrite) setStatus(L('saved'));   // 打开即与盘上一致，别留着空白状态
      }, 900);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installBar);
  else installBar();
  start();
})();
