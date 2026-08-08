/**
 * print-justify-render-corrected.ts
 *
 * Dependencies: tex-linebreak + hyphen only.
 * Corrected print-media version: measurements are taken only after @media print
 * is active; the real painted first-line indent is measured before mutation;
 * source <br> indentation is emulated on the generated line itself; tex-linebreak
 * chooses globally optimal breaks; and every rendered line is finally measured
 * in Chromium and nudged to the exact right edge via word-spacing. Source
 * `white-space: nowrap` ranges are kept indivisible.
 */

import {
  MAX_COST,
  MaxAdjustmentExceededError,
  PARAGRAPH_START,
  adjustmentRatios,
  breakLines,
  forcedBreak,
  lineContentStart,
  type Box,
  type Glue,
  type Penalty,
} from "tex-linebreak";
// `hyphen` ships JavaScript but no bundled declarations. esbuild only needs the
// runtime modules, so @types/hyphen is unnecessary for this print-only bundle.
// @ts-ignore
import { hyphenateSync as hyphenateEn } from "hyphen/en";
// @ts-ignore
import { hyphenateSync as hyphenateRo } from "hyphen/ro";

/**
 * Print-only Knuth–Plass justification for `.book > p`.
 *
 * Architecture:
 *   - `tex-linebreak` owns the Knuth–Plass algorithm.
 *   - `hyphen` supplies Liang-pattern discretionary hyphens.
 *   - This file adapts rich DOM content to box/glue/penalty items, measures
 *     actual print styles in a hidden DOM measurer, applies Romanian editorial
 *     hyphenation protections, and materializes the chosen lines back into DOM.
 *
 * The module is intended to be dynamically imported only after Cmd/Ctrl+P.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const JUSTIFICATION = {
  /** Natural inter-word space may grow by this fraction at adjustment ratio 1. */
  spaceStretch: 0.5,

  /** Natural inter-word space may shrink by this fraction at adjustment ratio -1. */
  spaceShrink: 1 / 3,

  /** Knuth–Plass penalty for an automatic dictionary hyphen. */
  hyphenPenalty: 50,

  /** Lower penalty for breaking after an already-visible hyphen (non-Romanian). */
  explicitHyphenPenalty: 20,

  /** Direct demerit added for each pair of consecutive hyphen-ended lines. */
  doubleHyphenPenalty: 10_000,

  /** Direct demerit for an abrupt jump between non-adjacent fitness classes. */
  adjacentLooseTightPenalty: 3_000,

  /** First Knuth–Plass pass: stay within the nominal stretch capacity. */
  initialMaxAdjustmentRatio: 1,

  /** Emergency ceiling before leaving the paragraph to Chromium. */
  maxAdjustmentRatio: 1.75,

  /** Pattern hyphenator minimum token length. */
  hyphenMinWordLength: 5,

  /** Romanian: never divide tokens already containing a visible hyphen. */
  protectRomanianHyphenatedWords: true,

  /** Romanian: treat mid-sentence Title Case tokens as probable proper names. */
  protectRomanianMidSentenceTitlecase: true,

  /** How many lines should a single dialog paragraph span in order to use Knuth–Plass. */
  dialogueMinLines: 4,
} as const;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let armed = false;
let transformed = false;
let restorations: Restoration[] = [];
let measurer: DOMTextMeasurer | null = null;
const printMedia = window.matchMedia("print");

/**
 * Called by the lazy Cmd/Ctrl+P loader before `window.print()`.
 * The expensive bundle is therefore absent from ordinary page loads.
 */
export async function armPrintJustification(): Promise<void> {
  if (!armed) {
    // Chromium can fire `beforeprint` before computed styles have fully switched
    // to @media print. The media-query transition is therefore the primary
    // trigger; beforeprint is only a fallback when print styles are already
    // active.
    printMedia.addEventListener("change", onPrintMediaChange);
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    armed = true;
  }

  // Measurement must happen only after the webfont has settled.
  await document.fonts.ready;

  // Useful when this module is armed while DevTools is already emulating print.
  if (printMedia.matches) applyPrintJustification();
}

function onPrintMediaChange(event: MediaQueryListEvent): void {
  if (event.matches) applyPrintJustification();
  else restorePrintJustification();
}

function onBeforePrint(): void {
  // Never measure screen styles. If Chromium fires beforeprint first, the
  // matchMedia("print") change handler will apply the transformation once the
  // print stylesheet is actually active.
  if (printMedia.matches) applyPrintJustification();
}

function onAfterPrint(): void {
  restorePrintJustification();
}

function applyPrintJustification(): void {
  if (transformed) return;
  if (!printMedia.matches) return;

  const paragraphs = Array.from(document.querySelectorAll<HTMLElement>(".book > p"));
  const nextRestorations: Restoration[] = [];
  measurer = new DOMTextMeasurer(document);

  try {
    for (const paragraph of paragraphs) {
      try {
        const restoration = justifyParagraph(paragraph, measurer);
        if (restoration) nextRestorations.push(restoration);
      } catch (error) {
        // Exotic content in one paragraph must never prevent printing.
        console.warn("print-justify: leaving paragraph to Chromium", paragraph, error);
      }
    }
  } finally {
    measurer.dispose();
    measurer = null;
  }

  restorations = nextRestorations;
  transformed = true;
}

function restorePrintJustification(): void {
  if (!transformed) return;
  for (const restoration of restorations) restoration.restore();
  restorations = [];
  transformed = false;
}

/**
 * DevTools helper. Enable print-media emulation first, then call this export.
 */
export async function debugApplyPrintJustification(): Promise<void> {
  await document.fonts.ready;
  if (!printMedia.matches) {
    throw new Error('print-justify: enable DevTools "Emulate CSS media type: print" before debugging');
  }
  applyPrintJustification();
}

export function debugRestorePrintJustification(): void {
  restorePrintJustification();
}

interface Restoration {
  restore(): void;
}

// ---------------------------------------------------------------------------
// DOM / typography model
// ---------------------------------------------------------------------------

interface DomPoint {
  node: Node;
  offset: number;
}

interface TypographyStyle {
  key: string;
  wordSpacing: number;
  hyphens: string;
  textTransform: string;
  whiteSpace: string;
  noWrap: boolean;
  css: Record<string, string>;
}

interface Unit {
  ch: string;
  start: DomPoint;
  end: DomPoint;
  style: TypographyStyle;
}

interface LogicalSegment {
  units: Unit[];
  startPoint: DomPoint;
  endPoint: DomPoint;
}

interface WordRecord {
  startUnit: number;
  endUnit: number;
  visibleText: string;
  visibleStart: number;
  lexicalStart: number;
  sentenceInitial: boolean;
}

interface DomItemMeta {
  startPoint: DomPoint;
  endPoint: DomPoint;
  appendHyphen?: boolean;
}

type DomBox = Box & DomItemMeta;
type DomGlue = Glue & DomItemMeta;
type DomPenalty = Penalty & DomItemMeta;
type DomInputItem = DomBox | DomGlue | DomPenalty;

interface SegmentLayout {
  items: DomInputItem[];
  breakpoints: number[];
  lineWidths: number[];
  adjustmentRatios: number[];
  spaceStretchPx: number;
  spaceShrinkPx: number;
  startPoint: DomPoint;
}

interface RenderedLine {
  startPoint: DomPoint;
  endPoint: DomPoint;
  appendHyphen: boolean;
  extraWordSpacing: number;
  indent: number;
  hardBreakAfter: boolean;
  justifyToMeasure: boolean;
}

function justifyParagraph(paragraph: HTMLElement, textMeasurer: DOMTextMeasurer): Restoration | null {
  if (!paragraphIsSupported(paragraph)) return null;

  const originalChildren = Array.from(paragraph.childNodes, (node) => node.cloneNode(true));
  const originalStyle = paragraph.getAttribute("style");
  const paragraphStyle = getComputedStyle(paragraph);
  const measure = contentBoxWidth(paragraph, paragraphStyle);
  // At this point @media print is guaranteed to be active, so the computed
  // text-indent is the authoritative resolved print value. Using the CSS value
  // avoids trying to infer indentation from a glyph Range (whose geometry is
  // affected by font side-bearings). Selectors that suppress indentation after
  // headings naturally compute to 0px here.
  const indent = parseCssPx(paragraphStyle.textIndent);
  const baseWordSpacing = parseCssPx(paragraphStyle.wordSpacing);

  if (!(measure > 0)) return null;

  const segments = flattenParagraph(paragraph);
  const lang = documentLanguage();
  const languageContext = buildLanguageContext(segments, lang);
  const renderedLines: RenderedLine[] = [];

  const isDialogue = paragraph.querySelector(".dialogue") !== null;
  let maxSegmentLines = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const segmentBase = languageContext.segmentBases[segmentIndex];
    const layout = layoutSegment(
      segment,
      segmentBase,
      languageContext.sentenceInitialStarts,
      lang,
      measure,
      indent,
      baseWordSpacing,
      textMeasurer,
    );

    if (!layout) return null;

    const lines = materializeLineMetadata(layout);
    maxSegmentLines = Math.max(maxSegmentLines, lines.length);

    for (let i = 0; i < lines.length; i++) {
      renderedLines.push({
        ...lines[i],
        // The paragraph itself owns its true first-line indent. Only the first
        // line after an author-supplied <br> needs us to emulate `each-line`.
        indent: segmentIndex > 0 && i === 0 ? indent : 0,
        hardBreakAfter: i === lines.length - 1 && segmentIndex < segments.length - 1,
      });
    }
  }

  if (isDialogue && maxSegmentLines < JUSTIFICATION.dialogueMinLines) {
    return null;
  }

  // Clone every range before altering source nodes. Range endpoints still point
  // into the untouched original DOM at this stage.
  const materialized = renderedLines.map((line) => {
    const fragment = cloneRange(paragraph.ownerDocument, line.startPoint, line.endPoint);
    stripSoftHyphens(fragment);
    if (line.appendHyphen) appendHyphenToFragment(fragment, paragraph.ownerDocument);
    return { ...line, fragment };
  });

  // Convert `text-indent: ... each-line` into an ordinary first-line indent.
  // Generated Knuth–Plass <br>s must not restart indentation; source <br>s are
  // emulated separately on their first generated line below.
  // Remove the `each-line` keyword while keeping exactly the indent Chrome was
  // already painting in print mode. Generated Knuth–Plass <br>s therefore do
  // not become new indented lines.
  paragraph.style.setProperty("text-indent", `${indent}px`, "important");
  paragraph.style.setProperty("text-align", "left", "important");
  paragraph.style.setProperty("hyphens", "none", "important");
  paragraph.style.setProperty("-webkit-hyphens", "none", "important");

  const out = paragraph.ownerDocument.createDocumentFragment();
  const renderedSpans: RenderedSpanInfo[] = [];

  for (let i = 0; i < materialized.length; i++) {
    const line = materialized[i];

    const lineSpan = paragraph.ownerDocument.createElement("span");
    lineSpan.className = "print-justify-line";
    lineSpan.style.whiteSpace = "nowrap";

    // Padding belongs to the same nowrap inline box as the line, so it cannot
    // be stranded on an otherwise empty line. This is used only after a source
    // <br>; the paragraph's first line uses real CSS text-indent.
    if (line.indent > 0) {
      lineSpan.style.paddingInlineStart = `${line.indent}px`;
    }

    const finalWordSpacing = baseWordSpacing + line.extraWordSpacing;
    if (Math.abs(finalWordSpacing) > 1e-5) {
      lineSpan.style.wordSpacing = `${finalWordSpacing}px`;
    } else if (Math.abs(line.extraWordSpacing) > 1e-5) {
      // Explicitly zero inherited spacing when the required final value is zero.
      lineSpan.style.wordSpacing = "0px";
    }

    lineSpan.append(line.fragment);
    out.append(lineSpan);
    renderedSpans.push({ span: lineSpan, justifyToMeasure: line.justifyToMeasure });

    if (i < materialized.length - 1) {
      const br = paragraph.ownerDocument.createElement("br");
      if (line.hardBreakAfter) br.className = "print-justify-source-break";
      else br.className = "print-justify-break";
      out.append(br);
    }
  }

  paragraph.replaceChildren(out);

  // `tex-linebreak` chooses the breakpoints from measured boxes. Browser text
  // shaping can differ by a fraction of a pixel once all real DOM styling,
  // kerning, ligatures and variable-font features are applied. Correct each
  // materialized line against its *actual* rendered right edge. This prevents
  // cumulative measurement error from clipping words and makes the visible
  // justification exact.
  correctRenderedLineSpacing(paragraph, renderedSpans);

  return {
    restore() {
      paragraph.replaceChildren(...originalChildren.map((node) => node.cloneNode(true)));
      if (originalStyle === null) paragraph.removeAttribute("style");
      else paragraph.setAttribute("style", originalStyle);
    },
  };
}

function paragraphIsSupported(paragraph: HTMLElement): boolean {
  if (paragraph.querySelector(".dialogue")) {
    return false;
  }

  const paragraphStyle = getComputedStyle(paragraph);
  if (paragraphStyle.textTransform !== "none") {
    console.warn("print-justify: text-transform is unsupported", paragraph);
    return false;
  }

  const paragraphWordSpacing = parseCssPx(paragraphStyle.wordSpacing);

  for (const element of Array.from(paragraph.querySelectorAll<HTMLElement>("*"))) {
    if (element.tagName === "BR") continue;

    const style = getComputedStyle(element);
    if (style.display !== "inline" && style.display !== "contents") {
      // Inline-blocks/images/widgets require opaque-box mapping that this adapter
      // intentionally does not attempt. Ordinary em/strong/a/span markup is fine.
      console.warn("print-justify: non-inline descendant is unsupported", element);
      return false;
    }

    if (style.textTransform !== "none") {
      console.warn("print-justify: descendant text-transform is unsupported", element);
      return false;
    }

    // We render a line with one additive CSS word-spacing value. If an inline
    // descendant establishes a different spacing value, leave the paragraph to
    // Chromium rather than measure one thing and render another.
    if (Math.abs(parseCssPx(style.wordSpacing) - paragraphWordSpacing) > 1e-4) {
      console.warn("print-justify: mixed word-spacing is unsupported", element);
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Flatten DOM while preserving author-supplied <br>s
// ---------------------------------------------------------------------------

interface PendingWhitespace {
  start: DomPoint;
  end: DomPoint;
  style: TypographyStyle;
}

function flattenParagraph(paragraph: HTMLElement): LogicalSegment[] {
  const segments: LogicalSegment[] = [];
  const styleCache = new WeakMap<Element, TypographyStyle>();

  let units: Unit[] = [];
  let pendingWhitespace: PendingWhitespace | null = null;
  let segmentStart: DomPoint = { node: paragraph, offset: 0 };

  const styleFor = (element: Element): TypographyStyle => {
    const cached = styleCache.get(element);
    if (cached) return cached;
    const style = typographyStyle(getComputedStyle(element));
    styleCache.set(element, style);
    return style;
  };

  const flushWhitespaceBeforeText = (): void => {
    if (!pendingWhitespace) return;
    if (units.length > 0) {
      units.push({
        ch: " ",
        start: pendingWhitespace.start,
        end: pendingWhitespace.end,
        style: pendingWhitespace.style,
      });
    }
    pendingWhitespace = null;
  };

  const pushSegment = (endPoint: DomPoint): void => {
    // Trailing collapsible whitespace disappears at a hard/end-of-block break.
    pendingWhitespace = null;
    segments.push({ units, startPoint: segmentStart, endPoint });
    units = [];
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const parent = textNode.parentElement ?? paragraph;
      const style = styleFor(parent);
      const text = textNode.data;

      for (let offset = 0; offset < text.length; ) {
        const codePoint = text.codePointAt(offset)!;
        const ch = String.fromCodePoint(codePoint);
        const next = offset + ch.length;
        const start = { node: textNode, offset };
        const end = { node: textNode, offset: next };

        if (isCollapsibleWhitespace(ch)) {
          if (pendingWhitespace === null) {
            pendingWhitespace = { start, end, style };
          } else {
            pendingWhitespace.end = end;
          }
        } else {
          flushWhitespaceBeforeText();
          units.push({ ch, start, end, style });
        }

        offset = next;
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;

    if (element.tagName === "BR") {
      const parent = element.parentNode!;
      const index = childIndex(element);
      pushSegment({ node: parent, offset: index });
      segmentStart = { node: parent, offset: index + 1 };
      return;
    }

    for (const child of Array.from(element.childNodes)) visit(child);
  };

  for (const child of Array.from(paragraph.childNodes)) visit(child);
  pushSegment({ node: paragraph, offset: paragraph.childNodes.length });

  return segments;
}

function isCollapsibleWhitespace(ch: string): boolean {
  // NBSP / NNBSP intentionally remain ordinary visible units.
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function childIndex(node: Node): number {
  let index = 0;
  for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) index++;
  return index;
}

// ---------------------------------------------------------------------------
// Language context / Romanian editorial protections
// ---------------------------------------------------------------------------

interface LanguageContext {
  paragraphText: string;
  segmentBases: number[];
  sentenceInitialStarts: Set<number>;
}

function buildLanguageContext(segments: LogicalSegment[], lang: string): LanguageContext {
  const segmentBases: number[] = [];
  let paragraphText = "";

  for (let i = 0; i < segments.length; i++) {
    segmentBases.push(paragraphText.length);
    paragraphText += visibleSegmentText(segments[i]);
    if (i < segments.length - 1) paragraphText += "\n";
  }

  return {
    paragraphText,
    segmentBases,
    sentenceInitialStarts: sentenceInitialWordStarts(paragraphText, lang),
  };
}

function visibleSegmentText(segment: LogicalSegment): string {
  let text = "";
  for (const unit of segment.units) {
    if (unit.ch !== "\u00ad") text += unit.ch;
  }
  return text;
}

function sentenceInitialWordStarts(text: string, lang: string): Set<number> {
  const starts = new Set<number>();

  try {
    const sentenceSegmenter = new Intl.Segmenter(lang, { granularity: "sentence" });
    const wordSegmenter = new Intl.Segmenter(lang, { granularity: "word" });

    for (const sentence of sentenceSegmenter.segment(text)) {
      for (const word of wordSegmenter.segment(sentence.segment)) {
        if (word.isWordLike) {
          starts.add(sentence.index + word.index);
          break;
        }
      }
    }
  } catch {
    // Chromium versions capable of running the rest of this code have
    // Intl.Segmenter. This fallback just makes failure conservative.
    const match = /\p{L}/u.exec(text);
    if (match?.index !== undefined) starts.add(match.index);
  }

  return starts;
}

function isRomanianProtectedWord(word: WordRecord): boolean {
  const text = word.visibleText;

  // House/editorial rule: do not divide any Romanian orthographic group that
  // already contains a visible hyphen. This covers să-i, i-am, într-o, etc.,
  // and intentionally extends the same protection to longer compounds.
  if (JUSTIFICATION.protectRomanianHyphenatedWords && /[-\u2010\u2011]/u.test(text)) {
    return true;
  }

  // Probable proper names: protect title-case words in mid-sentence. Sentence-
  // initial title-case words are left to the normal hyphenator because their
  // capitalization alone carries no proper-name information.
  return JUSTIFICATION.protectRomanianMidSentenceTitlecase && !word.sentenceInitial && isTitleCaseLexeme(text);
}

function isTitleCaseLexeme(text: string): boolean {
  const letters = Array.from(text).filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 2) return false;

  const first = letters[0];
  const rest = letters.slice(1).join("");
  const firstIsCasedUpper = first === first.toLocaleUpperCase("ro") && first !== first.toLocaleLowerCase("ro");
  const restHasCasedLetter = Array.from(rest).some((ch) => ch.toLocaleUpperCase("ro") !== ch.toLocaleLowerCase("ro"));
  const restIsLower = rest === rest.toLocaleLowerCase("ro");

  return firstIsCasedUpper && restHasCasedLetter && restIsLower;
}

function firstLetterOffset(text: string): number {
  let offset = 0;
  for (const ch of Array.from(text)) {
    if (/\p{L}/u.test(ch)) return offset;
    offset += ch.length;
  }
  return 0;
}

function documentLanguage(): string {
  const lang = (document.documentElement.lang || "en").trim().toLowerCase();
  return lang || "en";
}

function isRomanian(lang: string): boolean {
  return lang === "ro" || lang.startsWith("ro-");
}

function hyphenateToken(text: string, lang: string): string {
  const options = {
    minWordLength: JUSTIFICATION.hyphenMinWordLength,
    html: false,
  };

  if (isRomanian(lang)) return hyphenateRo(text, options);
  if (lang === "en" || lang.startsWith("en-")) return hyphenateEn(text, options);

  // German is intentionally easy to add later:
  //   import { hyphenateSync as hyphenateDe } from "hyphen/de";
  //   if (lang === "de" || lang.startsWith("de-")) return hyphenateDe(text, options);
  return hyphenateEn(text, options);
}

// ---------------------------------------------------------------------------
// DOM -> Knuth–Plass box/glue/penalty items
// ---------------------------------------------------------------------------

function layoutSegment(
  segment: LogicalSegment,
  segmentBase: number,
  sentenceInitialStarts: Set<number>,
  lang: string,
  measure: number,
  indent: number,
  baseWordSpacing: number,
  textMeasurer: DOMTextMeasurer,
): SegmentLayout | null {
  if (segment.units.length === 0) {
    // Preserve an author-supplied blank line between two <br>s.
    const endPenalty: DomPenalty = {
      ...forcedBreak(),
      startPoint: segment.endPoint,
      endPoint: segment.endPoint,
      appendHyphen: false,
    };
    return {
      items: [endPenalty],
      breakpoints: [0, 0],
      lineWidths: [Math.max(1, measure - indent)],
      adjustmentRatios: [0],
      spaceStretchPx: 0,
      spaceShrinkPx: 0,
      startPoint: segment.startPoint,
    };
  }

  const styleWordSpacing = new Set(segment.units.map((unit) => Math.round(unit.style.wordSpacing * 1000) / 1000));
  if (styleWordSpacing.size > 1 || Math.abs(segment.units[0].style.wordSpacing - baseWordSpacing) > 1e-4) {
    return null;
  }

  const words = collectWords(segment, segmentBase, sentenceInitialStarts);
  if (words.length === 0) return null;

  const paragraphStyle = segment.units[0].style;
  const naturalSpace = textMeasurer.measure(" ", paragraphStyle);
  const glueStretch = naturalSpace * JUSTIFICATION.spaceStretch;
  const glueShrink = naturalSpace * JUSTIFICATION.spaceShrink;

  const items: DomInputItem[] = [];

  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex];
    addWordItems(items, segment.units, word, lang, textMeasurer);

    if (wordIndex < words.length - 1) {
      const spaceUnit = segment.units[word.endUnit];
      if (!spaceUnit || !isBreakableSpaceUnit(spaceUnit)) return null;

      const glue: DomGlue = {
        type: "glue",
        width: textMeasurer.measure(" ", spaceUnit.style),
        stretch: glueStretch,
        shrink: glueShrink,
        startPoint: spaceUnit.start,
        endPoint: spaceUnit.end,
      };
      items.push(glue);
    }
  }

  // The finishing glue lets the final line remain ragged if it naturally fits.
  items.push({
    type: "glue",
    width: 0,
    stretch: MAX_COST,
    shrink: 0,
    startPoint: segment.endPoint,
    endPoint: segment.endPoint,
  });
  items.push({
    ...forcedBreak(),
    startPoint: segment.endPoint,
    endPoint: segment.endPoint,
    appendHyphen: false,
  });

  // A segment can never need more lines than it has content items. Supplying an
  // array is useful because the first line after every source <br> is shorter by
  // the text indent, while wrapped continuation lines use the full measure.
  const lineWidths = new Array(Math.max(2, items.length + 1)).fill(measure);
  lineWidths[0] = Math.max(1, measure - indent);

  try {
    const breakpoints = breakLines(items, lineWidths, {
      initialMaxAdjustmentRatio: JUSTIFICATION.initialMaxAdjustmentRatio,
      maxAdjustmentRatio: JUSTIFICATION.maxAdjustmentRatio,
      doubleHyphenPenalty: JUSTIFICATION.doubleHyphenPenalty,
      adjacentLooseTightPenalty: JUSTIFICATION.adjacentLooseTightPenalty,
    });
    const ratios = adjustmentRatios(items, lineWidths, breakpoints);

    return {
      items,
      breakpoints,
      lineWidths,
      adjustmentRatios: ratios,
      spaceStretchPx: glueStretch,
      spaceShrinkPx: glueShrink,
      startPoint: segment.startPoint,
    };
  } catch (error) {
    if (error instanceof MaxAdjustmentExceededError) {
      console.warn("print-justify: adjustment limit exceeded; using Chromium");
      return null;
    }
    throw error;
  }
}

function collectWords(segment: LogicalSegment, segmentBase: number, sentenceInitialStarts: Set<number>): WordRecord[] {
  // A "word" here is really an unbroken text atom between *breakable* spaces.
  // Spaces inside `white-space: nowrap` descendants stay inside the atom, so a
  // `.no-wrap` phrase is presented to Knuth–Plass as one box instead of several
  // words separated by legal glue breakpoints.
  const words: WordRecord[] = [];
  let unitIndex = 0;
  let visibleOffset = 0;

  while (unitIndex < segment.units.length) {
    const startUnit = unitIndex;
    const visibleStart = visibleOffset;
    let visibleText = "";

    while (unitIndex < segment.units.length && !isBreakableSpaceUnit(segment.units[unitIndex])) {
      const ch = segment.units[unitIndex].ch;
      if (ch !== "\u00ad") {
        visibleText += ch;
        visibleOffset += ch.length;
      }
      unitIndex++;
    }

    const endUnit = unitIndex;
    if (endUnit > startUnit && visibleText.length > 0) {
      const lexicalStart = firstLetterOffset(visibleText);
      words.push({
        startUnit,
        endUnit,
        visibleText,
        visibleStart,
        lexicalStart,
        sentenceInitial: sentenceInitialStarts.has(segmentBase + visibleStart + lexicalStart),
      });
    }

    if (unitIndex < segment.units.length && isBreakableSpaceUnit(segment.units[unitIndex])) {
      visibleOffset += 1;
      unitIndex++;
    }
  }

  return words;
}

function isBreakableSpaceUnit(unit: Unit): boolean {
  return unit.ch === " " && !unit.style.noWrap;
}

interface CandidateBreak {
  unitIndex: number;
  appendHyphen: boolean;
  explicit: boolean;
}

function addWordItems(
  items: DomInputItem[],
  units: Unit[],
  word: WordRecord,
  lang: string,
  textMeasurer: DOMTextMeasurer,
): void {
  const candidates = candidateBreaks(units, word, lang);
  let cursor = word.startUnit;

  for (const candidate of candidates) {
    if (candidate.unitIndex <= cursor || candidate.unitIndex >= word.endUnit) continue;

    addBox(items, units, cursor, candidate.unitIndex, textMeasurer);

    const point = boundaryPoint(units, candidate.unitIndex);
    const previousVisible = previousVisibleUnit(units, candidate.unitIndex, word.startUnit);
    if (!previousVisible) continue;

    const penalty: DomPenalty = {
      type: "penalty",
      width: candidate.appendHyphen ? textMeasurer.measure("-", previousVisible.style) : 0,
      cost: candidate.explicit ? JUSTIFICATION.explicitHyphenPenalty : JUSTIFICATION.hyphenPenalty,
      flagged: true,
      startPoint: point,
      endPoint: point,
      appendHyphen: candidate.appendHyphen,
    };
    items.push(penalty);
    cursor = candidate.unitIndex;
  }

  addBox(items, units, cursor, word.endUnit, textMeasurer);
}

function addBox(items: DomInputItem[], units: Unit[], start: number, end: number, textMeasurer: DOMTextMeasurer): void {
  if (end <= start) return;

  const box: DomBox = {
    type: "box",
    width: measureUnitRange(units, start, end, textMeasurer),
    startPoint: boundaryPoint(units, start),
    endPoint: boundaryPoint(units, end),
  };
  items.push(box);
}

function candidateBreaks(units: Unit[], word: WordRecord, lang: string): CandidateBreak[] {
  const candidates = new Map<number, CandidateBreak>();
  const romanianProtected = isRomanian(lang) && isRomanianProtectedWord(word);
  const containsNonBreakingHyphen = word.visibleText.includes("‑");
  const sourceNoWrap = units.slice(word.startUnit, word.endUnit).some((unit) => unit.style.noWrap);

  // `white-space: nowrap` means no browser-created break anywhere in this
  // source range, including dictionary hyphenation. The whole range remains a
  // box, while outer breakable spaces are still available to Knuth–Plass.
  if (sourceNoWrap) return [];

  // Existing soft hyphens are manual discretionary points. `hyphens:none`
  // suppresses them; Romanian protected words suppress all division, including
  // author-supplied SHY points.
  for (let u = word.startUnit; u < word.endUnit; u++) {
    if (!romanianProtected && units[u].ch === "\u00ad" && units[u].style.hyphens !== "none") {
      candidates.set(u + 1, {
        unitIndex: u + 1,
        appendHyphen: true,
        explicit: false,
      });
    }
  }

  if (!romanianProtected) {
    // Visible ordinary hyphens are legal breakpoints in non-Romanian text.
    // U+2011 NON-BREAKING HYPHEN is deliberately excluded everywhere.
    for (let u = word.startUnit; u < word.endUnit; u++) {
      if ((units[u].ch === "-" || units[u].ch === "\u2010") && u + 1 < word.endUnit) {
        candidates.set(u + 1, {
          unitIndex: u + 1,
          appendHyphen: false,
          explicit: true,
        });
      }
    }
  }

  const automaticHyphenation =
    !romanianProtected &&
    !containsNonBreakingHyphen &&
    Array.from({ length: word.endUnit - word.startUnit }, (_, i) => units[word.startUnit + i])
      .filter((unit) => unit.ch !== "\u00ad")
      .every((unit) => unit.style.hyphens === "auto");

  if (automaticHyphenation) {
    const visibleUnits: Unit[] = [];
    const visibleBoundaryToUnitIndex: number[] = [word.startUnit];
    for (let u = word.startUnit; u < word.endUnit; u++) {
      if (units[u].ch === "\u00ad") continue;
      visibleUnits.push(units[u]);

      // If the source already has SHY characters at this visible boundary,
      // normalize an automatic candidate to the point *after* them. This makes
      // manual and dictionary candidates at the same visual location collapse
      // to one penalty instead of creating a zero-width box between two SHYs.
      let boundary = u + 1;
      while (boundary < word.endUnit && units[boundary].ch === "\u00ad") boundary++;
      visibleBoundaryToUnitIndex.push(boundary);
    }

    const hyphenated = hyphenateToken(word.visibleText, lang);
    let consumedCodePoints = 0;

    for (const ch of Array.from(hyphenated)) {
      if (ch === "\u00ad") {
        if (consumedCodePoints > 0 && consumedCodePoints < visibleUnits.length) {
          const unitIndex = visibleBoundaryToUnitIndex[consumedCodePoints];
          candidates.set(unitIndex, {
            unitIndex,
            appendHyphen: true,
            explicit: false,
          });
        }
      } else {
        consumedCodePoints++;
      }
    }
  }

  return Array.from(candidates.values()).sort((a, b) => a.unitIndex - b.unitIndex);
}

function previousVisibleUnit(units: Unit[], from: number, min: number): Unit | null {
  for (let i = from - 1; i >= min; i--) {
    if (units[i].ch !== "\u00ad") return units[i];
  }
  return null;
}

function boundaryPoint(units: Unit[], unitIndex: number): DomPoint {
  if (unitIndex <= 0) return units[0].start;
  if (unitIndex >= units.length) return units[units.length - 1].end;
  return units[unitIndex - 1].end;
}

// ---------------------------------------------------------------------------
// Knuth–Plass result -> line ranges / CSS spacing
// ---------------------------------------------------------------------------

function materializeLineMetadata(layout: SegmentLayout): Omit<RenderedLine, "indent" | "hardBreakAfter">[] {
  const { items, breakpoints, adjustmentRatios: ratios } = layout;
  const lines: Omit<RenderedLine, "indent" | "hardBreakAfter">[] = [];

  // tex-linebreak returns a synthetic paragraph-start entry at index 0.
  for (let b = 1; b < breakpoints.length; b++) {
    const breakpoint = breakpoints[b];
    const previousBreakpoint = b > 1 ? breakpoints[b - 1] : PARAGRAPH_START;
    const startIndex = lineContentStart(items, previousBreakpoint, breakpoint);
    const endItem = items[breakpoint];

    if (startIndex > breakpoint) {
      // Empty segment / blank source line.
      const point = endItem.startPoint;
      lines.push({
        startPoint: point,
        endPoint: point,
        appendHyphen: false,
        extraWordSpacing: 0,
        justifyToMeasure: false,
      });
      continue;
    }

    const startItem = items[startIndex];
    const ratio = ratios[b - 1] ?? 0;
    const isFinalLine = b === breakpoints.length - 1;
    let extraWordSpacing = 0;

    if (Number.isFinite(ratio)) {
      if (isFinalLine && ratio >= 0) {
        // The finishing glue makes an underfull final line feasible without
        // visibly expanding ordinary spaces. Keep such lines ragged. Any
        // negative ratio is retained so an overfull final line cannot clip.
        extraWordSpacing = 0;
      } else if (ratio < 0) {
        extraWordSpacing = ratio * layout.spaceShrinkPx;
      } else {
        extraWordSpacing = ratio * layout.spaceStretchPx;
      }
    }

    lines.push({
      // Include leading empty inline marker elements (eg. `.dialogue`) on the
      // first physical line so selectors such as `p:has(.dialogue)` remain true
      // while the print DOM is materialized.
      startPoint: b === 1 ? layout.startPoint : startItem.startPoint,
      endPoint: endItem.startPoint,
      appendHyphen: endItem.type === "penalty" && Boolean(endItem.appendHyphen),
      extraWordSpacing,
      justifyToMeasure: !isFinalLine,
    });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Real-DOM print measurement
// ---------------------------------------------------------------------------

class DOMTextMeasurer {
  private root: HTMLDivElement;
  private span: HTMLSpanElement;
  private cache = new Map<string, number>();

  constructor(doc: Document) {
    this.root = doc.createElement("div");
    this.root.setAttribute("aria-hidden", "true");
    this.root.style.position = "fixed";
    this.root.style.left = "-100000px";
    this.root.style.top = "0";
    this.root.style.visibility = "hidden";
    this.root.style.pointerEvents = "none";
    this.root.style.whiteSpace = "pre";
    this.root.style.width = "max-content";
    this.root.style.contain = "layout style paint";
    this.root.style.zIndex = "-2147483648";

    this.span = doc.createElement("span");
    this.span.style.whiteSpace = "pre";
    this.root.append(this.span);
    doc.body.append(this.root);
  }

  measure(text: string, typography: TypographyStyle): number {
    if (text.length === 0) return 0;

    const cleanText = text.replaceAll("\u00ad", "");
    const cacheKey = `${typography.key}\u0000${cleanText}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    this.applyStyle(typography);
    this.span.textContent = cleanText;
    const width = this.span.getBoundingClientRect().width;
    this.cache.set(cacheKey, width);
    return width;
  }

  dispose(): void {
    this.root.remove();
    this.cache.clear();
  }

  private applyStyle(typography: TypographyStyle): void {
    const style = this.span.style;
    style.cssText = "white-space: pre;";
    for (const [property, value] of Object.entries(typography.css)) {
      if (value) style.setProperty(property, value);
    }
  }
}

function measureUnitRange(units: Unit[], start: number, end: number, textMeasurer: DOMTextMeasurer): number {
  let width = 0;
  let runStyle: TypographyStyle | null = null;
  let runText = "";

  const flush = (): void => {
    if (!runStyle || runText.length === 0) return;
    width += textMeasurer.measure(runText, runStyle);
    runText = "";
  };

  for (let i = start; i < end; i++) {
    const unit = units[i];
    if (unit.ch === "\u00ad") continue;

    if (runStyle && runStyle.key === unit.style.key) {
      runText += unit.ch;
    } else {
      flush();
      runStyle = unit.style;
      runText = unit.ch;
    }
  }

  flush();
  return width;
}

function typographyStyle(style: CSSStyleDeclaration): TypographyStyle {
  const css: Record<string, string> = {
    "font-family": style.fontFamily,
    "font-size": style.fontSize,
    "font-style": style.fontStyle,
    "font-weight": style.fontWeight,
    "font-stretch": style.fontStretch,
    "font-kerning": style.fontKerning,
    "font-variant-caps": style.fontVariantCaps,
    "font-variant-ligatures": style.fontVariantLigatures,
    "font-variant-numeric": style.fontVariantNumeric,
    "font-variant-east-asian": style.fontVariantEastAsian,
    "font-variant-position": style.fontVariantPosition,
    "font-feature-settings": style.fontFeatureSettings,
    "font-variation-settings": style.fontVariationSettings,
    "font-optical-sizing": style.fontOpticalSizing,
    "font-size-adjust": style.fontSizeAdjust,
    "font-synthesis": style.fontSynthesis,
    "letter-spacing": style.letterSpacing,
    "word-spacing": style.wordSpacing,
    "text-rendering": style.textRendering,
    "text-transform": style.textTransform,
  };

  const webkitTextSizeAdjust = style.getPropertyValue("-webkit-text-size-adjust");
  if (webkitTextSizeAdjust) css["-webkit-text-size-adjust"] = webkitTextSizeAdjust;

  const hyphens = style.hyphens || style.getPropertyValue("-webkit-hyphens") || "manual";

  return {
    key: JSON.stringify(css),
    wordSpacing: parseCssPx(style.wordSpacing),
    hyphens,
    textTransform: style.textTransform,
    whiteSpace: style.whiteSpace,
    noWrap: whiteSpaceDisallowsWrapping(style.whiteSpace),
    css,
  };
}

function whiteSpaceDisallowsWrapping(whiteSpace: string): boolean {
  // CSS `nowrap` and `pre` forbid soft wrapping. `pre-wrap`, `pre-line` and
  // `break-spaces` still allow wrapping and therefore remain breakable.
  return whiteSpace === "nowrap" || whiteSpace === "pre";
}

function contentBoxRight(element: HTMLElement, style: CSSStyleDeclaration): number {
  const rect = element.getBoundingClientRect();
  return rect.right - parseCssPx(style.borderRightWidth) - parseCssPx(style.paddingRight);
}

interface RenderedSpanInfo {
  span: HTMLSpanElement;
  justifyToMeasure: boolean;
}

function correctRenderedLineSpacing(paragraph: HTMLElement, lines: RenderedSpanInfo[]): void {
  const paragraphStyle = getComputedStyle(paragraph);
  const targetRight = contentBoxRight(paragraph, paragraphStyle);

  // Do not estimate the number of rendered spaces from textContent. HTML
  // whitespace collapsing, trailing source whitespace and nested inline markup
  // can make that count differ from the number of spaces which actually respond
  // to CSS word-spacing. Instead probe the browser: increasing word-spacing by
  // exactly 1px tells us how many adjustable spaces this rendered line contains.
  // This also automatically follows Chromium's real shaping and inheritance.
  for (let pass = 0; pass < 3; pass++) {
    for (const { span, justifyToMeasure } of lines) {
      const rect = span.getBoundingClientRect();
      const delta = targetRight - rect.right;

      // Normal paragraph/source-<br> final lines stay ragged if underfull, but
      // an overfull final line must still be shrunk to prevent clipping.
      if (!justifyToMeasure && delta >= -0.02) continue;
      if (Math.abs(delta) < 0.02) continue;

      const current = parseCssPx(getComputedStyle(span).wordSpacing);
      const probePx = 1;
      const rightBeforeProbe = rect.right;

      span.style.wordSpacing = `${current + probePx}px`;
      const rightAfterProbe = span.getBoundingClientRect().right;
      const sensitivity = (rightAfterProbe - rightBeforeProbe) / probePx;

      // Restore the current value before applying the actual correction.
      span.style.wordSpacing = `${current}px`;

      if (!(sensitivity > 0.01)) {
        if (delta < -0.02) {
          console.warn("print-justify: overfull line has no adjustable inherited spaces", span, { overflowPx: -delta });
        }
        continue;
      }

      const correction = delta / sensitivity;
      const next = current + correction;
      span.style.wordSpacing = `${next}px`;

      // Useful when inspecting a frozen print DOM in DevTools.
      span.dataset.printJustifyCorrection = correction.toFixed(5);
      span.dataset.printJustifySpaceSensitivity = sensitivity.toFixed(3);
    }
  }

  // Record the final geometric error. If these values are around zero but the
  // black glyph contours still appear microscopically ragged, that is optical
  // side-bearing / punctuation overhang rather than failed justification.
  for (const { span, justifyToMeasure } of lines) {
    if (!justifyToMeasure) continue;
    const residual = targetRight - span.getBoundingClientRect().right;
    span.dataset.printJustifyRightError = residual.toFixed(4);
  }
}

function contentBoxWidth(element: HTMLElement, style: CSSStyleDeclaration): number {
  const rect = element.getBoundingClientRect();
  return (
    rect.width -
    parseCssPx(style.borderLeftWidth) -
    parseCssPx(style.borderRightWidth) -
    parseCssPx(style.paddingLeft) -
    parseCssPx(style.paddingRight)
  );
}

function parseCssPx(value: string): number {
  if (!value || value === "normal") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function cloneRange(document: Document, start: DomPoint, end: DomPoint): DocumentFragment {
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range.cloneContents();
}

function stripSoftHyphens(fragment: DocumentFragment): void {
  const walker = fragment.ownerDocument!.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    if (node.data.includes("\u00ad")) node.data = node.data.replaceAll("\u00ad", "");
  }
}

function appendHyphenToFragment(fragment: DocumentFragment, document: Document): void {
  // cloneContents recreates partial inline ancestry; descending into the final
  // cloned element keeps the materialized hyphen inside the same em/span/etc.
  let container: Node = fragment;
  while (container.lastChild?.nodeType === Node.ELEMENT_NODE) {
    container = container.lastChild;
  }
  container.appendChild(document.createTextNode("-"));
}
