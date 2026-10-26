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

  var RENDER = !!H.renderOnly;                // 只当渲染器使：预览页起的隐藏 iframe
  var L = function (k) { return (H.lng && H.lng[k]) || k; };
  var KIND = H.kind || 'json';                 // png | svg | json；「另存为」换目标后会跟着改
  var SEED = { signal: [{ name: 'clk', wave: 'p....' }] };   // 新建文件的起点：一拍时钟

  var srcKind = '', dirty = false, busy = false, capture = null, autoTimer = null;
  var saveQueued = false;                      // 保存进行中又触发的保存：记一枪，收尾时补存
  /* 脏检测挂编辑器自己的 persist 钩子，不再轮询共享 localStorage 键：docKey 按文件派生、
     两标签页共用，A 的编辑会被 B 的轮询当成自己的改动、B 保存后还会用自己的旧内存盖掉
     A 未落盘的内容。钩子只听得见本页面编辑器的落盘，串台从根上不存在（与 VS Code 插件的
     注入脚本同模式）。docKey 键保留给编辑器自己：只承担启动闪现/装载兜底，两页互覆无实害
     （打开时 loadIntoEditor 永远以服务器文件内容收尾） */
  var armed = false;                           // 启动装载完成前钩子不计数（遮罩未揭，用户无从输入）
  var editorTouched = false;                   // 本次保存的载荷取走之后又发生过的编辑
  var selfPersist = false;                     // 桥自己触发的 persist（captureExport 收尾）不算编辑
  var loadingRemote = false;                   // 「加载新版」装载中：编辑器自 persist 不算编辑
  var serverMtime = H.mtime || '';             // 乐观锁基准：打开时/上次保存成功后的文件 mtime
  var remoteChanged = false, remoteMtime = ''; // 轮询发现的外部修改：只提醒，不动乐观锁基准
  var conflictStalled = false;                 // 自动保存撞上冲突：停下等用户裁决，不再循环撞墙
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
          /* 压缩的 iTXt（第三方工具重写文本块后可能出现）：同步环境解不了 zlib，
             跳过它继续扫后面的块——绝不能把压缩字节当明文解出乱码 JSON，
             那会让用户以为文件内容就是一张时钟 */
          if (body[z + 1] !== 0) { off += 12 + len; continue; }
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
      /* 这一声 persist 是桥的收尾动作（把导出时的状态落盘），不算用户编辑 */
      if (!err) { selfPersist = true; try { persist(); } catch (e) {} selfPersist = false; }
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

  function send(content, isBase64, cb, force) {
    var body = 'path=' + encodeURIComponent(H.savePath)
      + '&content=' + encodeURIComponent(content)
      + (isBase64 ? '&base64=1' : '')
      + (serverMtime ? '&baseMtime=' + encodeURIComponent(serverMtime) : '')   // 乐观锁基准
      + (force ? '&force=1' : '')
      + (H.csrfToken ? '&CSRF_TOKEN=' + encodeURIComponent(H.csrfToken) : '');
    var x = new XMLHttpRequest();
    x.open('POST', H.saveApi, true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8');
    x.timeout = 30000;                             // 服务器挂起时别让 busy 永久卡死保存通道
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) {}
      if (r && r.code === true) {
        /* 成功响应里带落盘后的 mtime：接管为下一次乐观锁基准 */
        if (r.data && typeof r.data === 'object' && r.data.modifyTime) serverMtime = String(r.data.modifyTime);
        return cb(null, r);
      }
      var d = r && r.data;
      var meta = (d && typeof d === 'object') ? d : null;   // 冲突响应把标记放在 data 对象里
      cb(new Error((meta && meta.message) || (typeof d === 'string' ? d : null) || ('HTTP ' + x.status)),
         { conflict: !!(meta && meta.conflict) });
    };
    x.onerror = function () { cb(new Error('network')); };
    x.ontimeout = function () { cb(new Error('timeout')); };
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
    serverMtime = '';   // 换了目标：原 mtime 属于别的文件，首存不带乐观锁，成功后从响应接管
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

  function save(manual, force) {
    if (busy) { saveQueued = true; return; }   // 在途不丢：排一枪，收尾时补存（PNG 导出常耗时数秒）
    if (!H.canWrite) {
      if (!H.savePath) { if (manual) saveAs(); return; }   // 自动保存不该弹窗，manual 才走
      if (manual) notify(L('readonly'), true);
      return;
    }
    busy = true;
    setStatus(L('saving'));
    finish(function (err, payload) {
      /* 载荷此刻已取自编辑器实时状态：此后的 persist 钩子才算「没保存进这次的新改动」 */
      editorTouched = false;
      if (err) { busy = false; dirty = true; settle(); setStatus(err.message || L('saveFail'), 'err'); notify(L('saveFail') + '：' + (err.message || err), true); return; }
      send(payload.text, payload.base64, function (e2, msg) {
        busy = false;
        if (e2) {
          dirty = true;   // 没存进去，全部内容都还是未保存（warnUnsaved 与状态灯都要认账）
          /* 冲突：文件已被别处（另一标签页/另一端）改过。手动保存问一次要不要覆盖；
             自动保存置冲突停机，等下一次手动保存给说法，否则会按 1.2s 节奏无限撞墙 */
          if (msg && msg.conflict && !force) {
            conflictStalled = true;
            setStatus(L('conflict'), 'err');
            notify(L('conflict'), true);
            if (manual && window.confirm(L('conflictAsk'))) { save(true, true); return; }
            settle();
            return;
          }
          settle(); setStatus(e2.message || L('saveFail'), 'err'); notify(L('saveFail') + '：' + e2.message, true);
          return;
        }
        conflictStalled = false;
        remoteChanged = false;
        refreshRemoteUi();   // 自己保存成功 = 文件内容已是本页的，外部修改提示过时了
        /* 只认载荷取走之后的钩子 fire；另一标签页写什么都与本页无关 */
        dirty = editorTouched;
        if (dirty) setStatus(L('dirty'), 'warn');
        else { setStatus(L('saved')); notify(L('saved')); }
        settle(true);
      }, force);
    });
  }

  /* 保存收尾。rearm 只在成功时给 true：失败的保存不自动重试（网络坏掉时不能按 1.2s
     节奏无限撞服务器），用户的下一次编辑会经钩子重新排起 */
  function settle(rearm) {
    if (saveQueued) { saveQueued = false; save(false); return; }
    if (rearm && dirty && H.autoSave && H.canWrite && !conflictStalled) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () { save(false); }, 1200);
    }
  }

  /* persist 钩子：编辑器每次落盘（400ms 防抖 / 撤销恢复 / beforeunload）都经过这里 */
  function onEditorTouched() {
    editorTouched = true;
    if (busy) return;                        // 保存收尾按 editorTouched 结账，中途不动状态灯
    if (!dirty) { dirty = true; if (saveable()) setStatus(L('dirty'), 'warn'); }
    if (H.autoSave && H.canWrite && !conflictStalled) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () { save(false); }, 1200);
    }
  }
  function hookPersist() {
    if (RENDER || typeof window.persist !== 'function') return;
    var orig = window.persist;
    window.persist = function () {
      var r = orig.apply(this, arguments);
      if (armed && !selfPersist && !loadingRemote) onEditorTouched();
      return r;
    };
  }
  /* 启动收尾：此后钩子才计数。文件路径下遮罩一直盖到此刻——武装前用户没有输入窗口，
     装载与启动自产生的 persist 全部被挡住；无文件路径没有自动保存目标，900ms 窗口期
     内的编辑无实害（手动保存取的是实时文档） */
  function arm() {
    armed = true;
    editorTouched = false;
    dirty = false;
  }

  /* ---------- 外部修改感知：轮询 mtime，让开着的编辑器知道文件被别处改了 ----------
     只负责提醒（干净页给「加载新版」，编辑中只提示保存时会再确认）；写回的精确拦截
     由 save 的乐观锁负责——轮询同秒漏报也不会静默覆盖。后台设置「检测文件在别处被
     修改」可关；外链文件（http/s）没有 mtime 可比，不轮询。 */
  function startPollWatch() {
    if (RENDER || !H.watchRemote || !H.fileUrl || !H.mtimeApi || !H.savePath) return;
    if (/^https?:/i.test(H.fileUrl)) return;
    var tick = function () { if (!document.hidden && !busy && !picking) pollMtime(); };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    setInterval(tick, H.pollMs || 20000);
  }
  function pollMtime() {
    var x = new XMLHttpRequest();
    x.open('GET', H.mtimeApi + '&path=' + encodeURIComponent(H.savePath), true);
    x.timeout = 10000;
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) {}
      var m = (r && r.data && typeof r.data === 'object') ? String(r.data.mtime || '') : '';
      if (!m) return;                                    // 拿不到就算了，下个周期再试
      if (!serverMtime) { serverMtime = m; return; }     // 没有基准（另存的新目标）：先认领
      if (m === serverMtime) return;
      remoteMtime = m;
      if (remoteChanged) return;                         // 已在提醒中，别反复弹
      remoteChanged = true;
      if (dirty) { setStatus(L('remoteChangedDirty'), 'warn'); notify(L('remoteChangedDirty'), true); }
      else { setStatus(L('remoteChanged'), 'warn'); notify(L('remoteChanged'), true); showReloadBtn(); }
    };
    x.onerror = function () {};
    x.send();
  }
  function showReloadBtn() {
    if (el.rbtn || !el.status) return;                   // 顶栏没装起来就只留 toast
    el.rbtn = document.createElement('button');
    el.rbtn.type = 'button';
    el.rbtn.className = 'btn';
    el.rbtn.textContent = L('reloadNew');
    el.rbtn.title = L('remoteChanged');
    el.rbtn.addEventListener('click', function () { reloadFromServer(); });
    el.status.insertAdjacentElement('afterend', el.rbtn);
  }
  function refreshRemoteUi() {
    if (el.rbtn) { try { el.rbtn.remove(); } catch (e) {} el.rbtn = null; }
  }
  /* 干净页的「加载新版」：走与打开时同一条 解码→装载 链；失败保留现状只报错。
     装载自 persist（同步 + 400ms 防抖落盘）不能算用户编辑，loadingRemote 门盖过防抖窗 */
  function reloadFromServer() {
    if (busy) return;
    busy = true;
    setStatus(L('loading'));
    readFile(function (err, bytes) {
      busy = false;
      if (err) { setStatus(err.message || L('loadFail'), 'err'); notify(L('loadFail') + '：' + (err.message || err), true); return; }
      var out = decodeFile(bytes);
      if (!out.json && !out.empty) { notify(L('noMeta'), true); setStatus(L('remoteChanged'), 'warn'); return; }
      loadingRemote = true;
      loadIntoEditor(out.json);
      serverMtime = remoteMtime || serverMtime;          // 基准跟到看到的这份
      editorTouched = false;
      dirty = false;
      remoteChanged = false;
      refreshRemoteUi();
      setStatus(L('saved'));
      setTimeout(function () { loadingRemote = false; editorTouched = false; }, 500);
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

  /* ---------- 脏检测已改走 persist 钩子（见文件头注释与 onEditorTouched） ---------- */

  function saveShortcut(ev) {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
    if (ev.key !== 's' && ev.key !== 'S') return;
    ev.preventDefault(); ev.stopPropagation();
    save(true);
  }
  function warnUnsaved(ev) {
    if (!dirty || busy) return;
    ev.preventDefault();
    ev.returnValue = L('dirty');
  }

  /* ---------- 渲染模式：预览页把编辑器装进隐藏 iframe 当渲染器用 ---------- */
  /* 图交给宿主页面塞进 <img>(SVG 走 img 不会执行里面的脚本)，这边不落盘、不装顶栏、
     不做脏检测；自动保存键也换了一条前缀(见 app.php)，免得搅坏同一个文件在别的
     标签页里的「有未保存改动」基线。 */
  function post(msg) {
    msg.app = 'wavedrom';
    try { parent.postMessage(msg, window.location.origin); } catch (e) {}
  }

  function renderMode(loaded) {
    hideMask();
    if (!loaded) return post({ type: 'wd-svg', error: 'no-meta' });
    var rendering = false;
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (rendering || ev.source !== parent || !d || d.type !== 'wd-render') return;
      rendering = true;
      // 不用 exportAction()：那条路按「要写回的文件后缀」选格式，源码文件(.wave)会去导 PNG。
      // 预览页只吃矢量，所以这里直接指定 SVG；风格仍跟着原图走。
      var act = srcKind === 'wavedrom' ? 'export-svg' : 'export-editor-svg';
      captureExport(act, function (err, blob) {
        if (err) { rendering = false; return post({ type: 'wd-svg', error: err.message || 'render' }); }
        var rd = new FileReader();
        rd.onload = function () { rendering = false; post({ type: 'wd-svg', svg: String(rd.result || '') }); };
        rd.onerror = function () { rendering = false; post({ type: 'wd-svg', error: 'blob-read' }); };
        rd.readAsText(blob);
      });
    });
    post({ type: 'wd-ready' });
  }

  /* ---------- 启动 ---------- */
  function start() {
    if (typeof window.applyDocJSON !== 'function' || typeof window.handleAct !== 'function') {
      if ((start.tries = (start.tries || 0) + 1) < 200) return setTimeout(start, 50);
      if (RENDER) return post({ type: 'wd-svg', error: 'no-renderer' });
      hideMask(L('loadFail'));
      return;
    }
    hookPersist();   // 脏检测改挂编辑器自己的 persist（见文件头注释与 onEditorTouched）
    if (!H.fileUrl) {                          // 从左侧菜单直接打开：保存时选位置，或「导出」下载到本地
      if (RENDER) return post({ type: 'wd-svg', error: 'no-file' });
      hideMask();
      if (!saveable() && el.btn) el.btn.disabled = true;
      setStatus(L('noFile'), 'warn');
      setTimeout(arm, 900);                    // 等编辑器启动自 persist 落地再武装（见 arm 注释）
      return;
    }
    readFile(function (err, bytes) {
      if (err) {
        if (RENDER) { hideMask(); return post({ type: 'wd-svg', error: 'load-fail' }); }
        hideMask(); setStatus(L('loadFail'), 'err'); notify(L('loadFail'), true); return;
      }
      var out = decodeFile(bytes);
      var fresh = !!H.fresh || !!out.empty;         // 新建(或被截断的空文件)：先渲染一份合法内容落盘
      loadIntoEditor(out.json);
      if (RENDER) return renderMode(!!out.json);
      if (!out.json && !out.empty) notify(L('noMeta'), true);
      setTimeout(function () {                       // 等装载与启动自 persist 全部落地，再武装钩子
        arm();
        startPollWatch();
        hideMask();
        if (fresh && H.canWrite) { setStatus(L('saving')); save(false); }
        else if (out.json && H.canWrite) setStatus(L('saved'));   // 打开即与盘上一致，别留着空白状态
      }, 900);
    });
  }

  if (!RENDER) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installBar);
    else installBar();
    document.addEventListener('keydown', saveShortcut, true);
    window.addEventListener('beforeunload', warnUnsaved);
  }
  start();
})();
