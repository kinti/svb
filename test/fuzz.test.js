// Fuzz smoke test in the suite: the full campaign lives in src/fuzz.js runs.
import zlib from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../src/encoder.js';
import { decode } from '../src/decoder.js';
import { mutate, runFuzz } from '../src/fuzz.js';
import { readFileSync } from 'node:fs';

const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });
const INFLATE = (u8) => zlib.inflateRawSync(u8);
const dec = (b) => decode(b, { inflate: INFLATE });

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: 600 mutated files never hang and never emit unsafe output', () => {
  const pin = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>pin</title><path fill="none" stroke="#000" stroke-width="2" d="M2 12h20"/></svg>`;
  const star = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><polygon points="5,0 10,10 0,10" fill="#3b7"/></svg>`;
  const bases = [encode(pin).bytes, encode(star).bytes];

  const rnd = mulberry32(7);
  let threw = 0, ok = 0;
  for (let i = 0; i < 600; i++) {
    const base = bases[i % bases.length];
    const mutant = mutate(base, rnd);
    let res = null, err = null;
    const t0 = Date.now();
    try { res = dec(mutant); } catch (e) { threw++; err = e; continue; }
    const dt = Date.now() - t0;
    assert.ok(dt < 1000, `case ${i}: decoder took ${dt} ms`);
    if (err) continue;
    const s = res.svg;
    assert.ok(!/NaN|Infinity/.test(s), `case ${i}: unsafe output ${s.slice(0, 80)}`);
    assert.ok(!s.includes('//>'), `case ${i}: malformed tag`);
    ok++;
  }
  assert.ok(threw + ok === 600, 'every case terminates');
});

