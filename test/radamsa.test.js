// Independent-mutator fuzzing: runs a small radamsa batch when the binary is
// available (CI has no radamsa — the full campaign is documented in
// SECURITY.md and reproducible via `npm run fuzz:radamsa`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from '../src/decoder.js';
import { validate } from '../src/validate.js';
import { MAX_DECOMPRESSED } from '../src/svb.js';
import zlib from 'node:zlib';

const INFLATE = (u8) => zlib.inflateRawSync(u8, { maxOutputLength: MAX_DECOMPRESSED });
const SEEDS = ['vectors/v01-icon.svb', 'vectors/v02-gradient.svb', 'vectors/v03-negative.svb', 'vectors/v04-template.svb'];

function hasRadamsa() {
  try { execFileSync('radamsa', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

test('radamsa: 300 mutants, contract holds (no hang possible in-process; no BAD output)', (t) => {
  if (!hasRadamsa()) return t.skip('radamsa not installed');
  const dir = mkdtempSync(join(tmpdir(), 'svb-radamsa-'));
  try {
    execFileSync('radamsa', [...SEEDS, '-n', '300', '-o', join(dir, 'm-%n.svb'), '--seed', '42'], { stdio: 'pipe' });
    let decoded = 0, rejected = 0;
    for (const f of readdirSync(dir).sort()) {
      const bytes = readFileSync(join(dir, f));
      let svg;
      try {
        ({ svg } = decode(bytes, { inflate: INFLATE }));
      } catch {
        rejected++;
        continue;
      }
      decoded++;
      assert.ok(svg.includes('<svg'), `${f}: decoded output without <svg`);
      assert.ok(!svg.includes('NaN') && !svg.includes('Infinity') && !svg.includes('//>'), `${f}: malformed decoded output`);
      assert.doesNotThrow(() => validate(bytes, { inflate: INFLATE }), `${f}: validator threw`);
    }
    assert.ok(rejected + decoded === 300, 'every mutant must be classified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
