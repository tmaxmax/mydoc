#!/usr/bin/env node

import pandoc from "pandoc-filter";
import hljs from "highlight.js";
import * as cheerio from "cheerio";
import mathjax from "mathjax-node";

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

pandoc.stdio(async (value, format, meta) => {
  if (value.t === "Math") {
    const [type, math] = value.c;
    const svg = await mathjax.typeset({
      math,
      format: type.t === "DisplayMath" ? "TeX" : "inline-TeX",
      svg: true,
    });
    const $ = cheerio.load(svg.svg, null, false);
    const $svg = $("svg");
    const width = Number.parseFloat($svg.attr("width"));
    const height = Number.parseFloat($svg.attr("height"));
    $svg.attr("width", `${width * 8}px`);
    $svg.attr("height", `${height * 8}px`);

    return pandoc.RawInline("html", $.html($svg));
  }

  if (value.t === "CodeBlock") {
    const [[, [language] = ["plaintext"]], code] = value.c;
    const html = `<div custom-style="CodeBlock">${hljs.highlight(code, { language }).value}</div>`;
    const $ = cheerio.load(html, null, false);
    $("span").each((_, el) => {
      const $s = $(el);
      const [kind] = $s
        .attr("class")
        .split(" ")
        .filter((c) => c.startsWith("hljs-"));
      $s.attr("custom-style", kind ?? "");
    });

    return pandoc.RawBlock("html", $.html($("div")));
  }
});
