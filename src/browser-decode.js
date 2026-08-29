// Browser-friendly async decode: uses DecompressionStream for COMPRESSED files.
// Works in any modern browser and Node ≥ 18 (both expose DecompressionStream).

import { decode } from './decoder.js';

const FLAG_COMPRESSED = 1;

export async function decodeAsync(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if ((bytes[4] & FLAG_COMPRESSED) === 0) return decode(bytes);

  // Rebuild an uncompressed copy: fixed header prefix (3 magic + version + flags)
  // followed by three varuints, then the DEFLATE-raw payload.
  let pos = 5;
  const readVar = () => {
    let result = 0, shift = 0;
    for (;;) {
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
  const payload = new Uint8Array(await new Response(stream).arrayBuffer());

  const full = new Uint8Array(head.length + payload.length);
  full.set(head, 0);
  full.set(payload, head.length);
  return decode(full);
}
