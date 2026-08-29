# SVB — Scalable Vector Binary

**Especificación v0.1 (borrador de trabajo)** · 2026-08-29
*Formato binario de gráficos vectoriales para la web: el tamaño de un binario, con accesibilidad y progreso como ciudadanos de primera clase.*

---

## 1. Objetivos y no-objetivos

**Objetivos**

1. **Tamaño**: reducir drásticamente los SVG reales (iconos, ilustraciones, logotipos) incluso antes de compresión de transporte. Los datos de coordenadas son la mayor parte de un SVG optimizado; en texto cuestan 3–8 bytes por número, aquí 1–2.
2. **Progresivo por diseño**: contenedor por chunks; un renderizador puede pintar con los primeros chunks y refinar con los siguientes. Un decodificador v1 ignora los chunks que no conoce.
3. **Accesibilidad obligatoria y verificable**: el nombre accesible y la descripción viven en un chunk propio, con posición fija en la gramática. Un validador puede exigirlo; un peritaje puede certificarlo. En SVG son atributos opcionales que casi nadie pone.
4. **Animación declarativa sin SMIL** (reservado, v0.2): chunk dedicado, no texto, no JavaScript.
5. **Agnóstico del renderizador**: el formato describe geometría y estilo; cómo se pinta (DOM→SVG, canvas, WebGL, nativo) no forma parte de la especificación.

**No-objetivos en v0.1**

- Reemplazar el 100% de SVG 1.1. El subconjunto objetivo cubre el ~90% del uso web real: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` con relleno sólido, trazo y transformadas. Quedan fuera por ahora (documentado): gradientes, filtros, `<text>`, `<use>/<defs>`, `<image>`, CSS embebido, clip/mask.
- Ser un estándar de consorcio. v0.1 es una especificación abierta con implementación de referencia; la vía de estandarización se decide con adopción, no antes.

**Precedentes**: TinyVG demostró que un SVG binario pesa ~39% del original, pero su nicho son los sistemas embebidos (sin animación, sin accesibilidad, sin entorno web). SVB apunta al entorno web: Service Worker como polyfill universal, chunk de accesibilidad, render progresivo y animación reservada. JPEG XL es el precedente de éxito técnico con adopción política difícil; Lottie y Rive, el de "formato + runtime propio" sin pedir permiso a los navegadores.

## 2. Convenciones

- Todos los enteros en **little-endian** salvo los varint, que son byte a byte.
- **varuint**: entero sin signo en LEB128 (7 bits por byte, bit alto = continuación).
- **varint**: entero con signo codificado en zigzag (`n ≥ 0 → 2n`, `n < 0 → −2n−1`) y luego como varuint.
- **fixed**: valor de coordenada cuantizado como `round(valor × coord_scale)` y almacenado como varuint (absoluto) o varint (delta). `coord_scale` viaja en la cabecera (p. ej. `64` ≈ 2 decimales; `256` ≈ subpíxel). Igual que SVG, el lienzo es sin unidades.
- Longitudes de cadena: `varuint` + UTF-8.
- Todo campo marcado *reservado* debe escribirse a 0 y ser ignorado al leer.

## 3. Cabecera de archivo

Bytes iniciales del archivo, nunca comprimidos:

| Campo        | Tipo    | Valor                                             |
|--------------|---------|---------------------------------------------------|
| magic        | 3 bytes | `53 56 42` (`"SVB"`)                              |
| version      | u8      | `1`                                               |
| flags        | u8      | ver tabla                                         |
| width        | varuint | ancho del lienzo en unidades de usuario (≤ 65535) |
| height       | varuint | alto del lienzo                                   |
| coord_scale  | varuint | factor de cuantización de coordenadas             |

**flags**

| bit | nombre        | significado                                                     |
|-----|---------------|-----------------------------------------------------------------|
| 0   | COMPRESSED    | el flujo de chunks va comprimido en DEFLATE (raw, sin cabecera zlib) |
| 1   | HAS_A11Y      | existe chunk A11Y                                               |
| 2   | HAS_ANIMATION | reservado (v0.2)                                                |
| 3   | HAS_STYLE     | existe chunk STYLE                                              |
| 4–7 | —             | reservados, 0                                                   |

## 4. Contenedor por chunks

Tras la cabecera (y, si procede, descomprimir el resto del archivo), el archivo es una secuencia:

```
chunk  =  tag:u8  size:varuint  body[size]
```

| tag    | chunk | obligatorio | contenido                                  |
|--------|-------|-------------|--------------------------------------------|
| `0x01` | STYLE | no          | tabla de estilos compartidos               |
| `0x02` | GEOM  | sí, 1 vez   | lista ordenada de elementos                |
| `0x03` | A11Y  | no (flag)   | nombre/descripción accesibles              |
| `0x04` | ANIM  | reservado   | animación declarativa (v0.2)               |
| `0x05` | META  | no          | metadatos (generador, licencia…)           |
| resto  | EXT   | no          | **debe saltarse** leyendo `size` → compatibilidad futura |

Reglas: un decodificador conforme debe poder saltar cualquier chunk desconocido sin bloquear el render. El render progresivo (v0.2) explotará esta propiedad ordenando los chunks de "base renderizable" a "refino".

## 5. Chunk STYLE (0x01)

Tabla de estilos indexada; los elementos referencian la entrada por índice. La internación de estilos repetidos (p. ej. el color de marca en un icono) es una de las ganancias frente a SVG.

```
count: varuint
entrada ×count:
  style_byte: u8
      bit 0–1  fill:    0 none · 1 color · 2 color+alfa
      bit 2–3  stroke:  0 none · 1 color · 2 color+alfa
      bit 4    tiene stroke-width
      bit 5    tiene byte de caps/join
      bit 6    tiene dash array
      bit 7    fill-rule evenodd (0 = nonzero)
  [ fill:  R,G,B (u8×3) ]              si fill ≠ 0
  [ fill alfa: u8 ]                    si fill = 2
  [ stroke: R,G,B ]                    si stroke ≠ 0
  [ stroke alfa: u8 ]                  si stroke = 2
  [ stroke-width: varuint fixed ]      si bit 4
  [ caps/join: u8 ]                    si bit 5   (nibble bajo: cap 0 butt · 1 round · 2 square;
                                                    nibble alto: join 0 miter · 1 round · 2 bevel)
  [ dash: n:varuint, n × varuint fixed ] si bit 6
```

## 6. Chunk GEOM (0x02)

Elementos en **orden de documento** (orden de pintado y de lectura).

```
count: varuint
elemento ×count:
  elem_byte: u8
      bit 0–3  forma: 1 rect · 2 circle · 3 ellipse · 4 line · 5 polyline · 6 polygon · 7 path
      bit 4    tiene transform: matriz 6 × varint fixed (orden SVG matrix(a,b,c,d,e,f))
      bit 5    estilo inline (misma codificación que una entrada STYLE, en línea)
      bit 6–7  reservados, 0
  [ style_index: varuint ]     si bit 5 = 0
  [ matriz a,b,c,d,e,f ]       si bit 4
  datos de forma (posiciones absolutas → **varint** con signo; tamaños y radios → **varuint**):
    rect      x:varint, y:varint, w:varuint, h:varuint, rx:varuint, ry:varuint
    circle    cx:varint, cy:varint, r:varuint
    ellipse   cx:varint, cy:varint, rx:varuint, ry:varuint
    line      x1, y1, x2, y2 (varint ×4)
    polyline  count:varuint, x0:varint, y0:varint, luego (count−1) pares varint delta
    polygon   idéntico a polyline
    path      cmd_count: varuint, seguido de comandos:
                cmd_byte: bits 0–2 → 0 M · 1 L · 2 C · 3 Q · 4 A · 5 Z ; bits 3–7 reservados, 0
                  M · L → 1 punto
                  C     → 3 puntos
                  Q     → 2 puntos
                  A     → rx:varuint, ry:varuint, rot:varint (grados, entero),
                           flags:u8 (bit0 large-arc, bit1 sweep), punto final
                  Z     → nada
```

**Codificación de puntos en `path`**: el primer `M` de cada path es absoluto (varint con signo ×2, admite coordenadas negativas fuera del lienzo). Todo punto posterior se almacena como **delta zigzag respecto al lápiz** (la posición actual tras el punto anterior), sea cual sea el comando. Esta codificación delta es la principal fuente de ahorro: en coordenadas contiguas, los deltas caben en 1 byte donde SVG gasta 6–10 caracteres.

**Normalización en el codificador**: `S→C`, `T→Q`, `H/V→L`, relativos→absolutos antes de cuantizar. El decodificador solo implementa los 6 comandos canónicos.

**viewBox y herencia**: el codificador "hornea" el `viewBox` raíz (traslación+escala) y las transformaciones anidadas de los `g` en la matriz de cada elemento. Un elemento sin transformación efectiva no lleva bit 4.

## 7. Chunk A11Y (0x03)

Ciudadano de primera clase: presencia anunciada por flag en la cabecera y gramática fija, validable sin interpretar la geometría.

```
name: lenpfx-utf8          nombre accesible del documento (puede ser "")
desc: lenpfx-utf8          descripción
labels: count: varuint
  entrada ×count:
    elem_index: varuint     índice del elemento en GEOM
    name:        lenpfx-utf8
    desc:        lenpfx-utf8
```

Reglas de emisión del decodificador hacia SVG: `name` → `<title>` e `desc` → `<desc>` como primeros hijos de la raíz, más `role="img"` y `aria-labelledby` cuando proceda. Las etiquetas por elemento → `<title>` hijo del elemento. Un codificador debe extraer estos datos de `<title>`, `<desc>` y `aria-label*` presentes en el SVG de origen.

**Norma del formato**: un archivo SVB conforme debe declarar flag HAS_A11Y. La no-declaración es válida pero marcada como "no conforme-a11y" por los validadores (base para auditoría/certificación posterior).

## 8. Chunk META (0x05)

`generator: lenpfx-utf8` — cadena informativa, ignorable. Reservado para licencia y autoría en v0.2.

## 9. Chunk ANIM (0x04) — reservado

Diseño previsto (no normativo en v0.1): pista(s) de keyframes por elemento o propiedad (`transform`, opacidad, geometría), temporización con curvas cúbicas, sin expresiones. Objetivo: sustituir el 100% de los usos vivos de SMIL con coste de bytes de orden inferior.

## 10. Tipo de medio y registro

- `image/x-svb` — hasta completar registro.
- Objetivo: `image/svb` en el registro IANA de tipos de medios (revisión de experto, RFC 6838), con esta especificación como referencia.

## 11. Conformidad

Un **codificador conforme** emite cabecera válida, al menos un chunk GEOM, chunks en orden creciente de tag y ningún byte fuera de chunk. Un **decodificador conforme** acepta cualquier archivo v1, ignora chunks desconocidos y renderiza el subconjunto GEOM+STYLE; el soporte de A11Y es obligatorio para el sello "SVB accesible".

## 12. Historial

- **v0.1 (2026-08-29)** — primer borrador público: cabecera, contenedor por chunks, STYLE/GEOM/A11Y/META, subconjunto geométrico, ANIM reservado.
