# Contributing

Thanks for wanting to help.

## Reporting bugs & ideas

Open an issue — for bugs, include what you did, what happened, and the file or command that reproduces it. If you can attach the offending `.svg` or `.svb` (or a minimal version of it), even better.

Hostile and crashing files are especially welcome. SVB is designed to fail closed: a malformed file must be rejected cleanly, never crash, hang, or emit broken output. Every input that gets past that contract becomes a regression test.

Feature ideas are very welcome too — real-world needs decide the roadmap. If your SVG didn't survive the round trip, that's exactly the report we want: which elements were dropped (the encoder lists them as warnings) and what they looked like.

## A note on code

Development follows a model-before-code process: the format's formal model and invariants (DESIGN.md) are written and reviewed before any implementation, and the current release is frozen for stability. Pull requests with new features will likely be declined for now — an issue describing the problem is the right way to plant the seed.

That said, small fixes are different: crash bugs, spec typos, and doc corrections are always in scope.

## Security

Found a way to crash, hang, or confuse the decoder? Please use GitHub's *Report a vulnerability* (Security tab) instead of a public issue. Known hardening history is documented in SPEC §12.

## Environment

Node ≥ 18, zero runtime dependencies.

```
node --test test/*.test.js   # run the test suite
node src/cli.js encode in.svg out.svb
```

Benchmarks under `benchmark/` are reproducible with fixed seeds — if you report a performance claim, include the command and seed you used.
