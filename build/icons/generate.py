#!/usr/bin/env python3
"""generate.py — render the KRT placeholder app icon.

Output: build/icons/krt-1024.png — 1024x1024 PNG, white "K" on indigo,
the design's deep-indigo accent.

This is a *placeholder* mark for v0.x — it's intentionally simple so it's
recognizable at small sizes (dock, taskbar, alt-tab thumbnails). Phase 11
swaps in a polished asset.

Run: `python3 build/icons/generate.py` from repo root.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Design accent — oklch(0.5 0.18 280) → roughly this RGB.
INDIGO = (79, 71, 197)
WHITE = (255, 255, 255)
SIZE = 1024

OUT_PATH = Path(__file__).parent / "krt-1024.png"

# Try to find a bold sans-serif system font in common macOS / Linux paths.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                pass
    # Fallback: bitmap default. Ugly at this size but doesn't crash.
    return ImageFont.load_default()


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), INDIGO)
    draw = ImageDraw.Draw(img)

    # Big bold K, centered. Pick a font size that fills ~70% of canvas height.
    font_size = int(SIZE * 0.78)
    font = load_font(font_size)

    text = "K"
    # textbbox returns (x0, y0, x1, y1). Use it to center.
    x0, y0, x1, y1 = draw.textbbox((0, 0), text, font=font)
    text_w = x1 - x0
    text_h = y1 - y0
    # Visual-center the K — text bbox accounts for the glyph's ascent/descent
    # baseline, so subtract y0 to place the glyph centered on canvas.
    x = (SIZE - text_w) / 2 - x0
    y = (SIZE - text_h) / 2 - y0
    draw.text((x, y), text, font=font, fill=WHITE)

    img.save(OUT_PATH, "PNG")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
