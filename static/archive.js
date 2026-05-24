"use strict";

// Display math tags have position: fixed and are therefore taken out
// of the document flow. When the display math containers overflow
// the tags overlap with the equation. The script below adds additional
// spacing to the right side as needed on overflow such that there is
// enough scroll space for the tag to not show above the equation,
// while still keeping the equation itself perfectly centered.
// A noscript fallback adds a fixed padding to the right to make space
// for the tag. This slightly decenters equations, though.

/**
 * The threshold at which to trigger overflow, the size of the
 * math equation at the same height as the tag and the size of the
 * full equation are precomputed on page load. The content is static
 * and the computation is expensive due to many getBoundingClientRect calls.
 *
 * @type {Map<Element, { thresh: number, math: number, base: number }>}
 */
const widths = new Map();

const o = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const e = /** @type {HTMLElement} **/ (entry.target);
    const { math, thresh, base } = widths.get(e);
    const { inlineSize } = entry.borderBoxSize[0];
    const delta = inlineSize - math;

    if (e.classList.contains("overflow") && delta > thresh) {
      e.classList.remove("overflow");
    } else if (!e.classList.contains("overflow") && delta <= thresh) {
      e.classList.add("overflow");
    }

    if (e.classList.contains("overflow")) {
      // Overflow sets left alignment so the script
      // repositions the equation to be centered again.
      e.style.setProperty("--offset", (inlineSize - base) / 2 + "px");
    }
  }
});

/**
 * @param {DOMRect} a
 * @param {DOMRect} b
 */
function intersect(a, b) {
  return a.top <= b.bottom && b.top <= a.bottom;
}

/** @typedef {{ left: number, right: number }} Interval */

/** @satisfies {Interval} */
const EMPTY = { left: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY };

/**
 * @param {Readonly<Interval>} a
 * @param  {Readonly<Interval>} b
 * @returns {Interval}
 */
function union(a, b) {
  return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
}

/**
 * @param {Element} e
 * @param {readonly string[]} prefixes
 */
function hasClassPrefix(e, ...prefixes) {
  for (const c of e.classList) {
    for (const prefix of prefixes) {
      if (c.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get the start and end of all elements within bases
 * which can overlap with tag on overflow – i.e. all
 * elements positioned at the same height.
 *
 * @param {readonly Element[]} bases
 * @param {DOMRect} tag
 * @returns {Readonly<Interval>}
 */
function mathSize(bases, tag) {
  const s = [...bases];

  let ret = EMPTY;
  while (s.length) {
    const e = s.pop();
    if (e.children.length === 0 || e instanceof SVGElement) {
      const rect = e.getBoundingClientRect();
      if ((e instanceof SVGElement || hasClassPrefix(e, "m", "delim")) && intersect(rect, tag)) {
        ret = union(ret, rect);
      }
    } else {
      s.push(...e.children);
    }
  }

  return ret;
}

for (const e of /** @type {NodeListOf<HTMLElement>} **/ (document.querySelectorAll(".katex-display:has(.tag)"))) {
  const container = e.getBoundingClientRect();
  const bases = /** @type {HTMLElement[]} */ ([...e.querySelectorAll(".katex-html > .base")]);
  const base = bases.reduce((m, e) => union(m, e.getBoundingClientRect()), EMPTY);
  const tag = e.querySelector(".tag .mord.text").getBoundingClientRect();
  const math = mathSize(bases, tag);

  const spaceForTag = Math.max(base.right - math.right, 0);
  if (spaceForTag >= tag.width) {
    continue;
  }

  e.style.setProperty("--tag-size", tag.width - spaceForTag + "px");
  widths.set(e, { thresh: tag.width, math: math.right - container.left, base: base.right - base.left });

  o.observe(e);
}
