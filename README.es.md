# SVB — Scalable Vector Binary

<p align="center"><img src="docs/social-card.png" alt="Logo de SVB: un camino vectorial en forma de S cuyos puntos de ancla son bits (llenos = 1, hueco = 0)" width="640"></p>

**Formato binario de imágenes vectoriales para la web** · v0.1 · especificación + implementación de referencia.

[![Tests](https://github.com/kinti/svb/actions/workflows/tests.yml/badge.svg)](https://github.com/kinti/svb/actions/workflows/tests.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/kinti/svb/codeql.yml?label=CodeQL)](https://github.com/kinti/svb/security/code-scanning)
[![Release](https://img.shields.io/github/v/release/kinti/svb)](https://github.com/kinti/svb/releases)
[![License](https://img.shields.io/github/license/kinti/svb)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-2ea44f)
![Median size](https://img.shields.io/badge/median_svb%2Fsvg-%C3%970.272-7A1F2B)
[![Live demo](https://img.shields.io/badge/live_demo-kinti.github.io%2Fsvb-7A1F2B)](https://kinti.github.io/svb/demo/)

**▶ Demo en vivo: <https://kinti.github.io/svb/demo/>** — `<img src="*.svb">` funcionando hoy en cualquier navegador vía Service Worker.

> English version in [README.md](README.md). Ante discrepancias, vale la versión inglesa (idioma normativo del proyecto). Artículo del proyecto: <https://jquin.net/svb/>

## Por qué existe

SVG está parado — y eso es exactamente lo que deja margen de mejora:

1. **El estándar está congelado.** SVG 2 murió como Candidate Recommendation abandonada y el grupo de trabajo del W3C está dormido. Los problemas estructurales de SVG no se arreglarán desde dentro; la mejora solo puede venir de fuera — igual que pasó con JPEG XL en raster.
2. **SVG es texto, y el texto cuesta.** Cada coordenada gasta 3–8 bytes de ASCII, la misma plomería se repite en todos los archivos, y la compresión genérica de transporte (gzip/brotli) no entiende la estructura que comprime.
3. **La accesibilidad es opcional en la práctica.** `<title>`, `<desc>`, ARIA dentro del SVG: casi nadie los pone, y nada en el formato permite verificarlos.

SVB convierte cada problema en una vía de mejora concreta:

- **Codificación binaria** — coordenadas en delta zigzag, cuantización de punto fijo, tabla de estilos internada. En las muestras de este repo, el binario crudo ya pesa **menos que el SVG comprimido con brotli**.
- **Accesibilidad como chunk de primera clase** — chunk A11Y de gramática fija, anunciado por flag en la cabecera. Un validador puede exigirlo; un auditor puede certificarlo. En SVG son atributos opcionales que nadie pone; aquí el formato los puede exigir.
- **Contenedor por chunks diseñado para evolucionar** — los decodificadores saltan los chunks que no conocen, así que el render progresivo (v0.2) y la animación declarativa sin SMIL (v0.2, reservada) se añaden sin romper nada.

Precedentes, con honestidad: TinyVG demostró que un subconjunto binario de SVG llega al ~39% del tamaño — pero es para sistemas embebidos, sin runtime web, sin animación, sin accesibilidad. Lottie y Rive demuestran que "formato + runtime propio" gana adopción *sin* esperar a los navegadores — el polyfill Service Worker de este repo es exactamente ese camino. Y JPEG XL es el recordatorio de que ser técnicamente superior no basta: la adopción es política. SVB está diseñado para que incluso el escenario "no despega" deje valor: una spec rigurosa, un codec funcionando y una demo en vivo.

## El logo, en su propio formato

La marca — un camino vectorial en forma de S cuyos puntos de ancla son bits (llenos = 1, hueco = 0) — está dibujada dentro del propio subconjunto de SVB v0.1 (rellenos sólidos, sin texto, sin gradientes), para que el formato pueda llevar su propia marca: **el logo en SVG pesa 789 B; en `.svb` pesa 150 B (19%)**. La paleta `#7A1F2B` / `#F5F0E6` pasa WCAG AAA (contraste 8,98:1, verificado con el [a11y-toolkit](https://github.com/kinti/a11y-toolkit) del autor). Ficheros en [`brand/`](brand/).

## Números — corpus real

**1.087 SVGs de producción** (Feather 287, Bootstrap Icons 400, Simple Icons 400 — semilla 42), cada uno optimizado antes con **svgo multipass**. Datos completos: **[página del benchmark](https://kinti.github.io/svb/benchmark/)** · `benchmark/run.mjs` lo reproduce.

| métrica | resultado |
|---|---|
| Mediana svb / svg-optimizado | **×0,272** (media ×0,270) |
| SVB crudo menor que svgo+brotli | **100% de los archivos** |
| Mediana svb+brotli / svgo+brotli | ×0,541 |
| Tamaño mediano | 467 B svg → **139 B svb** |
| Codificaciones limpias | 1.087 / 1.087 (0 con pérdida, 0 excluidos, round-trip verificado) |

Por fuente: Feather ×0,205 · Bootstrap ×0,279 · Simple Icons ×0,305. El peor archivo del corpus aún ahorra ~47%.

## Números — muestras artesanales (`demo/samples/`)

| archivo | svg | +gzip | +brotli | **svb** | svb+gzip | svb+brotli | svb/svg |
|---|---|---|---|---|---|---|---|
| icon-pin.svg | 328 | 240 | 199 | **86** | 109 | 90 | **26%** |
| illustration.svg | 946 | 513 | 462 | **303** | 326 | 307 | **32%** |
| logo-star.svg | 380 | 275 | 230 | **123** | 146 | 127 | **32%** |

El titular: **el SVB crudo es más pequeño que el SVG con brotli** — la ganancia viene del formato, no de la compresión de transporte. (Ojo: el SVB es tan denso que gzip/brotli encima lo *agranda* — comprimir lo comprimido. Los servidores no deberían re-comprimir `.svb`.)

## Uso

```bash
node src/cli.js encode in.svg out.svb
node src/cli.js decode out.svb back.svg
node src/cli.js roundtrip in.svg      # encode→decode y vuelca el SVG decodificado
node src/cli.js bench in.svg [more…]  # tabla svg/gzip/brotli/svb
npm test                              # 19 tests (node:test, sin dependencias)
```

## Demo (polyfill Service Worker)

En vivo: <https://kinti.github.io/svb/demo/>. En local: `python3 -m http.server 8923` desde la raíz y abrir `/demo/`.

Un Service Worker intercepta las peticiones `*.svb`, las decodifica (DecompressionStream + el decoder del repo) y responde `image/svg+xml`, así que `<img src="icon.svb">` funciona en cualquier navegador actual. **El polyfill es la vía de entrada del formato** — la misma jugada "formato + runtime" que funcionó a Lottie y Rive.

## Estructura del repo

```
SPEC.md              especificación byte a byte (v0.1, en inglés)
SPEC.es.md           versión española de la especificación
src/svb.js           primitivas: varuint/varint zigzag, punto fijo, colores
src/xml.js           parser XML mínimo (subconjunto SVG)
src/path.js          parser/normalizador de path data (→ M,L,C,Q,A,Z canónicos)
src/encoder.js       SVG → SVB (hornea viewBox/transforms, interna estilos)
src/decoder.js       SVB → SVG (salta chunks desconocidos: compatibilidad futura)
src/browser-decode.js  decodificación asíncrona vía DecompressionStream
src/cli.js           encode/decode/roundtrip/bench
demo/                Service Worker + página de comparación
benchmark/           benchmark con corpus real (run.mjs, resultados, página en vivo)
test/                round-trips, fuzz varint, forward-compat, errores
```

## Limitaciones v0.1 (documentadas, no ocultas)

- Subconjunto: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` con relleno sólido, trazo, opacidad, dash y transformadas. **Aún no**: gradientes, filtros, `<text>`, `<use>/<defs>`, `<image>`, CSS embebido, clip/mask (el encoder avisa y los salta/sustituye).
- Solo atributos de presentación (sin herencia CSS de `<style>`).
- Rotaciones de arco cuantizadas a grados enteros; coordenadas a `1/coord_scale` (por defecto 1/64 ≈ 0.016).

## Hoja de ruta

1. ~~**Corpus real**~~ *(hecho — [benchmark](https://kinti.github.io/svb/benchmark/): 1.087 archivos, mediana ×0,272)*. Ampliarlo: fuentes con ilustraciones y gradientes para priorizar la v0.2.
2. **Rust → WASM**: puerto del hot-path; un binario para CLI y web.
3. **Chunk ANIM (v0.2)**: keyframes declarativos sin SMIL.
4. **Progresivo real**: orden de chunks de capa base a refino.
5. **Validador + sello "SVB accesible"**: listo para auditoría (conexión con peritaje de accesibilidad, Ley 11/2023).
6. **Fuzzing + revisión de seguridad**: requerido antes de uso en producción con ficheros de terceros.

## Ruta de publicación

1. Este repo: spec versionada + implementación de referencia + tests *(hecho)*.
2. Registro del tipo de medio `image/svb` en **IANA** (revisión de experto, RFC 6838) — gratuito y formal.
3. Con tracción: **W3C Community Group** propio que publique CG Report (crear uno es gratis y abierto a individuos).
4. Precedentes honestos: TinyVG, Lottie y Rive nunca fueron estándares de consorcio y siguen importando. La adopción decide; el consorcio, si llega, llega después.

## Notas de seguridad

Por diseño, SVB **no puede llevar scripts** — no existe chunk de script y el decoder de referencia solo emite geometría y texto de accesibilidad, lo que elimina el vector clásico de XSS de SVG (logos SVG subidos por usuarios).

**Endurecimiento v0.1.1** (auditoría 2026-08-30, con los proof-of-concept conservados en `test/security.test.js`): un archivo hostil de ~20 bytes que declaraba 134 millones de comandos de path agotaba 4 GB de heap (ahora se rechaza en microsegundos por límites de contadores + guardas EOF); una bomba comprimida de 199 KB se expandía sin tope a 200 MB de RAM (ahora limitada a 64 MB, abortando en pleno stream); el parsing de listas de atributos adversarias ya no es cuadrático. Las reglas son normativas en [SPEC §12](SPEC.md).

Antes de uso en producción con ficheros de terceros sigue recomendado: fuzzing formal más allá de la suite de regresión (radamsa o similar).

## Licencia

MIT — © 2026 Jesús Quintana · [jquin.net](https://jquin.net/)
