// SVB v0.1 round-trip tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../src/encoder.js';
import { decode } from '../src/decoder.js';
import { decodeAsync } from '../src/browser-decode.js';
import { parsePathData } from '../src/path.js';
import { writeVarUint, readVarUint, writeVarInt, readVarInt, ByteWriter, ByteReader } from '../src/svb.js';
import zlib from 'node:zlib';

const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });
const INFLATE = (u8) => zlib.inflateRawSync(u8);

const enc = (svg, opts = {}) => encode(svg, { deflate: DEFLATE, generator: 'test', ...opts });
const dec = (bytes) => decode(bytes, { inflate: INFLATE });

// ---------- varint fuzz ----------

test('varuint round-trip', () => {
  for (const n of [0, 1, 127, 128, 255, 256, 16383, 16384, 65535, 65536, 2 ** 31, 2 ** 40]) {
    const w = new ByteWriter();
    w.varuint(n);
    const [v, pos] = readVarUint(w.toUint8Array(), 0);
    assert.equal(v, n);
    assert.equal(pos, w.bytes.length);
  }
});

test('varint zigzag round-trip (fuzz)', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 5000; i++) {
    const n = Math.round((rnd() - 0.5) * 2 ** (rnd() * 30)) + 0; // normalize -0 → 0
    const w = new ByteWriter();
    w.varint(n);
    const [v, pos] = readVarInt(w.toUint8Array(), 0);
    assert.equal(v, n + 0);
    assert.equal(pos, w.bytes.length);
  }
});

test('lenpfxUtf8 round-trip', () => {
  const w = new ByteWriter();
  w.lenpfxUtf8('Rías Baixas ♦ 出来る');
  const r = new ByteReader(w.toUint8Array());
  assert.equal(r.lenpfxUtf8(), 'Rías Baixas ♦ 出来る');
});

// ---------- basic round-trips ----------

const pin = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#123456" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <title>Map pin</title>
  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
  <circle cx="12" cy="10" r="3"/>
</svg>`;

test('icon: round-trip preserves structure', () => {
  const { bytes, warnings } = enc(pin);
  assert.deepEqual(warnings, []);
  const { svg, meta } = dec(bytes);
  assert.equal(meta.elements, 2);
  assert.ok(svg.includes('<title>Map pin</title>'));
  assert.ok(svg.includes('role="img"'));
  assert.ok(svg.includes('stroke-linecap="round"'));
  assert.ok(!svg.includes('NaN'), 'no NaN in output');
});

test('icon: svb+deflate smaller than svg', () => {
  const { bytes } = enc(pin);
  assert.ok(bytes.length < Buffer.byteLength(pin), `${bytes.length} < ${Buffer.byteLength(pin)}`);
});

test('path geometry survives quantization', () => {
  const { bytes } = enc(pin);
  const { svg } = dec(bytes);
  const d = /d="([^"]+)"/.exec(svg)[1];
  const segs = parsePathData(d);
  const m = segs[0];
  assert.equal(m.cmd, 'M');
  assert.ok(Math.abs(m.pts[0][0] - 21) < 0.02, `M.x ≈ 21, got ${m.pts[0][0]}`);
  // arc normalized: encoder turns "a9 9 0 0 1 18 0" into absolute A
  const arc = segs.find((s) => s.cmd === 'A');
  assert.ok(arc, 'arc preserved');
  assert.equal(arc.arc.sweep, true);
  assert.ok(Math.abs(arc.pts[0][0] - 21) < 0.02);
});

test('styles are interned (shared table)', () => {
  const { bytes, stats } = enc(pin);
  const { meta } = dec(bytes);
  assert.equal(meta.elements, 2);
  assert.equal(stats.styles, 1, 'both elements share the same style entry');
  assert.ok(bytes.length > 0);
});

test('fill-opacity, evenodd, transforms, dasharray', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <g transform="rotate(15 50 50)">
      <polygon points="10,10 90,10 50,90" fill="#7a1f2b" fill-opacity="0.8" fill-rule="evenodd"/>
      <path d="M10 80 h 20 M 40 80 h 20" fill="none" stroke="#000" stroke-width="3" stroke-dasharray="8 6"/>
    </g>
  </svg>`;
  const { bytes } = enc(svg);
  const { svg: out } = dec(bytes);
  assert.ok(out.includes('fill-opacity="0.8"'));
  assert.ok(out.includes('fill-rule="evenodd"'));
  assert.ok(out.includes('transform="matrix('));
  assert.ok(out.includes('stroke-dasharray="8 6"'));
  const { meta } = dec(enc(svg).bytes);
  assert.equal(meta.elements, 2);
});

test('nested g transforms compose', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <g transform="translate(10 20)">
      <g transform="scale(2)">
        <rect x="1" y="1" width="5" height="5" fill="red"/>
      </g>
    </g>
  </svg>`;
  const { bytes } = enc(svg);
  const { svg: out } = dec(bytes);
  // translate(10 20) * scale(2) = matrix(2 0 0 2 10 20)
  assert.ok(out.includes('matrix(2 0 0 2 10 20)'), out);
});

test('viewBox origin is baked in', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 100 100">
    <rect x="10" y="20" width="100" height="100" fill="blue"/>
  </svg>`;
  const { bytes } = enc(svg);
  const { svg: out, meta } = dec(bytes);
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 100);
  // rect at viewBox origin → matrix translate(-10,-20)
  assert.ok(out.includes('matrix(1 0 0 1 -10 -20)'), out);
});

test('polyline/polygon/ellipse/line round-trip', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
    <polyline points="1,2 11,12 21,4" fill="none" stroke="green" stroke-width="1.5"/>
    <polygon points="30,5 45,5 37,20" fill="orange"/>
    <ellipse cx="10" cy="40" rx="8" ry="4" fill="purple"/>
    <line x1="25" y1="35" x2="48" y2="45" stroke="black" stroke-width="2"/>
  </svg>`;
  const { bytes, warnings } = enc(svg);
  assert.deepEqual(warnings, []);
  const { svg: out, meta } = dec(bytes);
  assert.equal(meta.elements, 4);
  for (const tag of ['<polyline', '<polygon', '<ellipse', '<line']) {
    assert.ok(out.includes(tag), `contains ${tag}`);
  }
  assert.ok(out.includes('stroke-width="1.5"'));
});

test('negative coordinates survive (viewBox with negative origin)', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">
    <polygon fill="#7a1f2b" points="0,-46 13.5,-14.1 46,-14.2 19.9,6.6 29.4,38.5 0,19.1 -29.4,38.5 -19.9,6.6 -46,-14.2 -13.5,-14.1"/>
    <path d="M-40 -40 C -10 -10, -30 -5, -5 -5" fill="none" stroke="#000"/>
  </svg>`;
  const { bytes, warnings } = enc(svg);
  assert.deepEqual(warnings, []);
  const { svg: out } = dec(bytes);
  const pts = /points="([^"]+)"/.exec(out)[1].split(' ').map((p) => p.split(',').map(Number));
  assert.equal(pts.length, 10);
  assert.ok(Math.abs(pts[0][1] - -46) < 0.02, `first y ≈ -46, got ${pts[0][1]}`);
  assert.ok(Math.abs(pts[8][0] - -46) < 0.02, `point 9 x ≈ -46, got ${pts[8][0]}`);
  const m = /d="([^"]+)"/.exec(out)[1];
  assert.ok(m.startsWith('M-40 -40'), `path starts at negative coords: ${m.slice(0, 12)}`);
});

test('per-element a11y labels survive', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <title>Doc</title>
    <circle cx="3" cy="3" r="2" fill="red"><title>Botón rojo</title></circle>
    <rect x="6" y="6" width="3" height="3" fill="blue"><desc>cuadrado azul</desc></rect>
  </svg>`;
  const { bytes } = enc(svg);
  const { svg: out } = dec(bytes);
  assert.ok(out.includes('<circle'), out);
  assert.ok(/<circle[^>]*><title>Botón rojo<\/title><\/circle>/.test(out), 'circle title nested');
  assert.ok(/<rect[^>]*><desc>cuadrado azul<\/desc><\/rect>/.test(out), 'rect desc nested');
  assert.ok(out.includes('<title>Doc</title>'));
});

test('entities and special chars in a11y text', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5"><title>A &amp; B &lt;ic&gt;</title><rect width="4" height="4"/></svg>`;
  const { bytes } = enc(svg);
  const { svg: out } = dec(bytes);
  assert.ok(out.includes('A &amp; B &lt;ic&gt;'));
});

// ---------- forward compatibility ----------

test('unknown chunks are skipped', () => {
  const { bytes } = enc(pin);
  // append an unknown chunk (tag 0x42) after everything: decoder must ignore it
  const extended = new Uint8Array(bytes.length + 4);
  extended.set(bytes, 0);
  extended.set([0x42, 2, 0xde, 0xad], bytes.length);
  const { svg } = dec(extended);
  assert.ok(svg.includes('<title>Map pin</title>'));
});

// ---------- compression / async ----------

test('COMPRESSED flag set and async decode matches sync', async () => {
  // small files may not benefit from DEFLATE; generate a bigger repetitive one
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">';
  for (let i = 0; i < 120; i++) {
    svg += `<circle cx="${10 + (i % 20) * 20}" cy="${10 + Math.floor(i / 20) * 20}" r="8" fill="#3584e4"/>`;
  }
  svg += '</svg>';
  const { bytes } = enc(svg);
  assert.equal(bytes[4] & 1, 1, 'COMPRESSED flag');
  const sync = dec(bytes);
  const async = await decodeAsync(bytes);
  assert.equal(async.svg, sync.svg);
});

test('uncompressed files decode without inflate', () => {
  const raw = encode(pin, { deflate: null });
  assert.equal(raw.bytes[4] & 1, 0);
  const { svg } = decode(raw.bytes); // no inflate provided
  assert.ok(svg.includes('Map pin'));
});

// ---------- error handling ----------

test('rejects non-SVB input', () => {
  assert.throws(() => dec(Buffer.from('<svg>not svb</svg>')), /bad magic/);
});

test('rejects truncated files', () => {
  const { bytes } = enc(pin);
  assert.throws(() => dec(bytes.slice(0, 8)), Error);
});
