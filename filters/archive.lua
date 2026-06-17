function Pandoc(doc)
  pandoc.log.info(pandoc.json.encode(doc.meta.Tree))
  local out = pandoc.pipe("node", { "--experimental-strip-types", "filters/archive.ts" }, pandoc.write(doc, "json"))
  return pandoc.read(out, "json")
end
