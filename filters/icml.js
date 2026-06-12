#!/usr/bin/env node

import pandoc from "pandoc-filter";
import * as cheerio from "cheerio";
import mathjax from "mathjax-node";
import { Resvg } from "@resvg/resvg-js";
import hljs from "highlight.js";

mathjax.config({
  MathJax: {
    TeX: {
      Macros: {
        N: "\\mathbb{N}",
        R: "\\mathbb{R}",
        Set: ["\\left\\{ #1 \\right\\}", 1],
        coloneqq: "\\mathrel{:=}",
        uarr: "\\uparrow",
        exist: "\\exists",
      },
    },
  },
});

const alignments = new Map();

pandoc.stdio(async (value, format, meta) => {
  if (value.t === "Math") {
    const [type, math] = value.c;
    const exToPx = 5.665;
    const svg = await mathjax.typeset({
      math,
      format: type.t === "DisplayMath" ? "TeX" : "inline-TeX",
      svg: true,
      ex: exToPx,
    });

    const $ = cheerio.load(svg.svg, null, false);
    const $svg = $("svg");

    const exToPt = exToPx / 1.333;
    const width = Number.parseFloat($svg.attr("width")) * exToPt;
    const height = Number.parseFloat($svg.attr("height")) * exToPt;
    const alignment = (Number.parseFloat($svg.attr("style").replace("vertical-align: ", "")) * exToPt).toFixed(3);

    let objectStyle = "DisplayMath";
    if (type.t === "InlineMath") {
      objectStyle = alignments.get(alignment);
      if (!objectStyle) {
        objectStyle = `InlineMath${alignment}`;
        alignments.set(alignment, objectStyle);
      }
    }

    $svg.attr("width", `${width * 40}px`);
    $svg.attr("height", `${height * 40}px`);

    const resvg = new Resvg($.html($svg), null);
    const data = resvg.render().asPng().toString("base64");

    const img = pandoc.Image(
      pandoc.attributes({ width: `${width}pt`, height: `${height}pt`, "object-style": objectStyle }),
      [],
      [`data:image/png;base64,${data}`, ""],
    );

    return img;
  }

  if (value.t === "CodeBlock") {
    const [[, [language] = ["plaintext"]], code] = value.c;
    const $ = cheerio.load(hljs.highlight(code, { language }).value, null, false);

    const inline = [];
    for (const n of $.root().contents()) {
      const $n = $(n);
      const [style] = $n.attr("class")?.split(" ") ?? [""];
      const text = $n.text();

      if (style) {
        inline.push(pandoc.Span(pandoc.attributes({ "custom-style": style }), [pandoc.Str(text)]));
      } else {
        inline.push(pandoc.Str(text));
      }
    }

    return pandoc.Div(pandoc.attributes({ "custom-style": "CodeBlock" }), [pandoc.Para(inline)]);
  }
});
