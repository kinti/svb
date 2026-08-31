// Deterministic mutation fuzzer for SVB decoders.
// Contract under test: every mutated input either decodes to well-formed SVG
// or throws a classified error — never a hang, never NaN/Infinity, never
// malformed markup. Reproducible with a fixed seed.
import { decode } from './decoder.js';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mutate(bytes, rnd) {
  let m = bytes.slice();
  const strategy = Math.floor(rnd() * 6);
  const n = m.length;
  switch (strategy) {
    case 0: { // bit flips
      const flips = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < flips; i++) {
        const pos = Math.floor(rnd() * n);
        m[pos] ^= 1 << Math.floor(rnd() * 8);
      }
      break;
    }
    case 1: { // truncation
      m = m.slice(0, 1 + Math.floor(rnd() * (n - 1)));
      break;
    }
    case 2: { // byte storm over a span
      const start = Math.floor(rnd() * n);
      const len = Math.min(n - start, 1 + Math.floor(rnd() * 24));
      for (let i = 0; i < len; i++) m[start + i] = Math.floor(rnd() * 256);
      break;
    }
    case 3: { // splice: duplicate a span back into the file
      const start = Math.floor(rnd() * n);
      const len = Math.min(n - start, 1 + Math.floor(rnd() * 32));
      const span = bytes.slice(start, start + len);
      const at = Math.floor(rnd() * m.length);
      const out = new Uint8Array(m.length + len);
      out.set(m.subarray(0, at), 0);
      out.set(span, at);
      out.set(m.subarray(at), at + len);
      return out;
    }
    case 4: { // magic/version/flags corruption
      m[0 + Math.floor(rnd() * 5)] = Math.floor(rnd() * 256);
      break;
    }
    case 5: { // tail garbage
      const extra = 1 + Math.floor(rnd() * 16);
      const out = new Uint8Array(m.length + extra);
      out.set(m, 0);
      for (let i = 0; i < extra; i++) out[m.length + i] = Math.floor(rnd() * 256);
      return out;
    }
  }
  return m;
}

export function runFuzz(bases, { iterations = 2000, seed = 42, decode } = {}) {
  if (!decode) throw new Error('runFuzz requires a decode function');
  const rnd = mulberry32(seed);
  let ok = 0, threw = 0;
  const bad = [];

  for (let i = 0; i < iterations; i++) {
    const base = bases[Math.floor(rnd() * bases.length)];
    const mutant = mutate(base, rnd);
    let result = null, err = null;
    try { result = decode(mutant, {}); } catch (e) { err = e; }

    if (err) { threw++; continue; }
    // decoded without throwing: the emission contract must still hold
    const s = result.svg;
    if (/NaN|Infinity/.test(s)) bad.push({ i, why: 'NaN/Infinity in output', svg: s.slice(0, 120) });
    else if (s.includes('//>')) bad.push({ i, why: 'malformed tag', svg: s.slice(0, 120) });
    else ok++;
  }
  return { cases: iterations, ok, threw, bad };
}
