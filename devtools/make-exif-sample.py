# 確認用：写真に位置情報・日時・機種の Exif を付ける: python devtools/make-exif-sample.py in.jpg out.jpg
import struct, sys
src = open(sys.argv[1], "rb").read()
def ent(tag, typ, n, val): return struct.pack("<HHI", tag, typ, n) + val
pt = lambda o: struct.pack("<I", o)
# TIFF: 0 header, 8 IFD0(4件 = 2+48+4 = 54) → 62 文字列
model, date = b"TESTCAMERA\0", b"2026:01:02 03:04:05\0"
m_off, d_off = 62, 62 + len(model); gps_off = d_off + len(date)
g_data = gps_off + 2 + 12 * 4 + 4
ifd0 = struct.pack("<H", 3) + ent(0x0110, 2, len(model), pt(m_off)) + ent(0x0132, 2, len(date), pt(d_off)) + ent(0x8825, 4, 1, pt(gps_off)) + pt(0)
ifd0 = ifd0.ljust(54, b"\0")
gps = struct.pack("<H", 4) + ent(1, 2, 2, b"N\0\0\0") + ent(2, 5, 3, pt(g_data)) + ent(3, 2, 2, b"E\0\0\0") + ent(4, 5, 3, pt(g_data + 24)) + pt(0)
rat = struct.pack("<12I", 35, 1, 41, 1, 22, 1, 139, 1, 41, 1, 30, 1)
tiff = b"II*\0" + pt(8) + ifd0 + model + date + gps + rat
body = b"Exif\0\0" + tiff
open(sys.argv[2], "wb").write(src[:2] + b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body + src[2:])
