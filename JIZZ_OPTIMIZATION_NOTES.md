# Jizz JIT optimization follow-up

This note records the remaining Jizz optimization opportunities and the browser regression
caused by broad x87 inlining. It is a hand-off for future work, not a claim that every
theoretical optimization has been exhausted.

## Current measured state

Jizz has 22 XM orders. Each can be restored from an exact cold order-start checkpoint, so
visual phases can be benchmarked without replaying the intro up to that point:

```sh
npm run bench:jizz -- \
  --engine both \
  --orders 0-21 \
  --csv out/bench/jizz-orders.csv
```

The final one-run sweep covered 21,270,723,531 instructions:

- CPU: 39.6 MIPS
- JIT: 72.9 MIPS
- Overall speedup: 1.84x
- Slow clusters: orders 9-10 and 17-20
- Fast controls: orders 0, 8 and 12
- Browser-sensitive rasterizer controls: orders 1 and 2

The retained order-guided changes are deliberately narrow:

- `FXCH ST(i)` is emitted directly.
- Near indirect memory call and jump (`FF /2` and `FF /4`) are emitted as terminal
  transfers instead of crossing into the interpreter.

On order 18 these reduce callouts from 32.1 million to 9.1 million and raise template
coverage from 97.78% to 99.37%. In repeated focused runs, order 18 rose from 44.6 to
45.7 MIPS. The full sweep shows smaller but consistent gains across both slow clusters;
fast orders remain within normal run-to-run variation.

## Remaining measured opportunities

This is the post-change order-18 callout census. Counts come from a diagnostic run and
should be used for attribution only: `IXA_JIT_STATS=1` adds counters and perturbs timing.

| Form | Operation | Calls/order | Assessment |
|---|---|---:|---|
| `d9.fa` | `FSQRT` | 2,537,537 | Expensive `Math.sqrt`; dispatch may be a small part of its cost |
| `d9.e8` | `FLD1` | 2,176,997 | Cheap candidate, but test separately |
| `dd.c0` | `FFREE ST(0)` | 1,719,491 | Cheap candidate, but mutates FPU tag state |
| `d9.ee` | `FLDZ` | 1,087,230 | Cheap candidate, but test separately |
| `f7.r7` | signed integer divide | 377,989 | Complex fault and overflow semantics; higher correctness risk |
| `dd.dc` | `FSTP ST(4)` | 362,409 | Cheap candidate with stack-pop ordering requirements |
| `dd.c1` | `FFREE ST(1)` | 310,924 | Same experiment family as `dd.c0` |
| `87.r7/r3/r1` | general register `XCHG` | 537,376 total | Already tested; gain was within noise, so it was removed |
| `d9.fe` | `FSIN` | 3,344 | Too rare to justify changing hot generated functions |
| `d9.ff` | `FCOS` | 2,128 | Too rare to justify changing hot generated functions |

Recommended future order is:

1. Test `FFREE` alone.
2. Test `FLD1` alone.
3. Test `FLDZ` alone.
4. Test `FSTP ST(i)` alone.
5. Treat `FSQRT` as a separate browser experiment.
6. Attempt integer divide only with dedicated divide-by-zero and overflow differential
   probes.

Do not combine these into one patch. General `XCHG` already failed the measurable-benefit
gate, and `FSIN`/`FCOS` are too rare to be useful targets.

To obtain the exact uncovered forms for one order:

```sh
IXA_JIT_STATS=1 npm run bench:jizz -- \
  --engine jit \
  --orders 18
```

The form suffix is the x87 raw byte (`d9.fa`) or the ModRM location and `/reg` field
(`ff.m2`, `f7.r7`).

## The broad-x87 browser regression

An earlier experiment inlined all of the following as one stage:

- `FXCH` (`D9 C8-CF`)
- x87 constants (`D9 E8-EE`)
- unary operations including sign, absolute value, square root, sine and cosine
- `FFREE`, register `FST`, and register `FSTP` (`DD C0-DF`)

That bundle was neutral to slightly positive in some Node measurements, but it made the 3D
sections substantially slower in both Chrome and Safari. Removing only that stage restored
browser performance.

The exact browser-compiler mechanism was not proven with engine-internal traces. The most
plausible explanation is that the bundle made generated rasterizer functions less attractive
to the browser's optimizing tier. It mixed integer register/flag code with FPU object state,
typed-array accesses and `Math.*` intrinsics. That can increase compiler IR size, guards,
register pressure, deoptimization state and generated machine-code size. Optimizer decisions
have thresholds, so eliminating a JavaScript call can still make the containing function
slower as a whole.

The former `fpu.execute()` callout also acted as an optimization boundary: its per-instruction
dispatch cost was real, but it kept the surrounding generated integer block compact. Browser
execution amplifies tiering and pause effects because the worker runs in short slices and has
real-time frame/audio deadlines.

This is a plausible explanation, not a license to assume that every x87 template is harmful.
The selective `FXCH` experiment improved the slow orders without reproducing the broad bundle.
The lesson is to test one form at a time and let browser results overrule aggregate Node
throughput.

## Acceptance procedure for future Jizz work

For each candidate:

1. Run a three-repeat cold benchmark on the target order and record the unmodified baseline.
2. Add only one exact form.
3. Repeat the target benchmark; remove the change if the difference is within noise.
4. Run `--engine both` on the target so CPU/JIT instruction counts, frame counts and final
   architectural fingerprints must match.
5. Recheck orders 1 and 2 as browser-sensitive rasterizer canaries.
6. Generate a full `0-21` CSV only after the focused experiment passes.
7. Hard-refresh and test the 3D sections in both Chrome and Safari.
8. Keep the interpreter callout as the fallback for every unmeasured or rejected form.

Never use an `IXA_JIT_STATS=1` run as the performance number; the counters are intentionally
off in production because collecting them changes the hot path.

