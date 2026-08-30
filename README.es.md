# SVB — Scalable Vector Binary

<p align="center"><img src="docs/social-card.png" alt="SVB: un formato binario de imágenes vectoriales para la web" width="640"></p>

**Formato binario de imágenes vectoriales para la web** · v0.2 · especificación + implementación de referencia.

[![Tests](https://github.com/kinti/svb/actions/workflows/tests.yml/badge.svg)](https://github.com/kinti/svb/actions/workflows/tests.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/kinti/svb/codeql.yml?label=CodeQL)](https://github.com/kinti/svb/security/code-scanning)
[![Release](https://img.shields.io/github/v/release/kinti/svb)](https://github.com/kinti/svb/releases)
[![License](https://img.shields.io/github/license/kinti/svb)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-2ea44f)
![Median size](https://img.shields.io/badge/median_svb%2Fsvg-%C3%970.277-7A1F2B)
[![Live demo](https://img.shields.io/badge/live_demo-kinti.github.io%2Fsvb-7A1F2B)](https://kinti.github.io/svb/demo/)

**▶ Demo en vivo**: <https://kinti.github.io/svb/demo/> — `<img src="*.svb">` funcionando en los navegadores actuales vía Service Worker.

> English version in [README.md](README.md). Ante discrepancias, vale la versión inglesa (idioma normativo). Artículo del proyecto: <https://jquin.net/svb/>

## Qué es

SVG es el formato vectorial universal — y su formato de archivo lleva dos décadas congelado. SVB es una codificación binaria compacta de la misma geometría, diseñada sobre tres propiedades que a SVG le faltan: eficiencia de tamaño, accesibilidad verificable y seguridad de entrega. Los archivos se renderizan en los navegadores actuales mediante un polyfill de Service Worker — sin plugin y sin tocar los navegadores.

- **Especificación** — byte a byte, gramática libre de contexto, invariantes normativas: [SPEC.md](SPEC.md) (espejo en [SPEC.es.md](SPEC.es.md))
- **Modelo de diseño** — invariantes, modelo de amenazas, libro de hallazgos: [DESIGN.md](DESIGN.md)
- **Implementación de referencia** — JavaScript sin dependencias: encoder, decoder y CLI ([src/](src/))
- **Entrega** — polyfill de Service Worker + página de comparación: [demo en vivo](https://kinti.github.io/svb/demo/)

## Por qué

1. **El estándar está congelado.** SVG 2 murió como Candidate Recommendation abandonada y el grupo de trabajo lleva años en modo mantenimiento. Los problemas estructurales no se arreglan desde dentro.
2. **El texto cuesta.** Cada coordenada gasta 3–8 bytes de ASCII; la compresión genérica de transporte no ve la geometría que comprime.
3. **La accesibilidad es opcional en la práctica.** `<title>`, `<desc>`, ARIA dentro del SVG — casi nadie los pone, y nada en el formato puede verificarlos.
4. **Los scripts son un pasivo.** SVG puede llevar JavaScript — el clásico vector de XSS de los logos subidos por usuarios.

SVB responde cada punto a nivel de formato:

- **Codificación binaria** — coordenadas en delta zigzag a precisión de punto fijo configurable, tabla de estilos internada, packing de comandos estilo MVT. Mediana ×0,277 del SVG optimizado; el binario crudo es menor que svgo+brotli en el 100% del corpus medido.
- **A11Y como chunk de primera clase** — nombre accesible y descripción con gramática fija, anunciados por un flag de cabecera. Un validador puede exigirlos; un auditor puede certificarlos.
- **Seguridad por construcción** — no existe tipo de chunk ejecutable; el decoder emite solo geometría y texto escapado. Lecturas acotadas, validación de contadores declarados, techos de descompresión y expansión normativos (SPEC §12).
- **Contenedor por chunks preparado para evolucionar** — los chunks desconocidos se saltan, así que repetición, gradientes (v0.2) y el futuro render progresivo o animación llegan sin romper nada.

## Resultados medidos

**Corpus**: 1.087 SVG de producción (Feather, Bootstrap Icons, Simple Icons — semilla 42), cada uno optimizado antes con **svgo multipass** — la comparación es contra lo que un desarrollador publicaría de verdad. Reproducible con `benchmark/run.mjs`; datos completos en la [página del benchmark](https://kinti.github.io/svb/benchmark/).

| métrica | resultado |
|---|---|
| Mediana svb / svg-optimizado | **×0,277** |
| SVB crudo menor que svgo+brotli | **100% de los archivos** |
| Mediana svb+brotli / svgo+brotli | ×0,542 |
| Tamaño mediano | 467 B → **139 B** |

**Archivos grandes tipo producción** (140–580 KB: mapas repetitivos, esquemas, curvas orgánicas — la clase donde los formatos binarios ingenuos suelen perder contra brotli). La v0.2 añadió el modelo de repetición (semántica `<use>` como templates + instancias binarias con delta-chain) y el packing de comandos, cerrando esa brecha:

| muestra | svb | svg+brotli | ratio |
|---|---|---|---|
| mapa repetitivo, 12k bloques | **1.438 B** | 10.040 B | ×0,143 |
| mapa repetitivo, 3k bloques | 948 B | 3.897 B | ×0,233 |
| esquema, 2k instancias | **281 B** | 4.081 B | ×0,064 |
| curvas orgánicas (sin repetición) | 66.695 B | 63.190 B | ×1,055 — concedida a v0.3 |

La victoria en repetitivos viene del chunk DEF (semántica `<use>` como templates + instancias con delta-chain); la clase orgánica sin repetición es un problema de modelado geométrico aplazado a v0.3.

## Uso

```bash
node src/cli.js encode in.svg out.svb
node src/cli.js decode out.svb back.svg
node src/cli.js roundtrip in.svg      # encode→decode, vuelca el SVG decodificado
node src/cli.js bench in.svg [more…]  # tabla svg/gzip/brotli/svb
npm test                              # 43 tests (node:test, sin dependencias)
```

La entrega usa un Service Worker: las peticiones `*.svb` se decodifican (DEFLATE vía `DecompressionStream` y el decoder de referencia) y se responden como `image/svg+xml`, así `<img src="icon.svb">` funciona en cualquier navegador actual — el mismo camino "formato + runtime" que llevaron a Lottie y Rive.

## El formato

Contenedor por chunks con compatibilidad futura (los chunks desconocidos se saltan por tamaño declarado), coordenadas en delta zigzag a precisión de punto fijo configurable, tabla de estilos internada, **chunk A11Y** de gramática fija (nombre accesible y descripción, verificables sin renderizar), gradientes lineales y radiales (objectBoundingBox-u8 o userSpaceOnUse, transform opcional), repetición como templates más instancias con delta-chain, packing de comandos, y chunks reservados para render progresivo y animación declarativa.

Seguridad por diseño: sin constructos ejecutables (elimina el vector XSS del SVG subido), lecturas acotadas, validación de contadores declarados, techos de descompresión y expansión, cero dependencias runtime. Declaración formal: SPEC §12 y [DESIGN.md](DESIGN.md).

## Limitaciones v0.2

- Subconjunto: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, templates/instancias, gradientes lineales y radiales. **Aún no**: texto, filtros, clip/mask, CSS embebido, pattern fills.
- Solo atributos de presentación (sin herencia CSS de `<style>`).
- Rotaciones de arco cuantizadas a grados enteros; coordenadas a `1/coord_scale` (por defecto 1/64).
- La ilustración orgánica sin repetición sigue ~5% detrás de svg+brotli — modelado geométrico planeado para v0.3.

## Hoja de ruta

1. **Modelado geométrico de la clase orgánica** (cuantización adaptativa / ajuste de curvas) — v0.3.
2. **Etapa de entropía** (códigos grammar-informed o rANS) — gatillo: brecha medida contra svg+brotli > 10% tras el modelado de repetición.
3. **`<text>` y clip/mask** — los huecos restantes del subconjunto.
4. **Validador + sello "SVB accesible"** — chequeo de accesibilidad listo para auditoría.
5. **Campaña de fuzzing** — requerida antes de uso en producción con ficheros de terceros.
6. **Puerto Rust → WASM** del hot path.

## Ruta de publicación

Este repositorio (spec + implementación de referencia + suite de conformidad) es la base. Próximos pasos previstos: registro del media type `image/svb` en IANA (revisión de experto, RFC 6838) y un W3C Community Group si la adopción lo justifica. Precedentes: TinyVG, Lottie y Rive operan sin estandarización de consorcio; decide la adopción.

## Licencia

MIT — © 2026 Jesús Quintana · [jquin.net](https://jquin.net/)
