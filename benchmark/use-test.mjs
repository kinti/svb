#!/usr/bin/env node
// DD-3b: the FAIR comparison Ferrandis asked for.
// Same 12k-block map, but the SVG side uses the obvious SVG optimization:
// <defs> + <use> instances. Then svgo + brotli vs SVB (which models the same
// repetition internally via templates + delta-chained instances).
import zlib from 'node:zlib';
import { optimize } from 'svgo';
import { encode } from '../src/encoder.js';

const br = (buf) => zlib.brotliCompressSync(buf);
const side = 110;                       // 110×110 grid = 12,100 blocks
const W = side * 60;

// --- map WITH defs/use (SVG-native repetition) ---
let use = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${W}">`;
use += '<defs>';
const P = ['#e8e4d8', '#d8d2c0', '#cfc9b8', '#e2ddd0'];
// 3 distinct building shapes (width class × height class), origin-normalized
for (let k = 0; k < 3; k++) {
  const w = 40 + k * 4, h = 30 + k * 5;
  use += `<path id="b${k}" fill="none" d="M0 0h${w}v${h}h-${w - 2}z"/>`;
}
use += '<path id="sv" fill="none" stroke="#b8b2a0" stroke-width="3" d="M0 0v' + W + '"/>';
use += '<path id="sh" fill="none" stroke="#b8b2a0" stroke-width="3" d="M0 0h' + W + '"/>';
use += '</defs>';
for (let i = 0; i < side * side; i++) {
  const x = (i % side) * 60, y = Math.floor(i / side) * 60;
  const k = i % 3;
  use += `<use xlink:href="#b${k}" href="#b${k}" x="${x + 4}" y="${y + 4}" fill="${P[i % 4]}"/>`;
}
for (let i = 0; i <= side; i++) {
  use += `<use href="#sv" x="${i * 60}" y="0"/>`;
  use += `<use href="#sh" x="0" y="${i * 60}"/>`;
}
use += '</svg>';

// --- flat map, same visual (identical to benchmark/large.mjs generator) ---
let flat = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">`;
for (let i = 0; i < side * side; i++) {
  const x = (i % side) * 60, y = Math.floor(i / side) * 60;
  flat += `<path fill="${P[i % 4]}" d="M${x + 4} ${y + 4}h${40 + (i % 3) * 4}v${30 + ((i * 7) % 3) * 5}h-${38 + (i % 3) * 4}z"/>`;
}
for (let i = 0; i <= side; i++) {
  flat += `<path fill="none" stroke="#b8b2a0" stroke-width="3" d="M${i * 60} 0V${side * 60}"/>`;
  flat += `<path fill="none" stroke="#b8b2a0" stroke-width="3" d="M0 ${i * 60}H${side * 60}"/>`;
}
flat += '</svg>';

import { writeFileSync } from 'node:fs';
writeFileSync('/tmp/map-use.svg', use);
writeFileSync('/tmp/map-flat.svg', flat);

// --- measure both delivery paths ---
const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });

const useOpt = optimize(use, { multipass: true, plugins: ['preset-default'] }).data;
const flatOpt = optimize(flat, { multipass: true, plugins: ['preset-default'] }).data;

const useBr = br(Buffer.from(useOpt, 'utf8'));
const flatSvg = Buffer.from(flatOpt, 'utf8');
const flatBr = br(flatSvg);
const { bytes: flatSvb } = encode(flatOpt, { deflate: DEFLATE });
const flatSvbBr = br(flatSvb);

console.log('mismo mapa, mismo contenido visual (', side * side, 'bloques +', 2 * (side + 1), 'calles ):');
console.log('  SVG original plano        :', flatOpt.length, 'B');
console.log('  A) SVG plano + brotli     :', flatBr.length, 'B');
console.log('  B) SVG con <defs>/<use>   :', useOpt.length, 'B');
console.log('  B) + svgo + brotli        :', useBr.length, 'B');
console.log('  C) svb (v0.2, templating) :', flatSvb.length, 'B');
console.log('  C) + brotli               :', flatSvbBr.length, 'B');
console.log('');
console.log('veredicto: svb+br vs uso-svg+svgo+br =', (100 * flatSvbBr / useBr).toFixed(1) + '% del tamaño');
writeFileSync('/tmp/map-use-opt.svg', useOpt);
