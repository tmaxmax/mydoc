"use strict";

const widths = new Map();

const o = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const e = entry.target;
    const { math, thresh, base } = widths.get(e);
    const delta = e.clientWidth - math;

    if (e.classList.contains("overflow") && delta > thresh) {
      e.classList.remove("overflow");
    } else if (!e.classList.contains("overflow") && delta <= thresh) {
      e.classList.add("overflow");
    }

    if (e.classList.contains("overflow")) {
      e.style.setProperty("--offset", ((e.clientWidth - base) / 2).toString() + "px");
    }
  }
});

function intersect(a, b) {
  return a.y <= b.y + b.height && b.y <= a.y + a.height;
}

function union([a, b], [x, y]) {
  return [Math.min(a, x), Math.max(b, y)];
}

const EMPTY = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

function mathSize(e, tag) {
  const rect = e.getBoundingClientRect();
  if (e.children.length === 0 || e instanceof SVGElement) {
    const inter = (e instanceof SVGElement || [...e.classList].some((c) => c.startsWith("m"))) && intersect(rect, tag);
    return inter ? [rect.x, rect.x + rect.width] : EMPTY;
  }

  return [...e.children].reduce((s, e) => union(s, mathSize(e, tag)), EMPTY);
}

for (const e of document.querySelectorAll(".katex-display:has(.tag)")) {
  const tagWidth = e.querySelector(".tag").scrollWidth;
  const tag = e.querySelector(".tag .mord.text").getBoundingClientRect();
  const base = e.querySelector(".katex-html > .base").getBoundingClientRect();
  const [mathStart, mathEnd] = [...e.querySelectorAll(".katex-html > .base")].reduce(
    (m, e) => union(m, mathSize(e, tag)),
    EMPTY,
  );

  // TODO: Measure only with base that's inline with tag.
  const spaceForTag = Math.max(base.x + base.width - mathEnd, 0);
  if (spaceForTag >= tagWidth) {
    continue;
  }

  e.style.setProperty("--tag-size", tagWidth.toString() + "px");
  widths.set(e, { thresh: tagWidth + 16, math: mathEnd - base.x + 1, base: base.width });

  o.observe(e);
}
