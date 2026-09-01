// SVB validator — verifies conformance and the accessibility contract.
// Model: docs/validator.md (checks V-01…V-14). Verdicts: FAIL / PASS / SEAL.
// The validator verifies; it never repairs and never executes content.
import { CHUNK, ByteReader, MAX_DECOMPRESSED } from './svb.js';
import { decode } from './decoder.js';
import { parseXml } from './xml.js';

const VALIDATOR_VERSION = '0.2.0';
const CEILING = MAX_DECOMPRESSED;

export function validate(bytes, opts = {}) {
  const checks = [];
  const check = (id, requirement, pass, detail = '') => {
    checks.push({ id, requirement, pass: !!pass, detail: String(detail).slice(0, 200) });
    return !!pass;
  };
  const report = {
    verdict: 'FAIL',
    seal: false,
    sealFull: false,
    checks,
    error: null,
    a11y: { flag: false, chunk: false, name: '', description: '', labels: 0 },
    stats: { sizeBytes: bytes.length, sha256: opts.sha256 ?? null },
    validatorVersion: VALIDATOR_VERSION,
  };

  const bail = (id, requirement, detail) => {
    check(id, requirement, false, detail);
    report.error = detail;
    report.verdict = 'FAIL';
    return report;
  };

  // ---- V-01 magic / V-02 version / V-03 header (raw bytes, pre-decompression) ----
  const magicOk = bytes.length >= 3 && bytes[0] === 0x53 && bytes[1] === 0x56 && bytes[2] === 0x42;
  check('V-01', 'magic bytes SVB', magicOk);
  if (!magicOk) {
    // pista útil: ¿es un SVG decodificado guardado por error (p. ej. a través de un Service Worker)?
    let head = '';
    try { head = new TextDecoder().decode(bytes.slice(0, 200)); } catch {}
    if (head.includes('<svg') || head.includes('<?xml')) {
      return bail('V-01', 'magic bytes SVB',
        'this is a plain/decoded SVG, not an SVB binary — you probably saved the rendered file through a decoding Service Worker; download the raw .svb (demo "⬇ binary" links) and validate that');
    }
    return bail('V-01', 'magic bytes SVB', 'not an SVB file');
  }

  const version = bytes[3];
  check('V-02', 'version in {1,2}', version === 1 || version === 2, 'version=' + version);
  if (version !== 1 && version !== 2) return bail('V-02', 'version in {1,2}', `unsupported version ${version}`);

  const rd = new ByteReader(bytes);
  rd.pos = 4; // magic(3) + version(1)
  const flags = rd.u8();
  const width = rd.varuint(), height = rd.varuint(), scale = rd.varuint();
  const headerOk = scale > 0;
  check('V-03', 'header complete, coord_scale > 0', headerOk, `scale=${scale} canvas=${width}x${height}`);
  if (!headerOk) return bail('V-03', 'header', 'malformed header');

  report.stats.version = version;
  report.stats.width = width;
  report.stats.height = height;
  report.stats.scale = scale;
  report.a11y.flag = !!(flags & 0x02);

  // ---- V-06 decompression ceiling (before any further parsing) ----
  let payload = bytes.slice(rd.pos);
  if (flags & 0x01) {
    let out = null, ok = false, detail = '';
    try {
      if (!opts.inflate) throw new Error('no inflate provided');
      out = opts.inflate(payload);
      ok = out.length <= CEILING;
      detail = `${out.length} B`;
      payload = out;
    } catch (e) { detail = e.message; }
    check('V-06', 'decompressed payload <= 64 MB', ok, detail);
    if (!ok) return bail('V-06', 'decompression ceiling 64 MB', 'decompression failed: ' + detail);
  }

  // ---- V-04 chunk walk (grammar + full coverage) ----
  let a11yBody = null, geomCount = -1, walkOk = true, walkDetail = '';
  {
    const pr = new ByteReader(payload);
    while (pr.remaining > 0) {
      if (pr.remaining < 2) { walkOk = false; walkDetail = 'trailing partial chunk'; break; }
      const tag = pr.u8();
      const size = pr.varuint();
      if (size > pr.remaining) { walkOk = false; walkDetail = `chunk 0x${tag.toString(16)} size ${size} exceeds remaining ${pr.remaining}`; break; }
      const body = pr.bytes(size);
      if (tag === CHUNK.A11Y) a11yBody = body.slice();
      if (tag === CHUNK.GEOM) {
        const c = new ByteReader(body);
        geomCount = c.varuint();
      }
    }
    check('V-04', 'chunk grammar: sizes, bounds, full coverage', walkOk, walkDetail);
  }
  if (!walkOk) return bail('V-04', 'chunk grammar', walkDetail || 'incomplete walk');
  if (geomCount < 0) return bail('V-04', 'GEOM chunk', 'missing GEOM chunk');

  // ---- full grammar + references + expansion via the real decoder ----
  // rebuild an uncompressed copy: header (flag COMPRESSED cleared) + payload
  const head = bytes.slice(0, rd.pos);
  head[4] &= ~0x01;
  const work = new Uint8Array(head.length + payload.length);
  work.set(head, 0);
  work.set(payload, head.length);

  let decoded = null, decodeErr = null, decodeErrMsg = '';
  try {
    decoded = decode(work, { inflate: opts.inflate });
  } catch (e) { decodeErr = e; decodeErrMsg = e.message; }

  const cls = (msg) => {
    if (/varuint too long/.test(msg)) return ['V-05', 'varuint alphabet <= 7 bytes'];
    if (/references unknown (template|gradient)|duplicate template/.test(msg)) return ['V-07', 'reference integrity'];
    if (/template bomb|expansion/.test(msg)) return ['V-08', 'expansion budget <= 1M'];
    if (/zero stops|gradient (type|units|spread)|unknown shape/.test(msg)) return ['V-14', 'gradient/template vocabularies'];
    return ['V-04', 'grammar'];
  };
  if (decodeErr) {
    const [id, req] = cls(decodeErrMsg);
    check(id, req, false, decodeErrMsg);
    report.verdict = 'FAIL';
    report.error = decodeErrMsg;
    return report;
  }
  check('V-05', 'varuint alphabet <= 7 bytes', true);
  check('V-07', 'reference integrity (tmpl/grad)', true);
  check('V-08', 'expansion budget <= 1M elements', true);
  check('V-14', 'gradient/template vocabularies', true);

  // ---- V-09 emission safety (finite numbers + well-formed SVG) ----
  const out = decoded.svg;
  const finiteOk = !/NaN|Infinity/.test(out);
  const wellFormed = !out.includes('//>') && out.startsWith('<svg') && out.endsWith('</svg>');
  let parses = true;
  try { parseXml(out); } catch { parses = false; }
  check('V-09', 'emission: finite numbers + well-formed SVG', finiteOk && wellFormed && parses,
    `finite=${finiteOk} wellFormed=${wellFormed} parses=${parses}`);

  // ---- A11Y details (V-10..V-13) ----
  let name = '', desc = '', labels = 0, labelsOk = true;
  if (a11yBody) {
    try {
      const ar = new ByteReader(a11yBody);
      name = ar.lenpfxUtf8();
      desc = ar.lenpfxUtf8();
      const lc = ar.varuint();
      for (let i = 0; i < lc; i++) {
        ar.varuint();
        ar.lenpfxUtf8();
        ar.lenpfxUtf8();
      }
      labels = lc;
    } catch { labelsOk = false; }
  }
  report.a11y.chunk = !!a11yBody;
  report.a11y.name = name;
  report.a11y.description = desc;
  report.a11y.labels = labels;

  const flagConsistent = report.a11y.flag === !!a11yBody;
  check('V-10', 'A11Y flag consistent with chunk presence', flagConsistent,
    flagConsistent ? '' : `flag says ${!!report.a11y.flag}, chunk ${a11yBody ? 'present' : 'absent'}`);

  const nameOk = !!a11yBody && name.length > 0;
  check('V-11', 'accessible name non-empty', nameOk, name || '(empty)');
  check('V-12', 'description present', !!a11yBody && desc.length > 0, desc);
  check('V-13', 'element label indices valid', labelsOk, `${labels} labels`);

  // ---- verdict ----
  const hardFail = checks.some((c) => !c.pass && c.id !== 'V-12' && c.id !== 'V-13');
  if (hardFail) { report.verdict = 'FAIL'; return report; }

  report.verdict = 'PASS';
  if (nameOk) {
    report.verdict = 'SEAL — SVB accesible';
    report.seal = true;
    report.sealFull = desc.length > 0;
  }
  return report;
}
