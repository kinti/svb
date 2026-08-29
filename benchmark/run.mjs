#!/usr/bin/env node
// SVB real-world corpus benchmark.
//
// Sources (npm): feather-icons, bootstrap-icons, simple-icons — sampled with a
// fixed seed for reproducibility. Every file is optimized with svgo (multipass)
// first: the comparison is against what a web developer would actually ship.
//
// Classifications (honest reporting):
//   clean    — svgo ok, SVB encode without lossy warnings
//   lossy    — SVB encoded but dropped something (gradients, <text>, style attr…)
//   svgo-fail / svb-fail — excluded entirely
// Headline ratios are computed over `clean` files only; excluded counts travel
// with the results.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { optimize } from 'svgo';
import { encode } from '../src/encoder.js';
import { decode } from '../src/decoder.js';

const require = createRequire(import.meta.url);

// ---- sampling ----

const SEED = 42;
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickN = (list, n, rnd) => {
  const copy = [...list];
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  }
  return out;
};

const DEFLATE = (u8) => zlib.deflateRawSync(u8, { level: 9 });
const brotli = (buf) => zlib.brotliCompressSync(buf);
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });

const pkgVersion = (name) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
const versions = Object.fromEntries(['svgo', 'feather-icons', 'bootstrap-icons', 'simple-icons'].map((n) => [n, pkgVersion(n)]));

const SOURCES = [
  { id: 'feather', pkg: 'feather-icons', dir: 'dist/icons', take: Infinity, label: 'Feather Icons (stroke-based)' },
  { id: 'bootstrap', pkg: 'bootstrap-icons', dir: 'icons', take: 400, label: 'Bootstrap Icons (mixed solid)' },
  { id: 'simpleicons', pkg: 'simple-icons', dir: 'icons', take: 400, label: 'Simple Icons (brand logos, single path)' },
];

const files = [];
for (const src of SOURCES) {
  const dir = `node_modules/${src.pkg}/${src.dir}`;
  const all = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
  const rnd = mulberry32(SEED);
  const chosen = Number.isFinite(src.take) ? pickN(all, src.take, rnd) : all;
  for (const f of chosen) files.push({ source: src.id, name: f.replace(/\.svg$/, ''), path: `${dir}/${f}` });
}

// ---- bench ----

const results = [];
const excluded = { 'svgo-fail': 0, 'svb-fail': 0 };
let lossy = 0;

for (const file of files) {
  const origBuf = readFileSync(file.path);
  const orig = origBuf.toString('utf8');

  // svgo (what a developer would ship)
  let svgMin;
  try {
    const out = optimize(orig, { multipass: true, plugins: ['preset-default'] });
    svgMin = out.data;
    if (!svgMin.includes('<svg')) throw new Error('no svg root after svgo');
  } catch {
    excluded['svgo-fail']++;
    results.push({ ...file, orig: origBuf.length, status: 'svgo-fail' });
    continue;
  }

  // SVB encode of the optimized SVG
  let enc;
  try {
    enc = encode(svgMin, { deflate: DEFLATE });
  } catch {
    excluded['svb-fail']++;
    results.push({ ...file, orig: origBuf.length, status: 'svb-fail' });
    continue;
  }
  const status = enc.warnings.length ? 'lossy' : 'clean';
  if (status === 'lossy') lossy++;
  if (status !== 'clean') {
    results.push({
      ...file, orig: origBuf.length, status,
      svgMin: Buffer.byteLength(svgMin),
      svb: enc.bytes.length,
      warnings: [...new Set(enc.warnings)],
    });
    continue;
  }

  // round-trip sanity on clean files
  let ok = true;
  try {
    decode(enc.bytes, { inflate: (u8) => zlib.inflateRawSync(u8) });
  } catch {
    ok = false;
  }

  const svgMinBuf = Buffer.from(svgMin, 'utf8');
  results.push({
    ...file,
    orig: origBuf.length,
    status: ok ? 'clean' : 'rt-fail',
    svgMin: svgMinBuf.length,
    svgMinGz: gzip(svgMinBuf).length,
    svgMinBr: brotli(svgMinBuf).length,
    svb: enc.bytes.length,
    svbGz: gzip(enc.bytes).length,
    svbBr: brotli(enc.bytes).length,
    elements: enc.stats.elements,
    styles: enc.stats.styles,
  });
}

// ---- aggregates (clean only) ----

const clean = results.filter((r) => r.status === 'clean');
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const aggregate = (rows) => {
  if (!rows.length) return null;
  const ratios = rows.map((r) => r.svb / r.svgMin);
  const vsBr = rows.map((r) => r.svb < r.svgMinBr);
  const svbBrRatio = rows.map((r) => r.svbBr / r.svgMinBr);
  return {
    n: rows.length,
    medianRatio: +median(ratios).toFixed(3),
    meanRatio: +(ratios.reduce((a, b) => a + b, 0) / rows.length).toFixed(3),
    pctBelowRawBrotli: +((100 * vsBr.filter(Boolean).length) / rows.length).toFixed(1),
    medianSvbBrOverSvgBr: +median(svbBrRatio).toFixed(3),
    medianSvgMin: median(rows.map((r) => r.svgMin)),
    medianSvb: median(rows.map((r) => r.svb)),
  };
};

const summary = {
  seed: SEED,
  generated: new Date().toISOString().slice(0, 10),
  versions,
  collected: files.length,
  clean: clean.length,
  lossy,
  excluded,
  overall: aggregate(clean),
  bySource: Object.fromEntries(
    [...new Set(files.map((f) => f.source))].map((sid) => [
      sid,
      { label: SOURCES.find((s) => s.id === sid).label, ...(aggregate(clean.filter((r) => r.source === sid)) ?? { n: 0 }) },
    ])
  ),
};

writeFileSync('benchmark/manifest.json', JSON.stringify({
  seed: SEED, versions, sources: SOURCES.map(({ id, pkg, dir, take, label }) => ({ id, pkg, dir, take, label })),
  files: files.map(({ source, name }) => `${source}/${name}.svg`),
}, null, 1));

writeFileSync('benchmark/results.json', JSON.stringify({ summary, files: results }));

// ---- console report ----

console.log(`collected ${files.length} · clean ${clean.length} · lossy ${lossy} · excluded ${JSON.stringify(excluded)}`);
console.log(`overall: median svb/svgMin ×${summary.overall.medianRatio} · svb < svgMin+brotli in ${summary.overall.pctBelowRawBrotli}% of files · median svb+br / svgMin+br ×${summary.overall.medianSvbBrOverSvgBr}`);
for (const [sid, s] of Object.entries(summary.bySource)) {
  console.log(`  ${sid.padEnd(12)} n=${String(s.n).padEnd(4)} median ×${s.medianRatio} · <br ${s.pctBelowRawBrotli}%`);
}
const worst = [...clean].sort((a, b) => b.svb / b.svgMin - a.svb / a.svgMin).slice(0, 5);
console.log('worst 5:', worst.map((w) => `${w.name} ×${(w.svb / w.svgMin).toFixed(2)}`).join(', '));
