# Test vectors

Golden `.svb` files for conformance testing, generated deterministically with
`svb-cli/0.2.1` (encode is byte-stable: fixed scale 64, deflate level 9, no
timestamps). Each entry pairs a source `.svg` (in `src/`) with its binary
output. If your implementation produces different bytes for the same input,
either your encoder diverges from the spec or these vectors do — either way,
that's an issue worth opening.

| file | covers | sha256 | bytes |
|------|--------|--------|-------|
| v01-icon.svb | basic paths, A11Y title+desc, multiple styles | `a9ad409a…cbd7e94` | 120 |
| v02-gradient.svb | GRAD chunk, style gradient reference, HAS_GRAD flag | `8e2726b5…f3fc36` | 59 |
| v03-negative.svb | negative canvas origin + zigzag varint coordinates | `905e046d…0b29241` | 78 |
| v04-template.svb | DEF chunk, translation-only instances (delta chain) | `92018e85…b29241` | 78 |

Regenerate with:

```
node src/cli.js encode vectors/src vectors --strict
shasum -a 256 vectors/*.svb
```

`test/vectors.test.js` enforces byte-exactness, clean validation verdicts, and
round-trip fidelity for every vector above.
