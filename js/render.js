// 隠す処理を描く。画面の表示と保存で同じ関数を使う。

// 強さ 1〜5 → 短い辺を何マスに分けるか（少ないほど強い）
const CELLS = [10, 8, 6, 5, 4];

export const stampImages = new Map(); // id → ImageBitmap（自分の画像のスタンプ）

// 隠す範囲（中心と大きさ）
export function bounds(it) {
  if (it.kind === 'stroke') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of it.pts) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const r = it.size / 2;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + r * 2, h: y1 - y0 + r * 2 };
  }
  const p = it.kind === 'face' ? it.style.pad : 1;
  return { cx: it.cx, cy: it.cy, w: it.w * p, h: it.h * p };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// 範囲をマス目に分けて平均の色を出す。元の細かい模様は、この平均にしか残らない
function averageGrid(src, x, y, w, h, cols, rows) {
  const k = Math.max(2, Math.min(8, Math.floor(512 / Math.max(cols, rows))));
  const c = makeCanvas(cols * k, rows * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const grid = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
      const p = ((r * k + j) * c.width + q * k + i) * 4, a = d[p + 3];
      R += d[p] * a; G += d[p + 1] * a; B += d[p + 2] * a; A += a;
    }
    const o = (r * cols + q) * 3;
    if (A) { grid[o] = R / A; grid[o + 1] = G / A; grid[o + 2] = B / A; }
    else grid[o] = grid[o + 1] = grid[o + 2] = 128; // 写真の外
  }
  return grid;
}

function mosaicPatch(grid, cols, rows) {
  const c = makeCanvas(cols, rows), g = c.getContext('2d');
  const im = g.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    im.data[i * 4] = grid[i * 3]; im.data[i * 4 + 1] = grid[i * 3 + 1]; im.data[i * 4 + 2] = grid[i * 3 + 2]; im.data[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

// マス目をなめらかにつなぐ（3次Bスプライン）。モザイクと同じ情報量しか残らない
function blurPatch(grid, cols, rows) {
  const k = Math.max(2, Math.min(16, Math.floor(512 / Math.max(cols, rows))));
  const W = cols * k, H = rows * k;
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const im = g.createImageData(W, H);
  const weights = n => Array.from({ length: n * k }, (_, i) => {
    const u = (i + 0.5) / k - 0.5, b = Math.floor(u), t = u - b;
    return {
      idx: [-1, 0, 1, 2].map(o => Math.min(n - 1, Math.max(0, b + o))),
      w: [(1 - t) ** 3 / 6, (3 * t ** 3 - 6 * t * t + 4) / 6, (-3 * t ** 3 + 3 * t * t + 3 * t + 1) / 6, t ** 3 / 6],
    };
  });
  const wx = weights(cols), wy = weights(rows);
  for (let y = 0, p = 0; y < H; y++) for (let x = 0; x < W; x++, p += 4) {
    let R = 0, G = 0, B = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const w = wy[y].w[j] * wx[x].w[i], o = (wy[y].idx[j] * cols + wx[x].idx[i]) * 3;
      R += grid[o] * w; G += grid[o + 1] * w; B += grid[o + 2] * w;
    }
    im.data[p] = R; im.data[p + 1] = G; im.data[p + 2] = B; im.data[p + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

const cache = new WeakMap(); // src canvas → Map(item id → {key, patch})

function getPatch(src, it, mode) {
  const b = bounds(it);
  const unit = it.kind === 'stroke' ? it.size : Math.min(b.w, b.h);
  // なぞった線は細いので、1本の太さを顔よりずっと少ないマスで分ける
  let cell = unit / (it.kind === 'stroke' ? CELLS[it.style.strength - 1] / 4 : CELLS[it.style.strength - 1]);
  cell = Math.max(cell, Math.max(b.w, b.h) / 200, 1);
  const cols = Math.max(1, Math.ceil(b.w / cell - 1e-6)), rows = Math.max(1, Math.ceil(b.h / cell - 1e-6));
  const w = cols * cell, h = rows * cell, x = b.cx - w / 2, y = b.cy - h / 2;
  let m = cache.get(src);
  if (!m) cache.set(src, m = new Map());
  const key = [mode, x, y, w, h, cols].join();
  let e = m.get(it.id);
  if (!e || e.key !== key) {
    const grid = averageGrid(src, x, y, w, h, cols, rows);
    e = { key, patch: mode === 'blur' ? blurPatch(grid, cols, rows) : mosaicPatch(grid, cols, rows) };
    m.set(it.id, e);
  }
  return { patch: e.patch, x, y, w, h };
}

function shapePath(g, it, b) {
  g.beginPath();
  if (it.style.shape === 'rect') g.rect(b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h);
  else g.ellipse(b.cx, b.cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
}

function strokePath(g, it) {
  g.lineCap = g.lineJoin = 'round';
  g.lineWidth = it.size;
  g.beginPath();
  it.pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  if (it.pts.length === 1) g.lineTo(it.pts[0][0] + 0.01, it.pts[0][1]);
}

function drawStroke(g, src, it) {
  const mode = it.style.mode === 'stamp' ? 'mosaic' : it.style.mode;
  g.save();
  if (mode === 'fill') {
    g.strokeStyle = it.style.color;
    strokePath(g, it);
    g.stroke();
  } else {
    // 線の形に抜いたモザイクを別の紙に作ってから重ねる（元の画素は混ぜない）
    const p = getPatch(src, it, mode);
    const k = Math.min(1, 2048 / Math.max(p.w, p.h));
    const c = makeCanvas(Math.max(1, Math.ceil(p.w * k)), Math.max(1, Math.ceil(p.h * k)));
    const h = c.getContext('2d');
    h.imageSmoothingEnabled = mode === 'blur';
    h.drawImage(p.patch, 0, 0, p.w * k, p.h * k);
    h.globalCompositeOperation = 'destination-in';
    h.setTransform(k, 0, 0, k, -p.x * k, -p.y * k);
    strokePath(h, it);
    h.stroke();
    g.drawImage(c, p.x, p.y, c.width / k, c.height / k);
  }
  g.restore();
}

function drawRegion(g, src, it) {
  const b = bounds(it), st = it.style;
  const under = st.mode === 'stamp' ? (st.under ? 'blur' : null) : st.mode;
  if (under) {
    g.save();
    shapePath(g, it, b);
    if (under === 'fill') {
      g.fillStyle = st.color;
      g.fill();
    } else {
      g.clip();
      const p = getPatch(src, it, under);
      g.imageSmoothingEnabled = under === 'blur';
      g.imageSmoothingQuality = 'high';
      g.drawImage(p.patch, p.x, p.y, p.w, p.h);
    }
    g.restore();
  }
  if (st.mode === 'stamp') {
    g.save();
    g.translate(b.cx, b.cy);
    g.rotate(it.angle || 0);
    const size = Math.max(b.w, b.h) * 1.08;
    const img = st.stamp.startsWith('img:') ? stampImages.get(st.stamp) : null;
    if (img) {
      const k = size / Math.min(img.width, img.height);
      g.drawImage(img, -img.width * k / 2, -img.height * k / 2, img.width * k, img.height * k);
    } else {
      // 文字として描くので、実際に描かれる大きさを測って合わせる
      g.font = '200px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
      g.fillStyle = '#000';
      const m = g.measureText(st.stamp);
      const mw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight || 200;
      const mh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 200;
      const k = size / Math.max(mw, mh);
      g.scale(k, k);
      g.fillText(st.stamp, (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2, (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
    }
    g.restore();
  }
}

// g は写真の座標に合わせた状態で渡す
export function drawItems(g, src, items) {
  for (const it of items) {
    if (!it.on) continue;
    if (it.kind === 'stroke') drawStroke(g, src, it);
    else drawRegion(g, src, it);
  }
}

// 保存する画像を作る
export function renderOutput(src, items, crop, limit) {
  let x = 0, y = 0, w = src.width, h = src.height;
  if (crop.ratio !== 'orig') {
    if (crop.pad) {
      const r = crop.value;
      w = Math.max(src.width, src.height * r); h = w / r;
      x = (src.width - w) / 2; y = (src.height - h) / 2;
    } else ({ x, y, w, h } = crop);
  }
  let outW = limit ? Math.min(limit, w) : w;
  outW = Math.min(outW, 4096, 4096 * w / h);
  const c = makeCanvas(Math.max(1, Math.round(outW)), Math.max(1, Math.round(outW * h / w)));
  const g = c.getContext('2d');
  g.fillStyle = crop.pad && crop.ratio !== 'orig' ? crop.bg : '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const kx = c.width / w, ky = c.height / h;
  g.setTransform(kx, 0, 0, ky, -x * kx, -y * ky);
  g.imageSmoothingQuality = 'high';
  g.beginPath();
  g.rect(0, 0, src.width, src.height); // 余白にはみ出した分は描かない
  g.clip();
  g.drawImage(src, 0, 0);
  drawItems(g, src, items);
  return c;
}
