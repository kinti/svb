// SVG → SVB encoder (v0.2). See SPEC.md and docs/v0.2-model.md.
//
// v0.2 additions over v0.1.1: DEF chunk (repetition templates — <use>
// re-invented), GRAD chunk (linear/radial gradients), MVT-style command-run
// packing, version byte 2. Security: input ceiling, walk depth cap (F-11),
// gradient vocabulary validation.

import {
  MAGIC, VERSION2, FLAG, CHUNK, SHAPE, CMD,
  ByteWriter, parseColor, toHex, toFixed, MAX_INPUT, VARUINT_MAX,
} from './svb.js';
import { parseXml } from './xml.js';
import { parsePathData } from './path.js';

const SUPPORTED_SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const SKIP_TAGS = new Set([
  'defs', 'style', 'script', 'metadata', 'symbol', 'clipPath', 'mask', 'pattern',
  'linearGradient', 'radialGradient', 'filter', 'marker',
]);
const UNSUPPORTED_WARN = new Set(['use', 'text', 'image', 'tspan', 'textPath', 'foreignObject']);
const MAX_DEPTH = 64;

export function encode(svgString, opts = {}) {
  if (typeof svgString !== 'string' || svgString.length > MAX_INPUT) {
    throw new RangeError(`input too large (max ${MAX_INPUT} bytes)`);
  }
  const scale = opts.scale ?? 64;
  const warnings = [];
  const doc = parseXml(svgString);
  const svg = doc.children.find((n) => n.tag === 'svg');
  if (!svg) throw new Error('no <svg> root element found');

  // ---- canvas + root viewBox transform ----
  const vb = parseViewBox(svg.attrs.viewBox);
  const size = parseSize(svg.attrs);
  let width, height, rootMatrix = [1, 0, 0, 1, 0, 0];
  if (vb) {
    [width, height] = [vb.w, vb.h];
    if (vb.x !== 0 || vb.y !== 0) rootMatrix = mul(rootMatrix, [1, 0, 0, 1, -vb.x, -vb.y]);
  } else if (size.w != null && size.h != null) {
    [width, height] = [size.w, size.h];
  } else {
    [width, height] = [300, 150];
    warnings.push('no viewBox/width/height: defaulting canvas to 300x150');
  }
  width = clampDim(width, 'width', warnings);
  height = clampDim(height, 'height', warnings);

  // ---- gradients from <defs> (parsed before the walk so styles can reference) ----
  const gradIndex = new Map();  // SVG id → gradient index
  const gradients = [];         // gradient objects in parse order
  collectGradients(svg, gradients, gradIndex, warnings, 0);

  // ---- walk the tree ----
  const elements = [];        // { shape, styleIndex, matrix }
  const styleEntries = [];
  const styleIndex = new Map();
  const elementLabels = [];
  const labeled = new Set();

  const inheritableKeys = ['fill', 'fillOpacity', 'stroke', 'strokeOpacity', 'strokeWidth', 'lineCap', 'lineJoin', 'dash', 'evenodd'];
  const rootStyle = { fill: '#000000', fillOpacity: 1, stroke: null, strokeOpacity: 1, strokeWidth: 1, lineCap: 'butt', lineJoin: 'miter', dash: null, evenodd: false };
  if (svg.attrs.style) warnings.push('style attribute ignored (v0.1: presentation attributes only)');
  for (const [k, v] of Object.entries(readPresentationAttrs(svg.attrs, warnings, gradIndex))) {
    if (v !== undefined) rootStyle[k] = v;
  }

  walk(svg.children, rootMatrix, rootStyle, 0);

  function walk(nodes, matrix, inheritedStyle, depth) {
    if (depth > MAX_DEPTH) { warnings.push(`nesting deeper than ${MAX_DEPTH} skipped`); return; }
    for (const node of nodes) {
      const tag = node.tag;
      if (tag === 'title' || tag === 'desc') continue;
      if (tag === 'g' || tag === 'a' || tag === 'switch') {
        if (node.attrs.style) warnings.push('style attribute ignored (v0.1: presentation attributes only)');
        const own = readPresentationAttrs(node.attrs, warnings, gradIndex);
        const style = { ...inheritedStyle };
        for (const k of inheritableKeys) if (own[k] !== undefined) style[k] = own[k];
        let m = matrix;
        if (node.attrs.transform) m = mul(matrix, parseTransform(node.attrs.transform));
        walk(node.children, m, style, depth + 1);
        continue;
      }
      if (SKIP_TAGS.has(tag)) continue;
      if (UNSUPPORTED_WARN.has(tag)) {
        warnings.push(`<${tag}> skipped (not supported in v0.1)`);
        continue;
      }
      if (!SUPPORTED_SHAPES.has(tag)) {
        warnings.push(`<${tag}> unknown, skipped`);
        continue;
      }
      if (node.attrs.mask || node.attrs['clip-path'] || node.attrs.filter) {
        warnings.push(`<${tag}> mask/clip/filter ignored`);
      }
      if (node.attrs.style) warnings.push('style attribute ignored (v0.1: presentation attributes only)');

      const own = readPresentationAttrs(node.attrs, warnings, gradIndex);
      const style = { ...inheritedStyle };
      for (const k of inheritableKeys) if (own[k] !== undefined) style[k] = own[k];

      const shape = buildShape(tag, node.attrs, warnings);
      if (!shape) continue;

      let m = matrix;
      if (node.attrs.transform) m = mul(matrix, parseTransform(node.attrs.transform));

      const key = styleKey(style);
      let sIdx = styleIndex.get(key);
      if (sIdx === undefined) {
        sIdx = styleEntries.length;
        styleEntries.push(style);
        styleIndex.set(key, sIdx);
      }

      const idx = elements.length;
      elements.push({ shape, styleIndex: sIdx, matrix: m });

      for (const ch of node.children) {
        if (ch.tag === 'title') { elementLabels.push({ index: idx, name: ch.text || '', desc: '' }); labeled.add(idx); }
        else if (ch.tag === 'desc') { elementLabels.push({ index: idx, name: '', desc: ch.text || '' }); labeled.add(idx); }
        else warnings.push(`<${ch.tag}> inside <${tag}> skipped`);
      }
    }
  }

  if (elements.length === 0) warnings.push('no supported geometry found');

  // ---- repetition pass: translation-invariant repeats become DEF templates ----
  const templates = [];          // { id, element } (single-element templates, v0.2)
  const instanceOf = new Map();  // element index → instance descriptor
  buildTemplates();

  function buildTemplates() {
    if (elements.length < 2) return;
    const groups = new Map();
    elements.forEach((el, i) => {
      if (labeled.has(i)) return;
      if (estimateSize(el) < 12) return;
      const k = templateKey(el);
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    let nextId = 0;
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      const rep = idxs[0];
      const id = nextId++;
      templates.push({ id, element: elements[rep] });
      for (const i of idxs) instanceOf.set(i, { tmplId: id, repMatrix: elements[rep].matrix, repFirst: firstPointOf(elements[rep].shape), first: firstPointOf(elements[i].shape) });
    }
  }

  function firstPointOf(shape) {
    switch (shape.kind) {
      case 'rect': return [shape.x, shape.y];
      case 'circle': case 'ellipse': return [shape.cx, shape.cy];
      case 'line': return [shape.x1, shape.y1];
      case 'polyline': case 'polygon': case 'path': return shape.pts ? shape.pts[0] : (shape.segs.find((s) => s.pts.length)?.pts[0] ?? [0, 0]);
      default: return [0, 0];
    }
  }

  function estimateSize(el) {
    return el.shape.kind === 'path' ? 24 + el.shape.segs.length * 6 : 14;
  }

  function templateKey(el) {
    const s = el.shape;
    let body;
    switch (s.kind) {
      case 'rect': body = `r${s.w},${s.h},${s.rx},${s.ry}`; break;
      case 'circle': body = `c${s.r}`; break;
      case 'ellipse': body = `e${s.rx},${s.ry}`; break;
      case 'line': body = `l${s.x2 - s.x1},${s.y2 - s.y1}`; break;
      case 'polyline': case 'polygon': body = relPts(s.pts); break;
      case 'path': body = relPath(s.segs); break;
      default: return null;
    }
    return `${s.kind}|${el.styleIndex}|${body}`;
  }

  function relPts(pts) {
    const [px, py] = pts[0];
    return pts.map(([x, y]) => `${(x - px).toFixed(2)},${(y - py).toFixed(2)}`).join(';');
  }

  function relPath(segs) {
    const first = segs.find((s) => s.pts.length)?.pts[0];
    if (!first) return null;
    let out = '';
    for (const s of segs) {
      out += s.cmd;
      if (s.arc) out += `${s.arc.rx},${s.arc.ry},${Math.round(s.arc.rot)},${s.arc.largeArc ? 1 : 0},${s.arc.sweep ? 1 : 0}`;
      for (const [x, y] of s.pts) out += `${(x - first[0]).toFixed(2)},${(y - first[1]).toFixed(2)};`;
    }
    return out;
  }

  // ---- chunks ----
  const fileA11y = {
    name: svg.children.find((n) => n.tag === 'title')?.text || '',
    desc: svg.children.find((n) => n.tag === 'desc')?.text || '',
  };
  const styleChunk = styleEntries.length ? writeStyleChunk(styleEntries, scale) : null;
  const defChunk = templates.length ? writeDefChunk(templates, scale) : null;
  const gradChunk = gradients.length ? writeGradChunk(gradients) : null;
  const geomChunk = writeGeomChunk(elements, instanceOf, templates, scale);
  const a11yChunk = writeA11yChunk(fileA11y, elementLabels);
  const metaChunk = opts.generator != null ? writeMetaChunk(opts.generator) : null;

  let payload = new ByteWriter();
  if (styleChunk) payload.raw(styleChunk);
  if (defChunk) payload.raw(defChunk);
  if (gradChunk) payload.raw(gradChunk);
  payload.raw(geomChunk);
  if (a11yChunk) payload.raw(a11yChunk);
  if (metaChunk) payload.raw(metaChunk);
  let raw = payload.toUint8Array();

  let flags = 0;
  if (styleChunk) flags |= FLAG.HAS_STYLE;
  if (defChunk) flags |= FLAG.HAS_DEF;
  if (gradChunk) flags |= FLAG.HAS_GRAD;
  if (a11yChunk) flags |= FLAG.HAS_A11Y;
  if (opts.deflate) {
    const deflated = opts.deflate(raw);
    if (deflated.length < raw.length) {
      raw = deflated;
      flags |= FLAG.COMPRESSED;
    }
  }

  const head = new ByteWriter();
  head.raw(MAGIC).u8(VERSION2).u8(flags);
  head.varuint(Math.round(width)).varuint(Math.round(height)).varuint(scale);

  const bytes = new Uint8Array(head.bytes.length + raw.length);
  bytes.set(head.toUint8Array(), 0);
  bytes.set(raw, head.bytes.length);

  return { bytes, warnings, stats: { elements: elements.length, styles: styleEntries.length, templates: templates.length, gradients: gradients.length } };
}

// ---- gradient collection ----

function collectGradients(svg, gradients, gradIndex, warnings, depth) {
  if (depth > MAX_DEPTH) return;
  const stack = [[svg, 0]];
  while (stack.length) {
    const [node, d] = stack.pop();
    if (d > MAX_DEPTH) continue;
    for (const ch of node.children) {
      if (ch.tag === 'linearGradient' || ch.tag === 'radialGradient') {
        addGradient(ch, gradients, gradIndex, warnings);
      } else {
        stack.push([ch, d + 1]);
      }
    }
  }
}

function addGradient(node, gradients, gradIndex, warnings) {
  const type = node.tag === 'linearGradient' ? 0 : 1;
  const units = node.attrs.gradientUnits === 'userSpaceOnUse' ? 1 : 0;
  if (node.attrs.spreadMethod && node.attrs.spreadMethod !== 'pad') {
    warnings.push(`gradient spreadMethod "${node.attrs.spreadMethod}" replaced by pad`);
  }
  if (node.attrs.href || node.attrs['xlink:href']) {
    warnings.push('gradient href inheritance ignored (v0.2)');
  }
  const obb = units === 0;
  const coord = (v, def) => {
    if (v == null) return def;
    const s = String(v).trim();
    if (s.endsWith('%')) {
      const pct = parseFloat(s) / 100;
      return obb ? Math.max(0, Math.min(255, Math.round(pct * 255))) : pct;
    }
    const f = parseFloat(s);
    return obb ? Math.max(0, Math.min(255, Math.round(f * 255))) : f;
  };
  let coords;
  if (type === 0) {
    coords = obb
      ? [coord(node.attrs.x1, 0), coord(node.attrs.y1, 0), coord(node.attrs.x2, 255), coord(node.attrs.y2, 0)]
      : [coord(node.attrs.x1, 0), coord(node.attrs.y1, 0), coord(node.attrs.x2, 1), coord(node.attrs.y2, 0)];
  } else {
    coords = obb
      ? [coord(node.attrs.cx, 128), coord(node.attrs.cy, 128), coord(node.attrs.r, 128)]
      : [coord(node.attrs.cx, 0.5), coord(node.attrs.cy, 0.5), coord(node.attrs.r, 0.5)];
  }
  const stops = [];
  for (const st of node.children) {
    if (st.tag !== 'stop') continue;
    const off = String(st.attrs.offset ?? '0').trim();
    const offset = off.endsWith('%') ? Math.max(0, Math.min(255, Math.round(parseFloat(off) / 100 * 255))) : Math.max(0, Math.min(255, Math.round(parseFloat(off) * 255))) || 0;
    const color = parseColor(st.attrs['stop-color'] ?? '#000000') ?? [0, 0, 0];
    const opacity = st.attrs['stop-opacity'] != null ? Math.max(0, Math.min(255, Math.round(parseFloat(st.attrs['stop-opacity']) * 255))) : 255;
    stops.push({ offset, color, opacity });
  }
  if (!stops.length) { warnings.push('gradient without stops skipped'); return; }
  let matrix = null;
  if (node.attrs.gradientTransform) {
    matrix = parseTransform(node.attrs.gradientTransform).map((v) => toFixed(v, 1));
    warnings.push('gradientTransform quantized to 0.1 precision');
  }
  const index = gradients.length;
  gradients.push({ type, units, spread: 0, coords, stops, matrix });
  if (node.attrs.id) gradIndex.set(node.attrs.id, index);
}

// ---- header helpers ----

function clampDim(v, name, warnings) {
  if (!Number.isFinite(v)) return 300;
  if (v < 0) { warnings.push(`negative ${name} clamped to 0`); return 0; }
  if (v > 65535) { warnings.push(`${name} > 65535 clamped`); return 65535; }
  return v;
}

function parseViewBox(s) {
  if (!s) return null;
  const n = String(s).trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

function parseSize(attrs) {
  const num = (s) => {
    if (s == null) return null;
    const m = /^(-?[\d.]+)(px)?$/.exec(String(s).trim());
    return m ? parseFloat(m[1]) : null;
  };
  return { w: num(attrs.width), h: num(attrs.height) };
}

// ---- styles ----

function readPresentationAttrs(attrs, warnings, gradIndex) {
  const out = {};
  const gradRef = (v) => {
    const id = /url\(#([^)]+)\)/.exec(v)?.[1];
    const idx = id != null && gradIndex.has(id) ? gradIndex.get(id) : null;
    if (idx == null) { warnings.push('gradient reference not found — replaced by none'); return null; }
    return { grad: idx };
  };
  if (attrs.fill !== undefined) {
    if (attrs.fill.trim() === 'none') out.fill = null;
    else if (attrs.fill.startsWith('url(')) {
      const g = gradRef(attrs.fill);
      if (g) out.fill = g; else out.fill = null;
    } else out.fill = hexOr(attrs.fill);
  }
  if (attrs['fill-opacity'] !== undefined) out.fillOpacity = clamp01(parseFloat(attrs['fill-opacity']));
  if (attrs['fill-rule'] !== undefined) out.evenodd = attrs['fill-rule'].trim() === 'evenodd';
  if (attrs.stroke !== undefined) {
    if (attrs.stroke.trim() === 'none') out.stroke = null;
    else if (attrs.stroke.startsWith('url(')) {
      const g = gradRef(attrs.stroke);
      if (g) out.stroke = g; else out.stroke = null;
    } else out.stroke = hexOr(attrs.stroke);
  }
  if (attrs['stroke-opacity'] !== undefined) out.strokeOpacity = clamp01(parseFloat(attrs['stroke-opacity']));
  if (attrs['stroke-width'] !== undefined) out.strokeWidth = Math.max(0, parseFloat(attrs['stroke-width']) || 0);
  if (attrs['stroke-linecap'] !== undefined) out.lineCap = attrs['stroke-linecap'].trim();
  if (attrs['stroke-linejoin'] !== undefined) out.lineJoin = attrs['stroke-linejoin'].trim();
  if (attrs['stroke-dasharray'] !== undefined) {
    const v = attrs['stroke-dasharray'].trim();
    out.dash = v === 'none' ? null : v.split(/[\s,]+/).map(Number).filter(Number.isFinite);
  }
  return out;
}

function hexOr(color) {
  const c = parseColor(color);
  return c ? toHex(c) : '#000000';
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));

function styleKey(style) {
  return JSON.stringify([
    style.fill, Math.round((style.fillOpacity ?? 1) * 255), style.stroke, Math.round((style.strokeOpacity ?? 1) * 255),
    style.strokeWidth ?? 1, style.lineCap ?? 'butt', style.lineJoin ?? 'miter', style.dash ?? null, !!style.evenodd,
  ]);
}

function writeStyleEntryBytes(w, style, scale) {
  const fill = style.fill && typeof style.fill === 'object' && style.fill.grad !== undefined
    ? { grad: style.fill.grad } : (style.fill ? parseColor(style.fill) : null);
  const fillIsGrad = style.fill && typeof style.fill === 'object' && style.fill.grad !== undefined;
  const strokeIsGrad = style.stroke && typeof style.stroke === 'object' && style.stroke.grad !== undefined;
  const stroke = style.stroke && typeof style.stroke === 'object' && style.stroke.grad !== undefined
    ? { grad: style.stroke.grad } : (style.stroke ? parseColor(style.stroke) : null);
  const fillA = Math.round((style.fillOpacity ?? 1) * 255);
  const strokeA = Math.round((style.strokeOpacity ?? 1) * 255);
  const hasWidth = style.stroke != null && style.strokeWidth !== undefined;
  const caps = ({ butt: 0, round: 1, square: 2 })[style.lineCap] ?? 0;
  const joins = ({ miter: 0, round: 1, bevel: 2 })[style.lineJoin] ?? 0;
  const hasCaps = stroke != null && (caps !== 0 || joins !== 0);
  const dash = style.stroke != null && Array.isArray(style.dash) && style.dash.length ? style.dash : null;

  let sb = 0;
  sb |= fill ? (fillIsGrad ? 3 : fillA < 255 ? 2 : 1) : 0;
  sb |= stroke ? (strokeIsGrad ? 3 : strokeA < 255 ? 2 : 1) << 2 : 0;
  if (hasWidth) sb |= 1 << 4;
  if (hasCaps) sb |= 1 << 5;
  if (dash) sb |= 1 << 6;
  if (style.evenodd) sb |= 1 << 7;
  w.u8(sb);

  if (fill) {
    if (fillIsGrad) w.varuint(fill.grad << 1);
    else { w.rgb24(fill[0], fill[1], fill[2]); if (fillA < 255) w.u8(fillA); }
  }
  if (stroke) {
    if (strokeIsGrad) w.varuint(stroke.grad << 1);
    else { w.rgb24(stroke[0], stroke[1], stroke[2]); if (strokeA < 255) w.u8(strokeA); }
  }
  if (hasWidth) w.varuint(Math.max(0, toFixed(style.strokeWidth, scale)));
  if (hasCaps) w.u8(caps | (joins << 4));
  if (dash) { w.varuint(dash.length); for (const d of dash) w.varuint(Math.max(0, toFixed(d, scale))); }
}

function writeStyleChunk(entries, scale) {
  const w = new ByteWriter();
  const body = new ByteWriter();
  body.varuint(entries.length);
  for (const e of entries) writeStyleEntryBytes(body, e, scale);
  const b = body.toUint8Array();
  w.u8(CHUNK.STYLE).varuint(b.length).raw(b);
  return w.toUint8Array();
}

// ---- geometry ----

function writeGeomChunk(elements, instanceOf, templates, scale) {
  const fx = (v) => toFixed(v, scale);
  const u = (n) => Math.max(0, n);

  // instance descriptors (precomputed transforms)
  const instances = new Map();
  for (const [idx, desc] of instanceOf) {
    const inv = matInverse(desc.repMatrix);
    const tX = desc.first[0] - desc.repFirst[0];
    const tY = desc.first[1] - desc.repFirst[1];
    let X = mul(elements[idx].matrix, mul(T([tX, tY]), inv));
    // X × T(repFirst) × M_rep = rendered_e ✓ (see docs/v0.2-model.md)
    const pure = Math.abs(X[0] - 1) < 1e-9 && Math.abs(X[1]) < 1e-9 && Math.abs(X[2]) < 1e-9 && Math.abs(X[3] - 1) < 1e-9;
    instances.set(idx, pure ? { tmplId: desc.tmplId, tx: X[4], ty: X[5] } : { tmplId: desc.tmplId, matrix: X });
  }

  // element id → template id (representatives keep their place as instances too)
  const tmplOf = new Map();
  for (const [idx, desc] of instanceOf) tmplOf.set(idx, desc.tmplId);

  const body = new ByteWriter();
  body.varuint(elements.length);

  // translate-only instances delta-encode against the previous instance
  // (MVT-style: grid steps become 1-byte varints that deflate loves)
  let prevTx = 0, prevTy = 0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (tmplOf.has(i)) {
      // instance (the representative becomes an identity instance)
      const inst = instances.get(i);
      body.u8(SHAPE.INSTANCE);
      body.varuint(inst.tmplId);
      if (inst.matrix) {
        body.u8(1);
        for (const v of inst.matrix) body.varint(fx(v));
      } else {
        body.u8(0);
        body.varint(fx(inst.tx) - prevTx).varint(fx(inst.ty) - prevTy);
        prevTx = fx(inst.tx); prevTy = fx(inst.ty);
      }
      continue;
    }
    const hasTransform = !isIdentity(el.matrix);
    let eb = shapeTypeByte(el.shape.kind);
    if (hasTransform) eb |= 1 << 4;
    body.u8(eb);
    body.varuint(el.styleIndex);
    if (hasTransform) for (const v of el.matrix) body.varint(fx(v));
    writeShapeData(body, el.shape, fx, u, scale);
  }

  const w = new ByteWriter();
  const b = body.toUint8Array();
  w.u8(CHUNK.GEOM).varuint(b.length).raw(b);
  return w.toUint8Array();
}

function shapeTypeByte(kind) {
  return ({ rect: SHAPE.RECT, circle: SHAPE.CIRCLE, ellipse: SHAPE.ELLIPSE, line: SHAPE.LINE, polyline: SHAPE.POLYLINE, polygon: SHAPE.POLYGON, path: SHAPE.PATH })[kind];
}

function writeShapeData(body, s, fx, u, scale) {
  switch (s.kind) {
    case 'rect':
      body.varint(fx(s.x)).varint(fx(s.y)).varuint(u(fx(s.w))).varuint(u(fx(s.h)))
        .varuint(u(fx(s.rx))).varuint(u(fx(s.ry)));
      break;
    case 'circle':
      body.varint(fx(s.cx)).varint(fx(s.cy)).varuint(u(fx(s.r)));
      break;
    case 'ellipse':
      body.varint(fx(s.cx)).varint(fx(s.cy)).varuint(u(fx(s.rx))).varuint(u(fx(s.ry)));
      break;
    case 'line':
      body.varint(fx(s.x1)).varint(fx(s.y1)).varint(fx(s.x2)).varint(fx(s.y2));
      break;
    case 'polyline':
    case 'polygon': {
      body.varuint(s.pts.length);
      body.varint(fx(s.pts[0][0])).varint(fx(s.pts[0][1]));
      let px = fx(s.pts[0][0]), py = fx(s.pts[0][1]);
      for (let i = 1; i < s.pts.length; i++) {
        const X = fx(s.pts[i][0]), Y = fx(s.pts[i][1]);
        body.varint(X - px).varint(Y - py);
        px = X; py = Y;
      }
      break;
    }
    case 'path': {
      const cmdId = { M: CMD.M, L: CMD.L, C: CMD.C, Q: CMD.Q, A: CMD.A, Z: CMD.Z };
      // group consecutive same-command segments into runs (v0.2)
      const runs = [];
      for (const seg of s.segs) {
        if (runs.length && runs[runs.length - 1].cmd === seg.cmd) runs[runs.length - 1].segs.push(seg);
        else runs.push({ cmd: seg.cmd, segs: [seg] });
      }
      body.varuint(runs.length);
      let penX = 0, penY = 0, subX = 0, subY = 0, firstPoint = true;
      const writePoint = (pt) => {
        const X = fx(pt[0]), Y = fx(pt[1]);
        if (firstPoint) { body.varint(X).varint(Y); firstPoint = false; }
        else { body.varint(X - penX).varint(Y - penY); }
        penX = X; penY = Y;
      };
      for (const run of runs) {
        body.varuint((run.segs.length << 3) | cmdId[run.cmd]);
        for (const seg of run.segs) {
          if (seg.cmd === 'Z') { penX = subX; penY = subY; continue; }
          if (seg.cmd === 'A') {
            body.varuint(u(fx(seg.arc.rx))).varuint(u(fx(seg.arc.ry)));
            body.varint(Math.round(seg.arc.rot));
            body.u8((seg.arc.largeArc ? 1 : 0) | (seg.arc.sweep ? 2 : 0));
          }
          for (const pt of seg.pts) writePoint(pt);
          if (seg.cmd === 'M') { subX = penX; subY = penY; }
        }
      }
      break;
    }
    default:
      throw new Error(`unknown shape kind ${s.kind}`);
  }
}

// ---- v0.2 chunks ----

function writeDefChunk(templates, scale) {
  const body = new ByteWriter();
  body.varuint(templates.length);
  for (const t of templates) {
    body.varuint(t.id);
    body.varuint(1); // single-element template
    const el = t.element;
    const hasTransform = !isIdentity(el.matrix);
    let eb = el.shape.kind === 'instance' ? 0 : shapeTypeByte(el.shape.kind);
    if (hasTransform) eb |= 1 << 4;
    body.u8(eb);
    body.varuint(el.styleIndex);
    if (hasTransform) for (const v of el.matrix) body.varint(toFixed(v, scale));
    const tmp = new ByteWriter();
    // shape data via the shared writer (fx/u from the same quantization)
    const fx = (v) => toFixed(v, scale);
    const u = (n) => Math.max(0, n);
    writeShapeData(tmp, el.shape, fx, u, scale);
    body.raw(tmp.toUint8Array());
  }
  const w = new ByteWriter();
  const b = body.toUint8Array();
  w.u8(CHUNK.DEF).varuint(b.length).raw(b);
  return w.toUint8Array();
}

function writeGradChunk(gradients) {
  const body = new ByteWriter();
  body.varuint(gradients.length);
  for (const g of gradients) {
    const alphaStops = g.stops.some((s) => s.opacity < 1);
    const flags = (g.matrix ? 1 : 0) | (alphaStops ? 2 : 0);
    body.u8(g.type).u8(g.units).u8(g.spread).u8(flags);
    if (g.matrix) for (const v of g.matrix) body.varint(v);
    for (const c of g.coords) {
      if (g.units === 0) body.u8(Math.max(0, Math.min(255, Math.round(c))));
      else body.varint(Math.round(c));
    }
    body.varuint(g.stops.length);
    for (const s of g.stops) {
      body.u8(Math.max(0, Math.min(255, Math.round(s.offset))));
      body.rgb24(s.color[0], s.color[1], s.color[2]);
      if (alphaStops) body.u8(Math.round(s.opacity * 255));
    }
  }
  const w = new ByteWriter();
  const b = body.toUint8Array();
  w.u8(CHUNK.GRAD).varuint(b.length).raw(b);
  return w.toUint8Array();
}

// ---- a11y / meta ----

function writeA11yChunk(a11y, labels) {
  if (!a11y.name && !a11y.desc && labels.length === 0) return null;
  const body = new ByteWriter();
  body.lenpfxUtf8(a11y.name).lenpfxUtf8(a11y.desc);
  body.varuint(labels.length);
  for (const l of labels) {
    body.varuint(l.index).lenpfxUtf8(l.name || '').lenpfxUtf8(l.desc || '');
  }
  const w = new ByteWriter();
  const b = body.toUint8Array();
  w.u8(CHUNK.A11Y).varuint(b.length).raw(b);
  return w.toUint8Array();
}

function writeMetaChunk(generator) {
  const body = new ByteWriter();
  body.lenpfxUtf8(generator);
  const w = new ByteWriter();
  const b = body.toUint8Array();
  w.u8(CHUNK.META).varuint(b.length).raw(b);
  return w.toUint8Array();
}

// ---- shapes ----

function buildShape(tag, attrs, warnings) {
  const n = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
  switch (tag) {
    case 'rect': {
      const w = n(attrs.width), h = n(attrs.height);
      if (w <= 0 || h <= 0) return null;
      let rx = attrs.rx !== undefined ? n(attrs.rx) : (attrs.ry !== undefined ? n(attrs.ry) : 0);
      let ry = attrs.ry !== undefined ? n(attrs.ry) : rx;
      rx = Math.min(Math.max(0, rx), w / 2);
      ry = Math.min(Math.max(0, ry), h / 2);
      return { kind: 'rect', x: n(attrs.x), y: n(attrs.y), w, h, rx, ry };
    }
    case 'circle':
      return { kind: 'circle', cx: n(attrs.cx), cy: n(attrs.cy), r: Math.max(0, n(attrs.r)) };
    case 'ellipse':
      return { kind: 'ellipse', cx: n(attrs.cx), cy: n(attrs.cy), rx: Math.max(0, n(attrs.rx)), ry: Math.max(0, n(attrs.ry)) };
    case 'line':
      return { kind: 'line', x1: n(attrs.x1), y1: n(attrs.y1), x2: n(attrs.x2), y2: n(attrs.y2) };
    case 'polyline':
    case 'polygon': {
      const pts = parsePoints(attrs.points);
      if (pts.length < 2) return null;
      return { kind: tag === 'polygon' ? 'polygon' : 'polyline', pts };
    }
    case 'path': {
      try {
        const segs = parsePathData(attrs.d || '');
        if (!segs.length) return null;
        return { kind: 'path', segs };
      } catch (e) {
        warnings.push(`path skipped: ${e.message}`);
        return null;
      }
    }
    default:
      return null;
  }
}

export function parsePoints(s) {
  const nums = String(s || '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

// ---- transforms ----

const IDENTITY = [1, 0, 0, 1, 0, 0];

export function isIdentity(m) {
  return Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9
    && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;
}

export function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function matInverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return IDENTITY.slice();
  return [
    m[3] / det, -m[1] / det,
    -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

function T([x, y]) {
  return [1, 0, 0, 1, x, y];
}

export function parseTransform(s) {
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const args = match[2].trim().split(/[\s,]+/).map(Number);
    let t;
    switch (match[1]) {
      case 'matrix': t = args.length >= 6 ? args.slice(0, 6) : IDENTITY; break;
      case 'translate': t = [1, 0, 0, 1, args[0] || 0, args[1] || 0]; break;
      case 'scale': {
        const sx = args[0] ?? 1, sy = args.length > 1 ? args[1] : sx;
        t = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case 'rotate': {
        const a = (args[0] || 0) * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const rot = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          t = mul(mul([1, 0, 0, 1, args[1], args[2]], rot), [1, 0, 0, 1, -args[1], -args[2]]);
        } else t = rot;
        break;
      }
      case 'skewX': t = [1, 0, Math.tan((args[0] || 0) * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan((args[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}
