// warn-all: nothing is dropped silently (see test ladder in svb-test-0a100)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../src/encoder.js';

const enc = (svg) => encode(svg).warnings;
const WRAP = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;

test('warn-all: CSS <style> is reported, not silently dropped', () => {
  const w = enc(WRAP('<style>rect{fill:red}</style><rect width="5" height="5"/>'));
  assert.ok(w.some((x) => x.includes('<style>')), w.join(' | '));
});

test('warn-all: <script> is reported as dropped executable content', () => {
  const w = enc(WRAP('<script>alert(1)</script><rect width="5" height="5"/>'));
  assert.ok(w.some((x) => x.includes('<script>')), w.join(' | '));
});

test('warn-all: clipPath/mask/filter defs are reported', () => {
  for (const def of ['<clipPath id="c"><circle r="3"/></clipPath>', '<mask id="m"><rect width="5" height="5"/></mask>', '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter>']) {
    const w = enc(WRAP(`<defs>${def}</defs><rect width="5" height="5"/>`));
    assert.ok(w.length > 0, `no warning for ${def}`);
  }
});

test('warn-all: mask/clip/filter attributes on containers are reported', () => {
  const w = enc(WRAP('<g mask="url(#m)"><rect width="5" height="5"/></g>'));
  assert.ok(w.some((x) => x.includes('mask/clip/filter')), w.join(' | '));
});

test('warn-all: <symbol> and <use> are reported', () => {
  const w = enc(WRAP('<symbol id="s"><rect width="5" height="5"/></symbol><use href="#s"/>'));
  assert.ok(w.some((x) => x.includes('<symbol>')), w.join(' | '));
  assert.ok(w.some((x) => x.includes('<use>')), w.join(' | '));
});

test('warn-all: gradients and defs stay silent (they are carried, not dropped)', () => {
  const w = enc(WRAP('<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="5" height="5" fill="url(#g)"/>'));
  assert.deepEqual(w, []);
});
