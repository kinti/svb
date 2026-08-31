# SVB validator — verification model and seal

**Status**: model v1 (checks defined before implementation, per process rule) · applies to SPEC v0.2 files (versions 1 and 2)
**CLI**: `node src/cli.js validate in.svb [--json]`

---

## 1. Verdicts

| verdict | meaning |
|---|---|
| `FAIL` | the file violates a normative requirement — not a valid/conformant SVB |
| `PASS` | conformant file; accessibility chunk absent or empty |
| `SEAL — SVB accesible` | conformant **and** the accessibility contract is met (see §3) |

The validator verifies. It never repairs, never executes content, and never renders.

## 2. Checks

Each check maps to a SPEC requirement. Hard checks (V-01…V-10) gate the verdict; accessibility checks (V-11…V-14) qualify it.

| id | requirement (SPEC ref) | hard |
|---|---|---|
| V-01 | magic bytes `SVB` | yes (§3) |
| V-02 | version ∈ {1, 2} | yes (§3) |
| V-03 | header complete; coord_scale > 0 | yes (§3) |
| V-04 | chunk grammar: tag/size/body, no overrun, no trailing garbage, declared counts ≤ remaining | yes (§4, §12/INV-2) |
| V-05 | varuint alphabet ≤ 7 bytes (49 bits) | yes (§2/INV-3) |
| V-06 | decompressed payload ≤ 64 MB | yes (§12/INV-5) |
| V-07 | reference integrity: every tmpl-id and gradient index resolves | yes (INV-13/15) |
| V-08 | template expansion ≤ 1M elements | yes (INV-14) |
| V-09 | emitted SVG: finite numbers, well-formed markup, no double-closed tags | yes (INV-7/8) |
| V-10 | A11Y flag ↔ A11Y chunk consistency | yes (§3/§7) |
| V-11 | accessible name present and non-empty | seal base (§7) |
| V-12 | description present | seal quality (§7) |
| V-13 | element labels reference valid element indices | yes (§7) |
| V-14 | gradient/template vocabularies within v0.2 (type, units, spread) | yes (§4.1/4.2) |

## 3. The accessibility seal

`SEAL — SVB accesible` requires: PASS on all hard checks + V-11 (accessible name) + V-10. The description (V-12) is reported as an upgrade line (`seal+desc`) because the format can require it even when a given file omits it.

The seal is a property of the **file**, citable in audits: validators emit the SHA-256 of the file, the validator version, and the date, so a certificate is reproducible by re-running the check.

## 4. Output

Human-readable by default; `--json` for machine consumption (the a11y-toolkit MCP tool wraps exactly this):

```json
{
  "verdict": "SEAL — SVB accesible",
  "seal": true,
  "sealFull": false,
  "checks": [ { "id": "V-01", "pass": true } ],
  "a11y": { "flag": true, "name": "Map pin", "description": "", "labels": 0 },
  "stats": { "sizeBytes": 97, "sha256": "…", "elements": 3, "templates": 0, "gradients": 0 },
  "validatorVersion": "0.2.0"
}
```

Exit codes: `0` pass/seal · `1` fail · `2` not an SVB file.

## 5. Fuzzing (complementary robustness evidence)

`src/fuzz.js` mutates valid files (bit flips, truncations, chunk splices, header corruption) with a fixed seed and asserts the decoder contract: **every case either decodes to well-formed SVG or throws a classified error — never a hang, never NaN/Infinity output, never OOM**. Results are recorded in the validator report and re-runnable with a fixed seed.
