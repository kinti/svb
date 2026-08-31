# SVB — Statistical source model and entropy bounds

**Status**: modeling document, produced before any v0.3 code, per process rule §6 of DESIGN.md ("model before code"). This is the artifact the external gate reviews.
**Data**: 5,822 production SVGs (Feather 287 + Bootstrap Icons 400-class sets + Simple Icons, svgo-optimized), parsed to the canonical quantized delta representation of SPEC v0.2 (scale 64). Script: `benchmark/entropy.mjs` — fully reproducible.

---

## 1. The source model

A vector image is modeled as a discrete stochastic source emitting, per drawing operation:

```
S = (cmd, Δx, Δy)        cmd ∈ {M, L, C, Q, A, Z},  (Δx, Δy) ∈ Varint²
```

plus a start-of-path symbol (absolute quantized point) and side streams (styles, dashes). The distortion model: coordinates are quantized to `1/coord_scale` (k = 64), bounding per-coordinate error by 1/128 user unit — any format meeting this distortion bound is modeling the same source.

**Measured source statistics** (5,813 files, 486,933 deltas, 100% parse):

| component | entropy | notes |
|---|---|---|
| Δx (varint alphabet) | H = 7.80 bits/value | 84,967 distinct values |
| Δy (varint alphabet) | H = 7.63 bits/value | |
| (Δx, Δy) **joint** | H = **14.03 bits/pair** | 102,192 distinct pairs |
| command id | H = 2.23 bits/command | |
| P(Δ = 0) | 15.9% | exact coordinate repetition |

**Empirical PDF of |Δx|** (discrete Laplacian-like decay — the shape that justifies varint + zigzag as a near-matched code):

| \|Δx\| (fixed units) | count | share |
|---|---|---|
| 0 | 77,595 | 15.9% |
| 1 | 17,111 | 3.5% |
| 2–3 | 25,891 | 5.3% |
| 4–7 | 37,794 | 7.8% |
| 8–15 | 53,564 | 11.0% |
| 16–31 | 65,649 | 13.5% |
| 32–63 | 69,911 | 14.4% |
| 64–127 | 55,393 | 11.4% |
| 128–255 | 38,707 | 7.9% |
| ≥256 | 45,318 | 9.3% |

The distribution decays monotonically and is dominated by small magnitudes (72% of deltas ≤ 63 fixed units). This is precisely the source shape that zigzag-varint codes efficiently, and why the format's empirical ratio is stable across corpora.

## 2. Shannon lower bound (the "límite inferior")

By the source coding theorem, any lossless code for a discrete source pays at least its entropy. Applied to SVB's model:

- Per point (Δx, Δy): H(Δx, Δy) = **14.03 bits = 1.75 B/point** (joint coding; separate coding costs H(Δx) + H(Δy) = 15.43 — the 1.4-bit gap is the measured x/y correlation).
- Per command: H(cmd) = 2.23 bits.
- **Floor for a format with this source model and distortion bound: ≈ 14.03 + 2.23·(commands/point) bits per point.**

This bound is empirical (estimated from 486,933 real deltas), not an analytic proof of source optimality — but it is the information-theoretic lower bound *given the measured statistics*, and it is reproducible from the corpus with `benchmark/entropy.mjs`. No implementation — SVB, EXI, or any future coder — can encode this source losslessly below it without changing the source model (e.g., curve fitting, which changes the distortion bound and is therefore a different model).

## 3. Measured rate vs the bound — the honest gap

| coder | measured rate | vs floor |
|---|---|---|
| svb raw (v0.2, icons corpus) | ~25.5 bits/point | 1.6× the floor |
| svb + brotli | ~23 bits/point effective | 1.45× |
| **entropy stage ceiling (order-0 value coding)** | ≥ 18 bits/point (14.03 + cmd + style/instance share) | gap to floor ≈ 37% max |

Conclusions, quantified:

1. **Rung-4 (entropy stage) maximum gain is bounded at ~37%**, and realistically less (byte alignment, per-value model mismatch). It is a bounded optimization, not a transformation.
2. **On the organic no-repetition class**, svb already sits at its own order-0 floor: no entropy stage can improve it. Only a *source-model* change (curve fitting / adaptive quantization — a different distortion model) can. This is why v0.3's organic item is geometry modeling, not compression.
3. **On the synthetic repetitive map**, the source entropy is genuinely tiny (3 distinct shapes + a grid): the measured 1,438 B delivery is close to that source's bound. As a production proxy the source is degenerate (3 variants, regular grid — stated since the first publication of the benchmark); as a codec demonstration it is valid: the size reflects the true information content of the source.

## 4. What this model means for the roadmap (process)

- The entropy model now **precedes** any v0.3 implementation (rule #1). The v0.3 priorities re-derive from it: the geometry-modeling item outranks the entropy stage for the only class where the gap is structural (organic), because the bound says entropy alone cannot close it.
- The gate reviews this document. Implementation of anything in it starts only after the model is validated.
- No product code was changed to produce this document.
