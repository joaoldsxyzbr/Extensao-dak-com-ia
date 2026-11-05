"""Gera os icones da extensao (PNG) sem dependencias externas.

Desenho: lua crescente ambar sobre fundo azul-escuro em gradiente,
com um motivo de rede neural (nos conectados) nos tamanhos maiores.
Renderiza com supersampling (SS por pixel final) e reduz por media,
garantindo bordas suaves.
"""
import math
import os
import struct
import zlib

SIZES = [16, 32, 48, 128]
SS = 4  # subamostras por pixel final em cada eixo
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# paleta
BG_TOP = (35, 40, 56)       # #232838
BG_BOTTOM = (14, 16, 25)    # #0e1019
MOON_TOP = (255, 232, 120)  # ambar claro
MOON_BOTTOM = (255, 179, 91)  # ambar quente
NODE = (110, 160, 255)      # azul IA
NODE_CORE = (225, 235, 255)
LINK = (100, 145, 240, 180)  # rgba


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(len(a)))


def in_circle(x, y, cx, cy, r):
    return math.hypot(x - cx, y - cy) <= r


def seg_dist(px, py, x1, y1, x2, y2):
    vx, vy = x2 - x1, y2 - y1
    wx, wy = px - x1, py - y1
    vv = vx * vx + vy * vy
    t = 0.0 if vv == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / vv))
    return math.hypot(px - (x1 + vx * t), py - (y1 + vy * t))


def normalized_color(x, y, show_net):
    """x, y em 0..1 (cosseno do pixel em coordenadas normalizadas). Retorna RGBA."""
    # fundo: circulo com gradiente vertical
    if not in_circle(x, y, 0.5, 0.5, 0.495):
        return (0, 0, 0, 0)
    base = lerp(BG_TOP, BG_BOTTOM, y)

    # leve brilho radial interno (canto superior esquerdo)
    d = math.hypot(x - 0.32, y - 0.28)
    if d < 0.45:
        base = lerp(tuple(int(c * 1.25) for c in base), base, d / 0.45)

    # lua crescente: circulo cheio menos circulo de corte
    moon = in_circle(x, y, 0.44, 0.40, 0.275) and not in_circle(x, y, 0.585, 0.315, 0.245)
    if moon:
        # gradiente na cor da lua
        t = max(0.0, min(1.0, (y - 0.15) / 0.5))
        c1, c2 = MOON_TOP, MOON_BOTTOM
        # brilho suave perto da borda interna
        edge = 1.0 - (seg_dist(x, y, 0.44, 0.40, 0.585, 0.315) / 0.05)
        col = lerp(c1, c2, t)
        if edge > 0:
            col = lerp(col, tuple(min(255, int(c * 1.15)) for c in col), max(0.0, min(1.0, edge)) * 0.0)
        return (*col, 255)

    # motivo de rede neural (apenas em icones grandes)
    if show_net:
        eps = 0.014
        nodes = [(0.60, 0.68), (0.74, 0.60), (0.68, 0.82), (0.84, 0.74)]
        links = [(nodes[0], nodes[1]), (nodes[0], nodes[2]), (nodes[1], nodes[3]), (nodes[2], nodes[3])]
        for a, b in links:
            if seg_dist(x, y, a[0], a[1], b[0], b[1]) <= eps:
                return (*lerp(base, LINK[:3], 0.75), 255)
        for nx, ny in nodes:
            if in_circle(x, y, nx, ny, 0.030):
                # nucleo claro com borda azul
                if in_circle(x, y, nx, ny, 0.017):
                    return (*NODE_CORE, 255)
                return (*NODE, 255)

    return (*base, 255)


def render(size):
    show_net = size >= 48
    w = h = size
    px = [[(0, 0, 0, 0) for _ in range(w)] for _ in range(h)]
    for fy in range(h):
        for fx in range(w):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (fx + (sx + 0.5) / SS) / w
                    y = (fy + (sy + 0.5) / SS) / h
                    c = normalized_color(x, y, show_net)
                    r += c[0]; g += c[1]; b += c[2]; a += c[3]
            n = SS * SS
            px[fy][fx] = (int(r / n + 0.5), int(g / n + 0.5), int(b / n + 0.5), int(a / n + 0.5))
    return px


def chunk(tag, data):
    return (
        struct.pack(">I", len(data)) + tag + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def save_png(path, px):
    h = len(px)
    w = len(px[0])
    raw = b"".join(
        b"\x00" + bytes(v for pixel in row for v in pixel) for row in px
    )
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        save_png(path, render(size))
        print(f"ok: icon{size}.png")


if __name__ == "__main__":
    main()
