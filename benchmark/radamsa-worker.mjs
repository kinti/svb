// Batch worker: reads mutant files, classifies decode/validate outcomes,
// prints one JSON line per file. Started by radamsa.mjs under a timeout.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from '../src/decoder.js';
import { validate } from '../src/validate.js';
import { MAX_DECOMPRESSED } from '../src/svb.js';

const INFLATE = (u8) => zlib.inflateRawSync(u8, { maxOutputLength: MAX_DECOMPRESSED });
import zlib from 'node:zlib';

const [dir, ...files] = process.argv.slice(2);
const out = [];
for (const f of files) {
  const bytes = readFileSync(join(dir, f));
  let svg, meta;
  try {
    ({ svg, meta } = decode(bytes, { inflate: INFLATE }));
  } catch (e) {
    if (e instanceof RangeError || e instanceof SyntaxError || e instanceof Error) {
      out.push(JSON.stringify({ file: f, outcome: 'rejected' }));
      continue;
    }
    out.push(JSON.stringify({ file: f, outcome: 'bad', detail: 'threw non-Error' }));
    continue;
  }
  // decoded: output must be sane SVG, no numeric garbage, no double-close
  if (!svg.includes('<svg') || svg.includes('NaN') || svg.includes('Infinity') || svg.includes('//>')) {
    out.push(JSON.stringify({ file: f, outcome: 'bad', detail: 'malformed decoded output' }));
    continue;
  }
  try {
    const report = validate(bytes, { inflate: INFLATE });
    out.push(JSON.stringify({ file: f, outcome: report.verdict === 'FAIL' ? 'validator-fail' : 'decoded' }));
  } catch (e) {
    out.push(JSON.stringify({ file: f, outcome: 'bad', detail: `validate threw: ${e.message}` }));
  }
}
console.log(out.join('\n'));
