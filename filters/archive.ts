import fs from "fs";
import katex from "katex";
import type {
  CharacterMetricsTuple,
  CssStyle,
  FontName,
  FontShape,
  FontWeight,
  HtmlDomNode,
  Span,
  SymbolNode,
  TextFont,
  MacroDefinition,
  Token,
  MacroMap,
} from "katex";
import fontMetricsData from "katex/src/fontMetricsData.js";
import pandoc from "pandoc-filter";
import hljs from "highlight.js";
import getStdin from "get-stdin";

const displayMathFontSizeEm = 1.05; // keep in sync with CSS
const macros: MacroMap = {};

const action: pandoc.FilterActionAsync = (value, format, meta) => {
  if (value.t === "Math") {
    initKatex();

    const [{ t }, math] = value.c;
    const html =
      t === "DisplayMath"
        ? renderDisplayMath(math.trim())
        : katex.renderToString(math.trim(), {
            strict: "error",
            output: "htmlAndMathml",
            macros,
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
    if (m.t === "Math" && m.c[0].t === "InlineMath") {
      const start = i > 0 && c[i - 1].t === "Str" ? i - 1 : i;
      let end = i;
      for (; end < c.length && (c[end].t === "Str" || c[end].t === "Math"); end++);

      const s = pandoc.Span(pandoc.attributes({ classes: ["no-wrap"] }), []);
      s.c[1] = c.splice(start, end - start, s);
    }
  }

  return value;
};

function getInlineContent(value: pandoc.AnyElt) {
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

const responsiveMathContainerQueries: { minWidth: number; maxWidth: number }[] = [];

function renderDisplayMath(math: string) {
  let maxBrk = 0;
  for (const [, a] of math.matchAll(/\\brk(?:\[(\d+)?(?:,(\d+)?)?\])?/g)) {
    maxBrk = Math.max(maxBrk, a ? Number.parseInt(a) : 1);
  }

  let maxWidth = 0;
  let html = "";

  for (let brk = 0; brk <= maxBrk; brk++) {
    macros["\\brk"] = createBrkMacro(brk);

    const dom = katex.__renderToDomTree(math, {
      displayMode: true,
      strict: "error",
      minRuleThickness: 0.06,
      macros,
    });

    delete macros["\\brk"];

    if (maxWidth || brk < maxBrk) {
      let minWidth = 0;
      if (brk < maxBrk) {
        minWidth = Math.round(width(dom, displayMathFontSizeEm) + 1);
        if (maxWidth && minWidth >= maxWidth) {
          throw new Error(`Breakpoint ${brk} gives wider equation`, { cause: math });
        }
      }

      dom.classes.push("req", `req-${responsiveMathContainerQueries.length}`);
      responsiveMathContainerQueries.push({ minWidth, maxWidth });
      maxWidth = minWidth;
    }

    html += dom.toMarkup();
  }

  return html;
}

function createBrkMacro(brk: number): MacroDefinition {
  const raw = (t: Token[]) =>
    t
      .map((t) => t.text)
      .reverse()
      .join("");

  return (ctx) => {
    ctx.consumeSpaces();

    let a = 1;
    let b = Infinity;
    if (ctx.future().text === "[") {
      ctx.popToken();

      const input = raw(ctx.consumeArg(["]"]).tokens).trim();
      if (input.includes(",")) {
        const [left, right] = input.split(",").map((s) => s.trim());
        a = left === "" ? 0 : Number.parseInt(left);
        b = right === "" ? Infinity : Number.parseInt(right);
      } else {
        a = b = Number.parseInt(input);
      }
    }

    if (ctx.future().text === "{") {
      const { tokens } = ctx.consumeArg();
      if (a <= brk && brk <= b) {
        return { tokens, numArgs: 0 };
      }
    }

    return a <= brk && brk <= b ? "\\\\" : "";
  };
}

let sizings: Map<string, number> | undefined;

async function initKatex() {
  if (sizings) return;

  for (const [font, data] of Object.entries(JSON.parse(read("./out/fontMetrics.json")))) {
    katex.__setFontMetrics(font, data as Record<string, CharacterMetricsTuple>);
  }

  sizings = new Map();
  for (const [, sizing, em] of read("./static/katex.css").matchAll(
    /\.katex\s+\.sizing\.(reset-size\d+\.size\d+)\{font-size:((?:\.|\d)+)em\}/g,
  )) {
    sizings.set(sizing, Number.parseFloat(em));
  }
}

function isVerticalLayout(span: Span<HtmlDomNode>) {
  if (span.hasClass("vlist-t") || span.hasClass("vlist-b")) {
    return true;
  }
  return span.hasClass("vlist") && span.children?.some((c) => c.style && (c.style.top || c.style.bottom));
}

function width(d?: HtmlDomNode | HtmlDomNode[], emSize = 1, parent?: HtmlDomNode): number {
  if (!d || Array.isArray(d)) {
    return (d || []).reduce((a, b) => a + width(b, emSize, parent), 0);
  }

  if (d instanceof katex.__domTree.SymbolNode) {
    const codepoints = [...d.text];
    if (codepoints.length === 1) {
      return d.width * emSize;
    }

    // Workaround for KaTeX library setting width based on
    // first codepoint only.
    // @ts-expect-error wrong upstream types
    const metrics = fontMetricsData[retrieveFont(d, parent!)];
    const actualWidth = codepoints.map((cp) => metrics[cp.codePointAt(0)!][4]).reduce((a, b) => a + b, 0);

    return actualWidth * emSize;
  }

  if (!(d instanceof katex.__domTree.Span)) {
    // @ts-ignore
    return "type" in d ? 0 : width(d.children, emSize, d);
  }

  if (d.width) {
    return d.width;
  }

  if (d.hasClass("nulldelimiter")) {
    return 0.12 * emSize;
  }

  const i = Math.max(d.classes.indexOf("sizing"), d.classes.indexOf("fontsize-ensurer"));
  if (i >= 0) {
    const sizing = d.classes.filter((c, j) => j !== i && c.includes("size")).join(".");
    emSize *= sizings!.get(sizing)!;
  }

  let w = 0;
  for (const k of ["marginRight", "marginLeft", "minWidth", "width", "paddingLeft"] satisfies (keyof CssStyle)[]) {
    if (d.style?.[k]) {
      w += Number.parseFloat(d.style[k]);
    }
  }

  let childrenWidth;
  if (isVerticalLayout(d)) {
    childrenWidth = Math.max(...d.children.map((c) => width(c, emSize, d)));
  } else {
    childrenWidth = width(d.children, emSize, d);
  }

  return w * emSize + childrenWidth;
}

function retrieveFont(d: SymbolNode, parent: HtmlDomNode): FontName {
  let font: FontName = "Main-Regular";
  let mathClass = (Object.keys(mathFonts) as (keyof typeof mathFonts)[]).find((f) => d.hasClass(f));
  if (parent?.classes.includes("text")) {
    font = retrieveTextFontName(
      textFonts.find((f) => d.hasClass(f)) ?? "textrm",
      fontWeights.find((f) => d.hasClass(f)) ?? "",
      fontShapes.find((f) => d.hasClass(f)) ?? "",
    );
  } else if (mathClass) {
    font = mathFonts[mathClass];
  }
  return font;
}

const mathFonts = {
  mainrm: "Main-Regular",
  mathsfit: "SansSerif-Italic",
  mathitsf: "SansSerif-Italic",
  mathboldsf: "SansSerif-Bold",
  mathsf: "SansSerif-Regular",
  mathscr: "Script-Regular",
  mathtt: "Typewriter-Regular",
  boldsymbol: "Math-BoldItalic",
  mathbf: "Main-Bold",
  mathrm: "Main-Regular",
  mathit: "Main-Italic",
  mathnormal: "Main-Italic",
  mathbb: "AMS-Regular",
  mathcal: "Caligraphic-Regular",
  mathfrak: "Fraktur-Regular",
} satisfies Record<string, FontName>;

const textFonts = ["textrm", "textsf", "texttt", "amsrm"] satisfies TextFont[];
const fontWeights = ["textbf", "textmd"] satisfies FontWeight[];
const fontShapes = ["textit", "textup"] satisfies FontShape[];

function retrieveTextFontName(fontFamily: TextFont, fontWeight: FontWeight, fontShape: FontShape): FontName {
  let baseFontName;
  let fontStylesName;

  switch (fontFamily) {
    case "amsrm":
      baseFontName = "AMS";
      break;
    case "textrm":
      baseFontName = "Main";
      break;
    case "textsf":
      baseFontName = "SansSerif";
      break;
    case "texttt":
      baseFontName = "Typewriter";
      break;
    default:
      baseFontName = fontFamily;
  }

  if (fontWeight === "textbf" && fontShape === "textit") {
    fontStylesName = "BoldItalic";
  } else if (fontWeight === "textbf") {
    fontStylesName = "Bold";
  } else if (fontShape === "textit") {
    fontStylesName = "Italic";
  } else {
    fontStylesName = "Regular";
  }

  // @ts-ignore this is copied from KaTeX source, it's fine.
  return `${baseFontName}-${fontStylesName}`;
}

function read(file: string) {
  return fs.readFileSync(file, { encoding: "utf-8" });
}

function getMetaList(v?: pandoc.PandocMetaValue) {
  return v?.t === "MetaList" ? v : ({ t: "MetaList", c: v ? [v] : [] } satisfies pandoc.PandocMetaValue);
}

const doc = await pandoc.filter(JSON.parse(await getStdin()), action, process.argv.length > 2 ? process.argv[2] : "");

if (responsiveMathContainerQueries.length) {
  const queries = Map.groupBy(
    responsiveMathContainerQueries.map((_, i) => i),
    (i) => {
      const { minWidth: min, maxWidth: max } = responsiveMathContainerQueries[i];
      return `(${min ? `${min}em <= ` : ""}width${max ? ` < ${max}em` : ""})`;
    },
  );
  // prettier-ignore
  const style = /* html */ `<style>
  .req { display: none; }
  ${queries.entries().map(([query, indexes]) => /* css */ `@container main ${query} {
    ${indexes.map((i) => `.req-${i}`).join(',')} { display: block; }
  }`).toArray().join('\n')}
</style>`

  const block = pandoc.RawBlock("html", style);
  const header = getMetaList(doc.meta["header-includes"]);
  header.c.push({ t: "MetaBlocks", c: [block] });
  doc.meta["header-includes"] = header;
}

process.stdout.write(JSON.stringify(doc));
