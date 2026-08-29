// SVG → SVB encoder (v0.1). See SPEC.md.
//
// Strategy: parse XML → walk supported shapes with inherited presentation
// styles → intern styles → normalize paths to absolute M/L/C/Q/A/Z →
// quantize + delta-encode → chunk stream → optional DEFLATE (injected as
// opts.deflate so the module stays dependency-free and browser-safe).

import {
  MAGIC, VERSION, FLAG, CHUNK, SHAPE, CMD,
  ByteWriter, parseColor, toHex, toFixed,
} from './svb.js';
import { parseXml } from './xml.js';
import { parsePathData } from './path.js';

const SUPPORTED_SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const SKIP_TAGS = new Set([
  'defs', 'style', 'script', 'metadata', 'symbol', 'clipPath', 'mask', 'pattern',
  'linearGradient', 'radialGradient', 'filter', 'marker',
]);
const UNSUPPORTED_WARN = new Set(['use', 'text', 'image', 'tspan', 'textPath', 'foreignObject']);

export function encode(svgString, opts = {}) {
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

  // ---- walk the tree ----
  const elements = [];      // { shape, styleIndex, matrix }
  const styleEntries = [];  // resolved style objects, interned
  const styleIndex = new Map();
  const elementLabels = []; // { index, name, desc }

  const inheritableKeys = ['fill', 'fillOpacity', 'stroke', 'strokeOpacity', 'strokeWidth', 'lineCap', 'lineJoin', 'dash', 'evenodd'];
  const rootStyle = { fill: '#000000', fillOpacity: 1, stroke: null, strokeOpacity: 1, strokeWidth: 1, lineCap: 'butt', lineJoin: 'miter', dash: null, evenodd: false };
  // presentation attributes on the root <svg> (common in icon SVGs) are inherited
  for (const [k, v] of Object.entries(readPresentationAttrs(svg.attrs, warnings))) {
    if (v !== undefined) rootStyle[k] = v;
  }

  walk(svg.children, rootMatrix, rootStyle);

  function walk(nodes, matrix, inheritedStyle) {
    for (const node of nodes) {
      const tag = node.tag;
      if (tag === 'title' || tag === 'desc') continue; // handled per-context
      if (tag === 'g' || tag === 'a' || tag === 'switch') {
        // container: compose transform, inherit style, recurse
        const own = readPresentationAttrs(node.attrs, warnings);
        const style = { ...inheritedStyle };
        for (const k of inheritableKeys) if (own[k] !== undefined) style[k] = own[k];
        let m = matrix;
        if (node.attrs.transform) m = mul(matrix, parseTransform(node.attrs.transform));
        walk(node.children, m, style);
        continue;
      }
      if (SKIP_TAGS.has(tag)) {
        if (tag === 'defs' && (node.children.length || node.text)) {
          warnings.push('<defs> content skipped (use/refs not supported in v0.1)');
        }
        continue;
      }
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

      const own = readPresentationAttrs(node.attrs, warnings);
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

      // <title>/<desc> as direct children of a shape are its accessible labels
      for (const ch of node.children) {
        if (ch.tag === 'title') elementLabels.push({ index: idx, name: ch.text || '', desc: '' });
        else if (ch.tag === 'desc') elementLabels.push({ index: idx, name: '', desc: ch.text || '' });
        else warnings.push(`<${ch.tag}> inside <${tag}> skipped`);
      }
    }
  }

  if (elements.length === 0) warnings.push('no supported geometry found');

  // ---- chunks ----
  const fileA11y = {
    name: svg.children.find((n) => n.tag === 'title')?.text || '',
    desc: svg.children.find((n) => n.tag === 'desc')?.text || '',
  };
  const styleChunk = styleEntries.length ? writeStyleChunk(styleEntries, scale) : null;
  const geomChunk = writeGeomChunk(elements, scale);
  const a11yChunk = writeA11yChunk(fileA11y, elementLabels);
  const metaChunk = opts.generator != null ? writeMetaChunk(opts.generator) : null;

  let payload = new ByteWriter();
  if (styleChunk) payload.raw(styleChunk);
  payload.raw(geomChunk);
  if (a11yChunk) payload.raw(a11yChunk);
  if (metaChunk) payload.raw(metaChunk);
  let raw = payload.toUint8Array();

  let flags = 0;
  if (styleChunk) flags |= FLAG.HAS_STYLE;
  if (a11yChunk) flags |= FLAG.HAS_A11Y;
  if (opts.deflate) {
    const deflated = opts.deflate(raw);
    if (deflated.length < raw.length) {
      raw = deflated;
      flags |= FLAG.COMPRESSED;
    }
  }

  const head = new ByteWriter();
  head.raw(MAGIC).u8(VERSION).u8(flags);
  head.varuint(Math.round(width)).varuint(Math.round(height)).varuint(scale);

  const bytes = new Uint8Array(head.bytes.length + raw.length);
  bytes.set(head.toUint8Array(), 0);
  bytes.set(raw, head.bytes.length);

  return { bytes, warnings, stats: { elements: elements.length, styles: styleEntries.length } };
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

function readPresentationAttrs(attrs, warnings) {
  const out = {};
  if (attrs.fill !== undefined) {
    if (attrs.fill.trim() === 'none') out.fill = null;
    else if (attrs.fill.startsWith('url(')) { warnings.push('gradient/pattern fill replaced by none (v0.1)'); out.fill = null; }
    else out.fill = hexOr(attrs.fill);
  }
  if (attrs['fill-opacity'] !== undefined) out.fillOpacity = clamp01(parseFloat(attrs['fill-opacity']));
  if (attrs['fill-rule'] !== undefined) out.evenodd = attrs['fill-rule'].trim() === 'evenodd';
  if (attrs.stroke !== undefined) {
    if (attrs.stroke.trim() === 'none') out.stroke = null;
    else if (attrs.stroke.startsWith('url(')) { warnings.push('gradient/pattern stroke replaced by none (v0.1)'); out.stroke = null; }
    else out.stroke = hexOr(attrs.stroke);
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
  const fill = style.fill ? parseColor(style.fill) : null;
  const stroke = style.stroke ? parseColor(style.stroke) : null;
  const fillA = Math.round((style.fillOpacity ?? 1) * 255);
  const strokeA = Math.round((style.strokeOpacity ?? 1) * 255);
  const hasWidth = style.stroke != null && style.strokeWidth !== undefined;
  const caps = ({ butt: 0, round: 1, square: 2 })[style.lineCap] ?? 0;
  const joins = ({ miter: 0, round: 1, bevel: 2 })[style.lineJoin] ?? 0;
  const hasCaps = stroke != null && (caps !== 0 || joins !== 0);
  const dash = style.stroke != null && Array.isArray(style.dash) && style.dash.length ? style.dash : null;

  let sb = 0;
  sb |= fill ? (fillA < 255 ? 2 : 1) : 0;
  sb |= stroke ? (strokeA < 255 ? 2 : 1) << 2 : 0;
  if (hasWidth) sb |= 1 << 4;
  if (hasCaps) sb |= 1 << 5;
  if (dash) sb |= 1 << 6;
  if (style.evenodd) sb |= 1 << 7;
  w.u8(sb);

  if (fill) { w.rgb24(fill[0], fill[1], fill[2]); if (fillA < 255) w.u8(fillA); }
  if (stroke) { w.rgb24(stroke[0], stroke[1], stroke[2]); if (strokeA < 255) w.u8(strokeA); }
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

function writeGeomChunk(elements, scale) {
  const fx = (v) => toFixed(v, scale);   // fixed value, may be negative (for deltas/matrix)
  const u = (n) => Math.max(0, n);       // clamp for varuint fields

  const body = new ByteWriter();
  body.varuint(elements.length);

  for (const el of elements) {
    const hasTransform = !isIdentity(el.matrix);
    let eb = el.shape.type & 0x0f;
    if (hasTransform) eb |= 1 << 4;
    body.u8(eb);
    body.varuint(el.styleIndex);
    if (hasTransform) for (const v of el.matrix) body.varint(fx(v));

    const s = el.shape;
    switch (s.type) {
      case SHAPE.RECT:
        body.varint(fx(s.x)).varint(fx(s.y)).varuint(u(fx(s.w))).varuint(u(fx(s.h)))
          .varuint(u(fx(s.rx))).varuint(u(fx(s.ry)));
        break;
      case SHAPE.CIRCLE:
        body.varint(fx(s.cx)).varint(fx(s.cy)).varuint(u(fx(s.r)));
        break;
      case SHAPE.ELLIPSE:
        body.varint(fx(s.cx)).varint(fx(s.cy)).varuint(u(fx(s.rx))).varuint(u(fx(s.ry)));
        break;
      case SHAPE.LINE:
        body.varint(fx(s.x1)).varint(fx(s.y1)).varint(fx(s.x2)).varint(fx(s.y2));
        break;
      case SHAPE.POLYLINE:
      case SHAPE.POLYGON: {
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
      case SHAPE.PATH: {
        const cmdMap = { M: CMD.M, L: CMD.L, C: CMD.C, Q: CMD.Q, A: CMD.A, Z: CMD.Z };
        body.varuint(s.segs.length);
        let penX = 0, penY = 0;
        let subStartX = 0, subStartY = 0;
        let firstPoint = true;
        for (const seg of s.segs) {
          body.u8(cmdMap[seg.cmd]);
          if (seg.cmd === 'Z') {
            penX = subStartX; penY = subStartY;
            continue;
          }
          if (seg.cmd === 'A') {
            body.varuint(u(fx(seg.arc.rx))).varuint(u(fx(seg.arc.ry)));
            body.varint(Math.round(seg.arc.rot));
            body.u8((seg.arc.largeArc ? 1 : 0) | (seg.arc.sweep ? 2 : 0));
          }
          for (let p = 0; p < seg.pts.length; p++) {
            const X = fx(seg.pts[p][0]), Y = fx(seg.pts[p][1]);
            if (firstPoint) { body.varint(X).varint(Y); firstPoint = false; }
            else { body.varint(X - penX).varint(Y - penY); }
            penX = X; penY = Y;
          }
          if (seg.cmd === 'M') { subStartX = penX; subStartY = penY; }
        }
        break;
      }
    }
  }

  const w = new ByteWriter();
  const b = body.toUint8Array();
  w.u8(CHUNK.GEOM).varuint(b.length).raw(b);
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
      return { type: SHAPE.RECT, x: n(attrs.x), y: n(attrs.y), w, h, rx, ry };
    }
    case 'circle':
      return { type: SHAPE.CIRCLE, cx: n(attrs.cx), cy: n(attrs.cy), r: Math.max(0, n(attrs.r)) };
    case 'ellipse':
      return { type: SHAPE.ELLIPSE, cx: n(attrs.cx), cy: n(attrs.cy), rx: Math.max(0, n(attrs.rx)), ry: Math.max(0, n(attrs.ry)) };
    case 'line':
      return { type: SHAPE.LINE, x1: n(attrs.x1), y1: n(attrs.y1), x2: n(attrs.x2), y2: n(attrs.y2) };
    case 'polyline':
    case 'polygon': {
      const pts = parsePoints(attrs.points);
      if (pts.length < 2) return null;
      return { type: tag === 'polygon' ? SHAPE.POLYGON : SHAPE.POLYLINE, pts };
    }
    case 'path': {
      try {
        const segs = parsePathData(attrs.d || '');
        if (!segs.length) return null;
        return { type: SHAPE.PATH, segs };
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
