#!/usr/bin/env node

import katex from "katex";
import pandoc from "pandoc-filter";
import hljs from "highlight.js";

pandoc.stdio((value, format, meta) => {
  if (value.t === "Math") {
    const [type, math] = value.c;
    const html = katex.renderToString(math.trim(), {
      displayMode: type.t === "DisplayMath",
      output: "htmlAndMathml",
      throwOnError: false,
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
});
