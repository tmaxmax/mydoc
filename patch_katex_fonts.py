from collections.abc import Iterable
from dataclasses import dataclass
from io import BytesIO
from operator import itemgetter
from pathlib import Path
import re
import subprocess
import os
import json

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools import subset


def main():
    fonts_dir = Path("fonts")
    katex_dir = Path("node_modules") / "katex"
    out_dir = Path("out")

    out_dir.mkdir(exist_ok=True)

    # [0-9A-Za-zπμ]
    uppercase = range(0x41, 0x5b)
    alnum = [uppercase, range(0x61, 0x7B), 0x03C0, 0x03BC, range(0x30, 0x3A)]
    
    garamond_math_path = fonts_dir / "garamond-math.otf"
    garamond_math_feature_tags = {'ss07': 1, 'ss08': 1, 'ss09': 1}

    patch_sets = {
        "Math-Italic": [
            Patch(
                source_font=fonts_dir / "cormorant-garamond-italic.ttf",
                axis_limits={'wght': 570},
                feature_tags={'ss03': 1, 'lnum': 1, 'calt': 1, 'kern': 1},
                codepoints=alnum, 
            ),
        ],
        "Main-Regular": [
            Patch(
                source_font=fonts_dir / "eb-garamond.ttf",
                axis_limits={'wght': 400},
                feature_tags={'liga': 1, "kern": 1},
                codepoints=alnum,
            ),
        ],
        'Caligraphic-Regular': [
            Patch(
                source_font=garamond_math_path,
                feature_tags=garamond_math_feature_tags,
                codepoints=Projection(rng=uppercase, offset=0x1D45B),
                base_anchor_cp=ord('O')
            )
        ],
        'Caligraphic-Bold': [
            Patch(
                source_font=garamond_math_path,
                feature_tags=garamond_math_feature_tags,
                codepoints=Projection(rng=uppercase, offset=0x1D48F),
                base_anchor_cp=ord('O')
            )
        ],
        'AMS-Regular': [
            Patch(
                source_font=garamond_math_path,
                feature_tags=garamond_math_feature_tags,
                codepoints={
                    ord('C'): 0x2102,
                    ord('H'): 0x210D,
                    ord('N'): 0x2115,
                    ord('P'): 0x2119,
                    ord('Q'): 0x211A,
                    ord('R'): 0x211D,
                    ord('Z'): 0x2124,
                },
                base_anchor_cp=ord('N')
            )
        ]
    }

    metrics = read_metrics(katex_dir / "src" / "fontMetricsData.js")
    metrics = {k: v for k, v in metrics.items() if k in patch_sets}

    css = (katex_dir / "dist" / "katex-swap.min.css").read_text(encoding='utf-8')
    css = re.sub(r",url\(fonts\/\S+\.(woff|ttf)\) format\(\"(woff|truetype)\"\)", "", css)
    css = re.sub(r"fonts(\/KaTeX_(\S+)\.woff2)", r".\1", css)

    for base_font_name, patches in patch_sets.items():
        base_font_path = katex_dir / "dist" / "fonts" / f"KaTeX_{base_font_name}.woff2"
        with TTFont(base_font_path) as base_font:
            for p in patches:
                with TTFont(p.source_font) as source_font:
                    if p.axis_limits:
                        instantiateVariableFont(source_font, axisLimits=p.axis_limits, inplace=True)
                    if p.feature_tags:
                        instantiate_features(source_font, p.unicodes_source(), p.feature_tags)
                    patch_glyph_set(base_font, source_font, p.unicodes(), p.base_anchor_cp, p.source_anchor_cp())

            update_metrics(metrics, base_font, base_font_name, flatten(p.unicodes_base() for p in patches))
            save_font(base_font, out_dir / base_font_path.name)

    write_metrics(metrics, out_dir / "fontMetrics.json")
    (out_dir / "katex.css").write_text(css)


@dataclass(frozen=True)
class Projection:
    rng: range
    offset: int

    def __iter__(self):
        for i in self.rng:
            yield (i, i + self.offset)

@dataclass(frozen=True)
class Patch:
    source_font: Path
    codepoints: list[int | range] | dict[int, int] | Projection  # base -> source
    base_anchor_cp: int = ord('x')
    axis_limits: dict[str, float] | None = None
    feature_tags: dict[str, int] | None = None

    def unicodes(self) -> Iterable[tuple[int, int]]:
        if isinstance(self.codepoints, list):
            return ((i, i) for i in flatten(self.codepoints))
        if isinstance(self.codepoints, dict):
            return self.codepoints.items()
        return self.codepoints
    
    def unicodes_base(self) -> Iterable[int]:
        return map(itemgetter(0), self.unicodes())
    
    def unicodes_source(self) -> Iterable[int]:
        return map(itemgetter(1), self.unicodes())
    
    def source_anchor_cp(self) -> int:
        if isinstance(self.codepoints, list):
            return self.base_anchor_cp
        if isinstance(self.codepoints, dict):
            return self.codepoints[self.base_anchor_cp]
        return self.base_anchor_cp + self.codepoints.offset


def flatten(it):
    for i in it:
        try:
            yield from i
        except:
            yield i


def hb_font_from_ttfont(font: TTFont) -> hb.Font:
    buf = BytesIO()
    font.save(buf)
    return hb.Font(hb.Face(buf.getvalue()))


def instantiate_features(font: TTFont, codepoints: Iterable[int], tags: dict[str, int]) -> None:
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
    if 'glyf' in src:
        g = src["glyf"][src_gname]
        if g.isComposite():
            dpen = DecomposingRecordingPen(src_gs)
            src_gs[src_gname].draw(dpen)
            dpen.replay(pen)
            return

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

    tt_pen = TTGlyphPen(base_gs)
    out_pen = TransformPen(tt_pen, (scale, 0, 0, scale, tx, ty))

    if "CFF " in src or "CFF2" in src:
        out_pen = Cu2QuPen(out_pen, max_err=1.0, reverse_direction=True)
    
    _draw_src_glyph(src, src_gs, src_gname, out_pen)

    base["glyf"][base_gname] = tt_pen.glyph()
    base["hmtx"][base_gname] = (new_adv, new_lsb)


def patch_glyph_set(
    base: TTFont,
    src: TTFont,
    codepoints: Iterable[tuple[int, int]],
    base_anchor_cp: int,
    src_anchor_cp: int,
) -> None:
    base_cmap = base.getBestCmap()
    src_cmap = src.getBestCmap()
    base_gs = base.getGlyphSet()
    src_gs = src.getGlyphSet()

    if base_anchor_cp not in base_cmap or src_anchor_cp not in src_cmap:
        raise ValueError("Anchor codepoint missing in cmap")

    _, by0, _, by1 = bounds(base_gs, base_cmap[base_anchor_cp])
    _, sy0, _, sy1 = bounds(src_gs, src_cmap[src_anchor_cp], src_font=src)

    base_h = by1 - by0
    src_h = sy1 - sy0
    scale = (base_h / src_h) if src_h else 1.0

    for base_cp, src_cp in codepoints:
        if base_cp in base_cmap and src_cp in src_cmap:
            replace_glyph_and_hmtx(base, src, base_cmap[base_cp], src_cmap[src_cp], scale)


def ots_sanitize_file(input_path: Path) -> None:
    proc = subprocess.run(
        ["ots-sanitize", str(input_path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"OTS sanitize failed for {input_path}:\n{proc.stderr}")


def save_font(font: TTFont, p: Path, *, unicodes: list[int] | None = None) -> None:
    if unicodes:
        opts = subset.Options(flavor="woff2")
        s = subset.Subsetter(options=opts)
        s.populate(unicodes=subset)
        s.subset(font)

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
    text = path.read_text(encoding='utf-8').strip()
    text = re.sub(r'(?m)^[ \t]*//.*(?:\n|$)', '', text)
    text = re.sub(r"^\s*export\s+default\s+", "", text, count=1)
    text = re.sub(r",\n(\s*\})", r"\n\1", text)
    text = re.sub(r";\s*$", "", text)
    return json.loads(text)


def write_metrics(metrics_map: dict, p: Path) -> None:
    payload = json.dumps(metrics_map, ensure_ascii=False, indent=2, sort_keys=True)
    p.write_text(payload, encoding="utf-8")


if __name__ == "__main__":
    main()