# Changelog

All notable changes to the SVB format and reference implementation.

The format itself is versioned by its header version byte; releases here document both format changes and implementation fixes. v1 files remain valid for all later decoders.

## [Unreleased]

### Added

- **warn-all**: the encoder now reports every feature it does not carry — CSS `<style>`, `<script>`, `clipPath`/`mask`/`filter`/`pattern`/`marker`/`symbol` definitions, and `mask`/`clip-path`/`filter` attributes on container elements. Previously some of these were dropped silently; the ladder test that exposed it is documented in the repository history. No format change.
- **CLI batch mode**: `svb encode <indir/> <outdir/>` converts every `.svg` in a directory with a per-file report (size, warnings) and a summary; `--strict` turns any warning into a non-zero exit for build pipelines. CLI banner and default generator string now track the real version.
- **Conformance vectors**: `vectors/` ships four golden `.svb` files (icon, gradient, negative coordinates, DEF templates) with sources, SHA-256 manifest, and a byte-exactness test — the kernel of a conformance suite for third-party implementations.
- **SPEC Appendix A**: container grammar in ABNF (header, chunk framing, varuint alphabet, emission order).
- **Radamsa fuzzing campaign**: 6,000 mutants from an independent, grammar-agnostic mutator — 0 malformed outputs, 0 hangs, 0 crashes (94.3% clean rejection). Orchestrator with hang detection (`benchmark/radamsa.mjs`), 300-mutant test that runs wherever radamsa is installed, results in SECURITY.md.

### Fixed

- **Demo XSS (found by CodeQL)**: the in-browser validator rendered the uploaded file's name and the binary's a11y strings into `innerHTML` without escaping — a crafted `.svb` could execute markup in the demo page. Reports are now built with DOM APIs and `textContent`. The codec was never affected: `.svb` still cannot carry scripts by design; this was a bug in the demo page's report UI.
- **Demo Service Worker staleness**: the worker's module imports now carry a version query and registration uses `updateViaCache: 'none'`, so visitors with long-cached decoder code stop running stale decode logic; decode failures respond with `Cache-Control: no-store`.

## [0.2.1] — 2026-09-02

### Fixed

- **Encoder crash**: a gradient reference (`fill="url(#g)"`) on a `<g>` container crashed the encoder with a `TypeError` — the container branch of the style walk did not receive the gradient index map. Added round-trip regression test. No format change; files produced by previous encoders are unaffected.

## [0.2.0] — 2026-08-31

### Added

- **DEF chunk (0x06)** — flat templates; instance elements (`shape type 8`) with translate-only or full-matrix placement, SVG `<use>` semantics with MVT-style delta chains between consecutive instances.
- **GRAD chunk (0x07)** — linear and radial gradients, `objectBoundingBox` coordinates quantized to u8 or `userSpaceOnUse` varints, per-stop alpha, optional `gradientTransform`.
- **Style type 3** — fill/stroke as gradient reference (`index << 1 | has-matrix`).
- **Command-run packing** — `(count << 3) | cmd`, in the spirit of Mapbox Vector Tiles.
- **Version byte `2`** for files using v0.2 features; v1 decoders reject cleanly at the header, and v1 files remain valid everywhere.
- Invariants INV-13 (reference integrity, flat templates), INV-14 (expansion budget ≤ 1M emitted elements — the template-bomb guard), INV-15 (strict gradient vocabulary).

### Measured

- Corpus (1,087 production SVGs, svgo multipass + brotli as the production baseline): median ratio ×0.277, svb < svgo+brotli on 100% of files.
- Large repetitive files (former F-12 gap): ×0.064–×0.233 of the SVG+br baseline. Organic illustrations remain conceded to SVG+br — a v0.3 modeling problem.

## [0.1.1] — 2026-08-30

### Security hardening (format unchanged, version byte stays `1`)

- EOF guards on all byte readers — reads past the buffer throw instead of returning garbage.
- Declared counts must fit within the remaining bytes (kills the 20-byte → 4 GB OOM proof-of-concept; it now rejects in milliseconds).
- Decompression output cap (64 MB) — kills the ×1029 decompression bomb.
- Encoder input cap (10 MB) and O(n²) attribute parsing fixed.
- SPEC §12 (Security) added as normative text.

## [0.1.0] — 2026-08-30

- First public release: header, chunk container (STYLE / GEOM / A11Y / META), geometric subset, validator, fuzzer, Service Worker polyfill, CLI, benchmark over 1,087 production SVGs (median svb/svg ×0.272 at v0.1).

[0.2.1]: https://github.com/kinti/svb/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kinti/svb/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kinti/svb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kinti/svb/releases/tag/v0.1.0
