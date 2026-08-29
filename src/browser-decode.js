// Browser-friendly async decode: uses DecompressionStream for COMPRESSED files.
// Works in any modern browser and Node ≥ 18 (both expose DecompressionStream).

import { decode } from './decoder.js';
import { MAX_DECOMPRESSED } from './svb.js';

const FLAG_COMPRESSED = 1;

// Read a ReadableStream into a single Uint8Array, aborting if it grows past cap
// (SPEC §12: decompression bombs must fail fast instead of being allocated).

async function readCapped(stream, cap) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`decompressed payload exceeds ${cap} bytes — rejecting possible decompression bomb`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export async function decodeAsync(buffer, opts = {}) {
  const cap = opts.maxOutputBytes ?? MAX_DECOMPRESSED;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if ((bytes[4] & FLAG_COMPRESSED) === 0) return decode(bytes);

  // Rebuild an uncompressed copy: fixed header prefix (3 magic + version + flags)
  // followed by three varuints, then the DEFLATE-raw payload.
  let pos = 5;
  const readVar = () => {
    let result = 0, shift = 0;
    for (;;) {
      if (pos >= bytes.length) throw new RangeError('unexpected end of buffer');
      const b = bytes[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  };
  readVar(); readVar(); readVar(); // width, height, scale

  const head = bytes.slice(0, pos);
  head[4] &= ~FLAG_COMPRESSED;
  const body = bytes.slice(pos);

  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const payload = await readCapped(stream, cap);

  const full = new Uint8Array(head.length + payload.length);
  full.set(head, 0);
  full.set(payload, head.length);
  return decode(full);
}
