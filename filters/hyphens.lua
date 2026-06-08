local NBHY = utf8.char(0x2011)

function Str(el)
    el.text = el.text:gsub("([%w_])%-([%w_])", "%1" .. NBHY .. "%2")
    return el
end
