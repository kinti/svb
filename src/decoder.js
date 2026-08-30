// SVB → SVG decoder (v0.2). See SPEC.md.
//
// decode(bytes, { inflate? }) → { svg, meta }
// inflate: sync (Uint8Array) → Uint8Array for COMPRESSED files. Node CLI passes
// zlib.inflateRawSync; browsers use decodeAsync() from browser-decode.js which
// relies on DecompressionStream.
//
// Accepts version 1 (v0.1 grammar) and version 2 (DEF/GRAD chunks, instances,
// command runs). Normative hardening: SPEC §12 + INV-13/14/15.

import { MAGIC, VERSION, VERSION2, FLAG, CHUNK, SHAPE, ByteReader, MAX_EXPANSION } from './svb.js';
import { serializePathData } from './path.js';

// SPEC §12: a declared count can never exceed the bytes available to hold it.
function ensureAvailable(r, n, what) {
  if (n > r.remaining) {
    throw new Error(`${what} (${n}) exceeds the ${r.remaining} remaining bytes — rejecting hostile/corrupt file`);
  }
}

// translate-only instances delta-chain against the previous instance (raw fixed units)
let instPrevX = 0, instPrevY = 0;

export function decode(bytes, opts = {}) {
  const r = new ByteReader(bytes);
  for (let i = 0; i < 3; i++) {
    if (r.u8() !== MAGIC[i]) throw new Error('not an SVB file (bad magic)');
  }
  const version = r.u8();
  if (version !== VERSION && version !== VERSION2) throw new Error(`unsupported SVB version ${version}`);
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
  instPrevX = 0; instPrevY = 0; // reset translate-delta chain per file
  const styleTable = [];
  const templates = [];   // v0.2: { id, elements }
  const gradients = [];   // v0.2: gradient objects
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
      case CHUNK.GEOM: readGeomChunk(body, elements, scale, version); sawGeom = true; break;
      case CHUNK.A11Y: a11y = readA11yChunk(body); break;
      case CHUNK.META: meta.generator = body.lenpfxUtf8(); break;
      case CHUNK.DEF: readDefChunk(body, templates, scale, version); break;
      case CHUNK.GRAD: readGradChunk(body, gradients); break;
      default: /* EXT: skip (forward compatible) */ break;
    }
  }
  if (!sawGeom) throw new Error('missing GEOM chunk');

  // INV-13: reference integrity (checked after the full chunk pass — order-independent)
  const byId = new Map(templates.map((t) => [t.id, t]));
  if (byId.size !== templates.length) throw new Error('duplicate template id — rejecting file');
  for (const el of elements) {
    if (el.shape.kind === 'instance' && !byId.has(el.shape.tmplId)) {
      throw new Error(`instance references unknown template ${el.shape.tmplId} — rejecting file`);
    }
  }
  for (const st of styleTable) {
    for (const key of ['fill', 'stroke']) {
      const g = st[key];
      if (g && typeof g === 'object' && g.grad !== undefined && g.grad >= gradients.length) {
        throw new Error(`style references unknown gradient ${g.grad} — rejecting file`);
      }
    }
  }

  // INV-14: template-bomb budget (checked BEFORE any expansion)
  let expansion = elements.length;
  for (const el of elements) {
    if (el.shape.kind === 'instance') expansion += byId.get(el.shape.tmplId).elements.length - 1;
  }
  if (expansion > MAX_EXPANSION) {
    throw new Error(`template expansion would emit ${expansion} elements (cap ${MAX_EXPANSION}) — rejecting possible template bomb`);
  }

  return {
    svg: buildSvg(width, height, elements, styleTable, a11y, scale, byId, gradients),
    meta: { version, width, height, scale, elements: elements.length, hasA11y: !!a11y, generator: meta.generator ?? null },
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
  const fillType = sb & 0x03;        // 0 none · 1 rgb · 2 rgb+alpha · 3 gradient ref (v2)
  const strokeType = (sb >> 2) & 0x03;
  const hasWidth = !!(sb & (1 << 4));
  const hasCaps = !!(sb & (1 << 5));
  const hasDash = !!(sb & (1 << 6));
  const evenodd = !!(sb & (1 << 7));
  const style = { fill: null, stroke: null, evenodd };
  if (fillType === 3) {
    const ref = r.varuint();
    style.fill = { grad: ref >>> 1, gradMatrix: (ref & 1) ? readGradMatrix(r) : null };
  } else if (fillType) {
    style.fill = readRgb(r);
    if (fillType === 2) style.fillOpacity = r.u8() / 255;
  }
  if (strokeType === 3) {
    const ref = r.varuint();
    style.stroke = { grad: ref >>> 1, gradMatrix: (ref & 1) ? readGradMatrix(r) : null };
  } else if (strokeType) {
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

function readGradMatrix(r) {
  const m = [];
  for (let k = 0; k < 6; k++) m.push(r.varint());
  return m;
}

function readRgb(r) {
  return [r.u8(), r.u8(), r.u8()];
}

export function readGeomChunk(r, elements, scale, version) {
  const count = r.varuint();
  ensureAvailable(r, count, 'GEOM count');
  for (let i = 0; i < count; i++) {
    elements.push(readElement(r, scale, version, true));
  }
}

// One element — shared by GEOM (allowInstances=true) and DEF (false, INV-13).
function readElement(r, scale, version, allowInstances) {
  const eb = r.u8();
  const type = eb & 0x0f;
  const hasTransform = !!(eb & (1 << 4));
  const inlineStyle = !!(eb & (1 << 5));
  if (type === SHAPE.INSTANCE) {
    if (!allowInstances) throw new Error('instance inside template — templates are flat (norm.)');
    const tmplId = r.varuint();
    const kindByte = r.u8();
    let tx = 0, ty = 0, matrix = null;
    if (kindByte & 1) {
      matrix = [];
      for (let k = 0; k < 6; k++) matrix.push(r.varint() / scale);
    } else {
      instPrevX += r.varint();
      instPrevY += r.varint();
      tx = instPrevX / scale;
      ty = instPrevY / scale;
    }
    return { shape: { kind: 'instance', tmplId, tx, ty, matrix }, styleIndex: -1, inline: null, matrix: null };
  }
  let styleIndex = -1;
  let inline = null;
  if (inlineStyle) inline = readStyleEntry(r);
  else styleIndex = r.varuint();

  let matrix = null;
  if (hasTransform) {
    matrix = [];
    for (let k = 0; k < 6; k++) matrix.push(r.varint() / scale);
  }
  const shape = readShape(r, type, scale, version);
  return { shape, styleIndex, inline, matrix };
}

function readShape(r, type, scale, version) {
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
      const segs = [];
      let penX = 0, penY = 0, subStartX = 0, subStartY = 0, firstPoint = true;
      const readOne = (cmdId) => {
        const cmd = ({ 0: 'M', 1: 'L', 2: 'C', 3: 'Q', 4: 'A', 5: 'Z' })[cmdId];
        if (!cmd) throw new Error(`bad path command id ${cmdId} — rejecting file`);
        if (cmd === 'Z') {
          segs.push({ cmd: 'Z', pts: [] });
          penX = subStartX; penY = subStartY;
          return;
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
      };
      if (version >= 2) {
        // command-run packing (MVT-style): (count << 3) | cmdId
        // INV-2 per command: a run's count must be backed by the bytes its
        // command consumes (Z consumes none — capped separately, it only
        // closes the current subpath so its memory cost is one segment).
        const runCount = r.varuint();
        ensureAvailable(r, runCount, 'path run count');
        const minBytes = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 6, 5: 0 };
        for (let run = 0; run < runCount; run++) {
          const rv = r.varuint();
          if (rv < 8) throw new Error('command run value < 8 (count must be >= 1) — rejecting file');
          const cmdId = rv & 0x07;
          const count = rv >> 3;
          ensureAvailable(r, count * minBytes[cmdId], 'path run command count');
          if (cmdId === 5 && count > 65536) throw new Error('Z run too long — rejecting file');
          for (let c = 0; c < count; c++) readOne(cmdId);
        }
      } else {
        const cmdCount = r.varuint();
        ensureAvailable(r, cmdCount, 'path command count');
        for (let i = 0; i < cmdCount; i++) readOne(r.u8() & 0x07);
      }
      return { kind: 'path', segs };
    }
    default:
      throw new Error(`unknown shape type ${type}`);
  }
}

// ---- v0.2: DEF (templates) / GRAD (gradients) ----

function readDefChunk(r, templates, scale, version) {
  const count = r.varuint();
  ensureAvailable(r, count, 'DEF template count');
  for (let i = 0; i < count; i++) {
    const id = r.varuint();
    const elemCount = r.varuint();
    ensureAvailable(r, elemCount, 'template element count');
    const elements = [];
    for (let e = 0; e < elemCount; e++) {
      elements.push(readElement(r, scale, version, false)); // instances forbidden (INV-13)
    }
    templates.push({ id, elements });
  }
}

function readGradChunk(r, gradients) {
  const count = r.varuint();
  ensureAvailable(r, count, 'GRAD gradient count');
  for (let i = 0; i < count; i++) {
    const type = r.u8();       // 0 linear · 1 radial
    if (type > 1) throw new Error(`unknown gradient type ${type} — rejecting file`);
    const units = r.u8();      // 0 objectBoundingBox · 1 userSpaceOnUse
    if (units > 1) throw new Error(`unknown gradient units ${units} — rejecting file`);
    const spread = r.u8();     // 0 pad
    if (spread !== 0) throw new Error(`unknown spread method ${spread} — rejecting file`);
    const flags = r.u8();      // bit0 has-matrix · bit1 stops-have-alpha
    const hasMatrix = !!(flags & 1);
    const alphaStops = !!(flags & 2);
    let matrix = null;
    if (hasMatrix) matrix = readGradMatrix(r);
    // coordinates: OBB → 4 (linear) / 3 (radial) u8 over the unit box;
    // userSpace → varint fixed
    const nCoords = type === 0 ? 4 : 3;
    const coords = [];
    for (let c = 0; c < nCoords; c++) {
      coords.push(units === 0 ? r.u8() / 255 : r.varint() / 1);
    }
    const stopCount = r.varuint();
    ensureAvailable(r, stopCount, 'gradient stop count');
    if (stopCount < 1) throw new Error('gradient with zero stops — rejecting file');
    const stops = [];
    for (let s = 0; s < stopCount; s++) {
      const offset = r.u8() / 255;
      const color = [r.u8(), r.u8(), r.u8()];
      const opacity = alphaStops ? r.u8() / 255 : 1;
      stops.push({ offset, color, opacity });
    }
    gradients.push({ type, units, spread, coords, stops, matrix });
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

function buildSvg(width, height, elements, styleTable, a11y, scale, byId, gradients) {
  const labelMap = new Map();
  if (a11y) for (const l of a11y.labels) labelMap.set(l.index, l);

  const usedGrads = new Set();
  const body = [];

  elements.forEach((el, idx) => {
    const elLabel = labelMap.get(idx);
    const wrap = (inner) => {
      if (!elLabel || (!elLabel.name && !elLabel.desc)) return inner;
      const t = [];
      if (elLabel.name) t.push(`<title>${esc(elLabel.name)}</title>`);
      if (elLabel.desc) t.push(`<desc>${esc(elLabel.desc)}</desc>`);
      return `<g>${inner}${t.join('')}</g>`;
    };

    if (el.shape.kind === 'instance') {
      const tmpl = byId.get(el.shape.tmplId);
      const X = el.shape.matrix ?? [1, 0, 0, 1, el.shape.tx, el.shape.ty];
      for (const te of tmpl.elements) {
        const st = te.inline ?? styleTable[te.styleIndex] ?? {};
        const attrs = styleAttrs(st, scale, usedGrads);
        let inner = '';
        if (el.shape.matrix) {
          // full-matrix instance: emit the transform attribute
          const combined = matMul(X, te.matrix ?? [1, 0, 0, 1, 0, 0]);
          const a2 = attrs.concat([`transform="matrix(${combined.map(num).join(' ')})"`]);
          inner = shapeSvg(te.shape, a2);
        } else {
          // translate-only instance: bake the offset into the coordinates
          inner = shapeSvg(translateShape(te.shape, el.shape.tx, el.shape.ty), attrs);
        }
        body.push(wrap(inner));
      }
      return;
    }

    const style = el.inline ?? styleTable[el.styleIndex] ?? {};
    const attrs = styleAttrs(style, scale, usedGrads);
    if (el.matrix) attrs.push(`transform="matrix(${el.matrix.map(num).join(' ')})"`);
    const open = shapeSvg(el.shape, attrs); // ends with '/>'
    const label = labelMap.get(idx);
    const inner = [];
    if (label?.name) inner.push(`<title>${esc(label.name)}</title>`);
    if (label?.desc) inner.push(`<desc>${esc(label.desc)}</desc>`);
    body.push(inner.length ? open.slice(0, -2) + '>' + inner.join('') + `</${el.shape.kind}>` : open);
  });

  let defs = '';
  if (usedGrads.size) {
    const parts = [];
    for (const idx of [...usedGrads].sort((a, b) => a - b)) {
      const g = gradients[idx];
      if (!g) continue;
      const kind = g.type === 0 ? 'linearGradient' : 'radialGradient';
      const attrs = [`id="svbg${idx}"`];
      if (g.units === 1) attrs.push('gradientUnits="userSpaceOnUse"');
      if (g.type === 0) {
        attrs.push(`x1="${num(g.coords[0])}" y1="${num(g.coords[1])}" x2="${num(g.coords[2])}" y2="${num(g.coords[3])}"`);
      } else {
        attrs.push(`cx="${num(g.coords[0])}" cy="${num(g.coords[1])}" r="${num(g.coords[2])}"`);
      }
      if (g.matrix) attrs.push(`gradientTransform="matrix(${g.matrix.map(num).join(' ')})"`);
      const stops = g.stops.map((s) =>
        `<stop offset="${num(s.offset)}" stop-color="${hex(s.color)}"${s.opacity < 1 ? ` stop-opacity="${num(s.opacity)}"` : ''}/>`
      ).join('');
      parts.push(`<${kind} ${attrs.join(' ')}>${stops}</${kind}>`);
    }
    defs = `<defs>${parts.join('')}</defs>`;
  }

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}"${a11y?.name ? ' role="img" aria-label="' + esc(a11y.name) + '"' : ''}>`);
  if (defs) out.push(defs);
  if (a11y?.name) out.push(`<title>${esc(a11y.name)}</title>`);
  if (a11y?.desc) out.push(`<desc>${esc(a11y.desc)}</desc>`);
  out.push(...body);
  out.push('</svg>');
  return out.join('');
}

function matMul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

// translate-only instance emission: bake the offset into the coordinates
function translateShape(s, tx, ty) {
  switch (s.kind) {
    case 'rect': return { ...s, x: s.x + tx, y: s.y + ty };
    case 'circle': return { ...s, cx: s.cx + tx, cy: s.cy + ty };
    case 'ellipse': return { ...s, cx: s.cx + tx, cy: s.cy + ty };
    case 'line': return { ...s, x1: s.x1 + tx, y1: s.y1 + ty, x2: s.x2 + tx, y2: s.y2 + ty };
    case 'polyline': case 'polygon': return { ...s, pts: s.pts.map(([x, y]) => [x + tx, y + ty]) };
    case 'path': return { ...s, segs: s.segs.map((seg) => ({ ...seg, pts: seg.pts.map(([x, y]) => [x + tx, y + ty]) })) };
    default: return s;
  }
}

function shapeSvg(s, attrs, transform) {
  const a = attrs.slice();
  if (transform) a.push(`transform="matrix(${transform.map(num).join(' ')})"`);
  const at = a.length ? ' ' + a.join(' ') : '';
  switch (s.kind) {
    case 'rect': return `<rect${at} x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}"${s.rx || s.ry ? ` rx="${num(s.rx)}" ry="${num(s.ry)}"` : ''}/>`;
    case 'circle': return `<circle${at} cx="${num(s.cx)}" cy="${num(s.cy)}" r="${num(s.r)}"/>`;
    case 'ellipse': return `<ellipse${at} cx="${num(s.cx)}" cy="${num(s.cy)}" rx="${num(s.rx)}" ry="${num(s.ry)}"/>`;
    case 'line': return `<line${at} x1="${num(s.x1)}" y1="${num(s.y1)}" x2="${num(s.x2)}" y2="${num(s.y2)}"/>`;
    case 'polyline': return `<polyline${at} points="${s.pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' ')}"/>`;
    case 'polygon': return `<polygon${at} points="${s.pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' ')}"/>`;
    case 'path': return `<path${at} d="${esc(serializePathData(s.segs))}"/>`;
    default: throw new Error(`unknown shape kind ${s.kind}`);
  }
}

function styleAttrs(style, scale, usedGrads) {
  const attrs = [];
  const fill = style.fill;
  if (fill && typeof fill === 'object' && fill.grad !== undefined) {
    usedGrads.add(fill.grad);
    attrs.push(`fill="url(#svbg${fill.grad})"`);
  } else if (Array.isArray(fill)) {
    attrs.push(`fill="${hex(fill)}"`);
  } else {
    attrs.push('fill="none"');
  }
  if (style.fillOpacity !== undefined && style.fillOpacity < 1) attrs.push(`fill-opacity="${num(style.fillOpacity)}"`);
  const stroke = style.stroke;
  if (stroke && typeof stroke === 'object' && stroke.grad !== undefined) {
    usedGrads.add(stroke.grad);
    attrs.push(`stroke="url(#svbg${stroke.grad})"`);
  } else if (Array.isArray(stroke)) {
    attrs.push(`stroke="${hex(stroke)}"`);
    if (style.strokeOpacity !== undefined && style.strokeOpacity < 1) attrs.push(`stroke-opacity="${num(style.strokeOpacity)}"`);
    if (style.strokeWidth !== undefined) attrs.push(`stroke-width="${num(style.strokeWidth / scale)}"`);
    if (style.lineCap && style.lineCap !== 'butt') attrs.push(`stroke-linecap="${style.lineCap}"`);
    if (style.lineJoin && style.lineJoin !== 'miter') attrs.push(`stroke-linejoin="${style.lineJoin}"`);
    if (style.dash?.length) attrs.push(`stroke-dasharray="${style.dash.map((d) => num(d / scale)).join(' ')}"`);
  }
  if (style.evenodd) attrs.push('fill-rule="evenodd"');
  return attrs;
}

function hex(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function num(v) {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
