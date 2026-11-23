// JPEG に埋め込まれた情報を調べる・取り除く

// 元の写真にどんな情報が入っているか（位置情報・撮影日時・機種）
export async function inspect(file) {
  const none = { gps: false, date: false, model: false };
  try {
    const buf = await file.slice(0, 512 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return none;
    for (let p = 2; p + 4 < v.byteLength;) {
      const m = v.getUint16(p), len = v.getUint16(p + 2);
      if (m === 0xFFDA || (m >> 8) !== 0xFF) break;
      if (m === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) return readExif(v, p + 10);
      p += 2 + len;
    }
  } catch { /* 読めなければ「なし」として扱う。保存時にはどのみち消える */ }
  return none;
}

function readExif(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(t + o, le), u32 = o => v.getUint32(t + o, le);
  const tags = off => {
    const map = new Map();
    const n = u16(off);
    for (let i = 0; i < n; i++) map.set(u16(off + 2 + i * 12), u32(off + 2 + i * 12 + 8));
    return map;
  };
  const r = { gps: false, date: false, model: false };
  const ifd0 = tags(u32(4));
  r.model = ifd0.has(0x010F) || ifd0.has(0x0110);
  r.date = ifd0.has(0x0132);
  try { if (ifd0.has(0x8825)) r.gps = tags(ifd0.get(0x8825)).has(2); } catch { r.gps = true; }
  try { if (ifd0.has(0x8769)) r.date = r.date || tags(ifd0.get(0x8769)).has(0x9003); } catch { /* 続ける */ }
  return r;
}

// 画像に要る部分だけ残す。ブラウザが書き足した Exif なども落とす
// 残す APP: 0（JFIF）、2（色の定義 ICC）、14（色の並べ方）
export async function strip(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('JPEG ではありません');
  const parts = [b.subarray(0, 2)];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xFF) throw new Error('JPEG の形が崩れています');
    const m = b[p + 1];
    if (m === 0xDA) break;
    const end = p + 2 + (b[p + 2] << 8 | b[p + 3]);
    const isApp = m >= 0xE0 && m <= 0xEF;
    const icc = m === 0xE2 && b[p + 4] === 0x49 && b[p + 5] === 0x43 && b[p + 6] === 0x43; // "ICC"
    if (!(m === 0xFE || (isApp && m !== 0xE0 && m !== 0xEE && !icc))) parts.push(b.subarray(p, end));
    p = end;
  }
  parts.push(b.subarray(p));
  return new Blob(parts, { type: 'image/jpeg' });
}
