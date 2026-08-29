#!/usr/bin/env node
// SVB CLI — encode / decode / bench / roundtrip
//   node src/cli.js encode in.svg out.svb [--scale 64] [--generator "x"]
//   node src/cli.js decode in.svb out.svg
//   node src/cli.js roundtrip in.svg
//   node src/cli.js bench in.svg [more.svg ...]

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import zlib from 'node:zlib';
import { encode } from './encoder.js';
import { decode } from './decoder.js';
import { toHex } from './svb.js';

const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });
const INFLATE = (u8) => zlib.inflateRawSync(u8);

const [, , cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case 'encode': cmdEncode(args); break;
    case 'decode': cmdDecode(args); break;
    case 'roundtrip': cmdRoundtrip(args); break;
    case 'bench': cmdBench(args); break;
    default:
      console.error(usage());
      process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

function usage() {
  return `SVB v0.1 — Scalable Vector Binary
usage:
  svb encode <in.svg> <out.svb> [--scale 64] [--generator "app"]
  svb decode <in.svb> <out.svg>
  svb roundtrip <in.svg>            encode→decode, writes <in>.decoded.svg
  svb bench <in.svg> [more.svg ...] sizes vs gzip/brotli`;
}

function readArg(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

function cmdEncode(args) {
  const [inp, outp] = args.filter((a) => !a.startsWith('--'));
  if (!inp || !outp) throw new Error('encode needs <in.svg> <out.svb>');
  const scale = Number(readArg(args, '--scale', 64));
  const generator = readArg(args, '--generator', 'svb-cli/0.1');
  const { bytes, warnings, stats } = encode(readFileSync(inp, 'utf8'), { scale, generator, deflate: DEFLATE });
  writeFileSync(outp, bytes);
  warn(warnings);
  const svgSize = readFileSync(inp).length;
  console.log(`${inp} (${svgSize} B) → ${outp} (${bytes.length} B, ${(100 * bytes.length / svgSize).toFixed(1)}%) · ${stats.elements} elements, ${stats.styles} styles`);
}

function cmdDecode(args) {
  const [inp, outp] = args;
  if (!inp || !outp) throw new Error('decode needs <in.svb> <out.svg>');
  const { svg, meta } = decode(readFileSync(inp), { inflate: INFLATE });
  writeFileSync(outp, svg);
  console.log(`${inp} → ${outp} · ${meta.elements} elements, canvas ${meta.width}x${meta.height}, a11y=${meta.hasA11y}`);
}

function cmdRoundtrip(args) {
  const inp = args[0];
  if (!inp) throw new Error('roundtrip needs <in.svg>');
  const { bytes, warnings } = encode(readFileSync(inp, 'utf8'), { deflate: DEFLATE });
  const { svg } = decode(bytes, { inflate: INFLATE });
  const outp = inp.replace(/\.svg$/i, '') + '.decoded.svg';
  writeFileSync(outp, svg);
  warn(warnings);
  console.log(`svg ${readFileSync(inp).length} B → svb ${bytes.length} B → svg ${Buffer.byteLength(svg)} B · wrote ${outp}`);
}

function cmdBench(args) {
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) throw new Error('bench needs at least one <in.svg>');
  const rows = files.map((f) => {
    const svgBuf = readFileSync(f);
    const svg = svgBuf.toString('utf8');
    const { bytes: svb } = encode(svg, { deflate: DEFLATE });
    return {
      file: basename(f),
      svg: svgBuf.length,
      svgGz: zlib.gzipSync(svgBuf).length,
      svgBr: zlib.brotliCompressSync(svgBuf).length,
      svb: svb.length,
      svbGz: zlib.gzipSync(svb).length,
      svbBr: zlib.brotliCompressSync(svb).length,
    };
  });

  console.log('file'.padEnd(24) + 'svg'.padStart(8) + '+gzip'.padStart(8) + '+br'.padStart(8) + '  ' + 'svb'.padStart(8) + '+gzip'.padStart(8) + '+br'.padStart(8) + '   svb/svg');
  for (const r of rows) {
    const ratio = (100 * r.svb / r.svg).toFixed(1).padStart(5) + '%';
    console.log(r.file.padEnd(24) + String(r.svg).padStart(8) + String(r.svgGz).padStart(8) + String(r.svgBr).padStart(8) + '  ' + String(r.svb).padStart(8) + String(r.svbGz).padStart(8) + String(r.svbBr).padStart(8) + '   ' + ratio);
  }
}

function warn(warnings) {
  const uniq = [...new Set(warnings)];
  for (const w of uniq) console.error(`  ⚠ ${w}`);
}
