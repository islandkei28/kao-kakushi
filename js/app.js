// 画面の動き
import { bounds, drawItems, renderOutput, stampImages } from './render.js';
import { inspect, strip } from './jpeg.js';

const $ = id => document.getElementById(id);
const all = sel => [...document.querySelectorAll(sel)];
const MAX_SIDE = 4096;     // iPhone の canvas の上限（1677万画素）に収める
const SURE = 0.6;          // これ以上なら初めから隠す。下は「もしかして顔」の点線

const RATIOS = [
  ['orig', '元のまま', null], ['1:1', '正方形 1:1', 1], ['4:5', '縦長 4:5', 4 / 5], ['3:4', '縦長 3:4', 3 / 4],
  ['9:16', 'ストーリー 9:16', 9 / 16], ['1.91:1', '横長 1.91:1', 1.91], ['16:9', '横長 16:9', 16 / 9], ['free', '自由', null],
];
const EMOJI = ['😀', '😎', '🥰', '😂', '🤫', '🫥', '🐶', '🐱', '🐻', '🐼', '🦊', '🐸', '🐵', '🐧', '🌸', '🌻', '🍊', '⚽', '👻', '🎃'];

const DEFAULT_STYLE = { mode: 'mosaic', strength: 3, color: '#000000', stamp: '😀', under: true, pad: 1.35, shape: 'ellipse' };
let style = { ...DEFAULT_STYLE };
try {
  const saved = JSON.parse(localStorage.getItem('kaokakushi-style') || '{}');
  for (const k of Object.keys(style)) if (typeof saved[k] === typeof style[k]) style[k] = saved[k];
  if (style.stamp.startsWith('img:')) style.stamp = DEFAULT_STYLE.stamp;
  style.strength = Math.min(5, Math.max(1, Math.round(style.strength)));
} catch { /* 保存がなければ初期値 */ }

const photos = [];
let cur = null;           // 開いている写真
let src = null;           // 開いている写真の canvas
let selected = null;      // 選んでいる範囲の id
let tool = 'select';
let tab = 'hide';
let nextId = 1;
const view = { s: 1, ox: 0, oy: 0 };

// ---------- 読み込み ----------

async function decode(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const img = new Image();
    const url = URL.createObjectURL(file);
    try { img.src = url; await img.decode(); bmp = img; } finally { URL.revokeObjectURL(url); }
  }
  const W = bmp.width || bmp.naturalWidth, H = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, MAX_SIDE / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

async function addFiles(files) {
  const list = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp)$/i.test(f.name));
  if (!list.length) return;
  const first = photos.length;
  for (const file of list) {
    photos.push({
      id: nextId++, file, url: URL.createObjectURL(file), meta: await inspect(file), state: 'wait', seen: false,
      items: [], crop: { ratio: 'orig', value: null, pad: false, bg: '#ffffff', x: 0, y: 0, w: 0, h: 0 }, undo: [],
    });
  }
  await openPhoto(photos[first]);
  pump();
}

let openSeq = 0;
async function openPhoto(p) {
  const seq = ++openSeq;
  cur = p; src = null; selected = null;
  syncUI();
  try {
    const c = await decode(p.file);
    if (seq !== openSeq) return;
    src = c;
    p.seen = true;
  } catch {
    if (seq !== openSeq) return;
    p.state = 'bad';
  }
  fit();
  syncUI();
}

function removePhoto(p) {
  const i = photos.indexOf(p);
  if (i < 0) return;
  photos.splice(i, 1);
  URL.revokeObjectURL(p.url);
  if (cur === p) {
    cur = null; src = null; selected = null; openSeq++;
    if (photos.length) openPhoto(photos[Math.min(i, photos.length - 1)]);
  }
  syncUI();
}

// ---------- 顔を探す ----------

let worker = null, jobSeq = 0, busy = false;
let progress = null;

function detect(bitmap, thorough, onProgress) {
  return new Promise((resolve, reject) => {
    if (!worker) worker = new Worker('js/detect-worker.js');
    const id = ++jobSeq;
    worker.onmessage = e => {
      const d = e.data;
      if (d.id !== id) return;
      if (d.type === 'progress') onProgress(d.done, d.total);
      else if (d.type === 'done') resolve(d.faces);
      else reject(new Error(d.message));
    };
    worker.onerror = e => { worker.terminate(); worker = null; reject(new Error(e.message || '読み込めませんでした')); };
    worker.postMessage({ id, bitmap, thorough }, [bitmap]);
  });
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const p = cur && cur.state === 'wait' ? cur : photos.find(q => q.state === 'wait');
      if (!p) break;
      await runDetect(p, false);
    }
  } finally {
    busy = false;
    progress = null;
    syncUI();
  }
}

async function runDetect(p, thorough) {
  p.state = 'run';
  progress = { done: 0, total: 0 };
  syncUI();
  let c;
  try {
    c = p === cur && src ? src : await decode(p.file);
  } catch { p.state = 'bad'; syncUI(); return; }
  try {
    const faces = await detect(await createImageBitmap(c), thorough, (done, total) => { progress = { done, total }; syncStatus(); });
    const add = [], drop = new Set();
    for (const f of faces) {
      const it = {
        id: nextId++, kind: 'face', cx: f.x + f.w / 2, cy: f.y + f.h * 0.47, w: f.w * 1.05, h: f.h,
        angle: f.angle, score: f.score, on: f.score >= SURE, style: { ...style },
      };
      const near = p.items.filter(o => o.kind !== 'stroke' && overlap(o, it));
      // 弱い候補（点線）の所で確かな顔が見つかったら、そちらに置き換える
      const weak = near.filter(o => o.kind === 'face' && !o.on && o.score < SURE);
      if (!near.length) add.push(it);
      else if (it.on && weak.length === near.length) { add.push(it); weak.forEach(o => drop.add(o)); }
    }
    if (thorough && add.length) pushUndo(p);
    p.items = p.items.filter(o => !drop.has(o)).concat(add);
    p.state = 'done';
  } catch (err) {
    console.error(err);
    p.state = 'error';
  }
  syncUI();
}

function overlap(a, b) {
  const A = bounds(a), B = bounds(b);
  return Math.abs(A.cx - B.cx) < Math.min(A.w, B.w) / 2 && Math.abs(A.cy - B.cy) < Math.min(A.h, B.h) / 2;
}

$('thorough').onclick = async () => {
  if (busy || !cur || !src) return;
  busy = true;
  try { await runDetect(cur, true); } finally { busy = false; progress = null; syncUI(); pump(); }
};

// ---------- 元に戻す ----------

const snapshot = p => JSON.stringify({ items: p.items, crop: p.crop });
function pushUndo(p = cur) {
  p.undo.push(snapshot(p));
  if (p.undo.length > 60) p.undo.shift();
}
function undo() {
  if (!cur || !cur.undo.length) return;
  Object.assign(cur, JSON.parse(cur.undo.pop()));
  if (!cur.items.some(i => i.id === selected)) selected = null;
  syncUI();
}
// つまみを動かしている間は1回だけ記録する
let sliding = false;
function undoOnce() { if (!sliding && cur) { pushUndo(); sliding = true; } }
document.addEventListener('change', () => { sliding = false; });

// ---------- 隠し方 ----------

const sel = () => cur && cur.items.find(i => i.id === selected);

function applyStyle(k, v, slider) {
  if (slider) undoOnce(); else if (cur) pushUndo();
  const it = sel();
  if (it) it.style[k] = v;
  else {
    style[k] = v;
    try { localStorage.setItem('kaokakushi-style', JSON.stringify(style)); } catch { /* 覚えられなくてもよい */ }
    for (const p of photos) for (const o of p.items) {
      if (k === 'shape' && o.kind === 'box') continue; // 囲んだ形は個別に
      o.style[k] = v;
    }
  }
  syncUI();
}

all('[data-mode]').forEach(b => b.onclick = () => applyStyle('mode', b.dataset.mode));
all('[data-shape]').forEach(b => b.onclick = () => applyStyle('shape', b.dataset.shape));
$('strength').oninput = e => applyStyle('strength', +e.target.value, true);
$('pad').oninput = e => applyStyle('pad', +e.target.value, true);
$('color').oninput = e => applyStyle('color', e.target.value, true);
$('under').onchange = e => applyStyle('under', e.target.checked);
$('emoji').onchange = e => {
  const v = e.target.value.trim();
  if (!v) return;
  const seg = window.Intl && Intl.Segmenter ? [...new Intl.Segmenter('ja').segment(v)][0].segment : [...v][0];
  addStampButton(seg);
  applyStyle('stamp', seg);
  e.target.value = '';
};
$('stampimg').onclick = () => $('stampfile').click();
$('stampfile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const id = 'img:' + nextId++;
    stampImages.set(id, bmp);
    addStampButton(id, f);
    applyStyle('stamp', id);
  } catch { flash('この画像は開けませんでした'); }
};

function addStampButton(id, file) {
  if (all('#stamps button').some(b => b.dataset.stamp === id)) return;
  const b = document.createElement('button');
  b.dataset.stamp = id;
  if (file) {
    const im = document.createElement('img');
    im.src = URL.createObjectURL(file);
    im.alt = '自分の画像';
    b.append(im);
  } else b.textContent = id;
  b.onclick = () => applyStyle('stamp', id);
  $('stamps').append(b);
}
EMOJI.forEach(e => addStampButton(e));
if (!EMOJI.includes(style.stamp)) addStampButton(style.stamp);

all('[data-tool]').forEach(b => b.onclick = () => { tool = b.dataset.tool; selected = null; syncUI(); });
all('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; selected = null; syncUI(); });

$('toggle').onclick = () => { const it = sel(); if (it) { pushUndo(); it.on = !it.on; syncUI(); } };
$('remove').onclick = removeSelected;
function removeSelected() {
  if (!sel()) return;
  pushUndo();
  cur.items = cur.items.filter(i => i.id !== selected);
  selected = null;
  syncUI();
}

// ---------- 切り抜き ----------

for (const [key, label, value] of RATIOS) {
  const b = document.createElement('button');
  b.dataset.ratio = key;
  b.textContent = label;
  b.onclick = () => {
    if (!src) return;
    pushUndo();
    Object.assign(cur.crop, { ratio: key, value });
    if (key === 'free') cur.crop.pad = false;
    resetCrop();
    syncUI();
  };
  $('ratios').append(b);
}
function resetCrop() {
  const c = cur.crop, W = src.width, H = src.height;
  if (c.ratio === 'free' && c.w) return;
  const r = c.value || W / H;
  c.w = Math.min(W, H * r); c.h = c.w / r;
  c.x = (W - c.w) / 2; c.y = (H - c.h) / 2;
}
$('croppad').onchange = e => { pushUndo(); cur.crop.pad = e.target.checked; syncUI(); };
$('bg').oninput = e => { undoOnce(); cur.crop.bg = e.target.value; syncUI(); };

// ---------- 表示 ----------

const cv = $('view'), g = cv.getContext('2d');
let dirty = false;
function redraw() {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => { dirty = false; paint(); });
}

// 余白つきのときに見せる全体の範囲
function frame() {
  const c = cur.crop;
  if (tab === 'crop' && c.pad && c.value) {
    const w = Math.max(src.width, src.height * c.value), h = w / c.value;
    return { x: (src.width - w) / 2, y: (src.height - h) / 2, w, h };
  }
  return { x: 0, y: 0, w: src.width, h: src.height };
}

function fit() {
  if (!src) return;
  const W = cv.clientWidth, H = cv.clientHeight, m = 12, f = frame();
  view.s = Math.min((W - m * 2) / f.w, (H - m * 2) / f.h);
  if (!(view.s > 0)) view.s = 0.01;
  view.ox = (W - f.w * view.s) / 2 - f.x * view.s;
  view.oy = (H - f.h * view.s) / 2 - f.y * view.s;
  redraw();
}

function paint() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!src) return;
  const k = view.s * dpr;
  g.setTransform(k, 0, 0, k, view.ox * dpr, view.oy * dpr);
  const f = frame(), c = cur.crop;
  if (tab === 'crop' && c.pad && c.value) { g.fillStyle = c.bg; g.fillRect(f.x, f.y, f.w, f.h); }
  g.save();
  g.beginPath(); g.rect(0, 0, src.width, src.height); g.clip();
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0);
  drawItems(g, src, cur.items);
  g.restore();

  const px = 1 / view.s; // 画面の 1px
  if (draft && draft.kind === 'box') outline(draft, px, '#fff', []);
  if (tab === 'hide') {
    for (const it of cur.items) {
      if (it.kind !== 'stroke' && !it.on) outline(it, px, '#ffd23f', [6, 5]);
    }
    const it = sel();
    if (it) {
      outline(it, px, '#fff', [], true);
      if (it.kind !== 'stroke') corners(bounds(it)).forEach(p => knob(p, px));
    }
  } else if (c.ratio !== 'orig' && !c.pad) {
    g.fillStyle = '#000a';
    g.beginPath();
    g.rect(0, 0, src.width, src.height);
    g.rect(c.x, c.y, c.w, c.h);
    g.fill('evenodd');
    g.lineWidth = 2 * px; g.strokeStyle = '#fff';
    g.strokeRect(c.x, c.y, c.w, c.h);
    corners(cropBox()).forEach(p => knob(p, px));
  }
}

function outline(it, px, color, dash, forceRect) {
  const b = bounds(it);
  g.beginPath();
  if (forceRect || it.style.shape === 'rect' || it.kind === 'stroke') g.rect(b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h);
  else g.ellipse(b.cx, b.cy, b.w / 2, b.h / 2, 0, 0, 7);
  g.setLineDash(dash.map(d => d * px));
  g.lineWidth = 4 * px; g.strokeStyle = '#0008'; g.stroke();
  g.lineWidth = 2 * px; g.strokeStyle = color; g.stroke();
  g.setLineDash([]);
}
const corners = b => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [b.cx + i * b.w / 2, b.cy + j * b.h / 2]);
function knob([x, y], px) {
  g.beginPath(); g.arc(x, y, 7 * px, 0, 7);
  g.fillStyle = '#fff'; g.fill();
  g.lineWidth = 1.5 * px; g.strokeStyle = '#000a'; g.stroke();
}
const cropBox = () => { const c = cur.crop; return { cx: c.x + c.w / 2, cy: c.y + c.h / 2, w: c.w, h: c.h }; };

new ResizeObserver(() => fit()).observe($('stage'));

// ---------- 操作（指・マウス） ----------

const pts = new Map();
let act = null;     // 今している操作
let draft = null;   // 囲んでいる途中の範囲
let pinch = null;

const toImg = e => {
  const r = cv.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  return { sx, sy, x: (sx - view.ox) / view.s, y: (sy - view.oy) / view.s };
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function hitCorner(b, p) {
  const R = 22 / view.s;
  let best = -1, bd = R;
  corners(b).forEach(([x, y], i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = i; } });
  return best;
}
function hitItem(p) {
  const slack = 8 / view.s;
  for (let i = cur.items.length - 1; i >= 0; i--) {
    const it = cur.items[i];
    if (it.kind === 'stroke') {
      const R = Math.max(it.size / 2, slack);
      for (let j = 0; j < it.pts.length; j++) {
        const [x0, y0] = it.pts[Math.max(0, j - 1)], [x1, y1] = it.pts[j];
        const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
        const t = L ? clamp(((p.x - x0) * dx + (p.y - y0) * dy) / L, 0, 1) : 0;
        if (Math.hypot(p.x - x0 - t * dx, p.y - y0 - t * dy) <= R) return it;
      }
    } else {
      const b = bounds(it);
      if (Math.abs(p.x - b.cx) <= b.w / 2 + slack && Math.abs(p.y - b.cy) <= b.h / 2 + slack) return it;
    }
  }
  return null;
}

cv.onpointerdown = e => {
  if (!src || (e.pointerType === 'mouse' && e.button !== 0)) return;
  cv.setPointerCapture(e.pointerId);
  const p = toImg(e);
  pts.set(e.pointerId, p);
  if (pts.size === 2) { cancelAct(); startPinch(); return; }
  if (pts.size > 2) return;

  if (tab === 'crop') {
    const c = cur.crop;
    if (c.ratio === 'orig' || c.pad) act = { type: 'pan', p };
    else {
      const before = snapshot(cur), i = hitCorner(cropBox(), p);
      act = { type: i >= 0 ? 'cropsize' : 'cropmove', corner: i, p, before, c0: { ...c } };
    }
    return;
  }
  if (tool === 'box') {
    draft = { kind: 'box', cx: p.x, cy: p.y, w: 0, h: 0, style: { ...style, shape: 'rect' } };
    act = { type: 'box', p };
  } else if (tool === 'brush') {
    const before = snapshot(cur);
    const it = {
      id: nextId++, kind: 'stroke', size: Math.min(src.width, src.height) * $('brush').value / 100,
      pts: [[p.x, p.y]], on: true, style: { ...style },
    };
    cur.items.push(it);
    act = { type: 'brush', it, before };
  } else {
    const s = sel();
    if (s && s.kind !== 'stroke') {
      const i = hitCorner(bounds(s), p);
      if (i >= 0) { act = { type: 'size', it: s, corner: i, b0: bounds(s), before: snapshot(cur) }; return; }
    }
    const it = hitItem(p);
    act = it
      ? { type: 'move', it, p, start: JSON.parse(JSON.stringify(it)), before: snapshot(cur), was: selected }
      : { type: 'pan', p };
  }
  redraw();
};

cv.onpointermove = e => {
  if (!pts.has(e.pointerId)) return;
  const p = toImg(e);
  pts.set(e.pointerId, p);
  if (pinch) { movePinch(); return; }
  if (!act) return;
  const dx = act.p ? p.x - act.p.x : 0, dy = act.p ? p.y - act.p.y : 0;
  if (act.p && !act.moved) {
    if (Math.hypot(p.sx - act.p.sx, p.sy - act.p.sy) < 5) return;
    act.moved = true;
  }
  switch (act.type) {
    case 'pan':
      view.ox += p.sx - (act.lx ?? act.p.sx); view.oy += p.sy - (act.ly ?? act.p.sy);
      act.lx = p.sx; act.ly = p.sy;
      break;
    case 'box': {
      const x1 = clamp(p.x, 0, src.width), y1 = clamp(p.y, 0, src.height);
      const x0 = clamp(act.p.x, 0, src.width), y0 = clamp(act.p.y, 0, src.height);
      Object.assign(draft, { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
      break;
    }
    case 'brush': {
      const [lx, ly] = act.it.pts[act.it.pts.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) > act.it.size / 10) act.it.pts.push([p.x, p.y]);
      break;
    }
    case 'move':
      selected = act.it.id;
      if (act.it.kind === 'stroke') act.it.pts = act.start.pts.map(([x, y]) => [x + dx, y + dy]);
      else { act.it.cx = act.start.cx + dx; act.it.cy = act.start.cy + dy; }
      break;
    case 'size': {
      act.moved = true;
      const [ax, ay] = corners(act.b0)[(act.corner + 2) % 4];
      const min = 12 / view.s;
      const w = Math.max(min, Math.abs(p.x - ax)), h = Math.max(min, Math.abs(p.y - ay));
      const pad = act.it.kind === 'face' ? act.it.style.pad : 1;
      act.it.w = w / pad; act.it.h = h / pad;
      act.it.cx = ax + Math.sign(p.x - ax || 1) * w / 2;
      act.it.cy = ay + Math.sign(p.y - ay || 1) * h / 2;
      break;
    }
    case 'cropmove': {
      const c = cur.crop;
      c.x = clamp(act.c0.x + dx, 0, src.width - c.w);
      c.y = clamp(act.c0.y + dy, 0, src.height - c.h);
      break;
    }
    case 'cropsize': resizeCrop(p); break;
  }
  redraw();
};

function resizeCrop(p) {
  const c = cur.crop, c0 = act.c0;
  const right = act.corner === 1 || act.corner === 2, down = act.corner >= 2;
  const ax = right ? c0.x : c0.x + c0.w, ay = down ? c0.y : c0.y + c0.h;
  const maxW = right ? src.width - ax : ax, maxH = down ? src.height - ay : ay;
  const min = Math.min(src.width, src.height) * 0.1;
  let w = clamp(right ? p.x - ax : ax - p.x, min, maxW);
  let h = clamp(down ? p.y - ay : ay - p.y, min, maxH);
  if (c.value) {
    w = Math.min(Math.max(w, h * c.value), maxW, maxH * c.value);
    h = w / c.value;
  }
  Object.assign(c, { w, h, x: right ? ax : ax - w, y: down ? ay : ay - h });
}

cv.onpointerup = cv.onpointercancel = e => {
  if (!pts.delete(e.pointerId)) return;
  if (pinch) { if (pts.size < 2) pinch = null; if (!pts.size) syncUI(); return; }
  const a = act;
  act = null;
  if (!a) return;
  if (e.type === 'pointercancel') { act = a; cancelAct(); return; }
  if (a.type === 'box') {
    const d = draft;
    draft = null;
    if (d.w * view.s > 8 && d.h * view.s > 8) {
      pushUndo();
      const it = { ...d, id: nextId++, on: true };
      cur.items.push(it);
      tool = 'select'; selected = it.id;
    }
  } else if (a.type === 'move' && !a.moved) {
    // 軽く触れただけ：点線の候補なら隠す、そうでなければ選ぶ
    if (!a.it.on && a.was !== a.it.id) { keepUndo(a.before); a.it.on = true; }
    selected = a.it.id;
  } else if (a.type === 'pan' && !a.moved) selected = null;
  else if (a.before) keepUndo(a.before);
  syncUI();
};
function keepUndo(before) {
  if (before === snapshot(cur)) return;
  cur.undo.push(before);
  if (cur.undo.length > 60) cur.undo.shift();
}
function cancelAct() {
  if (act && act.before) Object.assign(cur, JSON.parse(act.before));
  act = null; draft = null;
  syncUI();
}

function startPinch() {
  const [a, b] = [...pts.values()];
  pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2, ...view };
}
function movePinch() {
  const [a, b] = [...pts.values()];
  if (!b) return;
  const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
  const s = clamp(pinch.s * Math.hypot(a.sx - b.sx, a.sy - b.sy) / pinch.d, 0.02, 20);
  view.ox = mx - (pinch.mx - pinch.ox) * s / pinch.s;
  view.oy = my - (pinch.my - pinch.oy) * s / pinch.s;
  view.s = s;
  redraw();
}
cv.addEventListener('wheel', e => {
  if (!src) return;
  e.preventDefault();
  const p = toImg(e), s = clamp(view.s * Math.exp(-e.deltaY * 0.0015), 0.02, 20);
  view.ox = p.sx - p.x * s; view.oy = p.sy - p.y * s; view.s = s;
  redraw();
}, { passive: false });
cv.ondblclick = () => fit();

document.addEventListener('keydown', e => {
  if ($('dlg').open || /^(text|color)$/.test(e.target.type || '') || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
  else if (e.key === 'Escape') { selected = null; syncUI(); }
});
$('undo').onclick = undo;

// ---------- 画面を今の状態に合わせる ----------

let flashTimer = 0, flashText = '';
function flash(t) {
  flashText = t;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashText = ''; syncStatus(); }, 4000);
  syncStatus();
}

function syncStatus() {
  let t = flashText;
  if (!t && cur) {
    const faces = cur.items.filter(i => i.kind === 'face');
    const maybe = faces.filter(i => !i.on).length;
    if (cur.state === 'bad') t = 'この写真は開けませんでした（HEIC は JPEG にしてから選んでください）';
    else if (cur.state === 'error') t = '顔を探せませんでした。「囲んで隠す」で隠してください';
    else if (cur.state === 'run') t = progress && progress.total ? `顔を探しています ${progress.done} / ${progress.total}` : '顔を探しています';
    else if (cur.state === 'wait') t = '順番を待っています';
    else if (tab === 'hide') {
      const on = cur.items.filter(i => i.on).length;
      t = !cur.items.length ? '顔は見つかりませんでした。「囲んで隠す」で隠せます' : `${on}か所を隠しています`;
      if (maybe) t += `・点線 ${maybe}か所は隠していません（触ると隠す）`;
    } else if (cur.crop.ratio !== 'orig' && !cur.crop.pad) t = '枠を動かして切り抜く所を決めます';
    else t = '';
  }
  $('status').textContent = t;
  $('status').hidden = !t;
}

function syncUI() {
  const has = photos.length > 0;
  $('empty').hidden = has;
  $('panel').hidden = !has;
  $('save').disabled = !has || !src;
  $('undo').disabled = !cur || !cur.undo.length;
  if (!cur) { $('itembar').hidden = true; syncStatus(); redraw(); syncThumbs(); return; }

  const it = sel(), st = it ? it.style : style;
  all('[data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
  all('[data-pane]').forEach(b => b.hidden = b.dataset.pane !== tab);
  all('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  $('brushrow').hidden = tool !== 'brush';
  $('target').textContent = it ? '選んだ1か所の隠し方' : '全部の隠し方';
  all('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === st.mode));
  all('[data-for]').forEach(b => b.hidden = !b.dataset.for.split(' ').includes(st.mode));
  all('[data-shape]').forEach(b => b.classList.toggle('on', b.dataset.shape === st.shape));
  all('#stamps button').forEach(b => b.classList.toggle('on', b.dataset.stamp === st.stamp));
  $('strength').value = st.strength;
  $('weak').hidden = !(st.strength === 1 && (st.mode === 'mosaic' || st.mode === 'blur'));
  $('pad').value = st.pad;
  $('color').value = st.color;
  $('under').checked = st.under;
  $('thorough').disabled = busy || !src;
  $('itembar').hidden = !it || tab !== 'hide';
  if (it) $('toggle').textContent = it.on ? '隠さない' : '隠す';

  const m = cur.meta;
  const found = [m.gps && '位置情報', m.date && '撮影日時', m.model && '機種名'].filter(Boolean);
  $('meta').textContent = found.length
    ? `この写真には${found.join('・')}が入っています。保存する写真には残しません。`
    : '撮影場所などの情報は、保存する写真には残しません。';

  const c = cur.crop;
  all('[data-ratio]').forEach(b => b.classList.toggle('on', b.dataset.ratio === c.ratio));
  $('padrow').hidden = !c.value;
  $('croppad').checked = c.pad;
  $('bgrow').hidden = !(c.value && c.pad);
  $('bg').value = c.bg;

  const key = [cur.id, tab, c.ratio, c.pad, !!src].join();
  if (key !== syncUI.key) { syncUI.key = key; fit(); }
  syncStatus();
  syncThumbs();
  redraw();
}

function syncThumbs() {
  const box = $('thumbs');
  const key = photos.map(p => [p.id, p === cur, p.state, p.items.filter(i => i.on).length].join()).join('|');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...photos.map(p => {
    const b = document.createElement('button');
    b.className = 'thumb' + (p === cur ? ' on' : '');
    const im = document.createElement('img');
    im.src = p.url;
    im.alt = '';
    const n = document.createElement('span');
    n.textContent = p.state === 'done' ? p.items.filter(i => i.on).length : p.state === 'bad' || p.state === 'error' ? '!' : '…';
    b.append(im, n);
    b.setAttribute('aria-label', `${photos.indexOf(p) + 1}枚目`);
    b.onclick = () => { if (p !== cur) openPhoto(p); };
    return b;
  }));
}
$('drop').onclick = () => { if (cur) removePhoto(cur); };

// ---------- 保存 ----------

let outputs = [];
const toBlob = c => new Promise((ok, ng) => c.toBlob(b => b ? ok(b) : ng(new Error('画像を作れませんでした')), 'image/jpeg', 0.92));

$('save').onclick = async () => {
  const list = photos.filter(p => p.state !== 'bad');
  clearOutputs();
  const warn = [];
  const unchecked = list.filter(p => p.state === 'wait' || p.state === 'run').length;
  const failed = list.filter(p => p.state === 'error').length;
  const unseen = list.filter(p => !p.seen).length;
  const maybe = list.reduce((n, p) => n + p.items.filter(i => i.kind === 'face' && !i.on).length, 0);
  if (unchecked) warn.push(`まだ顔を探し終わっていない写真が ${unchecked}枚あります`);
  if (failed) warn.push(`顔を探せなかった写真が ${failed}枚あります`);
  if (unseen) warn.push(`まだ開いて確かめていない写真が ${unseen}枚あります`);
  if (maybe) warn.push(`隠していない顔（候補を含む）が ${maybe}か所あります`);
  $('dlgmsg').textContent = '作っています';
  $('share').hidden = true;
  $('download').disabled = true;
  $('dlg').showModal();
  const limit = +$('limit').value;
  const mine = outputs;
  try {
    for (const [i, p] of list.entries()) {
      const c = p === cur && src ? src : await decode(p.file);
      const o = renderOutput(c, p.items, p.crop, limit);
      // 元のファイル名には日付などが入るので使わない
      const file = new File([await strip(await toBlob(o))], `photo-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' });
      if (outputs !== mine) return; // 途中で閉じた
      const url = URL.createObjectURL(file);
      mine.push({ file, url });
      const im = document.createElement('img');
      im.src = url;
      im.alt = `仕上がり ${i + 1}`;
      $('results').append(im);
    }
    $('dlgmsg').textContent = [`仕上がり ${mine.length}枚。隠し忘れがないか見てください。`, ...warn].join('\n');
    $('download').disabled = !mine.length;
    const files = mine.map(o => o.file);
    $('share').hidden = !(mine.length && navigator.canShare && navigator.canShare({ files }));
  } catch (err) {
    console.error(err);
    if (outputs === mine) $('dlgmsg').textContent = '画像を作れませんでした：' + err.message;
  }
};
function clearOutputs() {
  outputs.forEach(o => URL.revokeObjectURL(o.url));
  outputs = [];
  $('results').replaceChildren();
}
$('dlgclose').onclick = () => $('dlg').close();
$('dlg').onclose = () => { if (!$('dlg').open) clearOutputs(); };
$('share').onclick = async () => {
  try { await navigator.share({ files: outputs.map(o => o.file) }); } catch (err) {
    if (err.name !== 'AbortError') $('dlgmsg').textContent = '共有できませんでした。「ファイルに保存」を使ってください';
  }
};
$('download').onclick = async () => {
  for (const o of outputs) {
    const a = document.createElement('a');
    a.href = o.url;
    a.download = o.file.name;
    a.click();
    await new Promise(r => setTimeout(r, 300)); // 続けて保存すると取りこぼすブラウザがある
  }
};

// ---------- 入口 ----------

$('open').onclick = $('open2').onclick = () => $('file').click();
$('file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });
document.addEventListener('paste', e => { if (e.clipboardData.files.length) addFiles(e.clipboardData.files); });
window.addEventListener('beforeunload', e => { if (photos.length) e.preventDefault(); });

// Android の共有メニューから届いた写真
async function takeShared() {
  if (!new URLSearchParams(location.search).has('shared') || !window.caches) return;
  history.replaceState(null, '', './');
  const cache = await caches.open('kaokakushi-share');
  const files = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    files.push(new File([await res.blob()], 'shared', { type: res.headers.get('Content-Type') || 'image/jpeg' }));
    await cache.delete(req);
  }
  addFiles(files);
}

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
takeShared().catch(() => {});
syncUI();
