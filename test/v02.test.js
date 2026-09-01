// SVB v0.2 tests: templates/instances, gradients, command runs, INV-13/14/15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encode } from '../src/encoder.js';
import { decode } from '../src/decoder.js';
import { ByteWriter, MAGIC, VARUINT_MAX } from '../src/svb.js';

const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });
const INFLATE = (u8) => zlib.inflateRawSync(u8);
const enc = (svg) => encode(svg, { deflate: DEFLATE, generator: 'test' });
const dec = (bytes) => decode(bytes, { inflate: INFLATE });

// XML well-formedness smoke check for round-trips
function assertWellFormed(svg) {
  assert.ok(!svg.includes('//>'), 'double-closed tag (malformed XML)');
  assert.ok(!/NaN|Infinity/.test(svg), 'non-finite numbers leaked');
}

// ---------- instance round-trips ----------

test('v0.2: repeated shapes become instances and decode at the right positions', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">
    <rect x="10" y="10" width="20" height="10" fill="#3b7"/>
    <rect x="100" y="40" width="20" height="10" fill="#3b7"/>
    <rect x="200" y="70" width="20" height="10" fill="#3b7"/>
  </svg>`;
  const { bytes, warnings, stats } = enc(svg);
  assert.deepEqual(warnings, []);
  const { svg: out, meta } = dec(bytes);
  assertWellFormed(out);
  const xs = [...out.matchAll(/<rect[^>]*x="([\d.]+)" y="([\d.]+)"/g)].map((m) => [+m[1], +m[2]]);
  assert.equal(xs.length, 3);
  assert.deepEqual(xs, [[10, 10], [100, 40], [200, 70]]);
  void bytes; void meta;
});

test('v0.2: instance deltas chain correctly across many instances', () => {
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 100">';
  for (let i = 0; i < 25; i++) svg += `<rect x="${i * 80}" y="10" width="40" height="20" fill="#3b7"/>`;
  svg += '</svg>';
  const { bytes } = enc(svg);
  const { svg: out } = dec(bytes);
  assertWellFormed(out);
  const xs = [...out.matchAll(/x="([\d.]+)"/g)].map((m) => +m[1]);
  assert.equal(xs.length, 25);
  xs.forEach((x, i) => assert.equal(x, i * 80, `instance ${i} position`));
});

test('v0.2: single occurrence is not templated', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="4" height="4" fill="red"/></svg>';
  const { bytes, stats } = enc(svg);
  assert.equal(stats.templates, 0);
  const { svg: out } = dec(bytes);
  assert.ok(out.includes('<rect'), 'plain rect decoded');
});

// ---------- INV-13/14/15: hostile inputs ----------

// manual v2 file builder for hostile tests
function buildFile({ version = 2, chunks }) {
  const head = new ByteWriter();
  head.raw(MAGIC).u8(version).u8(0).varuint(100).varuint(100).varuint(64);
  const w = new ByteWriter();
  for (const [tag, body] of chunks) {
    w.u8(tag).varuint(body.length).raw(body);
  }
  const raw = w.toUint8Array();
  const bytes = new Uint8Array(head.bytes.length + raw.length);
  bytes.set(head.toUint8Array(), 0);
  bytes.set(raw, head.bytes.length);
  return bytes;
}

function rectElement(styleIdx = 0, x = 0, y = 0) {
  const w = new ByteWriter();
  w.u8(1); // RECT, no transform, no inline
  w.varuint(styleIdx);
  w.varint(x).varint(y).varuint(64).varuint(64).varuint(0).varuint(0);
  return w.toUint8Array();
}

test('INV-13: dangling template reference rejected', () => {
  const geom = new ByteWriter();
  geom.varuint(1);           // 1 element
  geom.u8(8);                // instance
  geom.varuint(99);          // dangling tmpl-id
  geom.u8(0);                // translate-only
  geom.varint(10).varint(10);
  assert.throws(() => dec(buildFile({ chunks: [[2, geom.toUint8Array()]] })), /unknown template/);
});

test('INV-13: duplicate template ids rejected', () => {
  const def = new ByteWriter();
  def.varuint(2);            // 2 templates
  for (const id of [1, 1]) { // duplicate!
    def.varuint(id).varuint(1);
    def.raw(rectElement());
  }
  const geom = new ByteWriter();
  geom.varuint(0); // empty GEOM
  assert.throws(() => dec(buildFile({ chunks: [[6, def.toUint8Array()], [2, geom.toUint8Array()]] })), /duplicate template/);
});

test('INV-13: instance inside a template rejected (templates are flat)', () => {
  const def = new ByteWriter();
  def.varuint(1);            // 1 template
  def.varuint(1).varuint(1); // id 1, 1 element
  def.u8(8);                 // ...which is an instance — forbidden
  def.varuint(1).u8(0).varint(0).varint(0);
  const geom = new ByteWriter();
  geom.varuint(0); // empty GEOM
  assert.throws(() => dec(buildFile({ chunks: [[6, def.toUint8Array()], [2, geom.toUint8Array()]] })), /templates are flat/);
});

test('INV-14: template bomb beyond 1M emitted elements rejected', () => {
  // template with 500 rect elements; 2500 instances -> 1.25M emitted > 1M cap
  const def = new ByteWriter();
  def.varuint(1).varuint(1).varuint(500);
  for (let i = 0; i < 500; i++) def.raw(rectElement(0, i, i));
  const defB = def.toUint8Array();

  const geom = new ByteWriter();
  geom.varuint(2500);
  for (let i = 0; i < 2500; i++) {
    geom.u8(8).varuint(1).u8(0).varint(i * 2).varint(0);
  }
  const geomB = geom.toUint8Array();
  assert.throws(() => dec(buildFile({ chunks: [[6, defB], [2, geomB]] })), /template bomb/);
});

test('v0.2: command run value < 8 rejected (norm.)', () => {
  const geom = new ByteWriter();
  geom.varuint(1);           // 1 element: path
  geom.u8(7);                // path, no transform, no inline
  geom.varuint(0);           // style 0
  geom.varuint(1);           // 1 run
  geom.varuint(0);           // run value 0 — count would be 0: illegal
  assert.throws(() => dec(buildFile({ chunks: [[2, geom.toUint8Array()]] })), /count must be >= 1|command run/);
});

// ---------- gradients ----------

test('v0.2: linear gradient round-trips through style + GRAD chunk', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e63946"/><stop offset="1" stop-color="#457b9d"/>
    </linearGradient></defs>
    <rect width="100" height="100" fill="url(#g)"/>
  </svg>`;
  const { bytes, warnings } = enc(svg);
  assert.deepEqual(warnings, []);
  const { svg: out } = dec(bytes);
  assert.ok(out.includes('linearGradient'), 'gradient def emitted');
  assert.ok(out.includes('url(#svbg0)'), 'fill references gradient');
  assert.ok(out.includes('#e63946'), 'stop color survives');
  assert.ok(out.includes('#457b9d'), 'second stop survives');
});

test('v0.2: gradient fill inherited from a <g> container round-trips', () => {
  // regression: container branch called readPresentationAttrs without gradIndex → TypeError
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e63946"/><stop offset="1" stop-color="#457b9d"/>
    </linearGradient></defs>
    <g fill="url(#g)"><rect width="40" height="40"/><rect x="50" width="40" height="40"/></g>
  </svg>`;
  const { bytes, warnings } = enc(svg);
  assert.deepEqual(warnings, []);
  const { svg: out } = dec(bytes);
  assertWellFormed(out);
  assert.ok(out.includes('url(#svbg0)'), 'inherited gradient fill applied to shapes');
});

test('v0.2: gradient with unknown type rejected', () => {
  const grad = new ByteWriter();
  grad.varuint(1);                        // 1 gradient
  grad.u8(2).u8(0).u8(0).u8(0);          // type 2 — illegal
  grad.varuint(1);                        // 1 stop
  grad.u8(0).raw([255, 0, 0]);
  assert.throws(() => dec(buildFile({ chunks: [[7, grad.toUint8Array()]] })), /gradient type/);
});

test('v0.2: gradient with zero stops rejected', () => {
  const grad = new ByteWriter();
  grad.varuint(1);                        // 1 gradient
  grad.u8(0).u8(0).u8(0).u8(0);          // linear, OBB, pad, no matrix
  grad.u8(0).u8(0).u8(0).u8(0);          // x1 y1 x2 y2 (OBB u8)
  grad.varuint(0);                        // zero stops — illegal
  assert.throws(() => dec(buildFile({ chunks: [[7, grad.toUint8Array()]] })), /zero stops/);
});

test('v0.2: style referencing unknown gradient rejected', () => {
  const style = new ByteWriter();
  style.varuint(1);       // 1 style entry
  style.u8(0x03);         // fill = gradient ref
  style.varuint(7 << 1);  // gradient 7 — does not exist
  const stB = style.toUint8Array();

  const grad = new ByteWriter();
  grad.varuint(0);
  const grB = grad.toUint8Array();

  const geom = new ByteWriter();
  geom.varuint(1);
  geom.u8(1).varuint(0);
  geom.varint(0).varint(0).varuint(64).varuint(64).varuint(0).varuint(0);
  const gB = geom.toUint8Array();
  assert.throws(() => dec(buildFile({ chunks: [[1, stB], [7, grB], [2, gB]] })), /unknown gradient/);
});

// ---------- versioning ----------

test('v0.2: version 3 rejected', () => {
  const head = new ByteWriter();
  head.raw(MAGIC).u8(3).u8(0).varuint(10).varuint(10).varuint(64);
  assert.throws(() => dec(head.toUint8Array()), /unsupported SVB version 3/);
});

test('v0.2: version 1 files still decode (backward compat)', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="8" height="8" fill="red"/></svg>';
  const raw = encode(svg, { deflate: null });
  // force the version byte back to 1 to simulate a legacy file
  const legacy = raw.bytes.slice();
  legacy[3] = 1;
  const { svg: out } = decode(legacy);
  assert.ok(out.includes('<rect'), 'v1 file decodes under v0.2 decoder');
});
