// SVB — Scalable Vector Binary · primitives (v0.1)
// Little-endian varuint (LEB128), zigzag varint, fixed-point, colors.

export const MAGIC = [0x53, 0x56, 0x42]; // "SVB"
export const VERSION = 1;

export const FLAG = {
  COMPRESSED: 1 << 0,
  HAS_A11Y: 1 << 1,
  HAS_ANIMATION: 1 << 2, // reserved
  HAS_STYLE: 1 << 3,
};

// Security limits (see SPEC §12): implementations SHOULD refuse inputs and
// decompressed payloads beyond these bounds.
export const MAX_INPUT = 10 * 1024 * 1024;        // SVG accepted by the encoder
export const MAX_DECOMPRESSED = 64 * 1024 * 1024; // SVB payload after DEFLATE

export const CHUNK = {
  STYLE: 0x01,
  GEOM: 0x02,
  A11Y: 0x03,
  ANIM: 0x04, // reserved
  META: 0x05,
};

export const SHAPE = { RECT: 1, CIRCLE: 2, ELLIPSE: 3, LINE: 4, POLYLINE: 5, POLYGON: 6, PATH: 7 };

export const CMD = { M: 0, L: 1, C: 2, Q: 3, A: 4, Z: 5 };

// ---- varuint (LEB128) ----
// Alphabet: 7 bytes max = 49 bits (values < 2^49). The decoder rejects any
// varuint whose 7th byte still carries a continuation bit, so the encoder MUST
// refuse out-of-alphabet values instead of emitting undecodable files.

export const VARUINT_MAX = 2 ** 49 - 1;

export function writeVarUint(bytes, n) {
  if (n < 0 || !Number.isFinite(n)) throw new RangeError(`varuint out of range: ${n}`);
  n = Math.round(n);
  if (n > VARUINT_MAX) throw new RangeError(`varuint overflow: ${n} exceeds 2^49-1 alphabet`);
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
}

export function readVarUint(buf, pos) {
  let result = 0, shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('unexpected end of buffer');
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 42) throw new RangeError('varuint too long');
  }
  return [result, pos];
}

// ---- varint (zigzag) ----

export function writeVarInt(bytes, n) {
  n = Math.round(n) || 0; // Math.round(-0.3) → -0; normalize to 0
  writeVarUint(bytes, n >= 0 ? n * 2 : -n * 2 - 1);
}

export function readVarInt(buf, pos) {
  const [u, p] = readVarUint(buf, pos);
  const n = u & 1 ? -(u + 1) / 2 : u / 2;
  return [n, p];
}

// ---- fixed-point ----

export function toFixed(v, scale) {
  return Math.round(Number(v) * scale);
}

export function fromFixed(n, scale) {
  return n / scale;
}

// ---- buffer helper ----

export class ByteWriter {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); return this; }
  varuint(n) { writeVarUint(this.bytes, n); return this; }
  varint(n) { writeVarInt(this.bytes, n); return this; }
  rgb24(r, g, b) { this.bytes.push(r & 0xff, g & 0xff, b & 0xff); return this; }
  lenpfxUtf8(s) {
    const enc = new TextEncoder().encode(String(s ?? ''));
    this.varuint(enc.length);
    for (const b of enc) this.bytes.push(b);
    return this;
  }
  raw(arr) { for (const b of arr) this.bytes.push(b); return this; }
  toUint8Array() { return Uint8Array.from(this.bytes); }
}

export class ByteReader {
  constructor(buf) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.pos = 0;
    this.dec = new TextDecoder();
  }
  u8() {
    if (this.pos >= this.buf.length) throw new RangeError('unexpected end of buffer');
    return this.buf[this.pos++];
  }
  bytes(n) {
    if (this.pos + n > this.buf.length) throw new RangeError('unexpected end of buffer');
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  varuint() { const [v, p] = readVarUint(this.buf, this.pos); this.pos = p; return v; }
  varint() { const [v, p] = readVarInt(this.buf, this.pos); this.pos = p; return v; }
  lenpfxUtf8() { const n = this.varuint(); return this.dec.decode(this.bytes(n)); }
  get remaining() { return this.buf.length - this.pos; }
}

// ---- colors ----

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', navy: '#000080', teal: '#008080', olive: '#808000',
  lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff', magenta: '#ff00ff',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', transparent: 'none',
};

export function parseColor(s) {
  if (s == null) return null;
  s = String(s).trim().toLowerCase();
  if (s === 'none') return null;
  if (NAMED[s]) s = NAMED[s];
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
    }
    if (hex.length === 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    return null;
  }
  const m = s.match(/^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    const ch = (v) => v.endsWith('%') ? Math.round(parseFloat(v) * 2.55) : Math.round(parseFloat(v));
    return [ch(m[1]), ch(m[2]), ch(m[3])];
  }
  return null;
}

export function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
