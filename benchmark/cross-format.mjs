#!/usr/bin/env node
// Cross-format benchmark: same 12,100-block map encoded as
//   GeoJSON+brotli · Geobuf (±deflate) · MVT (±gzip) · SVB (±deflate) · SVG+brotli
// Same content, same visual. Geobuf/MVT are geodata-exchange formats — this
// compares byte efficiency on identical content, not feature parity.
import zlib from 'node:zlib';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import * as geobufns from 'geobuf';
const geobuf = geobufns.default ?? geobufns;
import Pbf from 'pbf';
import { optimize } from 'svgo';
import { encode } from '../src/encoder.js';
import { writeFileSync } from 'node:fs';

const br = (buf) => zlib.brotliCompressSync(buf);
const gz = (buf) => zlib.gzipSync(buf, { level: 9 });
const df = (buf) => zlib.deflateRawSync(buf, { level: 9 });

const side = 110, W = side * 60;
const P = ['#e8e4d8', '#d8d2c0', '#cfc9b8', '#e2ddd0'];

// GeoJSON: 12,100 building polygons + 222 street lines, normalized to [0,1]²
const features = [];
const mvtFeatures = [];
const K = 4096 / W; // escala a unidades MVT (extent 4096)
for (let i = 0; i < side * side; i++) {
  const x = (i % side) * 60, y = Math.floor(i / side) * 60;
  const w = 40 + (i % 3) * 4, h = 30 + ((i * 7) % 3) * 5;
  const ring = [
    [x * K, y * K], [(x + w) * K, y * K],
    [(x + w) * K, (y + h) * K], [x * K, (y + h) * K], [x * K, y * K],
  ];
  features.push({
    type: 'Feature',
    properties: { t: `f${i % 4}` },
    geometry: { type: 'Polygon', coordinates: [[
      [x / W, 1 - y / W], [(x + w) / W, 1 - y / W],
      [(x + w) / W, 1 - (y + h) / W], [x / W, 1 - (y + h) / W], [x / W, 1 - y / W],
    ]] },
  });
  mvtFeatures.push({ type: 3, geometry: [ring], tags: { t: `f${i % 4}` } });
}
for (let i = 0; i <= side; i++) {
  const u = i / side;
  features.push({ type: 'Feature', properties: { t: 'street' }, geometry: { type: 'LineString', coordinates: [[u, 0], [u, 1]] } });
  features.push({ type: 'Feature', properties: { t: 'street' }, geometry: { type: 'LineString', coordinates: [[0, u], [1, u]] } });
  mvtFeatures.push({ type: 2, geometry: [[[i * 60 * K, 0], [i * 60 * K, W * K]]], tags: { t: 'street' } });
  mvtFeatures.push({ type: 2, geometry: [[[0, i * 60 * K], [W * K, i * 60 * K]]], tags: { t: 'street' } });
}
const geojson = { type: 'FeatureCollection', features };

// --- Geobuf ---
const geojsonCompact = JSON.parse(JSON.stringify(geojson));
const geoBuf = Buffer.from(geobuf.encode(geojsonCompact, new Pbf()));

// --- MVT (geojson-vt -> vt-pbf), single tile z0 covering everything ---

const mvt = vtpbf.fromGeojsonVt({ map: { features: mvtFeatures } }, { extent: 4096, version: 2 });

// --- SVG baseline + svb (same visual content as benchmark/large.mjs) ---
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">`;
for (let i = 0; i < side * side; i++) {
  const x = (i % side) * 60, y = Math.floor(i / side) * 60;
  svg += `<path fill="${P[i % 4]}" d="M${x + 4} ${y + 4}h${40 + (i % 3) * 4}v${30 + ((i * 7) % 3) * 5}h-${38 + (i % 3) * 4}z"/>`;
}
for (let i = 0; i <= side; i++) {
  svg += `<path fill="none" stroke="#b8b2a0" stroke-width="3" d="M${i * 60} 0V${side * 60}"/>`;
  svg += `<path fill="none" stroke="#b8b2a0" stroke-width="3" d="M0 ${i * 60}H${side * 60}"/>`;
}
svg += '</svg>';
const svgOpt = optimize(svg, { multipass: true, plugins: ['preset-default'] }).data;
const svgBr = br(Buffer.from(svgOpt, 'utf8'));
const { bytes: svb } = encode(svgOpt, { deflate: df });
const svbBr = br(svb);

const fmt = (n) => String(Math.round(n)).padStart(10);
console.log('formato'.padEnd(24) + 'raw'.padStart(10) + '+deflate/gzip'.padStart(14) + '+brotli'.padStart(10));
console.log('Geobuf (precisión 6)'.padEnd(24) + fmt(geoBuf.length) + fmt(geoBuf.length) + fmt(br(geoBuf).length));
console.log('MVT z0 extent4096'.padEnd(24) + fmt(mvt.length) + fmt(gz(mvt).length) + fmt(br(mvt).length));
console.log('SVG plano + brotli'.padEnd(24) + fmt(svgOpt.length) + '—'.padStart(10) + fmt(svgBr.length));
console.log('SVB v0.2'.padEnd(24) + fmt(svb.length) + fmt(df(svb).length) + fmt(br(svb).length));
writeFileSync('/tmp/cross-map.geojson', JSON.stringify(geojson));
writeFileSync('/tmp/cross-map.mvt', mvt);
writeFileSync('/tmp/cross-map.geobuf', geoBuf);
