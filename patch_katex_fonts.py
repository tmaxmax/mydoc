from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import subprocess
import os
import json

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen

@dataclass(frozen=True)
class Patch:
    source_font: Path
    axis_limits: dict[str, float]
    codepoints: list[int]
    feature_tags: dict[str, int]
    anchor_cp: int = ord('x')


def main():
    static_dir = Path("static")
    katex_dir = Path("vendor") / "katex@0.17.0" / "dist"
    fonts_dir = katex_dir / "fonts"

    # [0-9A-Za-zπμ]
    alnum = list(range(0x41, 0x5B)) + list(range(0x61, 0x7B)) + [0x03C0, 0x03BC] + list(range(0x30, 0x3A))

    patch_sets = {
        "Math-Italic": [
            Patch(
                source_font=static_dir / "cormorant-garamond-italic.ttf",
                axis_limits={'wght': 570},
                feature_tags={'ss03': 1, 'lnum': 1, 'calt': 1, 'kern': 1},
                codepoints=alnum, 
            ),
        ],
        "Main-Regular": [
            Patch(
                source_font=static_dir / "eb-garamond.ttf",
                axis_limits={'wght': 400},
                feature_tags={'liga': 1, "kern": 1},
                codepoints=alnum,
            ),
        ],
    }

    metrics = read_metrics(katex_dir / "fontMetricsData.json")

    for base_font_name, patches in patch_sets.items():
        with TTFont(fonts_dir / f"KaTeX_{base_font_name}.woff2") as base_font:
            for patch in patches:
                with TTFont(patch.source_font) as source_font:
                    instantiateVariableFont(source_font, axisLimits=patch.axis_limits, inplace=True)                   
                    instantiate_features(source_font, patch.codepoints, patch.feature_tags)
                    patch_glyph_set(base_font, source_font, patch.codepoints, patch.anchor_cp)
                    update_metrics(metrics, base_font, base_font_name, patch.codepoints)
            save_font(base_font, fonts_dir / f"KaTeX_{base_font_name}_patched.woff2")
    
    write_metrics(metrics, katex_dir / 'fontMetrics.json')


def hb_font_from_ttfont(font: TTFont) -> hb.Font:
    buf = BytesIO()
    font.save(buf)
    return hb.Font(hb.Face(buf.getvalue()))


def instantiate_features(font: TTFont, codepoints: list[int], tags: dict[str, int]) -> None:
    hb_font = hb_font_from_ttfont(font)
    cp_to_glyph = {}

    for cp in codepoints:
        b = hb.Buffer()
        b.add_str(chr(cp))
        b.guess_segment_properties()
        hb.shape(hb_font, b, tags)
        gid = b.glyph_infos[0].codepoint
        cp_to_glyph[cp] = font.getGlyphName(gid)

    for sub in font["cmap"].tables:
        if sub.isUnicode():
            for cp, gname in cp_to_glyph.items():
                sub.cmap[cp] = gname


def _draw_src_glyph(src: TTFont, src_gs, src_gname: str, pen) -> None:
    """Draw src glyph into `pen`, decomposing composites when needed."""
    g = src["glyf"][src_gname]
    if g.isComposite():
        dpen = DecomposingRecordingPen(src_gs)
        src_gs[src_gname].draw(dpen)
        dpen.replay(pen)
    else:
        src_gs[src_gname].draw(pen)


def bounds(glyph_set, glyph_name, src_font: TTFont | None = None):
    p = BoundsPen(glyph_set)
    if src_font is None:
        glyph_set[glyph_name].draw(p)
    else:
        _draw_src_glyph(src_font, glyph_set, glyph_name, p)  # handles composites
    return p.bounds


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
    _draw_src_glyph(src, src_gs, src_gname, tpen)

    base["glyf"][base_gname] = pen.glyph()
    base["hmtx"][base_gname] = (new_adv, new_lsb)


def patch_glyph_set(
    base: TTFont,
    src: TTFont,
    codepoints: list[int],
    anchor_cp: int,  # e.g. ord("x"), ord("0")
) -> None:
    base_cmap = base.getBestCmap()
    src_cmap = src.getBestCmap()
    base_gs = base.getGlyphSet()
    src_gs = src.getGlyphSet()

    if anchor_cp not in base_cmap or anchor_cp not in src_cmap:
        raise ValueError(f"Anchor codepoint {anchor_cp} missing in cmap")

    bx0, by0, bx1, by1 = bounds(base_gs, base_cmap[anchor_cp])
    sx0, sy0, sx1, sy1 = bounds(src_gs, src_cmap[anchor_cp], src_font=src)

    base_h = by1 - by0
    src_h = sy1 - sy0
    scale = (base_h / src_h) if src_h else 1.0

    for cp in codepoints:
        if cp in base_cmap and cp in src_cmap:
            replace_glyph_and_hmtx(base, src, base_cmap[cp], src_cmap[cp], scale)


def ots_sanitize_file(input_path: Path) -> None:
    proc = subprocess.run(
        ["ots-sanitize", str(input_path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"OTS sanitize failed for {input_path}:\n{proc.stderr}")


def save_font(font: TTFont, p: Path) -> None:
    font.flavor = "woff2"

    tmp = p.with_suffix(".tmp.woff2")
    font.save(str(tmp))

    try:
        ots_sanitize_file(tmp)
        os.replace(tmp, p)
    finally:
        tmp.unlink(missing_ok=True)


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
    gs = font.getGlyphSet()

    if font_name not in metrics_map:
        metrics_map[font_name] = {}

    out = metrics_map[font_name]

    for cp in codepoints:
        if cp not in cmap:
            continue

        gname = cmap[cp]
        adv, _lsb = hmtx[gname]
        _x0, y0, _x1, y1 = bounds(gs, gname)

        depth = max(0.0, -y0 / upem)
        height = max(0.0, y1 / upem)
        width = adv / upem

        key = str(cp)
        old = out.get(key, [0.0, 0.0, 0.0, 0.0, 0.0])
        italic = old[2] 
        skew = old[3]

        out[key] = list(map(_clean, [depth, height, italic, skew, width]))


def read_metrics(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8").strip())


def write_metrics(metrics_map: dict, p: Path) -> None:
    payload = json.dumps(metrics_map, ensure_ascii=False, indent=2, sort_keys=True)
    p.write_text(payload, encoding="utf-8")


if __name__ == "__main__":
    main()