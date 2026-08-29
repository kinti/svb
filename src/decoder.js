// SVB → SVG decoder (v0.1). See SPEC.md.
//
// decode(bytes, { inflate? }) → { svg, meta }
// inflate: sync (Uint8Array) → Uint8Array for COMPRESSED files. Node CLI passes
// zlib.inflateRawSync; browsers use decodeAsync() from browser-decode.js which
// relies on DecompressionStream.

import { MAGIC, VERSION, FLAG, CHUNK, SHAPE, ByteReader } from './svb.js';
import { serializePathData } from './path.js';

// SPEC §12: a declared count can never exceed the bytes available to hold it.
function ensureAvailable(r, n, what) {
  if (n > r.remaining) {
    throw new Error(`${what} (${n}) exceeds the ${r.remaining} remaining bytes — rejecting hostile/corrupt file`);
  }
}

export function decode(bytes, opts = {}) {
  const r = new ByteReader(bytes);
  for (let i = 0; i < 3; i++) {
    if (r.u8() !== MAGIC[i]) throw new Error('not an SVB file (bad magic)');
  }
  const version = r.u8();
  if (version !== VERSION) throw new Error(`unsupported SVB version ${version}`);
  const flags = r.u8();
  const width = r.varuint();
  const height = r.varuint();
  const scale = r.varuint();
  if (!scale) throw new Error('coord_scale must be > 0');

  let payload = r.bytes(r.remaining);
  if (flags & FLAG.COMPRESSED) {
    if (!opts.inflate) throw new Error('file is COMPRESSED but no inflate function was provided (use decodeAsync in the browser)');
    payload = opts.inflate(payload);
  }

  const pr = new ByteReader(payload);
  const styleTable = [];
  const elements = [];
  let a11y = null;
  let meta = {};
  let sawGeom = false;

  while (pr.remaining > 0) {
    const tag = pr.u8();
    const size = pr.varuint();
    if (size > pr.remaining) throw new Error(`chunk ${tag} overruns payload`);
    const body = new ByteReader(pr.bytes(size));
    switch (tag) {
      case CHUNK.STYLE: readStyleChunk(body, styleTable); break;
      case CHUNK.GEOM: readGeomChunk(body, elements, scale); sawGeom = true; break;
      case CHUNK.A11Y: a11y = readA11yChunk(body); break;
      case CHUNK.META: meta.generator = body.lenpfxUtf8(); break;
      default: /* EXT: skip (forward compatible) */ break;
    }
  }
  if (!sawGeom) throw new Error('missing GEOM chunk');

  return {
    svg: buildSvg(width, height, elements, styleTable, a11y, scale),
    meta: { width, height, scale, elements: elements.length, hasA11y: !!a11y, generator: meta.generator ?? null },
  };
}

// ---- chunk readers ----

function readStyleChunk(r, table) {
  const count = r.varuint();
  ensureAvailable(r, count, 'STYLE count');
  for (let i = 0; i < count; i++) {
    table.push(readStyleEntry(r));
  }
}

function readStyleEntry(r) {
  const sb = r.u8();
  const fillType = sb & 0x03;
  const strokeType = (sb >> 2) & 0x03;
  const hasWidth = !!(sb & (1 << 4));
  const hasCaps = !!(sb & (1 << 5));
  const hasDash = !!(sb & (1 << 6));
  const evenodd = !!(sb & (1 << 7));
  const style = { fill: null, stroke: null, evenodd };
  if (fillType) {
    style.fill = readRgb(r);
    if (fillType === 2) style.fillOpacity = r.u8() / 255;
  }
  if (strokeType) {
    style.stroke = readRgb(r);
    if (strokeType === 2) style.strokeOpacity = r.u8() / 255;
  }
  if (hasWidth) style.strokeWidth = r.varuint(); // fixed units
  if (hasCaps) {
    const cj = r.u8();
    style.lineCap = ({ 0: 'butt', 1: 'round', 2: 'square' })[cj & 0x0f] ?? 'butt';
    style.lineJoin = ({ 0: 'miter', 1: 'round', 2: 'bevel' })[(cj >> 4) & 0x0f] ?? 'miter';
  }
  if (hasDash) {
    const n = r.varuint();
    ensureAvailable(r, n, 'dash count');
    style.dash = [];
    for (let d = 0; d < n; d++) style.dash.push(r.varuint()); // fixed units
  }
  return style;
}

function readRgb(r) {
  return [r.u8(), r.u8(), r.u8()];
}

function readGeomChunk(r, elements, scale) {
  const count = r.varuint();
  ensureAvailable(r, count, 'GEOM count');
  for (let i = 0; i < count; i++) {
    const eb = r.u8();
    const type = eb & 0x0f;
    const hasTransform = !!(eb & (1 << 4));
    const inlineStyle = !!(eb & (1 << 5));
    let styleIndex = -1;
    let inline = null;
    if (inlineStyle) inline = readStyleEntry(r);
    else styleIndex = r.varuint();

    let matrix = null;
    if (hasTransform) {
      matrix = [];
      for (let k = 0; k < 6; k++) matrix.push(r.varint() / scale);
    }
    const shape = readShape(r, type, scale);
    elements.push({ shape, styleIndex, inline, matrix });
  }
}

function readShape(r, type, scale) {
  const uv = () => r.varuint() / scale;   // unsigned: sizes, radii
  const sv = () => r.varint() / scale;    // signed: absolute positions
  switch (type) {
    case SHAPE.RECT: {
      const [x, y, w, h, rx, ry] = [sv(), sv(), uv(), uv(), uv(), uv()];
      return { kind: 'rect', x, y, w, h, rx, ry };
    }
    case SHAPE.CIRCLE:
      return { kind: 'circle', cx: sv(), cy: sv(), r: uv() };
    case SHAPE.ELLIPSE:
      return { kind: 'ellipse', cx: sv(), cy: sv(), rx: uv(), ry: uv() };
    case SHAPE.LINE:
      return { kind: 'line', x1: sv(), y1: sv(), x2: sv(), y2: sv() };
    case SHAPE.POLYLINE:
    case SHAPE.POLYGON: {
      const n = r.varuint();
      ensureAvailable(r, n, 'polyline count');
      let px = sv(), py = sv();
      const pts = [[px, py]];
      for (let i = 1; i < n; i++) {
        px += r.varint() / scale;
        py += r.varint() / scale;
        pts.push([px, py]);
      }
      return { kind: type === SHAPE.POLYGON ? 'polygon' : 'polyline', pts };
    }
    case SHAPE.PATH: {
      const cmdCount = r.varuint();
      ensureAvailable(r, cmdCount, 'path command count');
      const segs = [];
      let penX = 0, penY = 0, subStartX = 0, subStartY = 0, firstPoint = true;
      for (let i = 0; i < cmdCount; i++) {
        const cb = r.u8();
        const cmd = ({ 0: 'M', 1: 'L', 2: 'C', 3: 'Q', 4: 'A', 5: 'Z' })[cb & 0x07];
        if (!cmd) throw new Error(`bad path command byte ${cb}`);
        if (cmd === 'Z') {
          segs.push({ cmd: 'Z', pts: [] });
          penX = subStartX; penY = subStartY;
          continue;
        }
        let arc = null;
        if (cmd === 'A') {
          const rx = uv(), ry = uv();
          const rot = r.varint();
          const aflags = r.u8();
          arc = { rx, ry, rot, largeArc: !!(aflags & 1), sweep: !!(aflags & 2) };
        }
        const nPts = cmd === 'C' ? 3 : cmd === 'Q' ? 2 : 1;
        const pts = [];
        for (let p = 0; p < nPts; p++) {
          if (firstPoint) {
            penX = r.varint(); penY = r.varint();
            firstPoint = false;
          } else {
            penX += r.varint();
            penY += r.varint();
          }
          pts.push([penX / scale, penY / scale]);
        }
        if (cmd === 'M') { subStartX = penX; subStartY = penY; }
        segs.push({ cmd, pts, arc });
      }
      return { kind: 'path', segs };
    }
    default:
      throw new Error(`unknown shape type ${type}`);
  }
}

function readA11yChunk(r) {
  const name = r.lenpfxUtf8();
  const desc = r.lenpfxUtf8();
  const labels = [];
  const count = r.varuint();
  ensureAvailable(r, count, 'A11Y label count');
  for (let i = 0; i < count; i++) {
    const index = r.varuint();
    const n = r.lenpfxUtf8();
    const d = r.lenpfxUtf8();
    labels.push({ index, name: n, desc: d });
  }
  return { name, desc, labels };
}

// ---- SVG emission ----

function buildSvg(width, height, elements, styleTable, a11y, scale) {
  const labelMap = new Map();
  if (a11y) for (const l of a11y.labels) labelMap.set(l.index, l);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}"${a11y?.name ? ' role="img" aria-label="' + esc(a11y.name) + '"' : ''}>`);
  if (a11y?.name) out.push(`<title>${esc(a11y.name)}</title>`);
  if (a11y?.desc) out.push(`<desc>${esc(a11y.desc)}</desc>`);

  elements.forEach((el, i) => {
    const style = el.inline ?? styleTable[el.styleIndex] ?? {};
    const attrs = styleAttrs(style, scale);
    if (el.matrix) attrs.push(`transform="matrix(${el.matrix.map(num).join(' ')})"`);
    const label = labelMap.get(i);
    const inner = [];
    if (label?.name) inner.push(`<title>${esc(label.name)}</title>`);
    if (label?.desc) inner.push(`<desc>${esc(label.desc)}</desc>`);
    const open = shapeTag(el.shape, attrs);
    out.push(inner.length ? `${open}${inner.join('')}</${el.shape.kind}>` : open.replace(/>$/, '/>'));
  });

  out.push('</svg>');
  return out.join('');
}

function shapeTag(s, attrs) {
  const a = attrs.length ? ' ' + attrs.join(' ') : '';
  switch (s.kind) {
    case 'rect': return `<rect${a} x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}"${s.rx || s.ry ? ` rx="${num(s.rx)}" ry="${num(s.ry)}"` : ''}>`;
    case 'circle': return `<circle${a} cx="${num(s.cx)}" cy="${num(s.cy)}" r="${num(s.r)}">`;
    case 'ellipse': return `<ellipse${a} cx="${num(s.cx)}" cy="${num(s.cy)}" rx="${num(s.rx)}" ry="${num(s.ry)}">`;
    case 'line': return `<line${a} x1="${num(s.x1)}" y1="${num(s.y1)}" x2="${num(s.x2)}" y2="${num(s.y2)}">`;
    case 'polyline': return `<polyline${a} points="${s.pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' ')}">`;
    case 'polygon': return `<polygon${a} points="${s.pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' ')}">`;
    case 'path': return `<path${a} d="${esc(serializePathData(s.segs))}">`;
    default: throw new Error(`unknown shape kind ${s.kind}`);
  }
}

function styleAttrs(style, scale) {
  const attrs = [];
  if (style.fill) attrs.push(`fill="${toHexAttr(style.fill)}"`);
  else attrs.push('fill="none"');
  if (style.fillOpacity !== undefined && style.fillOpacity < 1) attrs.push(`fill-opacity="${num(style.fillOpacity)}"`);
  if (style.stroke) {
    attrs.push(`stroke="${toHexAttr(style.stroke)}"`);
    if (style.strokeOpacity !== undefined && style.strokeOpacity < 1) attrs.push(`stroke-opacity="${num(style.strokeOpacity)}"`);
    if (style.strokeWidth !== undefined) attrs.push(`stroke-width="${num(style.strokeWidth / scale)}"`);
    if (style.lineCap && style.lineCap !== 'butt') attrs.push(`stroke-linecap="${style.lineCap}"`);
    if (style.lineJoin && style.lineJoin !== 'miter') attrs.push(`stroke-linejoin="${style.lineJoin}"`);
    if (style.dash?.length) attrs.push(`stroke-dasharray="${style.dash.map((d) => num(d / scale)).join(' ')}"`);
  }
  if (style.evenodd) attrs.push('fill-rule="evenodd"');
  return attrs;
}

// style fill/stroke arrive as [r,g,b] arrays from the chunk reader
function toHexAttr(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function num(v) {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
