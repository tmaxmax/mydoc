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
    const rem = getREM();
    const { inlineSize } = entry.borderBoxSize[0];
    const delta = inlineSize / rem - math;

    if (e.classList.contains("overflow") && delta > thresh) {
      e.classList.remove("overflow");
    } else if (!e.classList.contains("overflow") && delta <= thresh) {
      e.classList.add("overflow");
    }

    if (e.classList.contains("overflow")) {
      // Overflow sets left alignment so the script
      // repositions the equation to be centered again.
      e.style.setProperty("--offset", (inlineSize / rem - base) / 2 + "rem");
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

function getREM() {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

const rem = getREM();
for (const e of /** @type {NodeListOf<HTMLElement>} **/ (document.querySelectorAll(".katex-display:has(.tag)"))) {
  const container = e.getBoundingClientRect();
  const bases = /** @type {HTMLElement[]} */ ([...e.querySelectorAll(".katex-html > .base")]);
  const base = bases.reduce((m, e) => union(m, e.getBoundingClientRect()), EMPTY);
  const tag = e.querySelector(".tag .mord.text").getBoundingClientRect();
  const math = mathSize(bases, tag);
  const width = {
    thresh: tag.width / rem,
    math: (math.right - container.left) / rem,
    base: (base.right - base.left) / rem,
  };
  const spaceForTag = Math.max(base.right - math.right, 0) / rem;

  if (spaceForTag >= width.thresh) {
    continue;
  }

  e.style.setProperty("--tag-size", width.thresh - spaceForTag + "rem");
  if (Math.max(width.base - spaceForTag, width.math) + width.thresh >= 650 / 24) {
    e.classList.add("overflow");
    continue;
  }

  widths.set(e, width);
  o.observe(e);
}

const darkMode = window.matchMedia("(prefers-color-scheme: dark)");
const darkModeInput = /** @type {HTMLFieldSetElement} */ (document.querySelector("#dark-mode"));
const darkModeStorageKey = "darkMode";

function prefersDarkMode() {
  const value = window.localStorage.getItem(darkModeStorageKey);
  if (!value) {
    return null;
  }
  return value === "true";
}

/** @param {boolean | null} isDark */
function darkModeToInput(isDark) {
  return isDark === null ? "system" : isDark === darkMode.matches ? "self" : "other";
}

/** @param {boolean | null} isDark */
function setDarkMode(isDark) {
  /** @type {HTMLInputElement} */ (darkModeInput.querySelector(":checked")).checked = false;
  /** @type {HTMLInputElement} */ (darkModeInput.querySelector(`#dark-${darkModeToInput(isDark)}`)).checked = true;
}

darkModeInput.addEventListener("change", (e) => {
  const { value } = /** @type {HTMLInputElement} */ (e.target);
  const isDark = value === "self" ? darkMode.matches : value === "other" ? !darkMode.matches : null;
  if (isDark !== null) {
    window.localStorage.setItem(darkModeStorageKey, isDark.toString());
  } else {
    window.localStorage.removeItem(darkModeStorageKey);
  }
});

window.addEventListener("storage", (e) => {
  if (e.key === darkModeStorageKey) {
    setDarkMode(e.newValue === null ? null : e.newValue === "true");
  }
});

darkMode.addEventListener("change", () => {
  setDarkMode(prefersDarkMode());
});

setDarkMode(prefersDarkMode());
darkModeInput.classList.add("system");
