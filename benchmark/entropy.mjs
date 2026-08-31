#!/usr/bin/env node
// Entropy/statistical model of the SVB delta source, measured on the real corpus.
// Produces the empirical PDFs and Shannon bounds that docs/entropy-model.md cites.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { optimize } from 'svgo';
import { parsePathData } from '../src/path.js';

const scale = 64;
const sources = [
  ['feather', 'node_modules/feather-icons/dist/icons'],
  ['bootstrap', 'node_modules/bootstrap-icons/icons'],
  ['simpleicons', 'node_modules/simple-icons/icons'],
];

const deltaX = [], deltaY = [], cmds = [], firsts = [];
const perFile = [];
let files = 0;

for (const [name, dir] of sources) {
  for (const f of readdirSync(dir).sort().filter((x) => x.endsWith('.svg'))) {
    try {
      const opt = optimize(readFileSync(`${dir}/${f}`, 'utf8'), { multipass: true, plugins: ['preset-default'] }).data;
      let pts = 0, dxs = [], dys = [], cs = [];
      for (const m of opt.matchAll(/ d="([^"]+)"/g)) {
        let segs;
        try { segs = parsePathData(m[1]); } catch { continue; }
        let first = true, penX = 0, penY = 0, sx = 0, sy = 0;
        for (const seg of segs) {
          const id = { M: 0, L: 1, C: 2, Q: 3, A: 4, Z: 5 }[seg.cmd];
          cs.push(id);
          if (seg.cmd === 'Z') { penX = sx; penY = sy; continue; }
          for (const [x, y] of seg.pts) {
            const qx = Math.round(x * scale), qy = Math.round(y * scale);
            if (first) { dxs.push(qx); dys.push(qy); first = false; }
            else { dxs.push(qx - penX); dys.push(qy - penY); }
            pts++;
            penX = qx; penY = qy;
          }
          if (seg.cmd === 'M') { sx = penX; sy = penY; }
        }
      }
      if (pts > 0) { files++; dxs.forEach((v) => deltaX.push(v)); dys.forEach((v) => deltaY.push(v)); cs.forEach((c) => cmds.push(c)); perFile.push({ file: f, points: pts }); }
    } catch {}
  }
}

// empirical entropy of a value alphabet
function entropy(values) {
  const freq = new Map();
  for (const v of values) freq.set(v, (freq.get(v) || 0) + 1);
  let H = 0;
  for (const c of freq.values()) {
    const p = c / values.length;
    H -= p * Math.log2(p);
  }
  return { H, alphabet: freq.size };
}

const ex = entropy(deltaX), ey = entropy(deltaY);
// joint (x,y) pair entropy: the honest bound when coding both axes together
const joint = deltaX.map((v, i) => `${v}_${deltaY[i]}`);
const ej = entropy(joint);

// distribution buckets of |dx| (the PDF table)
const absX = deltaX.map(Math.abs).sort((a, b) => a - b);
const buckets = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, Infinity];
const dist = buckets.slice(0, -1).map((b, i) => {
  const lo = b, hi = buckets[i + 1];
  const n = absX.filter((v) => v >= lo && v < hi).length;
  return [`|${lo}${hi === Infinity ? '+' : `–${hi - 1}`}|`, n, (100 * n / absX.length).toFixed(1) + '%'];
});
dist.push([`|≥256|`, absX.filter((v) => v >= 256).length, (100 * absX.filter((v) => v >= 256).length / absX.length).toFixed(1) + '%']);

const totPoints = deltaX.length;
const H_joint_bits = ej.H;
const H_sep_bits = ex.H + ey.H;

writeFileSync('/tmp/entropy-results.json', JSON.stringify({
  files, totPoints,
  deltaX: { n: deltaX.length, H: ex.H, alphabet: ex.alphabet },
  deltaY: { n: deltaY.length, H: ey.H, alphabet: ey.alphabet },
  joint: { H: ej.H, alphabet: ej.alphabet },
  cmds: { n: cmds.length, H: entropy(cmds).H },
  absX: { n: absX.length, H: entropy(absX).H },
  dist,
  perFile,
}, null, 1));

console.log('archivos:', files, '· puntos (deltas):', totPoints);
console.log('H(varint x) =', ex.H.toFixed(2), 'bits · H(y) =', ey.H.toFixed(2), 'bits');
console.log('H conjunta (x,y) =', ej.H.toFixed(2), 'bits/par · alfabeto conjunto:', ej.alphabet, 'valores distintos');
console.log('H(cmd) =', entropy(cmds).H.toFixed(2), 'bits/comando');
console.log('límite Shannon por punto (x,y):', (ej.H).toFixed(2), 'bits ≈', (ej.H / 8).toFixed(2), 'bytes/punto');
console.log('|dx|=0 (repetición exacta de coordenada):', (100 * deltaX.filter((v) => v === 0).length / deltaX.length).toFixed(1) + '%');
console.log('PDF |dx| por bucket:');
for (const [b, n, p] of dist) console.log('  ', b.padEnd(10), String(n).padStart(8), p + '%');
