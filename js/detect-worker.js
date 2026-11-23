// 顔を探す（YuNet を onnxruntime-web で動かす）。写真はこの中だけで扱い、外へ送らない。
// 受け取る: { id, bitmap, thorough }
// 返す: { id, type: 'progress' | 'done' | 'error', done, total, faces }
/* global ort, importScripts */
const base = new URL('../vendor/', self.location.href).href;
importScripts(base + 'onnxruntime-web-1.20.1/ort.wasm.min.js');
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  mjs: base + 'onnxruntime-web-1.20.1/ort-wasm-simd-threaded.mjs',
  wasm: base + 'onnxruntime-web-1.20.1/ort-wasm-simd-threaded.wasm',
};

const N = 640;          // モデルの入力の一辺
const STEP = 480;       // 分けて探すときのずらし幅（重なり 160px）
const MIN_SCORE = 0.35;

let sessionP = null;
function getSession() {
  if (!sessionP) {
    sessionP = ort.InferenceSession.create(base + 'yunet/face_detection_yunet_2023mar.onnx', { executionProviders: ['wasm'] });
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

const canvas = new OffscreenCanvas(N, N);
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const input = new Float32Array(3 * N * N);

// 回した画像（右回り rot 度）への変換と、元へ戻す変換
function rotation(rot, W, H) {
  switch (rot) {
    case 90: return { W: H, H: W, m: [0, 1, -1, 0, H, 0], back: (x, y) => [y, H - x] };
    case 180: return { W, H, m: [-1, 0, 0, -1, W, H], back: (x, y) => [W - x, H - y] };
    case 270: return { W: H, H: W, m: [0, -1, 1, 0, 0, W], back: (x, y) => [W - y, x] };
    default: return { W, H, m: [1, 0, 0, 1, 0, 0], back: (x, y) => [x, y] };
  }
}

function origins(len) {
  if (len <= N) return [0];
  const n = Math.ceil((len - N) / STEP) + 1;
  return Array.from({ length: n }, (_, i) => Math.round((len - N) * i / (n - 1)));
}

function makePasses(W, H, thorough) {
  const L = Math.max(W, H);
  const targets = [640];
  if (L > 800) targets.push(Math.min(1280, L));
  if (L > 1600) targets.push(Math.min(2560, L));
  const rots = thorough ? [90, 180, 270] : [0];
  const passes = [];
  for (const rot of rots) {
    const R = rotation(rot, W, H);
    for (const t of (thorough ? targets.slice(0, 2) : targets)) {
      const s = Math.min(t / L, 2);
      for (const ty of origins(R.H * s)) for (const tx of origins(R.W * s)) passes.push({ R, s, tx, ty });
    }
  }
  return passes;
}

async function runPass(session, bitmap, { R, s, tx, ty }) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, N, N);
  ctx.imageSmoothingQuality = 'high';
  const m = R.m;
  ctx.setTransform(m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s - tx, m[5] * s - ty);
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, N, N).data;
  const area = N * N;
  for (let i = 0, p = 0; i < area; i++, p += 4) { // BGR
    input[i] = px[p + 2];
    input[area + i] = px[p + 1];
    input[2 * area + i] = px[p];
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, N, N]) });

  const found = [];
  const rightEdge = tx + N < R.W * s - 1;
  const bottomEdge = ty + N < R.H * s - 1;
  for (const st of [8, 16, 32]) {
    const cols = N / st;
    const cls = out['cls_' + st].data, obj = out['obj_' + st].data;
    const bb = out['bbox_' + st].data, kp = out['kps_' + st].data;
    for (let r = 0, i = 0; r < cols; r++) for (let c = 0; c < cols; c++, i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < MIN_SCORE) continue;
      const cx = (c + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st;
      const w = Math.exp(bb[i * 4 + 2]) * st, h = Math.exp(bb[i * 4 + 3]) * st;
      const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
      // 区切りの端で切れた顔は捨てる（隣の区切りか、粗い段で丸ごと見つかる）
      if ((tx > 0 && x0 < 3) || (ty > 0 && y0 < 3) || (rightEdge && x1 > N - 3) || (bottomEdge && y1 > N - 3)) continue;
      const toImg = (x, y) => R.back((x + tx) / s, (y + ty) / s);
      const [ax, ay] = toImg(x0, y0), [bx, by] = toImg(x1, y1);
      const [ex0, ey0] = toImg((kp[i * 10] + c) * st, (kp[i * 10 + 1] + r) * st);
      const [ex1, ey1] = toImg((kp[i * 10 + 2] + c) * st, (kp[i * 10 + 3] + r) * st);
      found.push({
        x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay),
        angle: Math.atan2(ey1 - ey0, ex1 - ex0), score,
      });
    }
  }
  return found;
}

const clamp01 = v => Math.min(1, Math.max(0, v));

function merge(list) {
  list.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of list) {
    const dup = keep.some(k => {
      const iw = Math.min(f.x + f.w, k.x + k.w) - Math.max(f.x, k.x);
      const ih = Math.min(f.y + f.h, k.y + k.h) - Math.max(f.y, k.y);
      if (iw <= 0 || ih <= 0) return false;
      const inter = iw * ih, a = f.w * f.h, b = k.w * k.h;
      return inter / (a + b - inter) > 0.3 || inter / Math.min(a, b) > 0.65;
    });
    if (!dup) keep.push(f);
  }
  return keep;
}

self.onmessage = async e => {
  const { id, bitmap, thorough } = e.data;
  try {
    const session = await getSession();
    const passes = makePasses(bitmap.width, bitmap.height, thorough);
    let faces = [];
    for (let i = 0; i < passes.length; i++) {
      faces = merge(faces.concat(await runPass(session, bitmap, passes[i])));
      self.postMessage({ id, type: 'progress', done: i + 1, total: passes.length });
    }
    self.postMessage({ id, type: 'done', faces });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  } finally {
    bitmap.close();
  }
};
