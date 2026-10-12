"""Build assets/fonts/twemoji-svg.woff2 from twemoji.woff2.

twemoji.woff2 is a COLR (v0) colour font, which Chrome, Edge and Firefox draw
but Safari ignores. This writes the same artwork into an OpenType-SVG table,
which Safari draws; styles.css lists both and each browser takes the one it
supports. Run it only when twemoji.woff2 changes (needs fontTools + brotli):

    python3 scripts/make-twemoji-svg.py
"""
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont, newTable

fonts = Path(__file__).resolve().parent.parent / "assets" / "fonts"
font = TTFont(fonts / "twemoji.woff2")
glyphs = font.getGlyphSet()
order = font.getGlyphOrder()
palette = font["CPAL"].palettes[0]


def hex_color(index):
    c = palette[index]
    return "#%02x%02x%02x" % (c.red, c.green, c.blue)


docs = []
for name, layers in font["COLR"].ColorLayers.items():
    parts = []
    for layer in layers:
        pen = SVGPathPen(glyphs)
        # SVG's y axis points down, the font's points up.
        glyphs[layer.name].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))
        d = pen.getCommands()
        if not d:
            continue
        fill = "#000" if layer.colorID == 0xFFFF else hex_color(layer.colorID)
        parts.append(f'<path fill="{fill}" d="{d}"/>')
    gid = order.index(name)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg"><g id="glyph{gid}">{"".join(parts)}</g></svg>'
    docs.append((svg, gid, gid))

docs.sort(key=lambda d: d[1])
table = newTable("SVG ")
table.docList = docs
font["SVG "] = table
del font["COLR"], font["CPAL"]
font.flavor = "woff2"
font.save(fonts / "twemoji-svg.woff2")
print(f"{len(docs)} glyphs, {(fonts / 'twemoji-svg.woff2').stat().st_size} bytes")
