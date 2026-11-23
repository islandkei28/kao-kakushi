// オフラインでも開けるようにアプリ本体を保存する。Android の共有メニューから届いた写真も受け取る。
// 写真そのものは保存しない（共有で届いたものは、開いたらすぐ消す）。
const APP = 'kaokakushi-app-v1';
const VENDOR = 'kaokakushi-vendor-onnx1.20.1-yunet2023mar'; // 大きいので本体と分けて、中身を替えたときだけ取り直す
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/render.js', 'js/jpeg.js', 'js/detect-worker.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const BIG = [
  'vendor/onnxruntime-web-1.20.1/ort.wasm.min.js',
  'vendor/onnxruntime-web-1.20.1/ort-wasm-simd-threaded.mjs',
  'vendor/onnxruntime-web-1.20.1/ort-wasm-simd-threaded.wasm',
  'vendor/yunet/face_detection_yunet_2023mar.onnx',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    await (await caches.open(APP)).addAll(SHELL);
    const v = await caches.open(VENDOR);
    for (const u of BIG) if (!await v.match(u)) await v.add(u);
    await self.skipWaiting();
  })());
});

// 同じ場所（github.io など）に置いた別のアプリの保存は消さない
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => /^kaokakushi-(app|vendor)-/.test(k) && ![APP, VENDOR].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) e.respondWith(receiveShare(e.request));
  else if (e.request.method === 'GET') e.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(e.request) : networkFirst(e.request));
});

async function receiveShare(req) {
  const form = await req.formData();
  const cache = await caches.open('kaokakushi-share');
  let i = 0;
  for (const f of form.getAll('file')) {
    if (typeof f !== 'string') await cache.put(`shared-${Date.now()}-${i++}`, new Response(f, { headers: { 'Content-Type': f.type } }));
  }
  return Response.redirect('./?shared=1', 303);
}

async function cacheFirst(req) {
  return await (await caches.open(VENDOR)).match(req) || fetch(req);
}

async function networkFirst(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
