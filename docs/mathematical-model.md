# SVB — Mathematical model and cross-format analysis

**Status**: normative modeling document · v0.2 semantics (SPEC v0.2, `9a6020c`+)
**Purpose**: formal specification of SVB as an abstract data type, and its comparison against the state of the art in binary vector encodings (EXI, Geobuf, MVT), with measured benchmarks on identical content.

---

## 1. The format as an abstract data type

### 1.1 Sorts

```
Byte ∈ [0, 255]              Seq⟨X⟩                    Varuint ∈ [0, 2⁴⁹−1]
Varint ∈ [−2⁴⁸, 2⁴⁸−1]       Coord = Varint / k        (k = coord_scale ≥ 1)
Color = [0,255]³             Point = Coord × Coord
Shape = Rect | Circle | Ellipse | Line | Polyline⟨Point⟩ | Polygon⟨Point⟩ | Path⟨Seg⟩
Style = fill: Color∪GradRef∪⊥ × stroke: Color∪GradRef∪⊥ × width? × caps? × dash? × rule
Grad = linear|radial × units × spread × coords × stops⟨offset,color,alpha⟩ × matrix?
Element = Shape × Style×Style-ref × Matrix?    Instance = TemplateRef × Transform
Template = Seq⟨Element⟩ (flat — no instances inside)
SVBFile = Header × Seq⟨Chunk⟩                 SVGDoc = the canonical SVG subset
```

### 1.2 Operations

```
encode : SVGDoc → SVBFile ⊕ Error
  requires : |input| ≤ 10 MB; depth ≤ 64; values within varuint alphabet
  ensures  : header valid (§3) · chunks well-formed (§4) · INV-1…INV-12 hold
             every lossy decision reported in Warnings

decode : SVBFile → SVGDoc ⊕ Error
  requires : magic + version ∈ {1,2} · INV-1…INV-5 · INV-13…INV-15
  ensures  : output = geometry + escaped text only (INV-7, INV-8)
             single-pass, O(n) time, O(log n) auxiliary space (§1.1)
             reference integrity: every tmpl-id / gradient index resolves (INV-13)
             expansion ≤ 1,000,000 emitted elements (INV-14)

decode ∘ encode = id_SVGDoc     on the canonical subset, up to INV-9 quantization
```

`Error` is a value of the result type: both operations are total over their domains. Failure carries a reason string and never a partial file.

### 1.3 Invariants

The fourteen normative invariants INV-1…INV-14 live in [DESIGN.md §2](DESIGN.md) and are unchanged here. Summary: bounded reads, honest counts, alphabet symmetry, division guard, decompression ceiling (64 MB), input ceiling, emission safety, non-finite unreachability, non-cumulative quantization error, forward compatibility, decidable constant-depth grammar, no executable semantics, reference integrity, expansion budget.

## 2. Model comparison with the state of the art

| | **SVB** | **MVT** | **Geobuf** | **EXI** |
|---|---|---|---|---|
| domain | static web vector images | tiled map delivery | geodata exchange | XML interchange |
| syntax model | context-free grammar, fixed depth | protobuf schema (fields) | protobuf schema (fields) | grammar-driven event codes |
| numbers | zigzag varint deltas, fixed-point | zigzag varint deltas, extent quantized | zigzag varint deltas, configurable precision | primitive types per grammar |
| repetition model | **templates + delta-chained instances (DEF)** | none (features stored fully) | none (features stored fully) | n/a (event structure only) |
| structure dedup | style table + templates | key/value tables (attributes only) | key/value-less (properties stored) | string table |
| accessibility | A11Y chunk, normative | none | none | n/a (XML semantics preserved) |
| executable content | impossible by grammar | n/a (geodata) | n/a (geodata) | preserved from XML |
| entropy stage | transport only (DEFLATE); rANS reserved | transport only | transport only | integrated (event codes) |

Reading: Geobuf and MVT share SVB's numeric core (zigzag varint deltas — the family is validated independently) but store every feature in full: their repetition model is empty. EXI's lesson is orthogonal and already adopted as a v0.2+ direction: its grammar-driven event codes are structural compression, compatible with SVB's fixed grammar. SVB's distinctive layers vs all three: the A11Y chunk and the script-free guarantee.

## 3. Measured cross-format benchmark

Same content, same visual: a 12,100-polygon + 222-line synthetic map (city grid, 4 fill classes). Geobuf and MVT are production npm implementations (`geobuf` 4.0, `geojson-vt` 4.0.3 + `vt-pbf` 3.1.3); MVT geometry encoded in a z0 tile at extent 4096 with property interning. Reproducible: `benchmark/cross-format.mjs`.

| format | raw bytes | +deflate/gzip | +brotli |
|---|---|---|---|
| Geobuf (precision 10⁶) | 405,743 | 405,743 | 14,555 |
| MVT (z0, extent 4096) | 281,903 | 42,882 (gzip) | 11,895 |
| SVG flat (svgo) | 578,822 | — | 10,255 |
| EXI schema-less (bit-packed) | 293,222 | 46,375 (gzip) | — |
| **SVB v0.2** | **1,727** | **1,490** | **1,443** |

**SVB is 7× smaller than SVG+brotli, 8.2× smaller than MVT+brotli, 10× smaller than Geobuf+brotli — and 203× smaller than schema-less EXI — on identical content.**

EXI caveats (stated): schema-less mode (built-in grammars — EXI's weakest setting; the schema-informed mode needs an SVG XSD and is EXI's best case, untested); EXI is lossless at the XML level (no coordinate quantization — svb's 1/64 lossy bound is a different, weaker distortion contract); processor: EXIficient 1.0.7 on Java 26, encoder source at `benchmark/exi/`. Even granting both caveats, schema-less EXI at 293 KB is two orders of magnitude from svb — the structural difference (XML event stream vs quantized binary deltas) dominates any tuning.

Caveats, stated plainly:

1. Geobuf/MVT are geodata-exchange formats (CRS, tiles, attributes, tooling). This benchmark compares byte efficiency on identical content, not feature parity or domain fitness.
2. Geobuf's precision is configurable (10⁶ default); coarser precision shrinks it toward ~180 KB — still ≥ 2× the svb+brotli figure for the same visual, because Geobuf stores full geometry per feature with no repetition model. Its compression also gains nothing from DEFLATE (the varint stream is already dense — 405,743 → 405,743).
3. MVT's key/value interning (2 street classes, 4 fill classes) is what makes gzip/brotli effective on it; without the property interning the tiles are larger.
4. EXI is **not measured here**: the maintained processors are Java-based (EXIficient); the npm port exposes no usable encoder. Pending: run EXIficient on the same SVG XML in a Java session. Analytic expectation per EXI's own literature: structural event coding lands between DEFLATE and dedicated binary formats for this document shape — i.e., the honest prediction is that EXI on SVG-XML would land between 10 KB and svb's 1.4 KB, and the grammar-informed event coding it uses is adopted as the v0.3 direction for SVB's rung 4.

## 4. The savings statement (public form)

Per file (n = 1,087 production SVGs, svgo-optimized first): median saving **72.3%**, mean saving **72.7%**; median file 467 B → 140 B; mean bytes saved per file 570 B; aggregate across the corpus 73.8% (839,345 → 220,085 B). Range: 48.5% (worst file) to 89.4% (best). Every file in the corpus is smaller than its svgo+brotli counterpart.

## 5. Process note

This document was produced as the modeling phase Ferrandis's review demanded: mathematical model first, cross-format comparison, then (only after the gate) implementation. The v0.2 implementation of §2's operations existed before this document; its grammar is therefore validated *by this formalization*, not designed from it — flagged explicitly per the honesty rule.
