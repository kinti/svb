# SVB — Scalable Vector Binary

**Specification v0.1 (working draft)** · 2026-08-29
*A binary vector-graphics format for the web: binary size, with accessibility and progressive rendering as first-class citizens.*

> Spanish version: [SPEC.es.md](SPEC.es.md). The English version is normative.

---

## 1. Goals and non-goals

**Goals**

1. **Size**: drastically reduce real-world SVG (icons, illustrations, logos) even *before* transport compression. Coordinate data is the bulk of an optimized SVG; as text it costs 3–8 bytes per number, here 1–2.
2. **Progressive by design**: a chunk container; a renderer can paint with the first chunks and refine with later ones. A v1 decoder ignores chunks it doesn't know.
3. **Mandatory, verifiable accessibility**: the accessible name and description live in their own chunk, with a fixed position in the grammar. A validator can require it; an auditor can certify it. In SVG these are optional attributes that almost nobody ships.
4. **Declarative animation without SMIL** (reserved, v0.2): a dedicated chunk — not text, not JavaScript.
5. **Renderer-agnostic**: the format describes geometry and style; how it is painted (DOM→SVG, canvas, WebGL, native) is outside this specification.

**Non-goals in v0.1**

- Replacing 100% of SVG 1.1. The target subset covers ~90% of real web usage: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` with solid fill, stroke and transforms. Out of scope for now (documented): gradients, filters, `<text>`, `<use>/<defs>`, `<image>`, embedded CSS, clip/mask.
- Being a consortium standard. v0.1 is an open specification with a reference implementation; the standardization route is decided by adoption, not in advance.

**Precedents**: TinyVG proved a binary SVG subset can weigh ~39% of the original — but it targets embedded systems (no animation, no accessibility, no web runtime). SVB targets the web: a Service Worker as universal polyfill, an accessibility chunk, progressive rendering and reserved animation. JPEG XL is the precedent of technical success with hard political adoption; Lottie and Rive, that of "format + own runtime" without asking browsers for permission.

## 2. Conventions

- All integers are **little-endian** except varints, which are byte-wise.
- **varuint**: unsigned integer in LEB128 (7 bits per byte, high bit = continuation).
- **varint**: signed integer zigzag-encoded (`n ≥ 0 → 2n`, `n < 0 → −2n−1`), then stored as varuint.
- **fixed**: a coordinate value quantized as `round(value × coord_scale)`, stored as varuint (absolute) or varint (delta). `coord_scale` travels in the file header (e.g. `64` ≈ 2 decimals; `256` ≈ subpixel). As in SVG, the canvas is unitless.
- String lengths: `varuint` + UTF-8.
- Fields marked *reserved* must be written as 0 and ignored when read.

## 3. File header

The initial bytes of the file, never compressed:

| Field       | Type    | Value                                                 |
|-------------|---------|-------------------------------------------------------|
| magic       | 3 bytes | `53 56 42` (`"SVB"`)                                  |
| version     | u8      | `1`                                                   |
| flags       | u8      | see table                                             |
| width       | varuint | canvas width in user units (≤ 65535)                  |
| height      | varuint | canvas height                                         |
| coord_scale | varuint | coordinate quantization factor                        |

**flags**

| bit | name          | meaning                                                                |
|-----|---------------|------------------------------------------------------------------------|
| 0   | COMPRESSED    | the chunk stream is DEFLATE-compressed (raw, no zlib header)           |
| 1   | HAS_A11Y      | an A11Y chunk exists                                                   |
| 2   | HAS_ANIMATION | reserved (v0.2)                                                        |
| 3   | HAS_STYLE     | a STYLE chunk exists                                                   |
| 4–7 | —             | reserved, 0                                                            |

## 4. Chunk container

After the header (and, if applicable, decompressing the rest of the file), the file is a sequence:

```
chunk  =  tag:u8  size:varuint  body[size]
```

| tag    | chunk | mandatory | content                                        |
|--------|-------|-----------|------------------------------------------------|
| `0x01` | STYLE | no        | table of shared styles                         |
| `0x02` | GEOM  | yes, once | ordered list of elements                       |
| `0x03` | A11Y  | no (flag) | accessible name/description                    |
| `0x04` | ANIM  | reserved  | declarative animation (v0.2)                   |
| `0x05` | META  | no        | metadata (generator, license…)                 |
| rest   | EXT   | no        | **must be skipped** by reading `size` → forward compat |

Rules: a conforming decoder must be able to skip any unknown chunk without blocking rendering. Progressive rendering (v0.2) will exploit this property by ordering chunks from "renderable base" to "refinement".

## 5. STYLE chunk (0x01)

An indexed style table; elements reference an entry by index. Interning repeated styles (e.g. a brand color in an icon) is one of the wins over SVG.

```
count: varuint
entry ×count:
  style_byte: u8
      bit 0–1  fill:    0 none · 1 color · 2 color+alpha
      bit 2–3  stroke:  0 none · 1 color · 2 color+alpha
      bit 4    has stroke-width
      bit 5    has caps/join byte
      bit 6    has dash array
      bit 7    evenodd fill-rule (0 = nonzero)
  [ fill:  R,G,B (u8×3) ]              if fill ≠ 0
  [ fill alpha: u8 ]                   if fill = 2
  [ stroke: R,G,B ]                    if stroke ≠ 0
  [ stroke alpha: u8 ]                 if stroke = 2
  [ stroke-width: varuint fixed ]      if bit 4
  [ caps/join: u8 ]                    if bit 5   (low nibble: cap 0 butt · 1 round · 2 square;
                                                    high nibble: join 0 miter · 1 round · 2 bevel)
  [ dash: n:varuint, n × varuint fixed ] if bit 6
```

## 6. GEOM chunk (0x02)

Elements in **document order** (paint order and reading order).

```
count: varuint
element ×count:
  elem_byte: u8
      bit 0–3  shape: 1 rect · 2 circle · 3 ellipse · 4 line · 5 polyline · 6 polygon · 7 path
      bit 4    has transform: 6 × varint fixed matrix (SVG matrix(a,b,c,d,e,f) order)
      bit 5    inline style (same encoding as a STYLE entry, in place)
      bit 6–7  reserved, 0
  [ style_index: varuint ]     if bit 5 = 0
  [ matrix a,b,c,d,e,f ]       if bit 4
  shape data (absolute positions → signed **varint**; sizes and radii → **varuint**):
    rect      x:varint, y:varint, w:varuint, h:varuint, rx:varuint, ry:varuint
    circle    cx:varint, cy:varint, r:varuint
    ellipse   cx:varint, cy:varint, rx:varuint, ry:varuint
    line      x1, y1, x2, y2 (varint ×4)
    polyline  count:varuint, x0:varint, y0:varint, then (count−1) varint delta pairs
    polygon   identical to polyline
    path      cmd_count: varuint, followed by commands:
                cmd_byte: bits 0–2 → 0 M · 1 L · 2 C · 3 Q · 4 A · 5 Z ; bits 3–7 reserved, 0
                  M · L → 1 point
                  C     → 3 points
                  Q     → 2 points
                  A     → rx:varuint, ry:varuint, rot:varint (degrees, integer),
                           flags:u8 (bit0 large-arc, bit1 sweep), end point
                  Z     → nothing
```

**Point encoding in `path`**: the first `M` of each path is absolute (two signed varints — negative coordinates are legal). Every subsequent point is stored as a **zigzag delta from the pen** (the current position after the previous point), regardless of the command. This delta encoding is the main source of savings: for contiguous coordinates, deltas fit in 1 byte where SVG spends 6–10 characters.

**Normalization in the encoder**: `S→C`, `T→Q`, `H/V→L`, relative→absolute before quantization. The decoder only implements the 6 canonical commands.

**viewBox and inheritance**: the encoder "bakes" the root `viewBox` (translation+scale) and the nested transforms of `g` elements into each element's matrix. An element with no effective transform carries no bit 4.

## 7. A11Y chunk (0x03)

A first-class citizen: presence announced by a header flag and a fixed grammar, verifiable without interpreting the geometry.

```
name: lenpfx-utf8          document accessible name (may be "")
desc: lenpfx-utf8          description
labels: count: varuint
  entry ×count:
    elem_index: varuint     element index within GEOM
    name:        lenpfx-utf8
    desc:        lenpfx-utf8
```

Decoder emission rules towards SVG: `name` → `<title>` and `desc` → `<desc>` as the root's first children, plus `role="img"` and labeling where applicable. Per-element labels → a `<title>` child of the element. An encoder must extract this data from the `<title>`, `<desc>` and `aria-label*` present in the source SVG.

**Format rule**: a conforming SVB file must declare the HAS_A11Y flag. Omitting it is valid but flagged "non-a11y-conformant" by validators (basis for later audit/certification).

## 8. META chunk (0x05)

`generator: lenpfx-utf8` — informative string, ignorable. Reserved for license and authorship in v0.2.

## 9. ANIM chunk (0x04) — reserved

Planned design (non-normative in v0.1): keyframe track(s) per element or property (`transform`, opacity, geometry), timing with cubic curves, no expressions. Goal: replace 100% of SMIL's living usage at a byte cost of a lower order.

## 10. Media type and registration

- `image/x-svb` — until registration completes.
- Target: `image/svb` in the IANA media type registry (expert review, RFC 6838), with this specification as reference.

## 11. Conformance

A conforming **encoder** emits a valid header, at least one GEOM chunk, chunks in ascending tag order, and no bytes outside chunks. A conforming **decoder** accepts any v1 file, ignores unknown chunks, and renders the GEOM+STYLE subset; A11Y support is mandatory for the "accessible SVB" seal.

## 12. Security

The format cannot carry executable code: there is no executable chunk type, and conforming decoders emit geometry and escaped text only.

Hardening rules, **normative for implementations**:

- Readers MUST fail on any read past the end of the buffer. Silent zero-fill on out-of-range reads is non-conforming.
- A declared count or size (chunk sizes, element counts, path command counts, array lengths) MUST be rejected when it exceeds the bytes remaining in the file. Hostile files must fail in bounded time, not be allocated into memory.
- Implementations SHOULD cap the decompressed payload size (recommended: 64 MB) and SHOULD cap accepted encoder input size.
- Rationale: without these rules, a ~20-byte file declaring 134 million path commands exhausts gigabytes of heap; with them, it is rejected in microseconds.

## 13. History

- **v0.1.1 (2026-08-30)** — security hardening release: EOF guards on all readers, declared-count bounds, decompression output cap, encoder input cap, quadratic attr parsing fixed; §12 added (normative). Format unchanged: files produced by v0.1 encoders remain valid, version byte stays `1`.
- **v0.1 (2026-08-29)** — first public draft: header, chunk container, STYLE/GEOM/A11Y/META, geometric subset, ANIM reserved.
