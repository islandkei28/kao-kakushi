// 確認用（アプリからは読み込まない）。ブラウザのコンソールで  await import('/devtools/test.js')  のあと
//   await T.load('gps.jpg'); await T.done(); await T.save()
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// CSP で blob: の fetch はできないので、作られた Blob を控えておく
const blobs = new Map(), make = URL.createObjectURL;
URL.createObjectURL = b => { const u = make.call(URL, b); blobs.set(u, b); return u; };
window.T = {
  blobs,
  async load(...names) {
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(new File([await (await fetch('/devtools/samples/' + n)).blob()], n, { type: 'image/jpeg' }));
    $('file').files = dt.files;
    $('file').dispatchEvent(new Event('change'));
  },
  async done() {
    const t = performance.now();
    for (;;) {
      await sleep(100);
      const s = $('status').textContent, th = $('thumbs').textContent, ms = Math.round(performance.now() - t);
      if (ms > 60000 || (ms > 500 && !/探しています|順番/.test(s) && !th.includes('…'))) return [s, th, ms + 'ms'];
    }
  },
  // 保存画面まで作り、大きさ・JPEG の中の区切り（APPn など）を返す
  async save() {
    $('save').click();
    for (let i = 0; i < 100 && $('download').disabled; i++) await sleep(50);
    const r = [];
    for (const im of document.querySelectorAll('#results img')) {
      await im.decode();
      const b = new Uint8Array(await blobs.get(im.src).arrayBuffer());
      const marks = [];
      for (let p = 2; b[p] === 0xFF && b[p + 1] !== 0xDA; p += 2 + (b[p + 2] << 8 | b[p + 3])) marks.push(b[p + 1].toString(16));
      r.push({ size: im.naturalWidth + 'x' + im.naturalHeight, bytes: b.length, marks: marks.join(' ') });
    }
    const out = { msg: $('dlgmsg').textContent, r };
    $('dlg').close();
    return out;
  },
  click: s => document.querySelector(s).click(),
  // 画面の割合（0〜1）でドラッグする
  async drag(...path) {
    const v = $('view'), b = v.getBoundingClientRect();
    v.setPointerCapture = () => {};
    const ev = (t, [x, y]) => v.dispatchEvent(new PointerEvent(t, { pointerId: 1, pointerType: 'touch', clientX: b.left + x * b.width, clientY: b.top + y * b.height, bubbles: true }));
    ev('pointerdown', path[0]);
    for (let i = 1; i < path.length; i++) for (let k = 1; k <= 5; k++) ev('pointermove', [0, 1].map(d => path[i - 1][d] + (path[i][d] - path[i - 1][d]) * k / 5));
    ev('pointerup', path[path.length - 1]);
    await sleep(60);
    return [$('status').textContent, 'undo=' + !$('undo').disabled, 'bar=' + !$('itembar').hidden];
  },
};
