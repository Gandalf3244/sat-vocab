/**
 * ui.js — small DOM + inline-SVG helpers. No chart library; these draw the
 * four shapes the Progress tab actually needs.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

let toastTimer = null;
export function toast(message, kind = '') {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast ${kind}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'bad' ? 5200 : 3000);
}

/* ---------------------------------------------------------------- charts --- */

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** The chart is drawn in real CSS pixels so line/text strokes aren't stretched
 *  non-uniformly by the SVG's `preserveAspectRatio="none"` scaling. Falls back
 *  to a sane width when the host is offscreen (e.g. the Progress tab isn't the
 *  active view yet), where clientWidth reads 0. */
function chartWidth(host) {
  return Math.round(host.clientWidth) || 320;
}

/** Draws evenly-spaced gridlines, but skips a tick's label when rounding
 *  (via `yFormat`) makes it read the same as a tick already drawn — e.g. a
 *  0/0.5/1 scale rounds to 0/1/1, and a duplicate "1" label is more confusing
 *  than a missing middle one. */
function yAxis(svg, { ticks, py, yFormat, padL, W, padR }) {
  const seen = new Set();
  for (const v of ticks) {
    const text = String(yFormat(v));
    if (seen.has(text)) continue;
    seen.add(text);
    const y = py(v);
    svg.append(svgEl('line', { class: 'gridline', x1: padL, x2: W - padR, y1: y, y2: y }));
    const label = svgEl('text', { class: 'lbl', x: 2, y: y + 3.5 });
    label.textContent = text;
    svg.append(label);
  }
}

function frame(host, { width = 320, height = 148 } = {}) {
  host.textContent = '';
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', width: '100%', height: '100%' });
  host.append(svg);
  return svg;
}

function empty(host, message) {
  host.textContent = '';
  host.append(el('div', { class: 'chart-empty', text: message }));
}

/**
 * Line chart with a filled area. `points` is [{x: label, y: number}].
 * `yMax` defaults to the data max; pass 1 for percentages.
 */
export function lineChart(host, points, { yMax = null, yFormat = (v) => v, good = false, minPoints = 2 } = {}) {
  if (!points || points.length < minPoints) return empty(host, 'Not enough sessions yet');
  const W = chartWidth(host), H = 148, padL = 30, padR = 8, padT = 10, padB = 20;
  const svg = frame(host, { width: W, height: H });
  const max = yMax ?? Math.max(1, ...points.map((p) => p.y));
  const min = 0;
  const iw = W - padL - padR, ih = H - padT - padB;
  const px = (i) => padL + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const py = (v) => padT + ih - ((v - min) / (max - min || 1)) * ih;

  yAxis(svg, { ticks: [min, max, (min + max) / 2], py, yFormat, padL, W, padR });

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { class: 'area', d: `${d} L${px(points.length - 1).toFixed(1)},${padT + ih} L${px(0).toFixed(1)},${padT + ih} Z` }));
  svg.append(svgEl('path', { class: `line${good ? ' line-good' : ''}`, d }));

  const step = Math.max(1, Math.floor(points.length / 6));
  const last = points.length - 1;
  let lastLabelled = -Infinity;
  points.forEach((p, i) => {
    if (points.length <= 30) svg.append(svgEl('circle', { class: 'dot', cx: px(i), cy: py(p.y), r: 2.2 }));
    // Label on the step, plus the final point — but only when it would not
    // collide with the label just before it.
    const onStep = i % step === 0;
    const isLast = i === last && last - lastLabelled >= Math.max(1, step * 0.7);
    if (!onStep && !isLast) return;
    if (onStep && i === last && last - lastLabelled < 1) return;
    lastLabelled = i;
    const t = svgEl('text', { class: 'lbl', x: px(i), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === last ? 'end' : 'middle' });
    t.textContent = p.x;
    svg.append(t);
  });
  return svg;
}

/** Column chart. `points` is [{x: label, y: number}]. */
export function barChart(host, points, { yFormat = (v) => v, emptyText = 'Nothing scheduled' } = {}) {
  if (!points || !points.length || points.every((p) => !p.y)) return empty(host, emptyText);
  const W = chartWidth(host), H = 148, padL = 26, padR = 6, padT = 10, padB = 20;
  const svg = frame(host, { width: W, height: H });
  const max = Math.max(1, ...points.map((p) => p.y));
  const iw = W - padL - padR, ih = H - padT - padB;
  const bw = iw / points.length;

  const py = (v) => padT + ih - (v / max) * ih;
  yAxis(svg, { ticks: [0, max, max / 2], py, yFormat, padL, W, padR });

  points.forEach((p, i) => {
    const h = (p.y / max) * ih;
    svg.append(svgEl('rect', {
      class: i === 0 ? 'bar' : 'bar-soft',
      x: padL + i * bw + bw * 0.16,
      y: padT + ih - h,
      width: Math.max(1.5, bw * 0.68),
      height: Math.max(p.y ? 1.5 : 0, h),
      rx: 2,
    }));
  });

  const step = Math.max(1, Math.floor(points.length / 7));
  points.forEach((p, i) => {
    if (i % step) return;
    const t = svgEl('text', { class: 'lbl', x: padL + i * bw + bw / 2, y: H - 5, 'text-anchor': 'middle' });
    t.textContent = p.x;
    svg.append(t);
  });
  return svg;
}

export function renderHeatmap(host, cells) {
  host.textContent = '';
  for (const c of cells) {
    const cell = el('i', { 'data-l': c.future ? 0 : c.level });
    cell.title = c.future ? '' : `${c.date} — ${c.items} question${c.items === 1 ? '' : 's'}`;
    if (c.future) cell.style.opacity = '.25';
    host.append(cell);
  }
}
