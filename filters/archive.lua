function Pandoc(doc)
  local out = pandoc.pipe("node", { "--experimental-strip-types", "filters/archive.ts" }, pandoc.write(doc, "json"))
  return pandoc.read(out, "json")
end
