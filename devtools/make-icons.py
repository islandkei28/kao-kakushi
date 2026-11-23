# アイコン（モザイクのかかった顔）を作る: python devtools/make-icons.py
import pathlib, struct, zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"
BG, SKIN = (29, 31, 33), [(240, 130, 74), (226, 112, 58), (247, 160, 110), (210, 98, 48)]
CELLS = ["012301", "130212", "203021", "012130", "321012", "103201"]


def pixel(u, v):  # 0..1
    x, y = (u - 0.5) / 0.27, (v - 0.5) / 0.32
    if x * x + y * y > 1:
        return BG
    cx, cy = min(5, int((x + 1) * 3)), min(5, int((y + 1) * 3))
    return SKIN[int(CELLS[cy][cx])]


def write(name, n):
    raw = bytearray()
    for j in range(n):
        raw.append(0)
        for i in range(n):
            px = [pixel((i + a) / n, (j + b) / n) for a in (0.25, 0.75) for b in (0.25, 0.75)]
            raw += bytes(sum(c[k] for c in px) // 4 for k in range(3))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    (OUT / name).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
                             + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


for name, n in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
    write(name, n)
