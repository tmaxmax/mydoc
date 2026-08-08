import argparse
import re
import sys
import pymupdf  # PyMuPDF


def remove_folio(page, footer_height=60, center_tolerance=30):
    """Remove a bottom-centred Arabic-numeral folio from one page."""

    w, h = page.rect.width, page.rect.height
    footer = pymupdf.Rect(0, h - footer_height, w, h)

    candidates = []

    for word in page.get_text("words", clip=footer):
        x0, y0, x1, y1, text = word[:5]

        if not re.fullmatch(r"\d+", text):
            continue

        cx = (x0 + x1) / 2

        # Only accept numbers sufficiently close to horizontal centre.
        if abs(cx - w / 2) <= center_tolerance:
            candidates.append((y0, pymupdf.Rect(x0, y0, x1, y1), text))

    if not candidates:
        return False

    # If somehow there is more than one candidate, use the lowest one.
    _, rect, text = max(candidates, key=lambda x: x[0])

    # Slight padding around the glyphs.
    rect = pymupdf.Rect(
        rect.x0 - 1,
        rect.y0 - 1,
        rect.x1 + 1,
        rect.y1 + 1,
    )

    page.add_redact_annot(rect, fill=(1, 1, 1))
    page.apply_redactions()
    return text


def main():
    parser = argparse.ArgumentParser(
        description="Remove bottom-centred page numbers from a PDF."
    )

    parser.add_argument("input", help="input PDF")
    parser.add_argument("output", help="output PDF")

    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--ends",
        action="store_true",
        help="remove folios from first and last pages only",
    )
    mode.add_argument(
        "--all",
        action="store_true",
        help="remove folios from every page",
    )

    args = parser.parse_args()

    doc = pymupdf.open(args.input)

    if args.all:
        pages = range(len(doc))
    else:
        pages = {0, len(doc) - 1}

    for i in pages:
        removed = remove_folio(doc[i])
        if removed:
            print(f"page {i + 1}: removed folio {removed!r}", file=sys.stderr)
        else:
            print(f"page {i + 1}: no folio found", file=sys.stderr)

    doc.save(
        args.output,
        garbage=4,
        deflate=True,
    )


if __name__ == "__main__":
    main()