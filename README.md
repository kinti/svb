# SVB — Scalable Vector Binary

<p align="center"><img src="docs/social-card.png" alt="SVB: a binary vector-image format for the web" width="640"></p>

**A binary vector-image format for the web** · v0.2 · specification + reference implementation.

[![Tests](https://github.com/kinti/svb/actions/workflows/tests.yml/badge.svg)](https://github.com/kinti/svb/actions/workflows/tests.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/kinti/svb/codeql.yml?label=CodeQL)](https://github.com/kinti/svb/security/code-scanning)
[![Release](https://img.shields.io/github/v/release/kinti/svb)](https://github.com/kinti/svb/releases)
[![License](https://img.shields.io/github/license/kinti/svb)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-2ea44f)
![Median size](https://img.shields.io/badge/median_svb%2Fsvg-%C3%970.277-7A1F2B)
[![Live demo](https://img.shields.io/badge/live_demo-kinti.github.io%2Fsvb-7A1F2B)](https://kinti.github.io/svb/demo/)

**▶ Live demo**: <https://kinti.github.io/svb/demo/> — `<img src="*.svb">` rendering in current browsers via a Service Worker.

> Spanish project article: <https://jquin.net/svb/>

## Overview

SVG is the universal vector format — and its file format has been frozen for two decades. SVB is a compact binary encoding of the same geometry, designed around three properties SVG lacks: size efficiency, verifiable accessibility, and delivery safety. Files render in current browsers through a Service Worker polyfill — no plugin, no browser changes.

- **Specification** — byte-level, context-free grammar, normative invariants: [SPEC.md](SPEC.md) (Spanish mirror included)
- **Design model** — invariants, threat model, findings ledger: [DESIGN.md](DESIGN.md)
- **Reference implementation** — dependency-free JavaScript: encoder, decoder, CLI, validator, fuzzer ([src/](src/))
- **Delivery** — Service Worker polyfill + comparison page: [live demo](https://kinti.github.io/svb/demo/)

## Why

1. **The standard is frozen.** SVG 2 died as an abandoned Candidate Recommendation; the working group has been in maintenance mode for years. Structural problems will not be fixed from the inside.
2. **Text is expensive.** Every coordinate costs 3–8 bytes of ASCII; generic transport compression cannot see the geometry it compresses.
3. **Accessibility is optional in practice.** `<title>`, `<desc>`, ARIA inside SVG — almost nobody ships them, and nothing in the format can verify them.
4. **Scripts are a liability.** SVG can carry JavaScript — the classic uploaded-logo XSS vector.

SVB addresses each point at the format level:

- **Binary encoding** — zigzag delta coordinates at configurable fixed-point precision, interned style table, MVT-style command-run packing. Median ×0.277 of the optimized SVG; raw SVB is smaller than svgo+brotli on 100% of the measured corpus.
- **A11Y as a first-class chunk** — accessible name and description with a fixed grammar, announced by a header flag. Validators can require it; auditors can certify it.
- **Safety by construction** — no executable chunk type exists; the decoder emits only geometry and escaped text. Bounded reads, declared-count validation, decompression and expansion ceilings are normative (SPEC §12).
- **A chunk container built to evolve** — unknown chunks are skipped, so repetition, gradients (v0.2) and future progressive rendering or animation ship without breaking anything.

## Measured results

**Corpus**: 1,087 production SVGs (Feather, Bootstrap Icons, Simple Icons — seed 42), each optimized with **svgo multipass** before measuring — the comparison is against what a developer would actually ship. Reproducible via `benchmark/run.mjs`; full data on the [benchmark page](https://kinti.github.io/svb/benchmark/).

| metric | result |
|---|---|
| Median svb / svg-optimized | **×0.277** |
| Raw SVB smaller than svgo+brotli | **100% of files** |
| Median svb+brotli / svgo+brotli | ×0.542 |
| Median size | 467 B → **139 B** |
| Mean savings per file | **72.7%** (570 B saved) |
| Aggregate bytes saved across the corpus | **73.8%** |

**Large production-like files** (140–580 KB: repetitive maps, schematics, organic curves — the class where naive binary formats typically lose to brotli). v0.2's repetition model (templates + delta-chained instances) and command packing close the gap:

| sample | svb | svg+brotli | ratio |
|---|---|---|---|
| repetitive map, 12k blocks | **1,438 B** | 10,040 B | ×0.143 |
| repetitive map, 3k blocks | 948 B | 3,897 B | ×0.233 |
| schematic, 2k instances | **281 B** | 4,081 B | ×0.064 |
| organic curves (no repetition) | 66,695 B | 63,190 B | ×1.055 — conceded to v0.3 |

## Usage

```bash
node src/cli.js encode in.svg out.svb
node src/cli.js decode out.svb back.svg
node src/cli.js roundtrip in.svg      # encode→decode, writes the decoded SVG
node src/cli.js bench in.svg [more…]  # svg/gzip/brotli/svb size table
node src/cli.js validate in.svb [--json]  # conformance report + accessibility seal
node src/cli.js fuzz [files…]             # mutation campaign against the decoder
npm test                              # 44 tests (node:test, zero dependencies)
```

Delivery uses a Service Worker: requests for `*.svb` are decoded (DEFLATE via `DecompressionStream`, then the reference decoder) and answered as `image/svg+xml`, so `<img src="icon.svb">` works in any current browser — the same "format + runtime" path that carried Lottie and Rive.

## Format

Chunk-based container with forward compatibility (unknown chunks are skipped by declared size), zigzag delta coordinates at configurable fixed-point precision, an interned style table, a grammar-fixed **A11Y chunk** (accessible name and description, verifiable without rendering), linear and radial gradients (objectBoundingBox-u8 or userSpaceOnUse, optional transform), repetition as templates plus delta-chained instances, command-run packing, and reserved chunks for progressive rendering and declarative animation.

Security properties, by design: no executable constructs (removes the uploaded-SVG XSS vector), bounded reads, declared-count validation, decompression and expansion ceilings, zero runtime dependencies. Formal statement: SPEC §12 and [DESIGN.md](DESIGN.md).

## v0.2 limitations

- Subset: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, templates/instances, linear and radial gradients. **Not yet**: text, filters, clip/mask, embedded CSS, pattern fills.
- Presentation attributes only (no CSS inheritance from `<style>`).
- Arc rotations quantized to whole degrees; coordinates to `1/coord_scale` (default 1/64).
- Organic no-repetition artwork stays ~5% behind svg+brotli — geometry modeling is planned for v0.3.

## Roadmap

1. **Geometry modeling for the organic class** (adaptive quantization / curve fitting) — v0.3.
2. **Entropy stage** (grammar-informed codes or rANS) — trigger: measured gap to svg+brotli > 10% after repetition modeling.
3. **`<text>` and clip/mask** — the remaining subset gaps.
4. ~~Validator + "accessible SVB" seal~~ — **core shipped in v0.2**: `svb validate` runs 14 conformance and accessibility checks (V-01…V-14, see [docs/validator.md](docs/validator.md)) and awards the **"SVB accesible" seal**. Next: report schema hardening + a11y-toolkit MCP integration.
5. **Fuzzing campaign** — required before any production use with untrusted files.
6. **Rust → WASM port** of the hot path.

## Publication path

This repository (spec + reference implementation + conformance suite) is the foundation. Planned next steps: `image/svb` media type registration with IANA (RFC 6838 expert review), and a W3C Community Group if adoption warrants it. Precedents: TinyVG, Lottie and Rive operate without consortium standardization; adoption decides, and the consortium — if it ever comes — comes after.

## License

MIT — © 2026 Jesús Quintana · [jquin.net](https://jquin.net/)
