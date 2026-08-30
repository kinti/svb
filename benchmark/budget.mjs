#!/usr/bin/env node
// v0.2 information budget (measured): per class, how much redundancy remains
// in the raw SVB stream after delta coding?
//   H0      — order-0 byte entropy of the uncompressed SVB (floor for any
//             order-0 entropy stage; grammar-informed codes can beat it)
//   svb+br  — what a generic LZ+entropy stage achieves on the SVB stream
//             (proxy for repetition headroom, F-12)
//   svg+br  — the number to beat (production delivery)
import zlib from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { optimize } from 'svgo';
import { encode } from '../src/encoder.js';

const br = (buf) => zlib.brotliCompressSync(buf);

// H0 entropy over a byte array, in bits/byte
function h0(bytes) {
  const freq = new Array(256).fill(0);
  for (const b of bytes) freq[b]++;
  let H = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / bytes.length;
    H -= p * Math.log2(p);
  }
  return H;
}

// --- generators (same as large.mjs) ---
function mapLike(blocks) {
  const P = ['#e8e4d8', '#d8d2c0', '#cfc9b8', '#e2ddd0'];
  const side = Math.ceil(Math.sqrt(blocks));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side * 60} ${side * 60}">`;
  for (let i = 0; i < blocks; i++) {
    const x = (i % side) * 60, y = Math.floor(i / side) * 60;
    s += `<path fill="${P[i % 4]}" d="M${x + 4} ${y + 4}h${40 + (i % 3) * 4}v${30 + ((i * 7) % 3) * 5}h-${38 + (i % 3) * 4}z"/>`;
  }
  for (let i = 0; i <= side; i++) {
    s += `<path fill="none" stroke="#b8b2a0" stroke-width="3" d="M${i * 60} 0V${side * 60}"/>`;
    s += `<path fill="none" stroke="#b8b2a0" stroke-width="3" d="M0 ${i * 60}H${side * 60}"/>`;
  }
  return s + '</svg>';
}
function organic(paths, segs) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900">`;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let p = 0; p < paths; p++) {
    let d = `M${(rnd() * 1200).toFixed(1)} ${(rnd() * 900).toFixed(1)}`;
    for (let i = 0; i < segs; i++) {
      d += `C${(rnd() * 1200).toFixed(1)} ${(rnd() * 900).toFixed(1)} ${(rnd() * 1200).toFixed(1)} ${(rnd() * 900).toFixed(1)} ${(rnd() * 1200).toFixed(1)} ${(rnd() * 900).toFixed(1)}`;
    }
    s += `<path fill="none" stroke="hsl(${p * 7 % 360} 60% 50%)" stroke-width="${(1 + rnd() * 3).toFixed(1)}" d="${d}"/>`;
  }
  return s + '</svg>';
}

const samples = [
  ['icon (pin)', readFileSync('demo/samples/icon-pin.svg', 'utf8')],
  ['illustration', readFileSync('demo/samples/illustration.svg', 'utf8')],
  ['map-12k', mapLike(12000)],
  ['organic-40x120', organic(40, 120)],
  ['bootstrap x10 (icons)', readdirSync('node_modules/bootstrap-icons/icons').sort().slice(0, 10)
    .map((f) => readFileSync(`node_modules/bootstrap-icons/icons/${f}`, 'utf8'))
    .join('').replace(/<\/svg><svg[^>]*>/g, '')],
];

console.log('class'.padEnd(16) + 'svb(raw)'.padStart(9) + 'H0 b/B'.padStart(7) + '→floor'.padStart(9) + 'svb+br'.padStart(9) + 'svg+br'.padStart(9) + '  floor vs svg+br');
for (const [name, svg] of samples) {
  try {
    const opt = optimize(svg, { multipass: true, plugins: ['preset-default'] }).data;
    const raw = encode(opt, { deflate: null }).bytes;          // uncompressed SVB
    const { bytes: svb } = encode(opt, { deflate: (u) => zlib.deflateRawSync(u, { level: 9 }) });
    const svgMin = Buffer.from(opt, 'utf8');
    const H = h0(raw);
    const floor = Math.round(raw.length * H / 8);
    const svbBr = br(svb).length;
    const svgBr = br(svgMin).length;
    const verdict = floor < svgBr ? 'floor WINS by ' + Math.round(100 * (1 - floor / svgBr)) + '%' : 'floor LOSES by ' + Math.round(100 * (floor / svgBr - 1)) + '%';
    console.log(
      name.padEnd(16) + String(raw.length).padStart(9) +
      H.toFixed(2).padStart(7) + String(floor).padStart(9) +
      String(svbBr).padStart(9) + String(svgBr).padStart(9) +
      '  ' + verdict
    );
  } catch (e) {
    console.log(name.padEnd(16) + 'ERROR ' + e.message.slice(0, 50));
  }
}
console.log('\nfloor = raw × H0/8: order-0 entropy floor of the CURRENT svb stream (no repetition modeling).');
console.log('back-references remove repetition BEFORE the entropy stage → the real v0.2 target is below the floor on repetitive classes.');
