#!/usr/bin/env node
// DD-3 test: does SVG+Brotli overtake SVB on large, production-like vector files
// (repetitive maps/schematics, organic illustrations)? Sizes ~50-400 KB.
import zlib from 'node:zlib';
import { optimize } from 'svgo';
import { encode } from '../src/encoder.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });
const br = (buf) => zlib.brotliCompressSync(buf);
const kb = (n) => (n / 1024).toFixed(1);

// --- synthetic generators (production-like shapes) ---

// map-like: city blocks grid + street paths; thousands of nodes, high structural repetition
function mapLike(blocks) {
  const P = ['#e8e4d8', '#d8d2c0', '#cfc9b8', '#e2ddd0'];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(Math.sqrt(blocks) * 60)} ${Math.ceil(Math.sqrt(blocks) * 60)}">`;
  const side = Math.ceil(Math.sqrt(blocks));
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

// schematic: repeated electronic-ish symbol instances at translations
function schematic(instances) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(Math.sqrt(instances) * 80)} 1000">`;
  const side = Math.ceil(Math.sqrt(instances));
  for (let i = 0; i < instances; i++) {
    const x = (i % side) * 80, y = Math.floor(i / side) * 46;
    s += `<g transform="translate(${x} ${y})">` +
      `<circle cx="10" cy="10" r="6" fill="none" stroke="#333" stroke-width="2"/>` +
      `<path fill="none" stroke="#333" stroke-width="2" d="M0 10H4M16 10H26"/>` +
      `<rect x="30" y="2" width="16" height="16" fill="#f0ede4" stroke="#333"/>` +
      `<path fill="none" stroke="#c33" d="M30 2l16 16"/>` +
      `</g>`;
  }
  return s + '</svg>';
}

// artistic organic: smooth bezier ribbons, low repetition (brotli's worst case)
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

// real-world large SVG (Wikipedia), if network allows
function realSample() {
  const candidates = [
    'https://upload.wikimedia.org/wikipedia/commons/0/07/Blank_Map-World.svg',
    'https://upload.wikimedia.org/wikipedia/commons/e/ec/World_map_blank_without_borders.svg',
  ];
  for (const url of candidates) {
    try {
      const res = JSON.parse(JSON.stringify({ url }));
      // sync fetch is unavailable; use execSync-style via child process below
    } catch {}
  }
  return null;
}

async function fetchReal() {
  const urls = [
    'https://upload.wikimedia.org/wikipedia/commons/0/07/Blank_Map-World.svg',
    'https://upload.wikimedia.org/wikipedia/commons/8/88/Demography_of_the_Philippines.svg',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes('<svg') && text.length > 30000) return { name: 'wikipedia-real', svg: text };
    } catch {}
  }
  return null;
}

const samples = [
  ['map-3k-blocks', mapLike(3000)],
  ['map-12k-blocks', mapLike(12000)],
  ['schematic-2k', schematic(2000)],
  ['organic-40x120', organic(40, 120)],
];

const real = await fetchReal();
if (real) samples.push([real.name, real.svg]);

console.log('file'.padEnd(18) + 'svgMin'.padStart(9) + 'svg+br'.padStart(9) + 'svb'.padStart(9) + 'svb+br'.padStart(9) + '  svb/svg  svb+br/svg+br');
for (const [name, svg] of samples) {
  try {
    const opt = optimize(svg, { multipass: true, plugins: ['preset-default'] }).data;
    const svgMin = Buffer.from(opt, 'utf8');
    const { bytes: svb, warnings } = encode(opt, { deflate: DEFLATE });
    const svgBr = br(svgMin), svbBr = br(svb);
    writeFileSync(`/tmp/large-${name}.svg`, svgMin);
    const lossy = warnings.length ? ` [${warnings.length} warn]` : '';
    console.log(
      name.padEnd(18) + String(svgMin.length).padStart(9) + String(svgBr.length).padStart(9) +
      String(svb.length).padStart(9) + String(svbBr.length).padStart(9) +
      '   ×' + (svb.length / svgMin.length).toFixed(3) + '   ×' + (svbBr.length / svgBr.length).toFixed(3) + lossy
    );
  } catch (e) {
    console.log(name.padEnd(18) + 'ERROR: ' + e.message.slice(0, 60));
  }
}
