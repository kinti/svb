#!/usr/bin/env node
// Radamsa campaign orchestrator: mutation fuzzing with an INDEPENDENT mutator
// (src/fuzz.js is our deterministic one; radamsa knows nothing about SVB).
// Batches run in worker subprocesses with a timeout so a hanging mutant is
// detected as HANG instead of killing the whole campaign.
//
//   radamsa <seeds...> -n <count> -o <dir>/m-%n.svb --seed <seed>
//   node benchmark/radamsa.mjs <mutant-dir> [--batch 500] [--timeout-ms 60000]

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2];
if (!dir) { console.error('usage: node benchmark/radamsa.mjs <mutant-dir>'); process.exit(1); }
const BATCH = Number(process.argv[process.argv.indexOf('--batch') + 1] ?? 500);
const TIMEOUT = Number(process.argv[process.argv.indexOf('--timeout-ms') + 1] ?? 60000);

const worker = join(fileURLToPath(new URL('.', import.meta.url)), 'radamsa-worker.mjs');
const files = readdirSync(dir).sort();
const tally = { rejected: 0, decoded: 0, validatorFail: 0, bad: 0, hang: 0 };
const badExamples = [];
const hangExamples = [];

for (let i = 0; i < files.length; i += BATCH) {
  const batch = files.slice(i, i + BATCH);
  const res = spawnSync(process.execPath, [worker, dir, ...batch], { timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 && !res.stdout?.length) {
    // worker died or timed out before reporting anything — attribute to first file conservatively
    tally.hang += batch.length;
    hangExamples.push(`batch ${i / BATCH} (first: ${batch[0]}) — signal ${res.signal ?? res.status}`);
    continue;
  }
  for (const line of res.stdout.toString().trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.outcome === 'rejected') tally.rejected++;
    else if (r.outcome === 'decoded') tally.decoded++;
    else if (r.outcome === 'validator-fail') tally.validatorFail++;
    else {
      tally.bad++;
      if (badExamples.length < 10) badExamples.push(`${r.file}: ${r.detail}`);
    }
  }
  const done = Math.min(i + BATCH, files.length);
  process.stdout.write(`\r${done}/${files.length}`);
}
console.log('');

console.log(`\nradamsa campaign — ${files.length} mutants`);
console.log(`  rejected cleanly : ${tally.rejected}`);
console.log(`  decoded ok       : ${tally.decoded}`);
console.log(`  validator FAIL   : ${tally.validatorFail} (verdict, not a crash)`);
console.log(`  BAD (contract)   : ${tally.bad}`);
console.log(`  HANG/CRASH       : ${tally.hang}`);
if (badExamples.length) console.log('  bad examples:\n    ' + badExamples.join('\n    '));
if (hangExamples.length) console.log('  hang examples:\n    ' + hangExamples.join('\n    '));
process.exitCode = tally.bad || tally.hang ? 1 : 0;
