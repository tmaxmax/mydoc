"use strict";

/** @type {Map<Element, { thresh: number, math: number, base: number }>} */
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
 * @param {Element} e
 * @param {DOMRect} tag
 * @returns {Readonly<Interval>}
 */
function mathSize(e, tag) {
  const rect = e.getBoundingClientRect();
  if (e.children.length === 0 || e instanceof SVGElement) {
    const inter = (e instanceof SVGElement || hasClassPrefix(e, "m", "delim")) && intersect(rect, tag);
    return inter ? rect : EMPTY;
  }

  let s = EMPTY;
  for (const c of e.children) {
    s = union(s, mathSize(c, tag));
  }

  return s;
}

for (const e of /** @type {NodeListOf<HTMLElement>} **/ (document.querySelectorAll(".katex-display:has(.tag)"))) {
  const container = e.getBoundingClientRect();
  const bases = /** @type {HTMLElement[]} */ ([...e.querySelectorAll(".katex-html > .base")]);
  const base = bases.reduce((m, e) => union(m, e.getBoundingClientRect()), EMPTY);
  const tag = e.querySelector(".tag .mord.text").getBoundingClientRect();
  const math = bases.reduce((m, e) => union(m, mathSize(e, tag)), EMPTY);

  const spaceForTag = Math.max(base.right - math.right, 0);
  if (spaceForTag >= tag.width) {
    continue;
  }

  e.style.setProperty("--tag-size", tag.width - spaceForTag + "px");
  widths.set(e, { thresh: tag.width, math: math.right - container.left, base: base.right - base.left });

  o.observe(e);
}
