"""从无头浏览器渲染出的 1024 源图，生成全部图标产物。

为什么不用 Pillow：本机没有（也不希望为一件事引一个依赖）。
这里只用标准库：PNG 解码 → 区域平均降采样（box filter，比双线性更干净）
→ 圆形裁切（4x4 超采样抗锯齿）→ PNG 重编码。

源图由 scripts/render-icons.sh 用 Edge 无头模式渲染：
  .icon-tmp/rounded.png  圆角方形（应用主图标）
  .icon-tmp/square.png   直角铺满（maskable / iOS）
  .icon-tmp/fg.png       透明背景的「考」（安卓自适应图标前景层）

用法：python scripts/make-app-icons.py
"""

import os
import struct
import zlib

SRC_ROUNDED = '.icon-tmp/rounded.png'
SRC_SQUARE = '.icon-tmp/square.png'
SRC_FG = '.icon-tmp/fg.png'

PNG_SIG = b'\x89PNG\r\n\x1a\n'


def read_png(path):
    data = open(path, 'rb').read()
    if data[:8] != PNG_SIG:
        raise SystemExit('不是 PNG: ' + path)
    pos, idat = 8, b''
    w = h = bd = ct = interlace = None
    while pos < len(data):
        (ln,) = struct.unpack('>I', data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct, _c, _f, interlace = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
    if bd != 8 or ct not in (2, 6) or interlace != 0:
        raise SystemExit(f'仅支持 8bit RGB/RGBA 非隔行：{path} bd={bd} ct={ct}')

    bpp = 4 if ct == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * bpp
    tmp = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        tmp[y * stride:(y + 1) * stride] = line
        prev = line

    if bpp == 4:
        return w, h, tmp
    out = bytearray(w * h * 4)
    for i in range(w * h):
        out[i * 4:i * 4 + 3] = tmp[i * 3:i * 3 + 3]
        out[i * 4 + 3] = 255
    return w, h, out


def write_png(path, w, h, pixels):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]
    comp = zlib.compress(bytes(raw), 9)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)

    png = PNG_SIG + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', comp) + chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(png)


def downscale(src_w, src_h, src, size):
    """区域平均。按 alpha 预乘后平均，避免透明边缘发黑。"""
    out = bytearray(size * size * 4)
    fx, fy = src_w / size, src_h / size
    for oy in range(size):
        y0, y1 = int(oy * fy), max(int(oy * fy) + 1, int((oy + 1) * fy))
        for ox in range(size):
            x0, x1 = int(ox * fx), max(int(ox * fx) + 1, int((ox + 1) * fx))
            r = g = b = a = n = 0
            for sy in range(y0, y1):
                base = sy * src_w * 4
                for sx in range(x0, x1):
                    i = base + sx * 4
                    al = src[i + 3]
                    r += src[i] * al
                    g += src[i + 1] * al
                    b += src[i + 2] * al
                    a += al
                    n += 1
            j = (oy * size + ox) * 4
            if a:
                out[j] = r // a
                out[j + 1] = g // a
                out[j + 2] = b // a
            out[j + 3] = a // n
    return out


def circle_mask(pixels, size):
    """圆形裁切，4x4 超采样求覆盖率，边缘平滑。"""
    cx = cy = size / 2.0
    rad = size / 2.0 - 0.5
    out = bytearray(pixels)
    for y in range(size):
        for x in range(size):
            cov = 0
            for sy in range(4):
                for sx in range(4):
                    px = x + (sx + 0.5) / 4
                    py = y + (sy + 0.5) / 4
                    if (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad:
                        cov += 1
            if cov < 16:
                i = (y * size + x) * 4
                out[i + 3] = out[i + 3] * cov // 16
    return out


def main():
    rw, rh, rounded = read_png(SRC_ROUNDED)
    sw, sh, square = read_png(SRC_SQUARE)
    fw, fh, fg = read_png(SRC_FG)

    jobs = [
        # (源, 宽, 高, 数据, 输出, 尺寸, 是否圆形)
        (rw, rh, rounded, 'public/icon.png', 512, False),
        (rw, rh, rounded, 'public/icon-192.png', 192, False),
        (rw, rh, rounded, 'public/favicon-32.png', 32, False),
        (sw, sh, square, 'public/apple-touch-icon.png', 180, False),
        (sw, sh, square, 'public/icon-maskable-512.png', 512, False),
        # 安卓旧版启动图标（API < 26）
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-mdpi/ic_launcher.png', 48, False),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-hdpi/ic_launcher.png', 72, False),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-xhdpi/ic_launcher.png', 96, False),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', 144, False),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 192, False),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png', 48, True),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png', 72, True),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png', 96, True),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png', 144, True),
        (rw, rh, rounded, 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png', 192, True),
        # 安卓自适应图标前景层（108dp，含安全区留白）
        (fw, fh, fg, 'android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png', 108, False),
        (fw, fh, fg, 'android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png', 162, False),
        (fw, fh, fg, 'android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png', 216, False),
        (fw, fh, fg, 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png', 324, False),
        (fw, fh, fg, 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', 432, False),
    ]

    cache = {}
    for w, h, data, path, size, is_round in jobs:
        key = (id(data), size)
        px = cache.get(key)
        if px is None:
            px = downscale(w, h, data, size)
            cache[key] = px
        if is_round:
            px = circle_mask(px, size)
        write_png(path, size, size, px)
        print(f'{path}  {size}x{size}')


if __name__ == '__main__':
    main()
