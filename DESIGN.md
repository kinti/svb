# SVB — Design model and invariants

**Status**: normative for v0.2+ · formalized from the shipped v0.1.1 system (`cb07954`–`e10e328`)
**Why this document exists**: the v0.1 implementation preceded a written theoretical model — an external review correctly identified that as the root process failure. This document is that missing phase, executed as design (not as patch), so that all future work (v0.2 gradients, ANIM, the Rust port) starts from invariants instead of from inherited patches. History: v0.1.0 shipped without INV-2/3/5 and was vulnerable (see findings ledger).

> **Rev. 4 (2026-08-30)**: algebraic specification added (§3, TAD layer: sorts, operations, pre/postconditions) following external review. Finding **F-11** accepted into the ledger with precise scoping: the *encoder's* XML walker recurses over nesting (RangeError, fail-closed — verified, not a browser crash); the *decoder* is immune by design — the binary grammar contains no recursive productions and call depth is constant (proof in INV-11). No code changed (review freeze); fix planned.
> **Rev. 5 (2026-08-30)**: machine classification added (§1.1) following external review: the container's minimal abstract machine is **not** a pushdown automaton — length prefixes and fixed arities reduce the language to a finite automaton with a grammar-bounded number of counters (O(1) memory, independent of input nesting). Decode formalized as a transition function over registers (§3.1). F-11 disposition updated: the fix adopts the reviewer's Stack-TAD prescription for the encoder (explicit, bounded stack instead of the JS call stack).

## 0. Application context and state of the art (modeling input for v0.2)

*Added per external review — step zero of the modeling phase, before designing any v0.2 feature. Research date 2026-08-30.*

### 0.1 Application context (the space-time tradeoff, answered)

| question | answer for SVB |
|---|---|
| what to prioritize | bandwidth/storage at delivery, **and** decode must remain fast with O(1)-memory (it runs in a Service Worker, often on mobile) |
| browser function | **downloaded once, rendered/animated repeatedly** — a static asset, not a stream. Tile-pyramid streaming (MVT's niche) is out of scope |
| hardware | mobile web: RAM/CPU/battery constrained → **asymmetric design is mandatory**: pay heavy compression at ENCODE time (offline, once), keep decode a simple fold. → favors rANS (expensive encode, table-driven fast decode) and/or grammar-informed structural codes (nearly free at decode) |

### 0.2 Prior art survey

| prior art | technique | what SVB adopts (v0.2) |
|---|---|---|
| **MVT** — Mapbox Vector Tiles (protobuf tiles; built so clients style/render map data client-side; ~80% smaller than alternatives per academic measurement) | **CommandInteger**: command id + repeat count packed into ONE varint (`(count << 3) \| id`; MoveTo/LineTo/ClosePath); ParameterInteger = zigzag varint deltas vs previous point; per-layer keys/values interning | command+count packing for paths (attacks the measured ~12% command-byte cost with an industry-proven encoding); validates our style interning. NOT adopting: tile pyramids/streaming (different niche) |
| **Geobuf** (Agafonkin; near-lossless GeoJSON → protobuf; 6–8× smaller than GeoJSON, often beats gzipped TopoJSON and MVT) | delta + zigzag coordinates; configurable precision | technique family **identical** to ours (independent validation of DD-1). SVB does not compete with it: different domain (geodata exchange/analysis vs web display images); SVB's differentiators are web-image features — a11y chunk, script-free by design, Service Worker delivery — not compression technique |
| **EXI** (W3C REC; XML as event sequence; each event gets a compact **event code from the current grammar state**; schema-informed grammars shorten codes for expected content; has a profile for **bounded dynamic memory**) | structural compression via grammar knowledge — strong compression **without a generic entropy stage**, keeping decoders simple and memory-bounded | the F-12 answer that preserves decode simplicity: **grammar-informed event coding over our own context-free grammar** (expected transitions get short codes — EXI proves this beats schema-less generic compression for structured data). Optional rANS stage on top for the large-file segment (INV-5 ceiling applies) |

**Position statement (answering "en qué mejora esto a Geobuf / estás luchando contra EXI"):** SVB does not compete with Geobuf (different domain, same technique family — the family is independently validated) and does not fight EXI: EXI is a **technique donor** — its grammar-driven coding maps 1:1 onto the context-free grammar this design already declares. MVT is the closest domain precedent, and its existence validates the demand for binary vector data on the web; SVB's niche remains static web vector images with verifiable accessibility and script-free delivery.

### 0.3 The ancestor, analyzed: SVG 1.1 as an information system

*The most important prior art of all — the format SVB succeeds — had no algorithmic analysis in this document. Fixed.*

**What SVG is, formally.** Three stacked layers: (1) **syntax** — an application of XML 1.0 (1998): a context-free tree grammar, parseable only by a pushdown machine (unbounded nesting); (2) **structure** — a DOM scene graph with grouping, `<defs>/<use>` references, and CSS-style inheritance; (3) **presentation** — the painter's algorithm: elements paint in document order, no spatial index mandated, precision is renderer-dependent (two conforming renderers legitimately output different pixels). W3C REC September 2001, effectively frozen since 1.1 (2003).

**The information ladder.** For an N-point image, the per-axis information actually transported:

| representation (the ladder) | bits/axis/point | who occupies it |
|---|---|---|
| 1. absolute ASCII ("123.45") — SVG as shipped | ~28–48 bits incl. syntax share | **SVG** |
| 2. absolute binary, quantized 1/64 | ~15 bits | (unused intermediate) |
| 3. quantized **delta** zigzag varint | ~5–10 bits | **SVB v0.1** |
| 4. entropy-coded residual (Huffman/rANS/grammar codes) | → source entropy (<5 bits) | **nobody yet — F-12** |

Each rung removes one predictable redundancy: (1→2) decimal ASCII and verbose markup; (2→3) absolute-position correlation; (3→4) residual frequency skew. **F-12 in one line: v0.1 climbed from rung 1 to rung 3 and declared victory, while the competition (svg+brotli) exploits rung-1 repetition AND rung-4 coding.** On small files the raw lead dominates; on large repetitive files rungs 1+4 beat rung 3 (measured, F-12).

**Redundancy models SVG had that SVB v0.1 dropped** — the blueprint failures, made precise:

1. **`<defs>`/`<use>` — the back-reference model.** SVG represents repetition as a pointer + transform (~200 bytes per instance in text; near-free informationally). v0.1's flattening (groups→matrices) destroyed this: every instance re-stores full geometry. **The F-12 fix (repetition chunk) must re-invent `<use>` at the binary layer**: template id + instance transform, ~10–20 B/instance.
2. **Style inheritance / CSS cascade — lazy redundancy.** SVG declares shared properties once and resolves them at render time. SVB's interned style table is the *precomputed* analog (resolved at encode: correct for decode cost — INV-7 stays), but the cascade's compactness (one declaration, many elements) is preserved by interning.
3. **Transport entropy as a doctrine.** SVG's founding decision — "compression is a transport concern; the format stays text" — was rational in the HTTP/1.1 gzip era. F-12 is the measured refutation of that doctrine for constrained binary formats aimed at delivery: when the format is the product, the entropy rung belongs *inside* it.

**Algorithmic properties reviewed.** Parsing: O(n), pushdown (tree). Rendering: O(elements) per pass, painter's order. Precision: renderer-dependent (vs INV-9's deterministic quantization — an SVB win worth stating). Security: scripts + foreignObject in format (the surface SVB removes). Accessibility: `title`/`desc` exist in the spec — first-class there, absent in practice (the gap SVB's A11Y chunk addresses by making them enforceable).

**Review conclusions for v0.2.** (a) The repetition chunk is not novel design — it is `<use>` re-invented at the binary layer; SVG's semantics (referenced template + transform + cascade) are the reference model to port. (b) The entropy rung has two candidate mechanisms (EXI-style grammar codes, rANS) — the information ladder says they are additive to, not alternatives of, the repetition model. (c) The honest scoreboard for v0.2: SVB must reach rung 4 and re-add rung-1's repetition model at the binary layer, or concede the large-file segment to svg+brotli.

## 1. The format as a formal system

SVB is a **context-free** byte grammar with length-prefixed, skippable chunks. Everything a decoder needs to accept or reject a file is decidable from the bytes seen so far; there is no backtracking, no context-sensitive syntax, and no unbounded lookahead.

### 1.1 Machine classification (why not a pushdown)

Context-free is the *upper bound* of this grammar's complexity, not its class. A pushdown automaton is the minimal machine for languages with **input-driven unbounded nesting** (balanced delimiters, aⁿbⁿ) — which is the shape of the SVG *source*, where our XML parser indeed runs an explicit stack (`xml.js`, `parseXml`). SVB's binary grammar deliberately **eliminates** that shape:

1. chunk boundaries are explicit (declared size), not bracketed — no matching to remember;
2. the six path commands have fixed arities — no command history to replay;
3. no production is recursive — counting nesting is bounded by the grammar itself.

**Precision on the counters (sharpened after external review):** the machine is *not* a pure finite automaton — it does keep counters, and some are nested. The exact inventory, verifiable in `decoder.js`:

- **Chunk skipping is arithmetic, not iteration**: INV-10's skip is `pos += size` after a bounds check — no counter, no loop, one pointer update. Declared lengths convert skipping into arithmetic.
- **Scope nesting is a grammar constant (≤ 3)**: payload scope → chunk-body scope (one nested `ByteReader` per chunk; chunks never nest inside chunks) → loop scope. It never grows with input.
- **Simultaneously live data counters ≤ 2**: element-index → command-index inside a path (or element-index → polyline/dash count). Points consume with fixed arity ≤ 3 — a constant-bound loop, not a data counter.

Therefore the minimal abstract machine is a **one-pass deterministic computation in O(log n) space** (the counters must hold values up to the payload size, i.e. log₂ n bits each; their *number* is O(1)). The memory hierarchy across the review discussion: DFA (O(1)) ⊂ **SVB decoder (O(log n), fixed variable count)** ⊂ PDA (stack grows with input nesting, ≤ O(n)). Against a hostile file, none of these variables' *depth* is attacker-controlled — a 20-byte file and a 64 MB file run the same variables. The pushdown where an input-driven stack *is* the right model (SVG/XML ingestion: `parseXml` + the encoder walker) is exactly where finding F-11 lives, and its fix adopts the reviewer's Stack-TAD prescription (§5).

**Alphabet**

| construct | set | notes |
|---|---|---|
| byte | [0, 255] | |
| varuint | [0, 2⁴⁹−1] | LEB128, ≤ 7 bytes; a 7th byte with continuation bit is a grammar violation |
| varint | [−2⁴⁸, 2⁴⁸−1] | zigzag over varuint |
| fixed coordinate | varuint or varint ÷ coord_scale | coord_scale ≥ 1 |
| color | RGB24 [+ α8] | |

**Grammar**: the ABNF in the audit brief §4 (to be merged into SPEC as appendix). Context-free by construction — and, per §1.1, *regular-plus-counters* in practice: the six canonical path commands have fixed arities; SVG constructs that require a state machine (S/T reflection, H/V, implicit command repetition) are normalized away by the encoder. The ABNF contains **no recursive productions** — verified: no non-terminal appears in its own expansion chain.

**Chunk topology**: ascending tag order (STYLE → GEOM → A11Y → META). All cross-references point backward (GEOM indexes STYLE; A11Y indexes GEOM), so a single forward pass suffices and no chunk can reference something not yet defined.

## 2. Invariants (normative)

Each invariant lists: statement → where it is enforced → the test that pins it.

- **INV-1 — Bounded reads.** Every read either returns a byte within the buffer or throws. Silent zero-fill is forbidden. *Enforced*: `ByteReader`, `readVarUint`. *Tests*: truncation cuts ×3.
- **INV-2 — Honest counts.** Any declared count or size (chunk size, element counts, command counts, array lengths) must not exceed the bytes remaining. *Enforced*: `ensureAvailable` ×6, chunk loop. *Tests*: hostile counts.
- **INV-3 — Alphabet symmetry.** Values outside the varuint alphabet are unrepresentable in both directions: the decoder rejects over-long encodings; the encoder refuses values ≥ 2⁴⁹ so undecodable files cannot be produced. *Enforced*: read guard (`varuint too long`) + `writeVarUint` (`varuint overflow`). *Tests*: alphabet in both directions; hostile 2⁵³ coordinate rejected at encode. *History*: the encoder side was missing until v0.1.1-rev.3 (finding F-5).
- **INV-4 — Division guard.** coord_scale > 0. It guards the only division in the decode path: without it, `coord / 0 = Infinity` would be emittable into path data. *Enforced*: header check. *Test*: scale = 0.
- **INV-5 — Decompression ceiling.** Decompressed payload ≤ 64 MB, enforced mid-stream with early abort (Node `maxOutputLength`; browser streaming reader). *Test*: decompression bomb.
- **INV-6 — Encoder input ceiling.** SVG input ≤ 10 MB. *Test*: oversized input.
- **INV-7 — Emission safety.** The decoder emits only (a) numbers formatted through fixed-decimal rounding and (b) strings passed through XML escaping. There are no executable constructs in the format and no interpolation path for markup. *Tests*: a11y text with entities; per-element labels.
- **INV-8 — No non-finite values.** NaN/Infinity are unreachable in the decode flow: (a) all inputs are byte-derived integers (INV-1); (b) the only arithmetic is addition; (c) the only division is guarded (INV-4); (d) magnitude bound: addends < 2⁴⁹, addition count bounded by INV-5 → cumulative ≤ ~10²², far below the float64 overflow threshold (~1,8·10³⁰⁸). *Test*: seeded property test — 200 hostile random-delta files, output never contains NaN/Infinity. **Preconditions**: INV-1 and INV-4 are load-bearing for this invariant.
- **INV-9 — Bounded, non-cumulative error.** Quantization error ≤ 1/(2·coord_scale) per coordinate, emission rounding ≤ 5·10⁻⁴, and no drift across points: the encoder quantizes absolute coordinates and derives deltas between quantized values; the decoder's sum recovers exactly those quantized absolutes. Precision loss is possible only for adversarial magnitude accumulation beyond 2⁵³ (documented, minor; saturation is the candidate future guard).
- **INV-10 — Forward compatibility.** Unknown chunk tags are skipped by declared size (≤ remaining bytes). New chunk types must therefore always carry an honest size prefix.
- **INV-11 — Decidable grammar, constant parser depth.** Acceptance/rejection is decidable by single-pass parsing; the context-free grammar and the four registers fully define parser state. Because the grammar has **no recursive productions**, the decoder's call depth is a constant (~4 frames: `decode → readGeomChunk → readShape → readStyleEntry`); stack-depth attacks on the **decoder** are structurally impossible. The *encoder*'s XML walker does recurse over input nesting — see F-11 for its disposition.
- **INV-12 — No executable semantics.** The format has no chunk type capable of carrying code, and no feature shall introduce one (see process rule, §6).

## 3. Algebraic specification (TAD layer)

Sorts (data kinds over which operations are defined):

```
Byte ∈ [0,255]   Seq<Byte>   Varuint ∈ [0, 2⁴⁹−1]   Varint ∈ [−2⁴⁸, 2⁴⁸−1]
Coord ∈ float64  SVGDoc (canonical subset: see SPEC §1 + encoder normalizations)
SVBFile ∈ Seq<Byte>   Warnings ∈ Seq<String>
```

Operations:

```
encode : SVGDoc × config → SVBFile ⊕ Error × Warnings
  requires (pre):
    R1  |input| ≤ 10 MB                                 (INV-6)
    R2  input parses into the SVG subset grammar
    R3  quantized values within varuint alphabet        (INV-3)
    R4  nesting depth ≤ D_MAX                           (F-11: cap to be specified,
                                                         proposed 64; not yet enforced)
  ensures (post):
    P1  magic/version/flags/grammar valid               (§1)
    P2  decode(encode(d)) ≈ d, per-coordinate error
        ≤ 1/(2·coord_scale) + 5·10⁻⁴                    (INV-9)
    P3  every lossy decision appears in Warnings
    P4  time and memory O(|input|)

decode : SVBFile × config → SVGDoc ⊕ Error
  requires (pre):
    R5  magic "SVB", version = 1                        (§1)
    R6  coord_scale > 0                                 (INV-4)
    R7  decompressed payload ≤ 64 MB                    (INV-5)
  ensures (post):
    P5  output contains only finite numbers and escaped text (INV-7, INV-8)
    P6  terminates in a single pass, O(n) time, constant call depth (INV-11)
    P7  unknown chunks skipped                          (INV-10)

decode ∘ encode = id_SVGDoc   (up to INV-9 quantization; exact on the canonical subset)
```

Error side: all `Error` outcomes are exceptions carrying a reason string; no partial results are emitted. This satisfies the TAD requirement that every operation is total over its sorts — failure is a value of the result type, never undefined behavior.

### 3.1 Decode as a transition function

Per the TAD contract, `decode` is a fold of a formal transition function over the byte stream, with all state explicit (no hidden control state, no call-stack dependence):

```
Registers (the complete mutable state):
  R = ( phase, elem-i, cmd-i, penX, penY, subX, subY, first )
  phase ∈ {HEADER, CHUNK-TAG, CHUNK-SIZE, CHUNK-BODY, DONE}
  penX, penY, subX, subY ∈ ℤ (bounded: |·| ≤ 64M × 2⁴⁸, see INV-8)
  first ∈ {true, false}

δ : R × Byte → R            (byte-structured: varint assembly consumes sub-frames)
decode(file) = fold δ over file, starting from R₀ = (HEADER, 0,0,0,0,0,0, true)
  emitting geometry as a side-written stream (INV-7 guarantees its safety)
```

Every invariant INV-1/2/4 is a guard predicate on a δ transition; a failed guard terminates the fold with an Error. The fold is the implementation's contract: any conforming decoder — JS, Rust, hardware — is an implementation of δ, and none of them requires a program stack whose depth depends on the input.

## 4. Threat model → invariant mapping

| attacker goal | status | guarded by |
|---|---|---|
| native code execution | structurally absent (managed runtime) | — (documented rationale) |
| script injection via emitted SVG | blocked by design | INV-7, INV-12 |
| CPU exhaustion (lying counts, EOF loops) | mitigated | INV-1, INV-2 |
| memory exhaustion (mass allocation, DEFLATE bomb) | mitigated | INV-2, INV-5 |
| stack exhaustion via nesting | **decoder**: impossible (INV-11, no recursive productions) · **encoder**: fail-closed RangeError, cap planned (F-11) |
| non-finite / absurd coordinates | bounded | INV-3, INV-4, INV-8 |
| parser confusion (unknown constructs) | mitigated | INV-10, INV-11 |
| file integrity (silent corruption) | **open** — checksum chunk planned (v0.2) | — |

### 4.1 Design decisions challenged in review

**DD-1 — variable-length integers (LEB128 + zigzag + delta) for coordinate streams.**
Challenge: LEB128 was designed for debug/Wasm integers, not geometry. **Upheld.** The pattern is the established one for this exact data shape: MIDI variable-length quantities (1983), Protocol Buffers' zigzag rationale for signed values, and OpenStreetMap PBF `DenseNodes` — delta + zigzag varints for planetary-scale map coordinates. Known non-optimal alternatives (group-varint, bit-packing) are recorded as a v0.2 benchmark experiment; "non-optimal" ≠ "wrong".

**DD-2 — no entropy-coding stage in v0.1.**
Challenge: without Huffman/arithmetic coding SVB "can never compete with SVG+Brotli in production". **Upheld against measurement**: the benchmark's headline *is* the production condition — inputs optimized with svgo, competitors compressed with brotli (quality 11) — and raw SVB beats svgo+brotli on 100% of 1,087 files; giving both sides brotli, median ×0.541. Mechanism: the delta layer is a reversible transform that removes semantic redundancy (adjacent coordinates differ little) *before* any entropy stage; generic text compressors cannot see it — brotli extracts ~39% from SVG text but ~0–5% from SVB (sometimes growing it; see "compressing the compressed"). The deferred entropy stage is a documented trade (auditability vs est. 10–15%), not an incapacity; decision trigger for v0.2 recorded in the roadmap.

## 5. Findings ledger (audit trail)

| id | finding | class | disposition | status |
|---|---|---|---|---|
| F-1 | D2 wording implied "no NaN in JS" (false in general) | process/doc | invariant rewritten with preconditions + property test | fixed (rev.2) |
| F-2 | DoS: declared counts → 4 GB OOM from 20 B | implementation | INV-2 + EOF guards | fixed v0.1.1 |
| F-3 | decompression bomb ×1029 | implementation | INV-5 | fixed v0.1.1 |
| F-4 | quadratic attribute parsing in encoder XML | implementation | sticky regexes | fixed v0.1.1 |
| F-5 | encoder/decoder varuint alphabet asymmetry | contract | INV-3 write-side guard | fixed rev.3 |
| F-6 | style-index out of range → silent default fallback | design decision | strict-reject vs fallback undecided | open |
| F-7 | reserved flag bits silently tolerated | design decision | strict vs lenient policy undecided | open |
| F-8 | no integrity checksum | design gap | reserved chunk planned | open (v0.2) |
| F-9 | pen accumulation beyond 2⁵³ loses precision | minor, adversarial only | saturation candidate | open |
| F-10 | no formal fuzzing campaign | process | radamsa/AFL pass pending | open |
| F-11 | encoder XML walker recurses without explicit depth cap: hostile nesting (50k `<g>`) → RangeError. **Verified fail-closed** (catchable exception, process survives; not a browser crash). **Decoder unaffected**: no recursive productions in the grammar, constant call depth (INV-11) | implementation | **adopted the reviewer's Stack-TAD prescription**: replace the recursive walker with an iterative one carrying an explicit, bounded stack (D_MAX, proposed 64) — nesting controlled in a program-owned TAD, not in the JS call stack | **accepted; fix planned — not patched during review freeze** |
| F-12 | **large repetitive/organic files: svb+brotli converges to parity or loses vs svg+brotli (×0.91–1.09)**; on the most repetitive class even raw svb loses to svg+brotli (41 KB vs 10 KB). Reviewer's prediction, **confirmed by measurement** (`benchmark/large.mjs`: repetitive map ×1.015, schematic ×1.059, organic ×1.089). Mechanism: large text files give brotli's back-references exact repeated substrings; the delta layer already removed the local redundancy brotli would otherwise find in svb, so brotli contributes less there. The corpus's 100%-wins claim was domain-bounded (icons/logos) | **design gap** — no large-scale repetition modeling (no back-reference/template construct, no entropy stage) | accepted. Roadmap consequence: repetition/back-reference chunk (semantic `use`-like templates) + entropy stage **promoted from "deferred" to required** for the large-file segment; READMEs scoped honestly | **accepted; v0.2 priority** |

**Reading of the ledger**: to date, zero findings invalidate the design model itself (container, grammar, delta encoding); every code finding is an implementation guard (F-2…F-5, F-11) or a documented decision gap (F-6…F-9). That distinction is checkable against the ledger and is the evidence on which "wrong foundations" should be judged.

## 6. Process rule (the fix for the process failure)

**Model before code.** Programming is translation; engineering is modeling. For every format feature — and for the format itself — the order is: (1) an **information budget** for the target domain (what the data contains, what repeats, what is predictable, entropy per class), (2) the mathematical model (TAD, grammar, invariants, pre/postconditions), (3) external review of *that model* — reductio ad absurdum from domain knowledge invited as a formal gate, (4) only then, implementation, which is translation of the approved model.

This rule is F-12's legacy: the entropy/repetition model was missing from the original blueprints, and a domain-based reductio ad absurdum — written *before reading any code* — invalidated the design decision in two sentences, where 29 tests (which can only check what their authors thought to check) had found nothing. Tests verify bricks; model review audits blueprints. Both are required, in that order.

No feature may enter the format — new chunk, flag, opcode, or field — without, **in this order**: (1) its ABNF grammar extension, (2) the invariants it preserves or adds stated here with their bounds, (3) its tests written against hostile inputs, (4) only then, implementation. The v0.1.0 → v0.1.1 history is the cautionary example of the reverse order. Code is frozen during external review: findings enter the ledger; fixes ship in planned releases, except for actively exploitable issues.
