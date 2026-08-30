# SVB — Design model and invariants

**Status**: normative for v0.2+ · formalized from the shipped v0.1.1 system (`cb07954`–`e10e328`)
**Why this document exists**: the v0.1 implementation preceded a written theoretical model — an external review correctly identified that as the root process failure. This document is that missing phase, executed as design (not as patch), so that all future work (v0.2 gradients, ANIM, the Rust port) starts from invariants instead of from inherited patches. History: v0.1.0 shipped without INV-2/3/5 and was vulnerable (see findings ledger).

---

## 1. The format as a formal system

SVB is a **context-free** byte grammar with length-prefixed, skippable chunks. Everything a decoder needs to accept or reject a file is decidable from the bytes seen so far; there is no backtracking, no context-sensitive syntax, and no unbounded lookahead.

**Alphabet**

| construct | set | notes |
|---|---|---|
| byte | [0, 255] | |
| varuint | [0, 2⁴⁹−1] | LEB128, ≤ 7 bytes; a 7th byte with continuation bit is a grammar violation |
| varint | [−2⁴⁸, 2⁴⁸−1] | zigzag over varuint |
| fixed coordinate | varuint or varint ÷ coord_scale | coord_scale ≥ 1 |
| color | RGB24 [+ α8] | |

**Grammar**: the ABNF in the audit brief §4 (to be merged into SPEC as appendix). Context-free by construction: the six canonical path commands have fixed arities; SVG constructs that require a state machine (S/T reflection, H/V, implicit command repetition) are normalized away by the encoder. Decoder runtime state is exactly four registers: pen x, pen y, subpath start, first-point flag.

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
- **INV-11 — Decidable grammar.** Acceptance/rejection is decidable by single-pass parsing; the context-free grammar and the four registers fully define parser state. No FSM over command history is required — SVG constructs that would require one never reach the binary layer.
- **INV-12 — No executable semantics.** The format has no chunk type capable of carrying code, and no feature shall introduce one (see process rule, §5).

## 3. Threat model → invariant mapping

| attacker goal | status | guarded by |
|---|---|---|
| native code execution | structurally absent (managed runtime) | — (documented rationale) |
| script injection via emitted SVG | blocked by design | INV-7, INV-12 |
| CPU exhaustion (lying counts, EOF loops) | mitigated | INV-1, INV-2 |
| memory exhaustion (mass allocation, DEFLATE bomb) | mitigated | INV-2, INV-5 |
| non-finite / absurd coordinates | bounded | INV-3, INV-4, INV-8 |
| parser confusion (unknown constructs) | mitigated | INV-10, INV-11 |
| file integrity (silent corruption) | **open** — checksum chunk planned (v0.2) | — |

## 4. Findings ledger (audit trail)

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

**Reading of the ledger**: to date, zero findings invalidate the design model itself (container, grammar, delta encoding); every code finding is an implementation guard (F-2…F-5) or a documented decision gap (F-6…F-9). That distinction is checkable against the ledger and is the evidence on which "wrong foundations" should be judged.

## 5. Process rule (the fix for the process failure)

No feature may enter the format — new chunk, flag, opcode, or field — without, **in this order**: (1) its ABNF grammar extension, (2) the invariants it preserves or adds stated here with their bounds, (3) its tests written against hostile inputs, (4) only then, implementation. The v0.1.0 → v0.1.1 history is the cautionary example of the reverse order. Code is frozen during external review: findings enter the ledger; fixes ship in planned releases, except for actively exploitable issues.
