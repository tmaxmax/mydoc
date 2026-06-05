from io import BytesIO
from pathlib import Path
import subprocess
import tempfile

import uharfbuzz as hb
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen

# ---------- Codepoint sets ----------
LATIN_BASE = list(range(0x41, 0x5B)) + list(range(0x61, 0x7B))  # A-Z + a-z
LATIN_EXTRA = [0x03C0, 0x03BC]  # π, μ
MATH_CHARS = LATIN_BASE + LATIN_EXTRA

DIGITS = list(range(0x30, 0x3A))  # 0-9
PRIMES = [0x0027, 0x2032]
MAIN_CHARS = DIGITS + PRIMES


# ---------- Generic font helpers ----------
def clone_font(font: TTFont) -> TTFont:
    buf = BytesIO()
    font.save(buf)
    buf.seek(0)
    return TTFont(buf)


def hb_font_from_ttfont(font: TTFont) -> hb.Font:
    buf = BytesIO()
    font.save(buf)
    face = hb.Face(buf.getvalue())
    return hb.Font(face)


# ---------- Instantiation + feature baking ----------
def instantiate_font(
    src_font: TTFont,
    weight: int,
    feature_codepoints: list[int] | None = None,
    feature_tags: dict[str, int] | None = None,
) -> TTFont:
    inst = instantiateVariableFont(src_font, {"wght": weight}, inplace=False)

    if feature_codepoints and feature_tags:
        hb_font = hb_font_from_ttfont(inst)
        cp_to_glyph = {}

        for cp in feature_codepoints:
            b = hb.Buffer()
            b.add_str(chr(cp))
            b.guess_segment_properties()
            hb.shape(hb_font, b, feature_tags)
            gid = b.glyph_infos[0].codepoint
            cp_to_glyph[cp] = inst.getGlyphName(gid)

        for sub in inst["cmap"].tables:
            if sub.isUnicode():
                for cp, gname in cp_to_glyph.items():
                    sub.cmap[cp] = gname

    return inst


# ---------- Geometry ----------
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


def patch_math_latin(base_font: TTFont, src_font: TTFont) -> TTFont:
    base = clone_font(base_font)
    src = src_font

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

    return base


def patch_main_digits_primes(base_font: TTFont, src_font: TTFont) -> TTFont:
    base = clone_font(base_font)
    src = src_font

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

    return base


def ots_sanitize_file(input_path: Path, output_path: Path) -> None:
    proc = subprocess.run(
        ["ots-sanitize", str(input_path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"OTS sanitize failed for {input_path}:\n{proc.stderr}")
    output_path.write_bytes(input_path.read_bytes())


def subset_to_woff2(font: TTFont, unicodes: list[int], output_path: Path) -> None:
    out_font = clone_font(font)  # subset mutates font in place

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]

    s = subset.Subsetter(options=opts)
    s.populate(unicodes=unicodes)
    s.subset(out_font)

    with tempfile.TemporaryDirectory() as td:
        tmp_out = Path(td) / "subset.woff2"
        subset.save_font(out_font, str(tmp_out), opts)
        ots_sanitize_file(tmp_out, output_path)

    subset.save_font(out_font, str(output_path), opts)


def main():
    static_dir = Path("static")
    fonts_dir = static_dir / "fonts"

    cormorant_roman_path =  static_dir / "cormorant-garamond.ttf"
    cormorant_italic_path = static_dir / "cormorant-garamond-italic.ttf"
    katex_math_base_path = fonts_dir / "KaTeX_Math-Italic.woff2"
    katex_main_base_path = fonts_dir / "KaTeX_Main-Regular.woff2"

    out_math_woff2 = static_dir / "KaTeX_Math-Latin.woff2"
    out_main_woff2 = static_dir / "KaTeX_Main-DigitsPrime.woff2"

    # Load source/base fonts (only main does file I/O)
    cormorant_roman_src = TTFont(cormorant_roman_path)
    cormorant_italic_src = TTFont(cormorant_italic_path)
    katex_math_base = TTFont(katex_math_base_path)
    katex_main_base = TTFont(katex_main_base_path)

    # Instantiate + bake feature selections into cmap
    cormorant_italic_600 = instantiate_font(
        cormorant_italic_src,
        weight=600,
        feature_codepoints=MATH_CHARS,
        feature_tags={"ss03": 1, "calt": 1, "kern": 1},
    )

    cormorant_roman_600 = instantiate_font(
        cormorant_roman_src,
        weight=600,
        feature_codepoints=DIGITS,
        feature_tags={"lnum": 1, "calt": 1, "kern": 1},
    )

    # Patch KaTeX fonts
    patched_math = patch_math_latin(katex_math_base, cormorant_italic_600)
    patched_main = patch_main_digits_primes(katex_main_base, cormorant_roman_600)

    # Subset + save WOFF2
    subset_to_woff2(patched_math, MATH_CHARS, out_math_woff2)
    subset_to_woff2(patched_main, MAIN_CHARS, out_main_woff2)


if __name__ == "__main__":
    main()