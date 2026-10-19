"""把 public/icon.png（512）缩放成 PWA 需要的 192 图标。

本机没有 Pillow / ImageMagick，所以这里只用标准库实现：
PNG 解码（8bit RGBA、非隔行）→ 双线性缩放 → 重新编码。
用法：python scripts/make-icon.py [源文件] [目标尺寸]
"""

import struct
import sys
import zlib

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != PNG_SIG:
        raise SystemExit("不是 PNG 文件: " + path)
    pos = 8
    idat = b""
    w = h = bd = ct = interlace = None
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, bd, ct, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
    if bd != 8 or ct != 6 or interlace != 0:
        raise SystemExit(f"仅支持 8bit RGBA 非隔行 PNG，当前 bitDepth={bd} colorType={ct}")

    raw = zlib.decompress(idat)
    bpp = 4
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    i = 0
    for y in range(h):
        f = raw[i]
        i += 1
        line = bytearray(raw[i:i + stride])
        i += stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def resize_bilinear(w, h, src, dw, dh):
    out = bytearray(dw * dh * 4)
    for y in range(dh):
        sy = (y + 0.5) * h / dh - 0.5
        y0 = max(0, min(h - 1, int(sy)))
        y1 = min(h - 1, y0 + 1)
        fy = min(1.0, max(0.0, sy - y0))
        for x in range(dw):
            sx = (x + 0.5) * w / dw - 0.5
            x0 = max(0, min(w - 1, int(sx)))
            x1 = min(w - 1, x0 + 1)
            fx = min(1.0, max(0.0, sx - x0))
            base = (y * dw + x) * 4
            for c in range(4):
                p00 = src[(y0 * w + x0) * 4 + c]
                p10 = src[(y0 * w + x1) * 4 + c]
                p01 = src[(y1 * w + x0) * 4 + c]
                p11 = src[(y1 * w + x1) * 4 + c]
                top = p00 + (p10 - p00) * fx
                bot = p01 + (p11 - p01) * fx
                out[base + c] = int(round(top + (bot - top) * fy))
    return out


def write_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # 过滤器类型 0
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(typ, body):
        return (
            struct.pack(">I", len(body))
            + typ
            + body
            + struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = PNG_SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


if __name__ == "__main__":
    src_path = sys.argv[1] if len(sys.argv) > 1 else "public/icon.png"
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 192
    out_path = sys.argv[3] if len(sys.argv) > 3 else f"public/icon-{size}.png"
    w, h, pixels = read_png(src_path)
    write_png(out_path, size, size, resize_bilinear(w, h, pixels, size, size))
    print(f"{src_path} {w}x{h} -> {out_path} {size}x{size}")
