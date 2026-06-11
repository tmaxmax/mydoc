function Pandoc(doc)
  local has_math = false

  pcall(function()
    doc:walk {
      Math = function()
        has_math = true
        error({}, 0)
      end
    }
  end)

  doc.meta.math = pandoc.MetaBool(has_math)
  if has_math and doc.meta["dev.skip_fonts"] == nil then
    pandoc.pipe("python3", { "patch_katex_fonts.py" }, "")
  end

  local out = pandoc.pipe("node", { "--experimental-strip-types", "filters/archive.ts" }, pandoc.write(doc, "json"))
  return pandoc.read(out, "json")
end
