# SVB — Scalable Vector Binary

**A binary vector-image format for the web** · v0.1 · specification + reference implementation.

**▶ Live demo: <https://kinti.github.io/svb/demo/>** — `<img src="*.svb">` working in today's browsers via a Service Worker. No plugin, no new browser engine.

> También disponible en [español](README.es.md).

## Why this exists

SVG is stuck — and that is exactly why there is room to improve it:

1. **The standard is frozen.** SVG 2 died as an abandoned Candidate Recommendation and the W3C Working Group is dormant. SVG's structural problems will never be fixed from the inside; improvement can only come from outside — the same way JPEG XL happened for raster images.
2. **SVG is text, and text is expensive.** Every coordinate costs 3–8 bytes of ASCII, the same boilerplate repeats in every single file, and generic transport compression (gzip/brotli) cannot see the structure it is compressing.
3. **Accessibility is optional in practice.** `<title>`, `<desc>`, ARIA inside SVG: almost nobody ships them, and nothing in the format itself can verify them.

SVB turns each problem into a concrete improvement path:

- **Binary encoding** — delta zigzag coordinates, fixed-point quantization, interned style table. On the samples in this repo, the raw binary is already *smaller than brotli-compressed SVG*.
- **Accessibility as a first-class chunk** — a fixed-grammar A11Y chunk announced by a header flag. Validators can require it; auditors can certify it. In SVG these are optional attributes nobody ships; here the format itself can demand them.
- **A chunk container built for evolution** — decoders skip chunks they don't know, so progressive rendering (v0.2) and declarative animation without SMIL (v0.2, reserved) can be added without breaking anything.

Precedents, honestly stated: TinyVG proved a binary SVG subset can hit ~39% of the size — but it targets embedded systems, with no web runtime, no animation, no accessibility. Lottie and Rive prove that "format + own runtime" wins adoption *without* waiting for browser vendors — the Service Worker polyfill in this repo is exactly that path. And JPEG XL is the reminder that being technically superior is not enough; adoption is political. SVB is designed so that even the "it never takes off" scenario leaves value behind: a rigorous spec, a working codec, and a live demo.

## Numbers

Unoptimized samples from this repo:

| file | svg | +gzip | +brotli | **svb** | svb+gzip | svb+brotli | svb/svg |
|---|---|---|---|---|---|---|---|
| icon-pin.svg | 328 | 240 | 199 | **86** | 109 | 90 | **26%** |
| illustration.svg | 946 | 513 | 462 | **303** | 326 | 307 | **32%** |
| logo-star.svg | 380 | 275 | 230 | **123** | 146 | 127 | **32%** |

The headline: **raw SVB is smaller than brotli-compressed SVG** in all three cases — the win comes from the format itself, not from transport compression.

## Usage

```bash
node src/cli.js encode in.svg out.svb
node src/cli.js decode out.svb back.svg
node src/cli.js roundtrip in.svg      # encode→decode, writes the decoded SVG
node src/cli.js bench in.svg [more…]  # svg/gzip/brotli/svb size table
npm test                              # 19 tests (node:test, zero dependencies)
```

## Demo (Service Worker polyfill)

Live at <https://kinti.github.io/svb/demo/>. Locally: `python3 -m http.server 8923` from the repo root, then open `/demo/`.

A Service Worker intercepts `*.svb` requests, decodes them (DecompressionStream + the decoder in this repo) and responds `image/svg+xml`, so `<img src="icon.svb">` just works in any current browser. **The polyfill is the format's entry path** — the same "format + runtime" move that worked for Lottie and Rive.

## Repository layout

```
SPEC.md              byte-level specification (v0.1)
src/svb.js           primitives: varuint / zigzag varint, fixed-point, colors
src/xml.js           minimal XML parser (SVG subset)
src/path.js          path-data parser/normalizer (→ canonical M,L,C,Q,A,Z)
src/encoder.js       SVG → SVB (bakes viewBox/transforms, interns styles)
src/decoder.js       SVB → SVG (skips unknown chunks: forward compatible)
src/browser-decode.js  async decode via DecompressionStream
src/cli.js           encode/decode/roundtrip/bench
demo/                Service Worker + comparison page
test/                round-trips, varint fuzz, forward-compat, error handling
```

## v0.1 limitations (documented, not hidden)

- Subset: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` with solid fill, stroke, opacity, dash arrays and transforms. **Not yet**: gradients, filters, `<text>`, `<use>/<defs>`, `<image>`, embedded CSS, clip/mask (the encoder warns and skips/replaces them).
- Presentation attributes only (no CSS inheritance from `<style>`).
- Arc rotations quantized to whole degrees; coordinates to `1/coord_scale` (default 1/64 ≈ 0.016).

## Roadmap

1. **Real-world corpus**: honest benchmarks over hundreds of production SVGs (pre- and post-svgo).
2. **Rust → WASM**: port the hot path; one binary for CLI and web.
3. **ANIM chunk (v0.2)**: declarative keyframes without SMIL.
4. **Real progressive rendering**: chunk ordering from base layer to refinement.
5. **Validator + "accessible SVB" seal**: audit-ready (connects with accessibility auditing under EU Web Accessibility Directive / Spain's Ley 11/2023).

## Publication path

1. This repo: versioned spec + reference implementation + test suite *(done)*.
2. Register the `image/svb` media type with **IANA** (expert review, RFC 6838) — free and formal.
3. With traction: a **W3C Community Group** publishing a CG Report (creating one is free and open to individuals).
4. Honest precedents: TinyVG, Lottie and Rive were never consortium standards and still matter. Adoption decides; the consortium, if it ever comes, comes after.

## Security notes

By design, SVB **cannot carry scripts** — there is no script chunk and the reference decoder only emits geometry and accessibility text, which removes SVG's classic XSS vector (user-uploaded SVG logos). The v0.1 decoder enforces basic hardening: mandatory magic bytes, chunk-bounds checks, varint length caps. It is still a young reference implementation: before any production use with untrusted files, it needs fuzzing and a formal security review — the same path PNG went through.

## License

MIT — © 2026 Jesús Quintana
