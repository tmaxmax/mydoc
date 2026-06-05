from io import BytesIO
from pathlib import Path
import subprocess
import os
import json
import re

import uharfbuzz as hb
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen

LATIN_BASE = list(range(0x41, 0x5B)) + list(range(0x61, 0x7B))  # A-Z + a-z
LATIN_EXTRA = [0x03C0, 0x03BC]  # π, μ
MATH_CHARS = LATIN_BASE + LATIN_EXTRA

DIGITS = list(range(0x30, 0x3A))  # 0-9
PRIMES = [0x0027, 0x2032]
MAIN_CHARS = DIGITS + PRIMES


def hb_font_from_ttfont(font: TTFont) -> hb.Font:
    buf = BytesIO()
    font.save(buf)
    face = hb.Face(buf.getvalue())
    return hb.Font(face)


def instantiate_font(
    font: TTFont,
    weight: int,
    feature_codepoints: list[int] | None = None,
    feature_tags: dict[str, int] | None = None,
) -> TTFont:
    instantiateVariableFont(font, {"wght": weight}, inplace=True)

    if feature_codepoints and feature_tags:
        hb_font = hb_font_from_ttfont(font)
        cp_to_glyph = {}

        for cp in feature_codepoints:
            b = hb.Buffer()
            b.add_str(chr(cp))
            b.guess_segment_properties()
            hb.shape(hb_font, b, feature_tags)
            gid = b.glyph_infos[0].codepoint
            cp_to_glyph[cp] = font.getGlyphName(gid)

        for sub in font["cmap"].tables:
            if sub.isUnicode():
                for cp, gname in cp_to_glyph.items():
                    sub.cmap[cp] = gname


def bounds(glyph_set, glyph_name):
    p = BoundsPen(glyph_set)
    glyph_set[glyph_name].draw(p)
    return p.bounds  # (xMin, yMin, xMax, yMax)


def replace_glyph_and_hmtx(
    base: TTFont,
    src: TTFont,
    base_gname: str,
    src_gname: str,
    scale: float,
) -> None:
    base_gs = base.getGlyphSet()
    src_gs = src.getGlyphSet()

    # Source metrics
    src_adv, src_lsb = src["hmtx"][src_gname]
    new_adv = int(round(src_adv * scale))
    new_lsb = int(round(src_lsb * scale))

    # Shift outline so xMin == new_lsb (keeps metrics/outlines consistent)
    sx0, _, _, _ = bounds(src_gs, src_gname)
    tx = new_lsb - sx0 * scale
    ty = 0.0  # baseline-preserving full replacement

    pen = TTGlyphPen(base_gs)
    tpen = TransformPen(pen, (scale, 0, 0, scale, tx, ty))
    src_gs[src_gname].draw(tpen)

    base["glyf"][base_gname] = pen.glyph()
    base["hmtx"][base_gname] = (new_adv, new_lsb)


def patch_math_latin(base: TTFont, src: TTFont) -> None:
    base_cmap = base.getBestCmap()
    src_cmap = src.getBestCmap()
    base_gs = base.getGlyphSet()
    src_gs = src.getGlyphSet()

    # Global scale from x-height (full replacement, no bbox fitting)
    bx0, by0, bx1, by1 = bounds(base_gs, base_cmap[ord("x")])
    sx0, sy0, sx1, sy1 = bounds(src_gs, src_cmap[ord("x")])
    base_xh = by1 - by0
    src_xh = sy1 - sy0
    scale = (base_xh / src_xh) if src_xh else 1.0

    for cp in MATH_CHARS:
        if cp not in base_cmap or cp not in src_cmap:
            continue
        replace_glyph_and_hmtx(base, src, base_cmap[cp], src_cmap[cp], scale)


def patch_main_digits_primes(base: TTFont, src: TTFont) -> None:
    base_cmap = base.getBestCmap()
    src_cmap = src.getBestCmap()
    base_gs = base.getGlyphSet()
    src_gs = src.getGlyphSet()

    bx0, by0, bx1, by1 = bounds(base_gs, base_cmap[ord("0")])
    sx0, sy0, sx1, sy1 = bounds(src_gs, src_cmap[ord("0")])
    base_h = by1 - by0
    src_h = sy1 - sy0
    scale = (base_h / src_h) if src_h else 1.0

    for cp in MAIN_CHARS:
        if cp not in base_cmap or cp not in src_cmap:
            continue
        replace_glyph_and_hmtx(base, src, base_cmap[cp], src_cmap[cp], scale)


def ots_sanitize_file(input_path: Path) -> None:
    proc = subprocess.run(
        ["ots-sanitize", str(input_path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"OTS sanitize failed for {input_path}:\n{proc.stderr}")


def save_font_in_place(font: TTFont, path: str) -> None:
    p = Path(path)
    font.flavor = "woff2"  # always write WOFF2

    tmp = p.with_suffix(".tmp.woff2")
    font.save(str(tmp))
    ots_sanitize_file(tmp)
    os.replace(tmp, p)  # atomic replace


def _glyph_bounds(font: TTFont, gname: str) -> tuple[float, float, float, float]:
    gs = font.getGlyphSet()
    pen = BoundsPen(gs)
    gs[gname].draw(pen)
    if pen.bounds is None:
        return 0.0, 0.0, 0.0, 0.0
    return pen.bounds  # xMin, yMin, xMax, yMax


def _clean(v: float, ndigits: int = 5) -> float:
    x = round(float(v), ndigits)
    return 0.0 if x == -0.0 else x


def update_metrics(
    metrics_map: dict[str, dict[str, list[float]]],
    font: TTFont,
    font_name: str,
    codepoints: list[int],
) -> None:
    """
    Mutates metrics_map in place for metrics_map[font_name][str(cp)].

    Tuple format: [depth, height, italic, skew, width]
    - depth/height/width are recomputed from font outlines + hmtx
    - italic/skew are preserved from existing metrics if present, else 0
    """
    cmap = font.getBestCmap() or {}
    upem = font["head"].unitsPerEm
    hmtx = font["hmtx"]

    if font_name not in metrics_map:
        metrics_map[font_name] = {}

    out = metrics_map[font_name]

    for cp in codepoints:
        if cp not in cmap:
            continue

        gname = cmap[cp]
        adv, _lsb = hmtx[gname]
        _x0, y0, _x1, y1 = _glyph_bounds(font, gname)

        depth = max(0.0, -y0 / upem)
        height = max(0.0, y1 / upem)
        width = adv / upem

        key = str(cp)
        old = out.get(key, [0.0, 0.0, 0.0, 0.0, 0.0])
        italic = old[2] 
        skew = old[3]

        out[key] = [_clean(depth), _clean(height), _clean(italic), _clean(skew), _clean(width)]


def read_metrics(path: Path) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    text = re.sub(r"^\s*export\s+default\s+", "", text, count=1)
    text = re.sub(r";\s*$", "", text)

    return json.loads(text)


def write_metrics(metrics_map: dict, p: Path) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(metrics_map, ensure_ascii=False, indent=2, sort_keys=True)
    p.write_text(f"export default {payload};\n", encoding="utf-8")


def main():
    static_dir = Path("static")
    katex_dir = Path("vendor") / "katex@0.17.0" / "dist"
    fonts_dir = katex_dir / "fonts"

    cormorant_roman_path =  static_dir / "cormorant-garamond.ttf"
    cormorant_italic_path = static_dir / "cormorant-garamond-italic.ttf"
    katex_math_base_path = fonts_dir / "KaTeX_Math-Italic.woff2"
    katex_main_base_path = fonts_dir / "KaTeX_Main-Regular.woff2"
    metrics_path = katex_dir / "fontMetricsData.json"

    cormorant_roman = TTFont(cormorant_roman_path)
    cormorant_italic = TTFont(cormorant_italic_path)
    katex_math = TTFont(katex_math_base_path)
    katex_main = TTFont(katex_main_base_path)
    metrics = read_metrics(metrics_path)

    instantiate_font(
        cormorant_italic,
        weight=600,
        feature_codepoints=MATH_CHARS,
        feature_tags={"ss03": 1, "calt": 1, "kern": 1},
    )

    instantiate_font(
        cormorant_roman,
        weight=600,
        feature_codepoints=DIGITS,
        feature_tags={"lnum": 1, "calt": 1, "kern": 1},
    )

    patch_math_latin(katex_math, cormorant_italic)
    patch_main_digits_primes(katex_main, cormorant_roman)

    save_font_in_place(katex_math, katex_main_base_path)
    save_font_in_place(katex_main, katex_math_base_path)

    update_metrics(metrics, katex_math, 'Math-Italic', MATH_CHARS)
    update_metrics(metrics, katex_main, 'Main-Regular', MAIN_CHARS)
    write_metrics(metrics, metrics_path)


if __name__ == "__main__":
    main()