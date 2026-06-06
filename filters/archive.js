#!/usr/bin/env node

import katex from "katex";
import pandoc from "pandoc-filter";
import hljs from "highlight.js";

// @ts-ignore
const { default: metricMap } = await import("../out/fontMetrics.json", { with: { type: "json" } });

for (const [font, data] of Object.entries(metricMap)) {
  // @ts-ignore
  katex.__setFontMetrics(font, data);
}

pandoc.stdio((value, format, meta) => {
  if (value.t === "Math") {
    const [type, math] = value.c;
    const html = katex.renderToString(math.trim(), {
      displayMode: type.t === "DisplayMath",
      output: "htmlAndMathml",
      strict: "error",
    });

    return pandoc.RawInline("html", html);
  }

  if (value.t === "CodeBlock") {
    const [[, [language] = []], code] = value.c;
    const html = `<pre><code class="hljs hljs-${language}">${hljs.highlight(code, { language }).value}</code></pre>`;

    return pandoc.RawBlock("html", html);
  }

  if (value.t === "Code") {
    const [, code] = value.c;
    const html = `<code class="hljs">${hljs.highlight(code, { language: "plaintext" }).value}</code>`;

    return pandoc.RawInline("html", html);
  }

  // Modify the markup so that inline math doesn't wrap and
  // inline math with text immediately afterwards, like punctuation,
  // remain together when wrapping.
  const c = getInlineContent(value);
  for (let i = 0; i < c.length; i++) {
    const m = c[i];
    if (m.t === "Math") {
      const start = i > 0 && c[i - 1].t === "Str" ? i - 1 : i;
      let end = i;
      for (; end < c.length && (c[end].t === "Str" || c[end].t === "Math"); end++);

      const s = pandoc.Span(pandoc.attributes({ classes: ["no-wrap"] }), []);
      s.c[1] = c.splice(start, end - start, s);
    }
  }

  return value;
});

/**
 * @param {pandoc.AnyElt} value
 * @return {pandoc.Inline[]}
 */
function getInlineContent(value) {
  switch (value.t) {
    case "Quoted":
      return value.c[1];
    case "Emph":
    case "Strong":
    case "Para":
      return value.c;
    case "Header":
      return value.c[2];
    case "Plain":
      return value.c;
    default:
      return [];
  }
}
