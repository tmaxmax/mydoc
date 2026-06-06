#!/usr/bin/env node

import pandoc from "pandoc-filter";

pandoc.stdio((value, format, meta) => {
  const c = getInlineContent(value);
  for (let i = 0; i < c.length; i++) {
    const m = c[i];
    if (m.t === "Str") {
      m.c = m.c.replace(/(\w)-(\w)/g, "$1\u{2011}$2");
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
