# SVB brand assets

The mark: an S-shaped vector path whose anchor points are binary bits —
filled square = 1, hollow square = 0. Drawn entirely within SVB v0.1's own
subset (solid fills, strokes, no text, no gradients): the format carries its
own logo. As SVG: 789 B · as `.svb`: **150 B**.

| file | use |
|---|---|
| `logo.svg` | badge (rounded square, granate) — favicon, avatar, cards |
| `glyph-ink.svg` | transparent glyph for light backgrounds (`#7A1F2B`) |
| `glyph-cream.svg` | transparent glyph for dark backgrounds (`#F5F0E6`) |
| `logo.svb` | the badge, encoded — 150 B |
| `sheet.html` | contact sheet: all sizes, light/dark |

**Palette**: tinta `#7A1F2B` · crema `#F5F0E6` — contrast 8.98:1, WCAG AAA
(1.4.3, 1.4.6) and 1.4.11 non-text, verified with
[a11y-toolkit](https://github.com/kinti/a11y-toolkit).

`docs/social-card.png` (1280×640) is the GitHub social preview source —
regenerate with `docs/social-card.html` at a 1280×640 viewport.
