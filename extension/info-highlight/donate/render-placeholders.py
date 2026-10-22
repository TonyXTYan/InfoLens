#!/usr/bin/env python3
"""Donate QR assets live in this folder as alipay.png and wechat.png.

Replace those two files in place to change the codes shown in the extension.
Keep the same filenames (PNG, Git LFS via *.png) so options.js / pack paths
do not need to change. Store the QR card only (not the full poster); the
dialog shows them at a modest size with the original aspect ratio.

This script only generates square placeholders for local layout. It will not
overwrite existing files unless you pass --placeholders.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 480
MARGIN = 28
MODULE = 10
CAPTION_H = 92

CHANNELS = (
    {
        "file": "alipay.png",
        "en": "Alipay",
        "zh": "支付宝",
        "accent": (22, 119, 255),
        "seed": 0xA11A4,
    },
    {
        "file": "wechat.png",
        "en": "WeChat Pay",
        "zh": "微信支付",
        "accent": (7, 193, 96),
        "seed": 0xC0DE,
    },
)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def bit(seed: int, x: int, y: int) -> bool:
    n = (seed ^ (x * 374761) ^ (y * 668265263)) & 0xFFFFFFFF
    n = (n ^ (n >> 16)) * 0x7FEB352D & 0xFFFFFFFF
    n = (n ^ (n >> 15)) * 0x846CA68B & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xF) > 6


def finder(draw: ImageDraw.ImageDraw, origin: tuple[int, int], modules: int, cell: int) -> None:
    x0, y0 = origin
    outer = modules * cell
    draw.rectangle((x0, y0, x0 + outer - 1, y0 + outer - 1), fill=(20, 20, 20))
    draw.rectangle(
        (x0 + cell, y0 + cell, x0 + outer - cell - 1, y0 + outer - cell - 1),
        fill=(255, 255, 255),
    )
    draw.rectangle(
        (x0 + 2 * cell, y0 + 2 * cell, x0 + outer - 2 * cell - 1, y0 + outer - 2 * cell - 1),
        fill=(20, 20, 20),
    )


def draw_qr(draw: ImageDraw.ImageDraw, seed: int, accent: tuple[int, int, int]) -> None:
    top = MARGIN
    area = SIZE - 2 * MARGIN - CAPTION_H
    cols = area // MODULE
    grid = cols * MODULE
    x0 = (SIZE - grid) // 2
    y0 = top + (area - grid) // 2
    draw.rounded_rectangle(
        (x0 - 8, y0 - 8, x0 + grid + 7, y0 + grid + 7),
        radius=12,
        fill=(255, 255, 255),
        outline=(210, 214, 220),
        width=2,
    )
    finder_n = 7
    for y in range(cols):
        for x in range(cols):
            in_finder = (
                (x < finder_n and y < finder_n)
                or (x >= cols - finder_n and y < finder_n)
                or (x < finder_n and y >= cols - finder_n)
            )
            if in_finder:
                continue
            if bit(seed, x, y):
                px = x0 + x * MODULE
                py = y0 + y * MODULE
                draw.rectangle((px, py, px + MODULE - 2, py + MODULE - 2), fill=(32, 32, 32))
    finder(draw, (x0, y0), finder_n, MODULE)
    finder(draw, (x0 + (cols - finder_n) * MODULE, y0), finder_n, MODULE)
    finder(draw, (x0, y0 + (cols - finder_n) * MODULE), finder_n, MODULE)
    logo = 56
    cx = x0 + grid // 2
    cy = y0 + grid // 2
    draw.rounded_rectangle(
        (cx - logo, cy - logo, cx + logo, cy + logo),
        radius=14,
        fill=accent,
    )


def centered(draw: ImageDraw.ImageDraw, text: str, y: int, fnt: ImageFont.ImageFont, fill: tuple[int, int, int]) -> None:
    box = draw.textbbox((0, 0), text, font=fnt)
    x = (SIZE - (box[2] - box[0])) // 2
    draw.text((x, y), text, font=fnt, fill=fill)


def render(channel: dict) -> Image.Image:
    img = Image.new("RGB", (SIZE, SIZE), (248, 249, 250))
    draw = ImageDraw.Draw(img)
    draw_qr(draw, channel["seed"], channel["accent"])
    title_y = SIZE - CAPTION_H + 8
    centered(draw, "占位 / placeholder", title_y, font(28), (80, 80, 80))
    centered(
        draw,
        f"{channel['zh']} / {channel['en']}",
        title_y + 38,
        font(22),
        channel["accent"],
    )
    return img


def main() -> None:
    out = Path(__file__).resolve().parent
    if "--placeholders" not in sys.argv:
        print(
            "Donate QR files: alipay.png, wechat.png.\n"
            "Replace those filenames in place (PNG, Git LFS). "
            "Do not change options.js paths.\n"
            "Pass --placeholders only to write square layout stubs."
        )
        return
    for channel in CHANNELS:
        path = out / channel["file"]
        render(channel).save(path, format="PNG", optimize=True)
        print(f"wrote {path.name} {SIZE}x{SIZE}")


if __name__ == "__main__":
    main()
