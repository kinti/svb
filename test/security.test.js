// Security regression tests — each one starts life as a proof of concept.
// See SPEC §12 (hardening rules) and README "Security notes".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encode } from '../src/encoder.js';
import { decode } from '../src/decoder.js';
import { decodeAsync } from '../src/browser-decode.js';
import { ByteWriter, MAGIC, MAX_DECOMPRESSED } from '../src/svb.js';

const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });
const INFLATE = (u8) => zlib.inflateRawSync(u8, { maxOutputLength: MAX_DECOMPRESSED });

// craft a minimal SVB whose GEOM holds a single path declaring `cmdCount` commands
function hostilePathFile(cmdCount) {
  const head = new ByteWriter();
  head.raw(MAGIC).u8(1).u8(0).varuint(10).varuint(10).varuint(64);
  const body = new ByteWriter();
  body.varuint(1);       // one element
  body.u8(7);            // shape = path
  body.varuint(0);       // style_index 0
  body.varuint(cmdCount); // the lie
  body.u8(0);            // M
  body.varuint(0).varuint(0);
  const chunk = new ByteWriter();
  const b = body.toUint8Array();
  chunk.u8(2).varuint(b.length).raw(b);
  return new Uint8Array([...head.toUint8Array(), ...chunk.toUint8Array()]);
}

test('security: 20-byte file declaring 134M path commands is rejected fast (was: OOM)', () => {
  const bytes = hostilePathFile(2 ** 27);
  assert.equal(bytes.length < 64, true, 'attack file is tiny');
  const t0 = Date.now();
  assert.throws(() => decode(bytes), /exceeds|unexpected end of buffer/);
  assert.ok(Date.now() - t0 < 1000, `must reject in bounded time, took ${Date.now() - t0} ms`);
});

test('security: GEOM count beyond payload is rejected', () => {
  const head = new ByteWriter();
  head.raw(MAGIC).u8(1).u8(0).varuint(10).varuint(10).varuint(64);
  const body = new ByteWriter();
  body.varuint(2 ** 30); // element count lie
  body.u8(1);            // one rect header...
  const chunk = new ByteWriter();
  const b = body.toUint8Array();
  chunk.u8(2).varuint(b.length).raw(b);
  const bytes = new Uint8Array([...head.toUint8Array(), ...chunk.toUint8Array()]);
  assert.throws(() => decode(bytes), /exceeds/);
});

test('security: truncated files throw instead of reading silent zeros', () => {
  const { bytes } = encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5"><rect width="4" height="4"/></svg>', { deflate: null });
  for (const cut of [bytes.length - 1, bytes.length - 3, 9]) {
    assert.throws(() => decode(bytes.slice(0, cut)), /unexpected end of buffer|exceeds|overruns/);
  }
});

test('security: decompression bomb is rejected by the output cap', async () => {
  // 4 MB of zeros deflate to ~4 KB; a 64 KB cap must abort mid-stream
  const raw = new Uint8Array(4 * 1024 * 1024);
  const small = zlib.deflateRawSync(raw, { level: 9 });
  assert.ok(small.length < 16 * 1024, 'bomb payload is small on disk');
  const head = new ByteWriter();
  head.raw(MAGIC).u8(1).u8(1).varuint(100).varuint(100).varuint(64); // flags: COMPRESSED
  const bytes = new Uint8Array(head.bytes.length + small.length);
  bytes.set(head.toUint8Array(), 0);
  bytes.set(small, head.bytes.length);
  await assert.rejects(
    () => decodeAsync(bytes, { maxOutputBytes: 64 * 1024 }),
    /exceeds/
  );
});

test('security: benign compressed files still decode through the cap', async () => {
  const { bytes } = encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="8" height="8" fill="red"/></svg>',
    { deflate: DEFLATE }
  );
  const { svg } = await decodeAsync(bytes);
  assert.ok(svg.includes('<rect'), 'normal file decodes via decodeAsync');
});

test('security: encoder rejects oversized input', () => {
  const huge = '<svg xmlns="http://www.w3.org/2000/svg"></svg>' + ' '.repeat(10 * 1024 * 1024);
  assert.throws(() => encode(huge), /input too large/);
});
