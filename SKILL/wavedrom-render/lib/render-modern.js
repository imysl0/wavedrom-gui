'use strict';
/*
 * Modern-mode renderer.
 *
 * Reproduces the WaveDrom-Gui editor-area waveform look as a standalone SVG,
 * with no browser and no DOM. The geometry is a faithful port of laneSVG() plus
 * the grid layout (name column, tick row, head/foot strips, lane rows, node
 * markers, edge overlay) from index.html. Colors use the app's LIGHT theme,
 * matching the app's own SVG/PNG export (exports are always light).
 *
 * Everything is emitted as SVG-string fragments; there is no dependency on the
 * WaveDrom engine here.
 */

/* ---------- light-theme palette (from index.html [data-theme="light"]) ---------- */
const C = {
  bg: '#EEF1F6', panel: '#FFFFFF', line: '#CBD5E4', lineSoft: '#E2E8F2',
  text: '#1B2536', muted: '#54637F', faint: '#6E7D96', accText: '#0B7A55',
  info: '#0369A1', warnInk: '#92610A', xbox: '#64748B',
  nodeFill: '#FFFFFF', nodeLine: '#0B7A55',
  ch: ['#059669', '#0284C7', '#B45309', '#DB2777', '#7C3AED', '#E11D48'],
};
const DIGIT_FILLS = { 2: '#ffffff', 3: '#ffffb4', 4: '#ffe0b9', 5: '#b9e0ff', 6: '#ccfdfe', 7: '#cdfdc5', 8: '#f0c1fb', 9: '#f5c2c0' };
const DATA_CHARS = '=23456789';
const NODE_INSET_DEF = 4; // 靠边节点的默认横向内缩（px），与 index.html 保持一致
/* 九宫格锚点比例 [横, 纵]。中心格是「自动」：几何同左中，另外会躲开数据框标签；
   其余八种都是纯定位，指到哪画到哪，不做任何避让。'c' 为旧键，等同 auto。 */
const NODE_POS_KEYS = {
  lt: [0, 0], tm: [.5, 0], rt: [1, 0],
  lm: [0, .5], auto: [0, .5], c: [0, .5], rm: [1, .5],
  lb: [0, 1], bm: [.5, 1], rb: [1, 1],
};
/* 仅「自动」参与数据框标签避让 */
const isAutoPos = pos => pos === 'auto' || pos === 'c';
/* ============================================================================
 *  FONT CONFIG — read from ../fonts.config.json (appearance block).
 *  Users edit fonts.config.json (single place for both download/embed AND
 *  fonts/sizes); the built-in defaults below are only a fallback for when the
 *  config is missing / partial / unreadable, so rendering never breaks.
 *    fontFamily.mono/ui : CSS font-family stacks (per-glyph fallback applies —
 *                         Latin uses first Latin font, CJK falls to first CJK)
 *    size.*             : SVG user units (~px at 1x); PNG multiplies by --scale
 * ========================================================================== */
const FONT_DEFAULTS = {
  mono: '"LXGW WenKai Mono","Cascadia Code",Consolas,"Noto Sans Mono CJK SC","Microsoft YaHei","PingFang SC","Noto Sans CJK SC","WenQuanYi Micro Hei",monospace',
  ui:   '"LXGW WenKai Mono","PingFang SC","Noto Sans CJK SC","Microsoft YaHei","Hiragino Sans GB","WenQuanYi Micro Hei",system-ui,sans-serif',
  dataLabel: 14, signalName: 16, groupName: 16, title: 16,
  tick: 12, spacer: 11.5, ppBadge: 11, node: 10, edgeLabel: 11,
};
function loadFonts() {
  const F = Object.assign({}, FONT_DEFAULTS);
  try {
    const cfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'fonts.config.json'), 'utf8'));
    const ap = cfg && cfg.appearance;
    if (ap) {
      if (ap.fontFamily) {
        if (typeof ap.fontFamily.mono === 'string' && ap.fontFamily.mono) F.mono = ap.fontFamily.mono;
        if (typeof ap.fontFamily.ui === 'string' && ap.fontFamily.ui) F.ui = ap.fontFamily.ui;
      }
      if (ap.size) for (const k of ['dataLabel', 'signalName', 'groupName', 'title', 'tick', 'spacer', 'ppBadge', 'node', 'edgeLabel']) {
        if (typeof ap.size[k] === 'number' && ap.size[k] > 0) F[k] = ap.size[k];
      }
    }
  } catch (e) { /* missing/corrupt config -> built-in defaults */ }
  return F;
}
const FONTS = loadFonts();
// Aliases used throughout the drawing code.
const FONT_MONO = FONTS.mono;
const FONT_UI = FONTS.ui;


/* ---------- geometry constants (from index.html) ---------- */
const CELLW = 40;
const HI = 13, LO = 35, MID = 24, LANE_H = 48;

const isData = g => DATA_CHARS.includes(g);
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/* ---------- tiny SVG string helpers ---------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function tag(name, attrs, body) {
  let s = '<' + name;
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === '') continue;
    // Always escape attribute values (font stacks contain double quotes).
    s += ` ${k}="${esc(v)}"`;
  }
  if (body === undefined || body === null) return s + '/>';
  return s + '>' + body + '</' + name + '>';
}

/* ============================================================================
 * WaveJSON -> internal lane/group/spacer tree
 * (mirrors parseEntry / parseDoc in index.html)
 * ========================================================================== */
function parseEntry(e) {
  if (Array.isArray(e)) {
    const g = { kind: 'group', name: typeof e[0] === 'string' ? e[0] : '', children: [] };
    e.slice(1).forEach(x => g.children.push(parseEntry(x)));
    return g;
  }
  if (!e || typeof e !== 'object') return { kind: 'spacer' };
  const lane = { kind: 'lane', name: e.name || '', slots: [], nodeByT: {}, period: null, phase: null, len: 0 };
  const wave = typeof e.wave === 'string' ? e.wave : '';
  if (wave.length) lane.len = wave.length;
  const data = Array.isArray(e.data) ? e.data.map(String)
    : (typeof e.data === 'string' ? e.data.trim().split(/\s+/) : []);
  let runIdx = -1;
  for (let t = 0; t < wave.length; t++) {
    const ch = wave[t];
    if (ch === '.') { if (!lane.slots[t]) lane.slots[t] = { glyph: '.' }; continue; }
    if (ch === ' ' || ch === '#') continue;
    const slot = { glyph: ch };
    if (isData(ch)) { runIdx++; if (data[runIdx] !== undefined) slot.label = data[runIdx]; }
    lane.slots[t] = slot;
  }
  if (typeof e.node === 'string') {
    for (let t = 0; t < e.node.length; t++) if (/[a-zA-Z]/.test(e.node[t])) lane.nodeByT[t] = e.node[t];
  }
  if (e.period !== undefined) lane.period = +e.period || null;
  if (e.phase !== undefined) lane.phase = e.phase;
  return lane;
}

function parseEdge(str) {
  const EDGE_SET = new Set(['->', '-', '~>', '~', '-~>', '-~', '~-', '~->', '<->', '<~>', '<-~>',
    '-|', '|->', '-|>', '-|->', '-|-', '<-|>', '<-|->', '+']);
  const m = /^\s*([a-zA-Z])([~|\-+<>]+?)\s*([a-zA-Z])(?:\s+(.*))?$/.exec(str);
  if (!m || !EDGE_SET.has(m[2])) return null;
  return { from: m[1], to: m[3], spec: m[2], label: m[4] || '' };
}

function parseDoc(j) {
  const st = {
    tree: [], edges: [],
    head: { text: '', tick: null, every: null, tock: null },
    foot: { text: '', tick: null, every: null, tock: null },
    hscale: 1, hb: null,
  };
  const sig = Array.isArray(j.signal) ? j.signal : [];
  sig.forEach(e => st.tree.push(parseEntry(e)));
  if (Array.isArray(j.edge)) j.edge.forEach(s => { const e = parseEdge(s); if (e) st.edges.push(e); });
  const rd = hf => (typeof hf === 'object' && hf) ? {
    text: hf.text != null && typeof hf.text === 'string' ? hf.text : '',
    tick: hf.tick != null ? hf.tick : null,
    tock: hf.tock != null ? hf.tock : null,
    every: hf.every != null ? hf.every : null,
  } : { text: '', tick: null, tock: null, every: null };
  if (j.head) st.head = rd(j.head);
  if (j.foot) st.foot = rd(j.foot);
  const c = j.config || {};
  if (typeof c.hscale === 'number') st.hscale = Math.min(8, Math.max(1, Math.round(c.hscale)));
  if (Array.isArray(c.hbounds) && c.hbounds.length === 2) st.hb = [c.hbounds[0], c.hbounds[1]];
  return st;
}

/* ============================================================================
 * lane measurement helpers (mirror index.html)
 * ========================================================================== */
function laneLen(lane) {
  let last = -1;
  lane.slots.forEach((s, t) => { if (s) last = t; });
  if (lane.len) last = Math.max(last, lane.len - 1);
  return last + 1;
}
function eachLane(tree, fn) {
  tree.forEach(n => {
    if (n.kind === 'lane') fn(n);
    else if (n.kind === 'group') eachLane(n.children, fn);
  });
}
function allLanes(tree) { const r = []; eachLane(tree, l => r.push(l)); return r; }
function laneUnits(lane) { return Math.ceil((laneLen(lane) - (lane.phase || 0)) * (lane.period || 1)); }

function laneCharPositions(lane, gw) {
  const base = gw * (lane.period || 1);
  const ph = lane.phase || 0;
  const positions = [];
  let x = -ph * base, sub = false;
  const n = laneLen(lane);
  for (let i = 0; i < n; i++) {
    const s = lane.slots[i];
    const ch = s ? s.glyph : '.';
    if (ch === '<') { positions.push(null); sub = true; continue; }
    if (ch === '>') { positions.push(null); sub = false; continue; }
    const w = sub ? CELLW / 2 : base;
    positions.push({ x, w });
    x += w;
  }
  return positions;
}

/* 画一个节点标记：letter=圆圈+字母；bare=仅字母（微透明白底衬）；dot=实心小圆点 */
function nodeMarkerSVG(x, y, letter, scale, mode) {
  if (mode === 'dot') {
    return tag('circle', { cx: x, cy: y, r: 3 * scale, fill: C.nodeLine, stroke: C.nodeFill, 'stroke-width': 1 });
  }
  const bare = mode === 'bare';
  const circle = bare
    ? tag('circle', { cx: x, cy: y, r: 5.2 * scale, fill: hexA(C.nodeFill, .82) })
    : tag('circle', { cx: x, cy: y, r: 6.5 * scale, fill: C.nodeFill, stroke: C.nodeLine, 'stroke-width': 1.3 });
  return circle + tag('text', { x: 0, y: 3.5, 'text-anchor': 'middle', 'font-size': FONTS.node, 'font-weight': 600,
    transform: `translate(${x} ${y}) scale(${scale})`, 'font-family': FONT_MONO, fill: C.nodeLine }, esc(letter));
}
/* 节点标记的外接半径（供数据框标签避让用） */
function nodeMarkerR(scale, mode) {
  if (mode === 'dot') return 3 * scale + 1;
  if (mode === 'bare') return 5.2 * scale;
  return 6.5 * scale + 0.65;
}
function nodeAnchorXY(bx, bw, pos, scale, inset) {
  const [fx, fy] = NODE_POS_KEYS[pos] || NODE_POS_KEYS.lm;
  const nIn = (inset === undefined ? NODE_INSET_DEF : inset) * scale;
  const vIn = Math.max(8, 6.5 * scale + 1.5);
  return [
    fx === 0 ? bx + nIn : fx === 1 ? bx + bw - nIn : bx + bw / 2,
    fy === 0 ? vIn : fy === 1 ? LANE_H - vIn : MID,
  ];
}
/* 数据框里 14px 标签的实际占位行（基线 29，上到字冠、下到降部） */
const LABEL_BAND = [18.5, 32];
const labelTextW = (s, fs) => String(s).length * fs * 0.53;
/* 被抬起的节点圆心 y：贴数据框上沿，完全避开标签行 */
const liftedNodeY = (scale, mode) => Math.max(nodeMarkerR(scale, mode), LABEL_BAND[0] - nodeMarkerR(scale, mode) - 1.5);

/* 一次性算清整条通道里「数据框标签 × 节点圆标」的避让方案，供通道本体与连线层共用
   （连线层必须拿到同一份结果，否则箭头会指向节点被抬走前的旧位置）。
   返回 { ranges: Map<起始拍, [lo,hi]>, lift: Set<拍> }：
     - 节点压在标签行上时，先让出它占的那一侧；
     - 让完仍放得下标签 → 记进 ranges，标签在剩余区间居中；
     - 放不下（窄框）→ 该框内的节点记进 lift，抬到框上沿，标签仍按整框居中。 */
function planLaneNodes(lane, gw, pos, scale, fs, inset, mode) {
  const ranges = new Map(), lift = new Set();
  if (!isAutoPos(pos)) return { ranges, lift }; // 非自动：纯定位，标签与节点都不挪
  const positions = laneCharPositions(lane, gw);
  const slots = lane.slots, len = laneLen(lane);
  const mr = nodeMarkerR(scale, mode);
  for (let t = 0; t < len; t++) {
    const s = slots[t];
    if (!s || !isData(s.glyph)) continue;
    const pp = positions[t];
    if (!pp) continue;
    let e = t + 1;
    while (e < len && (!slots[e] || slots[e].glyph === '.' || slots[e].glyph === '|')) e++;
    const lastP = positions[e - 1];
    const x0 = pp.x, w = lastP ? (lastP.x + lastP.w - x0) : 0;
    const label = s.label;
    const hasLabel = label !== undefined && label !== null && String(label) !== '' && w > 14;
    if (hasLabel) {
      let lo = x0 + 4, hi = x0 + w - 4, hit = false, centered = false;
      const mid = x0 + w / 2;
      for (let k = t; k < e; k++) {
        if (!lane.nodeByT[k]) continue;
        const pk = positions[k];
        if (!pk) continue;
        const [nx, ny] = nodeAnchorXY(pk.x, pk.w, pos, scale, inset);
        if (ny + mr <= LABEL_BAND[0] || ny - mr >= LABEL_BAND[1]) continue; // 不在标签行上
        hit = true;
        if (nx < mid) lo = Math.max(lo, nx + mr + 2);
        else if (nx > mid) hi = Math.min(hi, nx - mr - 2);
        else centered = true; // 正压在框中心：左右都让不动，只能抬走
      }
      if (hit && (centered || labelTextW(label, fs) > hi - lo)) {
        for (let k = t; k < e; k++) if (lane.nodeByT[k]) lift.add(k);
      } else {
        ranges.set(t, [lo, hi]);
      }
    }
    t = e - 1;
  }
  return { ranges, lift };
}

/* ============================================================================
 * laneSVG: the self-drawn mini waveform (faithful port of index.html laneSVG)
 * Returns { inner: <svg-body string>, width }. `color` is the trace color.
 * ========================================================================== */
function laneSVG(lane, gw, color, nodePos, nodeScale, nodeInset, nodeMode) {
  const W = gw * (lane.period || 1), len = laneLen(lane);
  const positions = laneCharPositions(lane, gw);
  let out = '';       // path + decorations, in draw order
  let overlays = '';  // gap marks, drawn last
  let d = '';
  const M = (x, y) => { d += `M${x} ${y}`; };
  const Hline = x2 => { d += `H${x2}`; };
  const V = (x, y1, y2) => { d += `M${x} ${y1}V${y2}`; };
  const yOf = lvl => lvl === 'hi' ? HI : lvl === 'lo' ? LO : MID;
  let lvl = null;
  const slots = lane.slots;
  let t = 0, prevClock = null, prevClockNoLead = false, gapPend = '', prevG = null, lastEnd = 0;
  const nodePlan = planLaneNodes(lane, gw, nodePos, nodeScale, FONTS.dataLabel, nodeInset, nodeMode);

  const arrowTri = (x, y, dir) => {
    if (!dir) return;
    out += tag('path', { d: dir === 'up' ? `M${x} ${y - 4}l-3.2 6h6.4z` : `M${x} ${y + 4}l-3.2 -6h6.4z`, fill: color });
  };
  const gapMark = (xr, yr) => {
    let g = `<g transform="translate(${xr}, ${yr}) scale(1.1)">`;
    g += tag('path', { d: 'm7,-2 -4,0 c -5,0 -5,24 -10,24 l 4,0 C 2,22 2,-2 7,-2 z', fill: hexA(C.xbox, .4) });
    g += tag('path', { d: 'M-7,22 C -2,22 -2,-2 3,-2', fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'round' });
    g += tag('path', { d: 'M-3,22 C 2,22 2,-2 7,-2', fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'round' });
    g += '</g>';
    overlays += g;
  };
  const drawClock = (x0, kind, w, arrowed, noLead) => {
    // 官方几何（pclk/nclk/Pclk/Nclk 砖）：拍起点一条贯穿低高的垂直沿，半拍处翻转
    // noLead：官方 xclude 命中（hp/Hp、ln/Ln），只去掉起点垂直沿，半拍翻转照旧
    const x1 = x0 + w;
    const pos = (kind === 'p' || kind === 'P');
    const firstHalf = pos ? HI : LO, secondHalf = pos ? LO : HI;
    if (!noLead) {
      V(x0, LO, HI);
      if (arrowed) arrowTri(x0, MID, pos ? 'up' : 'down');
    }
    M(x0, firstHalf); d += `H${x0 + w / 2}V${secondHalf}`; Hline(x1);
    lvl = pos ? 'lo' : 'hi';
  };

  while (t < len) {
    const s = slots[t];
    const pp = positions[t];
    if (!pp) {
      const ch = s ? s.glyph : '';
      if ((ch === '<' || ch === '>') && lastEnd > 0) {
        out += tag('path', {
          d: ch === '<'
            ? `M${lastEnd + 6} ${MID - 5}L${lastEnd - 2} ${MID}L${lastEnd + 6} ${MID + 5}`
            : `M${lastEnd - 6} ${MID - 5}L${lastEnd + 2} ${MID}L${lastEnd - 6} ${MID + 5}`,
          stroke: hexA(color, .35), 'stroke-width': 1.2, fill: 'none',
        });
      }
      t++; continue;
    }
    const x0 = pp.x, cw = pp.w, x1 = x0 + cw;
    lastEnd = x1;
    if (!s || s.glyph === '.') {
      // 官方把重复拍整砖复制，所以 xclude 抑制掉的起点垂直沿在延续拍里同样不画
      if (prevClock) drawClock(x0, prevClock, cw, prevClock === 'P' || prevClock === 'N', prevClockNoLead);
      else if (lvl === 'hi' || lvl === 'lo' || lvl === 'mid') Hline(x1);
      t++; continue;
    }
    const g = s.glyph;
    const pg = prevG;
    prevG = g;
    if (g !== '|') prevClock = null;

    /* 大写 U/D 在官方引擎里没有对应砖（gen-wave-brick 落到 default 'xxx'），一律画成不确定框 */
    if (g === 'x' || g === 'X' || g === 'U' || g === 'D') {
      let e = t + 1;
      const gapPts = [];
      while (e < len && (!slots[e] || slots[e].glyph === '.' || slots[e].glyph === '|')) {
        if (slots[e] && slots[e].glyph === '|') gapPts.push(e);
        e++;
      }
      const lastP = positions[e - 1];
      const w = lastP ? (lastP.x + lastP.w - x0) : 0;
      out += tag('rect', { x: x0 + 2, y: 13, width: Math.max(4, w - 4), height: 22, rx: 2.5,
        fill: hexA(C.xbox, .13), stroke: hexA(C.xbox, g === 'X' ? .55 : .3), 'stroke-width': 1.4 });
      // hatch fill (approximate the clipPath crosshatch with clipped lines)
      let hatch = '';
      for (let xx = x0 - 22; xx < x0 + w; xx += 7) {
        hatch += tag('path', { d: `M${xx + 22} 13L${xx} 35`, stroke: hexA(C.xbox, .35), 'stroke-width': 1 });
      }
      const clipId = `xhatch_${x0 | 0}_${t}`;
      out += `<clipPath id="${clipId}"><rect x="${x0 + 2}" y="13" width="${Math.max(4, w - 4)}" height="22" rx="2.5"/></clipPath>`;
      out += `<g clip-path="url(#${clipId})">${hatch}</g>`;
      gapPts.forEach(gt => { const gp = positions[gt]; if (gp) gapMark(gp.x + gp.w / 2, MID - 11); });
      lvl = null; t = e; continue;
    }

    if (isData(g)) {
      let e = t + 1;
      const gapPts = [];
      while (e < len && (!slots[e] || slots[e].glyph === '.' || slots[e].glyph === '|')) {
        if (slots[e] && slots[e].glyph === '|') gapPts.push(e);
        e++;
      }
      const lastP = positions[e - 1];
      const w = lastP ? (lastP.x + lastP.w - x0) : 0;
      const isDigit = g !== '=';
      out += tag('rect', { x: x0 + 1.5, y: 13, width: Math.max(4, w - 3), height: 22, rx: 2.5,
        fill: isDigit ? DIGIT_FILLS[g] : C.nodeFill,
        stroke: isDigit ? 'rgba(27,37,54,.55)' : hexA(color, .85), 'stroke-width': 1.4 });
      const label = s.label;
      if (label !== undefined && label !== null && String(label) !== '' && w > 14) {
        /* 避让方案由 planLaneNodes 统一决定：ranges 里有 = 让开节点后居中；没有 = 节点已被抬走，按整框居中 */
        const [lo, hi] = nodePlan.ranges.get(t) || [x0 + 4, x0 + w - 4];
        const avail = hi - lo;
        const attrs = { x: (lo + hi) / 2, y: 29, 'text-anchor': 'middle', 'font-size': FONTS.dataLabel,
          'font-family': FONT_MONO, fill: isDigit ? '#1B2536' : color };
        if (labelTextW(label, FONTS.dataLabel) > avail && avail > 0) { attrs.textLength = avail; attrs.lengthAdjust = 'spacingAndGlyphs'; }
        out += tag('text', attrs, esc(String(label)));
      }
      gapPts.forEach(gt => { const gp = positions[gt]; if (gp) gapMark(gp.x + gp.w / 2, MID - 11); });
      lvl = null; t = e; continue;
    }

    switch (g) {
      case '1': {
        const target = HI;
        if (lvl === null || lvl === target) { M(x0, target); }
        else { M(x0, yOf(lvl)); d += `H${x0 + CELLW * .075}L${x0 + CELLW * .225} ${target}`; }
        Hline(x1); lvl = 'hi'; break;
      }
      case '0': {
        const target = LO;
        if (lvl === null || lvl === target) { M(x0, target); }
        else { M(x0, yOf(lvl)); d += `H${x0 + CELLW * .075}L${x0 + CELLW * .225} ${target}`; }
        Hline(x1); lvl = 'lo'; break;
      }
      /* h/H、l/L 用的是官方时钟砖 pclk/Pclk、nclk/Nclk：拍起点一条贯穿低高的垂直沿 +
         整拍平电平，H/L 再叠一个箭头——与 0/1 的斜坡过渡形状不同。
         首拍退化成纯平线（官方首砖表 h/H→'111'、l/L→'000'）；
         官方 xclude 另把 'nh'/'Nh' 抑制成 '111'、'pl'/'Pl' 抑制成 '000'（只针对小写 h/l）。 */
      case 'h': case 'H': {
        if (pg !== null && !(g === 'h' && (pg === 'n' || pg === 'N'))) {
          V(x0, LO, HI);
          if (g === 'H') arrowTri(x0, MID, 'up');
        }
        M(x0, HI); Hline(x1); lvl = 'hi'; break;
      }
      case 'l': case 'L': {
        if (pg !== null && !(g === 'l' && (pg === 'p' || pg === 'P'))) {
          V(x0, HI, LO);
          if (g === 'L') arrowTri(x0, MID, 'down');
        }
        M(x0, LO); Hline(x1); lvl = 'lo'; break;
      }
      case 'p': case 'P':
        // 官方 xclude 'hp'/'Hp'：高电平后的 p 不再画起点垂直沿（已经在高位）
        prevClockNoLead = (g === 'p' && (pg === 'h' || pg === 'H'));
        drawClock(x0, g, cw, g === 'P', prevClockNoLead);
        prevClock = g; break;
      case 'n': case 'N':
        // 官方 xclude 'ln'/'Ln'：低电平后的 n 不再画起点垂直沿
        prevClockNoLead = (g === 'n' && (pg === 'l' || pg === 'L'));
        drawClock(x0, g, cw, g === 'N', prevClockNoLead);
        prevClock = g; break;
      case 'u': {
        if (lvl === 'hi') { M(x0, HI); Hline(x1); }
        else { M(x0, LO); d += `H${x0 + CELLW * .075}C${x0 + CELLW * .175} ${LO},${x0 + CELLW * .25} ${HI},${x0 + CELLW * .5} ${HI}`; Hline(x1); }
        lvl = 'hi'; break;
      }
      case 'd': {
        if (lvl === 'lo') { M(x0, LO); Hline(x1); }
        else { M(x0, HI); d += `H${x0 + CELLW * .075}C${x0 + CELLW * .175} ${HI},${x0 + CELLW * .25} ${LO},${x0 + CELLW * .5} ${LO}`; Hline(x1); }
        lvl = 'lo'; break;
      }
      case 'z': case 'Z':
        if (lvl !== null && lvl !== 'mid') { M(x0, yOf(lvl)); d += `H${x0 + CELLW * .075}C${x0 + CELLW * .15} ${yOf(lvl)},${x0 + CELLW * .2} ${MID},${x0 + CELLW * .5} ${MID}`; }
        else M(x0, MID);
        Hline(x1); lvl = 'mid'; break;
      case '|': {
        prevG = pg;
        if (prevClock) drawClock(x0, prevClock, W, prevClock === 'P' || prevClock === 'N', prevClockNoLead);
        else if (lvl === 'hi' || lvl === 'lo' || lvl === 'mid') { M(x0, yOf(lvl)); Hline(x1); }
        gapMark(x0 + cw / 2, MID - 11);
        break;
      }
    }
    t++;
  }

  let body = out;
  if (d) {
    body += tag('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  }
  body += overlays;
  // node markers inside the lane
  Object.keys(lane.nodeByT).forEach(k => {
    const pk = positions[+k];
    const bx = pk ? pk.x : (+k - (lane.phase || 0)) * W;
    const bw = pk ? pk.w : W;
    const [nx, ny0] = nodeAnchorXY(bx, bw, nodePos, nodeScale, nodeInset);
    /* 窄数据框让不出横向空间时，把圆标抬到框上沿，避开标签行而不遮字 */
    const ny = nodePlan.lift.has(+k) ? liftedNodeY(nodeScale, nodeMode) : ny0;
    body += nodeMarkerSVG(nx, ny, lane.nodeByT[k], nodeScale, nodeMode);
  });
  return body;
}

/* ============================================================================
 * tick labels (port of tickLabels)
 * ========================================================================== */
function tickLabels(val, len) {
  let L = [], offset;
  if (val === null || val === undefined || val === '') return { L, offset: 0 };
  if (typeof val === 'number') { offset = val; for (let i = 0; i < len; i++) L.push(i + offset); return { L, offset }; }
  let arr = val;
  if (typeof val === 'string') arr = val.trim().split(/\s+/);
  if (!Array.isArray(arr) || arr.length === 0) return { L, offset: 0 };
  if (arr.length === 1) {
    const s0 = Number(arr[0]);
    if (isNaN(s0)) L = arr; else { offset = s0; for (let i = 0; i < len; i++) L.push(i + s0); }
  } else if (arr.length === 2) {
    const s0 = Number(arr[0]), stp = Number(arr[1]);
    const dp = (String(arr[1]).split('.')[1] || '').length;
    if (isNaN(s0) || isNaN(stp)) L = arr;
    else { offset = stp * s0; for (let i = 0; i < len; i++) L.push((stp * i + stp * s0).toFixed(dp)); }
  } else L = arr;
  return { L, offset };
}

/* ============================================================================
 * Full diagram assembly (port of renderGrid + buildEditorSvg + renderMiniEdges)
 * ========================================================================== */
function textW(s, size = FONTS.signalName) {
  // per-char width estimate at the given size (LXGW Mono: ~0.55em latin, 1em CJK)
  let w = 0;
  for (const ch of s) w += (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55) * size;
  return w;
}

function computeCols(tree) {
  let max = 0; eachLane(tree, l => { max = Math.max(max, laneUnits(l)); });
  return max === 0 ? 8 : max;
}
function gridWindow(st) {
  const cols = computeCols(st.tree);
  if (st.hb && st.hb[1] > st.hb[0]) {
    const b = Math.min(st.hb[1], Math.max(cols, st.hb[0] + 1));
    return { a: st.hb[0], b: Math.max(b, st.hb[0] + 1) };
  }
  return { a: 0, b: cols };
}

function renderModern(source, opts = {}) {
  const st = parseDoc(source || {});
  const nodePos = opts.nodePos && NODE_POS_KEYS[opts.nodePos] ? opts.nodePos : 'lm';
  const nodeScale = Math.max(0.4, Math.min(2, opts.nodeScale || 1));
  const nodeInset = Number.isFinite(opts.nodeInset) ? Math.max(0, Math.min(9, opts.nodeInset)) : NODE_INSET_DEF;
  const nodeMode = ['letter', 'bare', 'dot'].includes(opts.nodeMode) ? opts.nodeMode : 'bare';
  const gw = CELLW * (st.hscale || 1);

  if (!st.tree.length) {
    const svg = tag('svg', { xmlns: 'http://www.w3.org/2000/svg', width: 200, height: 60, viewBox: '0 0 200 60' },
      tag('rect', { x: 0, y: 0, width: 200, height: 60, fill: C.bg }) +
      tag('text', { x: 100, y: 34, 'text-anchor': 'middle', 'font-size': 13, fill: C.faint, 'font-family': FONT_UI }, '空文档 / empty signal'));
    return { svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + svg, width: 200, height: 60 };
  }

  /* --- name column width (port of renderGrid auto-fit) --- */
  let namew = 120;
  const walk = (list, depth) => list.forEach(n => {
    const indent = depth * 14;
    let extra = 0;
    if (n.kind === 'lane' && ((n.period && n.period > 1) || n.phase)) {
      const label = (n.period && n.period > 1 ? '×' + n.period : '') + (n.phase ? ' φ' + n.phase : '');
      extra = 14 + label.length * 6;
    }
    const nameW = textW(n.name || '');
    namew = Math.max(namew, Math.min(480, 70 + indent + nameW + extra));
    if (n.kind === 'group') walk(n.children, depth + 1);
  });
  walk(st.tree, 0);
  namew = Math.round(Math.min(480, namew));

  const win = gridWindow(st);
  const colCount = win.b - win.a;
  const winX = win.a * gw;

  /* --- used pixel width across visible lanes (port of buildEditorSvg) --- */
  let usedPx = 0;
  eachLane(st.tree, l => {
    let lastT = -1;
    l.slots.forEach((s, t) => { if (s) lastT = t; });
    Object.keys(l.nodeByT).forEach(t => { lastT = Math.max(lastT, +t); });
    if (lastT < 0) return;
    const end = Math.max(laneLen(l), lastT + 1);
    const p = laneCharPositions(l, gw)[end - 1];
    const right = p ? p.x + p.w : (end - 1 - (l.phase || 0)) * gw * (l.period || 1) + gw * (l.period || 1);
    usedPx = Math.max(usedPx, right - winX);
  });
  const winW = colCount * gw;
  const colsW = Math.max(gw, Math.ceil(Math.min(winW, Math.ceil(usedPx))));

  /* --- vertical layout: rows in order --- */
  const H = st.head, F = st.foot;
  const headNums = H.tick !== null && H.tick !== '';
  const headEvery = Math.max(1, H.every || 1);
  const footNums = (F.tock !== null && F.tock !== '') || (F.tick !== null && F.tick !== '');
  const footEvery = Math.max(1, F.every || 1);
  const STRIP_H = 26, TIME_H = 26;
  const W = namew + colsW;

  const rows = [];               // { type, y, h, ...data }
  let y = 0;
  if (H.text) { rows.push({ type: 'headtext', y, h: STRIP_H }); y += STRIP_H; }
  rows.push({ type: 'time', y, h: TIME_H }); y += TIME_H;
  const flat = allLanes(st.tree);
  const rowRef = {};             // lane.id-ish -> {y,h} via index; we key by lane object
  const laneRowY = new Map();
  const emit = (list, depth) => list.forEach(n => {
    if (n.kind === 'group') {
      rows.push({ type: 'group', y, h: 24, node: n, depth });
      y += 24;
      emit(n.children, depth + 1);
    } else if (n.kind === 'spacer') {
      rows.push({ type: 'spacer', y, h: LANE_H, node: n, depth });
      y += LANE_H;
    } else {
      rows.push({ type: 'lane', y, h: LANE_H, node: n, depth });
      laneRowY.set(n, { y, h: LANE_H });
      y += LANE_H;
    }
  });
  emit(st.tree, 0);
  if (footNums) { rows.push({ type: 'footnums', y, h: STRIP_H }); y += STRIP_H; }
  if (F.text) { rows.push({ type: 'foottext', y, h: STRIP_H }); y += STRIP_H; }
  const totalH = y;

  /* --- paint --- */
  let bg = tag('rect', { x: 0, y: 0, width: W, height: totalH, fill: C.bg });
  let content = '';   // column area (waves, ticks, strips)
  let edgeLayer = ''; // node edges overlay
  let nameLayer = ''; // sticky name column, drawn last

  const headTL = headNums ? tickLabels(H.tick, win.b) : { L: [], offset: 0 };
  const footBase = (F.tock !== null && F.tock !== '' && F.tock !== undefined) ? F.tock : F.tick;
  const footTL = footNums ? tickLabels(footBase, win.b) : { L: [], offset: 0 };

  for (const r of rows) {
    if (r.type === 'headtext' || r.type === 'foottext') {
      const t = r.type === 'headtext' ? H.text : F.text;
      content += tag('rect', { x: namew, y: r.y, width: colsW, height: r.h, fill: C.bg });
      content += tag('text', { x: namew + colsW / 2, y: r.y + r.h / 2 + 4.5, 'text-anchor': 'middle',
        'font-size': FONTS.title, 'font-weight': 600, fill: C.muted, 'font-family': FONT_UI }, esc(t));
    } else if (r.type === 'time') {
      content += tag('rect', { x: 0, y: r.y, width: W, height: r.h, fill: C.bg });
      content += tag('line', { x1: 0, y1: r.y + r.h, x2: W, y2: r.y + r.h, stroke: C.line });
      for (let i = 0; i < colCount; i++) {
        const tt = win.a + i;
        const cx = namew + i * gw;
        if (i > 0) content += tag('line', { x1: cx, y1: r.y + 4, x2: cx, y2: r.y + r.h - 4, stroke: C.lineSoft });
        let label = String(tt);
        if (headNums) {
          const v = headTL.L[tt], off = headTL.offset ?? 0;
          label = (v === undefined || (headEvery > 1 && (((off + tt) % headEvery) + headEvery) % headEvery !== 0)) ? '' : String(v);
        }
        if (label) content += tag('text', { x: cx + gw / 2, y: r.y + r.h / 2 + 3.5, 'text-anchor': 'middle',
          'font-size': FONTS.tick, 'font-weight': headNums ? 600 : 500, fill: headNums ? C.accText : C.faint, 'font-family': FONT_MONO }, esc(label));
      }
    } else if (r.type === 'footnums') {
      content += tag('rect', { x: namew, y: r.y, width: colsW, height: r.h, fill: C.bg });
      for (let i = 0; i < colCount; i++) {
        const tt = win.a + i;
        const v = footTL.L[tt], off = footTL.offset ?? 0;
        const label = (v === undefined || (footEvery > 1 && (((off + tt) % footEvery) + footEvery) % footEvery !== 0)) ? '' : String(v);
        if (label) content += tag('text', { x: namew + i * gw + gw / 2, y: r.y + r.h / 2 + 3.5, 'text-anchor': 'middle',
          'font-size': FONTS.tick, 'font-weight': 500, fill: C.accText, 'font-family': FONT_MONO }, esc(label));
      }
    } else if (r.type === 'lane') {
      const lane = r.node;
      content += tag('line', { x1: 0, y1: r.y + r.h, x2: W, y2: r.y + r.h, stroke: C.lineSoft });
      const idx = flat.indexOf(lane);
      const color = C.ch[(idx < 0 ? 0 : idx) % 6];
      const body = laneSVG(lane, gw, color, nodePos, nodeScale, nodeInset, nodeMode);
      // translate into place: lane track starts at namew, minus crop offset winX
      content += `<g transform="translate(${namew - winX}, ${r.y})">${body}</g>`;
    } else if (r.type === 'group' || r.type === 'spacer') {
      content += tag('line', { x1: 0, y1: r.y + r.h, x2: W, y2: r.y + r.h, stroke: C.lineSoft });
    }
  }

  /* --- edge overlay (port of renderMiniEdges) --- */
  if (st.edges.length) {
    const nodes = [];
    eachLane(st.tree, l => Object.keys(l.nodeByT).forEach(tk => nodes.push({ letter: l.nodeByT[tk], lane: l, t: +tk })));
    const byLetter = {};
    nodes.forEach(n => { byLetter[n.letter] = n; });
    const col = C.info;
    const planCache = new Map();
    const planOf = l => {
      if (!planCache.has(l)) planCache.set(l, planLaneNodes(l, gw, nodePos, nodeScale, FONTS.dataLabel, nodeInset, nodeMode));
      return planCache.get(l);
    };
    const pos = letter => {
      const n = byLetter[letter];
      if (!n) return null;
      const ry = laneRowY.get(n.lane);
      if (!ry) return null;
      const lw = gw * (n.lane.period || 1);
      const lp = laneCharPositions(n.lane, gw)[n.t];
      const bx = lp ? lp.x : (n.t - (n.lane.phase || 0)) * lw;
      const [ax, ay0] = nodeAnchorXY(bx, lp ? lp.w : lw, nodePos, nodeScale, nodeInset);
      /* 与通道本体用同一份避让方案，否则箭头会指向节点被抬走前的旧位置 */
      const ay = planOf(n.lane).lift.has(n.t) ? liftedNodeY(nodeScale, nodeMode) : ay0;
      return { x: namew - winX + ax, y: ry.y + ay };
    };
    const arrow = (x, y, dx, dy) => {
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, s = 5.5;
      edgeLayer += tag('path', { d: `M${x + ux * s} ${y + uy * s}L${x - uy * 3} ${y + ux * 3}L${x + uy * 3} ${y - ux * 3}z`, fill: col, opacity: .9 });
    };
    for (const e of st.edges) {
      const pa = pos(e.from), pb = pos(e.to);
      if (!pa || !pb) continue;
      const spec = e.spec, segs = [], heads = [], dots = [], rr = 9;
      if (spec === '+') {
        const dx = pb.x - pa.x, dy = pb.y - pa.y, dist = Math.hypot(dx, dy) || 1, ux = dx / dist, uy = dy / dist;
        segs.push([[pa.x + ux * rr, pa.y + uy * rr], [pb.x - ux * rr, pb.y - uy * rr]]);
        dots.push(pa, pb);
      } else if (spec.includes('|')) {
        const lead = spec.startsWith('|');
        const dx = pb.x - pa.x, sx = pa.x, ex = pb.x, sy = pa.y, ey = pb.y, dyv = ey > sy ? 1 : -1;
        if (lead) {
          segs.push([[sx, sy - rr], [sx, ey]]); segs.push([[sx, ey], [ex, ey]]);
          if (spec.endsWith('>')) heads.push([ex - rr, ey, 1, 0]);
          if (spec.startsWith('<')) heads.push([sx, sy - rr, 0, -dyv]);
        } else if ((spec.match(/\|/g) || []).length >= 2 && !spec.endsWith('|')) {
          const mx = (sx + ex) / 2;
          segs.push([[sx, sy], [mx, sy]]); segs.push([[mx, sy], [mx, ey]]); segs.push([[mx, ey], [ex, ey]]);
          if (spec.endsWith('>')) heads.push([ex - rr, ey, 1, 0]);
          if (spec.startsWith('<')) heads.push([sx + rr, sy, -1, 0]);
        } else {
          segs.push([[sx, sy], [ex, sy]]); segs.push([[ex, sy], [ex, ey]]);
          if (spec.endsWith('>')) heads.push([ex, ey - dyv * rr, 0, dyv]);
          if (spec.startsWith('<')) heads.push([sx, sy + (sy < ey ? -rr : rr), 0, sy < ey ? -1 : 1]);
        }
      } else {
        const dx = pb.x - pa.x, dy = pb.y - pa.y, dist = Math.hypot(dx, dy) || 1, ux = dx / dist, uy = dy / dist;
        const ax = pa.x + ux * rr, ay = pa.y + uy * rr, bx = pb.x - ux * rr, by = pb.y - uy * rr;
        if (spec.includes('~')) {
          const cx = (ax + bx) / 2 - uy * Math.min(26, dist * .22);
          const cy = (ay + by) / 2 + ux * Math.min(26, dist * .22);
          segs.push([['Q', ax, ay, cx, cy, bx, by]]);
          let ex = bx - cx, ey2 = by - cy; const el = Math.hypot(ex, ey2) || 1;
          if (spec.endsWith('>')) heads.push([bx, by, ex / el, ey2 / el]);
          let sx2 = ax - cx, sy2 = ay - cy; const sl = Math.hypot(sx2, sy2) || 1;
          if (spec.startsWith('<')) heads.push([ax, ay, sx2 / sl, sy2 / sl]);
        } else {
          segs.push([[ax, ay], [bx, by]]);
          if (spec.endsWith('>')) heads.push([bx, by, ux, uy]);
          if (spec.startsWith('<')) heads.push([ax, ay, -ux, -uy]);
        }
      }
      for (const sg of segs) {
        edgeLayer += tag('path', {
          d: sg[0][0] === 'Q' ? `M${sg[0][1]} ${sg[0][2]}Q${sg[0][3]} ${sg[0][4]} ${sg[0][5]} ${sg[0][6]}` : `M${sg[0][0]} ${sg[0][1]}L${sg[1][0]} ${sg[1][1]}`,
          fill: 'none', stroke: col, 'stroke-width': 1.4, opacity: .8,
        });
      }
      for (const [hx, hy, dx2, dy2] of heads) arrow(hx, hy, dx2, dy2);
      for (const p of dots) edgeLayer += tag('circle', { cx: p.x, cy: p.y, r: 2.4, fill: col, opacity: .9 });
      if (e.label) {
        let lp = null;
        if (!segs.length && dots.length === 2) lp = [(dots[0].x + dots[1].x) / 2, Math.min(dots[0].y, dots[1].y) - 6, 'middle'];
        else if (segs.length === 1 && segs[0][0][0] === 'Q') { const a = segs[0][0]; lp = [(a[1] + 2 * a[3] + a[5]) / 4, (a[2] + 2 * a[4] + a[6]) / 4 - 5, 'middle']; }
        else if (segs.length === 1) lp = [(segs[0][0][0] + segs[0][1][0]) / 2, (segs[0][0][1] + segs[0][1][1]) / 2 - 5, 'middle'];
        else {
          let best = null, bl = -1;
          segs.forEach(sg => { const l = Math.hypot(sg[1][0] - sg[0][0], sg[1][1] - sg[0][1]); if (l > bl) { bl = l; best = sg; } });
          if (best) { const mx2 = (best[0][0] + best[1][0]) / 2, my2 = (best[0][1] + best[1][1]) / 2; lp = best[0][1] === best[1][1] ? [mx2, my2 - 5, 'middle'] : [mx2 + 7, my2, 'start']; }
        }
        if (lp) {
          // NOTE: cairosvg silently drops any <text> that carries a `stroke`
          // attribute, so we cannot use a stroke "halo" for legibility. Draw a
          // filled background rect behind the label instead, then fill-only text.
          const fs = FONTS.edgeLabel;
          let lw = 0;
          for (const ch of String(e.label)) lw += (ch.charCodeAt(0) > 0x2e7f ? fs : fs * 0.6);
          const pad = 3, bh = fs + 4;
          const anchor = lp[2];
          const bx = anchor === 'middle' ? lp[0] - lw / 2 - pad : (anchor === 'start' ? lp[0] - pad : lp[0] - lw - pad);
          edgeLayer += tag('rect', { x: bx, y: lp[1] - fs + 1, width: lw + pad * 2, height: bh, rx: 3, fill: C.bg, opacity: .82 });
          edgeLayer += tag('text', { x: lp[0], y: lp[1], 'text-anchor': anchor, 'font-size': fs,
            'font-family': FONT_MONO, fill: col }, esc(e.label));
        }
      }
    }
    // node markers re-drawn on top
    for (const n of nodes) {
      const p = pos(n.letter);
      if (!p) continue;
      edgeLayer += nodeMarkerSVG(p.x, p.y, n.letter, nodeScale, nodeMode);
    }
  }

  /* --- name column (sticky, drawn last to cover crossing edges) ---
     名称列默认与波形区同底色（C.bg，右缘分割线保留），对齐编辑器「信号名底色 = 与波形同色」的默认 */
  nameLayer += tag('rect', { x: 0, y: 0, width: namew, height: totalH, fill: C.bg });
  nameLayer += tag('line', { x1: namew, y1: 0, x2: namew, y2: totalH, stroke: C.line });
  for (const r of rows) {
    if (r.type !== 'lane' && r.type !== 'group' && r.type !== 'spacer') continue;
    const cy = r.y + r.h / 2, ix = r.depth * 14;
    if (r.type === 'lane') {
      const idx = flat.indexOf(r.node);
      const color = C.ch[(idx < 0 ? 0 : idx) % 6];
      nameLayer += tag('circle', { cx: 22 + ix, cy, r: 4.5, fill: color });
      if (r.node.name) nameLayer += tag('text', { x: 44 + ix, y: cy + 4.5, 'font-size': FONTS.signalName, 'font-weight': 500, fill: C.text, 'font-family': FONT_MONO }, esc(r.node.name));
      if ((r.node.period && r.node.period > 1) || r.node.phase) {
        const badge = (r.node.period && r.node.period > 1 ? '×' + r.node.period : '') + (r.node.phase ? ' φ' + r.node.phase : '');
        nameLayer += tag('text', { x: namew - 8 - textW(badge, FONTS.ppBadge), y: cy + 3.5, 'font-size': FONTS.ppBadge, 'font-weight': 600, fill: C.warnInk, 'font-family': FONT_MONO }, esc(badge));
      }
    } else if (r.type === 'group') {
      // Fold triangle drawn as an SVG path (font glyph ▸ substitutes wrongly
      // in some rasterizers), then the group name text after it.
      const chevCx = 22 + ix;
      nameLayer += tag('path', { d: `M${chevCx - 2.2} ${cy - 1.6}L${chevCx} ${cy + 1.6}L${chevCx + 2.2} ${cy - 1.6}`, fill: 'none', stroke: C.faint, 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      nameLayer += tag('text', { x: 44 + ix, y: cy + 4.5, 'font-size': FONTS.groupName, 'font-weight': 700, fill: C.accText, 'font-family': FONT_UI }, esc(r.node.name || ''));
    } else {
      nameLayer += tag('text', { x: 31 + ix, y: cy + 4, 'font-size': FONTS.spacer, fill: C.faint, 'font-family': FONT_UI }, '空白占位');
    }
  }

  const svgBody = bg + content + edgeLayer + nameLayer;

  // Optional self-contained font embedding (see fonts.config.json + lib/font-embed.js).
  // Collect the characters actually drawn (for optional subsetting), then prepend
  // a <style> block with @font-face base64. Falls back to '' (font-family names).
  let fontStyle = '';
  try {
    const { buildFontStyle } = require('./font-embed.js');
    const usedChars = (svgBody.match(/>([^<]*)<\/text>/g) || []).map(m => m.slice(1, -7)).join('');
    fontStyle = buildFontStyle(usedChars);
  } catch (e) { /* embedding is best-effort; ignore and fall back to font names */ }

  const svg = tag('svg', { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink',
    width: W, height: totalH, viewBox: `0 0 ${W} ${totalH}` }, fontStyle + svgBody);
  return { svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + svg, width: W, height: totalH };
}

module.exports = { renderModern };
