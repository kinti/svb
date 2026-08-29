# SVB — Scalable Vector Binary

**Formato binario de gráficos vectoriales para la web** · v0.1 · especificación + implementación de referencia.

**▶ Demo en vivo: <https://kinti.github.io/svb/demo/>** — `<img src="*.svb">` funcionando hoy en tu navegador vía Service Worker.

> **EN abstract** — SVB is a binary vector-image format: same content as SVG at ~30–35% of the size *before* transport compression, with accessibility metadata as a first-class chunk, chunk-based forward compatibility, and animation reserved for v0.2. Ships with a Service Worker polyfill so `<img src="*.svb">` works in today's browsers — no plugin, no new browser engine.

## Por qué

SVG es texto: cada coordenada cuesta 3–8 bytes, las cabeceras se repiten y la accesibilidad interna es opcional en la práctica (nadie la pone). El estándar está congelado desde la abandoned-CR de SVG 2, así que las mejoras solo pueden venir de fuera. SVB ataca las tres cosas:

1. **Tamaño**: deltas zigzag + cuantización fija + tabla de estilos internada. En los ejemplos de este repo, el binario puro pesa menos que el SVG comprimido con brotli.
2. **Accesibilidad verificable**: chunk A11Y con gramática fija, anunciado por flag en cabecera. Un validador puede exigirlo; un peritaje puede certificarlo.
3. **Evolución sin romper**: contenedor por chunks; un decodificador v1 ignora chunks que no conoce (ANIM v0.2, EXT futuros).

## Números (muestras de este repo, sin optimizar previamente con svgo)

| archivo | svg | +gzip | +brotli | **svb** | svb+gzip | svb+brotli | svb/svg |
|---|---|---|---|---|---|---|---|
| icon-pin.svg | 328 | 240 | 199 | **86** | 109 | 90 | **26%** |
| illustration.svg | 946 | 513 | 462 | **303** | 326 | 307 | **32%** |
| logo-star.svg | 380 | 275 | 230 | **123** | 146 | 127 | **32%** |

El dato importante: **SVB crudo < SVG + brotli** en los tres casos.

## Uso

```bash
node src/cli.js encode in.svg out.svb
node src/cli.js decode out.svb back.svg
node src/cli.js roundtrip in.svg      # encode→decode y vuelca el SVG decodificado
node src/cli.js bench in.svg [more…]  # tabla svg/gzip/brotli/svb
npm test                              # 19 tests (node:test, sin dependencias)
```

## Demo (Service Worker polyfill)

En vivo en <https://kinti.github.io/svb/demo/> (o en local: `python3 -m http.server 8923` desde la raíz del repo → `/demo/`).

Un Service Worker intercepta las peticiones `*.svb`, las decodifica con `DecompressionStream` + el decoder del repo y responde `image/svg+xml`. Así `<img src="icon.svb">` funciona en cualquier navegador actual: **el polyfill es la vía de entrada del formato**, el mismo patrón que usaron Lottie y Rive (formato + runtime propio, sin esperar a los navegadores).

## Estructura

```
SPEC.md              especificación v0.1 (byte a byte)
src/svb.js           primitivas: varuint/varint zigzag, fixed, colores
src/xml.js           parser XML mínimo (subconjunto SVG)
src/path.js          parser/normalizador de path data (→ M,L,C,Q,A,Z)
src/encoder.js       SVG → SVB (hornea viewBox/transforms, interna estilos)
src/decoder.js       SVB → SVG (salta chunks desconocidos: forward-compat)
src/browser-decode.js  decodeAsync con DecompressionStream
src/cli.js           encode/decode/roundtrip/bench
demo/                Service Worker + página de comparación
test/                round-trips, fuzz varint, forward-compat, errores
```

## Limitaciones v0.1 (documentadas, no ocultas)

- Subconjunto: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` con relleno sólido, trazo, opacidad, dash y transformadas. **Sin**: gradientes, filtros, `<text>`, `<use>/<defs>`, `<image>`, CSS embebido, clip/mask (el encoder avisa y los sustituye/salta).
- Atributos de presentación únicamente (no CSS heredado de `<style>`).
- Rotaciones de arco cuantizadas a grados enteros; coordenadas a `1/coord_scale` (por defecto 1/64 ≈ 0.016).

## Hoja de ruta

1. **Corpus real**: benchmark honesto sobre cientos de SVGs de producción (pre-svgo y post-svgo).
2. **Rust → WASM**: puerto del codec hot-path; mismo binario para CLI y web.
3. **Chunk ANIM (v0.2)**: keyframes declarativos sin SMIL.
4. **Progresivo real**: orden de chunks base→refino explotando el salto de chunks desconocidos.
5. **Validador + sello "SVB accesible"**: base para auditoría (conexión con peritaje Ley 11/2023).

## Ruta de publicación (la pregunta "¿y el W3C?")

1. Este repo: spec versionada + implementación de referencia + test suite *(hecho)*.
2. Registro del tipo de medio `image/svb` en **IANA** (revisión de experto, RFC 6838) — gratuito y formal.
3. Si hay tracción: **W3C Community Group** propio (crearlo es gratis y abierto) que publique CG Report en w3.org.
4. Precedentes honestos: TinyVG, Lottie y Rive nunca fueron estándar de consorcio y funcionan. La adopción manda; el consorcio, si llega, viene después.

## Licencia

MIT — © 2026 Jesús Quintana
