# mydoc

Pandoc pipeline to generate HTML for [archive.quateo.com][1] and Adobe InDesign ICML from Markdown + LaTeX documents.

## Install

Requires Node and [pnpm](https://pnpm.io/).

```sh
$ pnpm ci
$ ln -s "$(realpath run.sh)" ~/.local/bin/mydoc
```

Link to any location present in `$PATH`.

## How it works

`run.sh` is just a Pandoc wrapper which uses the appropriate custom filters in this repository.

For HTML, the filter:

- convert math equations within `$ ... $` and `$$ ... $$` to plain HTML and MathML for accessibility and reader mode using [KaTeX](https://katex.org/)
- convert code blocks to HTML with syntax highlighting using [highlight.js](https://highlightjs.org/)
- wraps adjacent inline math and strings in additional markup to prevent the browser from breaking them across multiple lines
    - this avoids awkward breaks where an equation is split in the middle or punctuation after an equation goes on the next line
- outputs self-contained pages with all resources embedded (images, CSS, scripts) so they're archivable with [web.archive.org](https://web.archive.org) and downloadable
    - while some documents are sizable, gzip on the server reduces size by 50-70% and internet is fast these days

For ICML, the filter:

- renders the math equations to SVG using MathJax and then further renders the SVG to PNG so they're embeddable in the ICML
    - for the ICML target Pandoc renders math by simply replacing TeX with plain Unicode characters which has no layout or scaling (it doesn't look like math) so math must be manually handled
    - embedding SVGs directly is broken for a reason I couldn't figure out
    - to handle vertical alignment custom InDesign object styles are generated for all possible alignments (there aren't many since rendering is meant to be very regular) so that the designer can change Y offset to all images at once in InDesign
    - display math is also assigned an object style so they can all be styled together in InDesign
- renders code blocks in an object with its own object style and renders the code itself with distinct character styles for all tokens so syntax highlighting colors can be applied in InDesign without having to manually color each token

Pandoc does have syntax highlighting included but I don't like it. It also supports KaTeX/MathJax output but Pandoc outputs documents which render equations client-side and I want the equations fully rendered in HTML instead.

The KaTeX CSS is copied because I changed styling of math tags. They are set to have `position: fixed` within the display container such that on overflow when scrolling they keep their position on the right. I also removed the WOFF and TTF fonts because [WOFF2 is baseline](https://caniuse.com/woff2).

## Development

For working on the HTML output run:

```sh
$ node serve.js path/to/sample.md
```

This opens a local server which serves the rendered `sample.md` and a file watcher that automatically rerenders and reloads the page when changes are made. You may also want to run `./auth/dev.sh` if working with link sharing.

[1]: https://archive.quateo.com/grid/rigorous.html