local normalize

normalize = function(m)
  local out = {}
  for k, v in pairs(m) do
    local t = pandoc.utils.type(v)
    if k == "Children" then
      if t == "List" then
        local a = {}
        for i, child in ipairs(v) do
          a[i] = normalize(child)
        end
        if #a > 0 then
          out[k] = a
        end
      end
    elseif t == "Inlines" then
      if k == "Title" or k == "Subtitle" then
        local doc = pandoc.Pandoc({ pandoc.Plain(v) })
        out[k] = pandoc.write(doc, "html"):gsub("%s+$", "")
      else
        local a = {}
        for i, p in ipairs(v) do
          if p.t == "Str" then
            a[i] = p.text
          elseif p.t == "Space" then
            a[i] = " "
          else
            pandoc.log.error(("Unexpected value %s"):format(tostring(p)))
          end
        end
        out[k] = table.concat(a)
      end
    else
      out[k] = v
    end
  end
  return out
end


function Pandoc(doc)
  if doc.meta.Tree ~= "" then
    local tree = normalize(doc.meta.Tree)
    local out = pandoc.pipe("go", { "run", "filters/archive.go" }, pandoc.json.encode(tree))
    doc.meta.Tree = pandoc.RawBlock("html", out)
  end
  local out = pandoc.pipe("node", { "--experimental-strip-types", "filters/archive.ts" }, pandoc.write(doc, "json"))
  return pandoc.read(out, "json")
end
