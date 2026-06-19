local NBHY = utf8.char(0x2011)

local function hyphenate(el)
    el.text = el.text:gsub("([%w_])%-([%w_])", "%1" .. NBHY .. "%2")
    return el
end

function Pandoc(doc)
    local meta = doc.meta
    doc = doc:walk({ Str = hyphenate })
    doc.meta = meta
    return doc
end
