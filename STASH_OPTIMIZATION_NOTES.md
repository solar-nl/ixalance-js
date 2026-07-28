# Stash row-window profiling and generated-code invalidation

Stash uses two generated XM modules and does not fit Jizz's one-order-per-visual-phase
assumption. The first module is untitled, has 11 orders and normally uses tracker speed 24.
The second is `BLUISH`, has 7 orders and starts at speed 12. Whole 64-row order timings
average several distinct visual workloads together.

## Reproducible phase selection

The benchmark now identifies a phase by `(music, order, row)`. It follows actual XM
playback, including pattern breaks, speed changes, the handoff to the second XM and the
final program halt. It never invents checkpoints for unreachable rows.

The full Stash sweeps use 16-row windows for XM 1 and 32-row windows for XM 2:

```sh
npm run bench:stash -- \
  --music 1 \
  --row-step 16 \
  --engine jit \
  --csv out/bench/stash-xm1-rows.csv

npm run bench:stash -- \
  --music 2 \
  --row-step 32 \
  --engine jit \
  --csv out/bench/stash-xm2-rows.csv
```

A single sub-order can be rerun from its exact cold snapshot:

```sh
npm run bench:stash -- \
  --music 1 \
  --orders 9 \
  --row-step 16 \
  --rows 32 \
  --engine jit
```

Stash's first XM reaches the second `TBL1` call during order 10 row 25. `BLUISH` is cached
as a separate music-start checkpoint, so its order and row numbers cannot collide with the
first module. Early `D00` pattern breaks produce shortened final windows. The last `BLUISH`
window ends at order 6 row 20 when the part returns to the host.

## Baseline diagnosis

The original cold-JIT sweeps measured:

| Soundtrack | Windows | Instructions | Aggregate JIT |
|---|---:|---:|---:|
| XM 1 | 32 | 54,036,250,930 | 49.53 MIPS |
| XM 2 (`BLUISH`) | 12 | 21,232,513,295 | 32.69 MIPS |

The worst XM 1 phase was order 9 rows 32–48 at 30.2 MIPS. The worst XM 2 phases were
order 3's two halves at about 24.3 MIPS.

Exact-form profiles showed that these blocks were already 99.2–99.7% templated. A fast XM 2
control even executed millions of x87 callouts while sustaining more than 200 MIPS. Missing
x87 templates therefore did not explain the large difference.

The distinguishing counter was byte-identical JIT revalidation. XM 2 order 3 rows 32–64
performed 65.3 million revalidations, versus 0.39 million in the fast order-4 control.
Stash's generated rasterizers patch code densely. The cache used one generation counter per
4 KiB, so changing one code address invalidated unrelated decoded and compiled blocks
elsewhere in that span. The JIT recovered the existing generated function after comparing
its bytes, but the inherited block cache had already decoded the block again.

## Retained optimization

The block-cache generation span is now 256 bytes. The maximum decoded block is capped at
224 bytes; even after its final instruction it is shorter than one generation span, so the
existing two-endpoint generation proof remains sufficient. Actual writes are still filtered
through the existing 16-byte code bitmap before a generation is bumped.

On the focused XM 2 hotspot, progressively reducing the span produced:

| Generation span | Identical revalidations | Diagnostic JIT |
|---|---:|---:|
| 4 KiB | 65.3M | 24.0 MIPS |
| 2 KiB | 48.9M | 29.8 MIPS |
| 1 KiB | 33.8M | 31.5 MIPS |
| 512 B | 17.3M | 34.7 MIPS |
| 256 B | 12.1M | 37.4 MIPS |

The 256-byte run caused only about 2% more block entries from splitting long blocks. A
three-repeat run without diagnostic counters measured 37.6 MIPS on the same phase. The
fast XM 2 order-4 control improved from 214.4 to 220.4 MIPS, so the finer span did not trade
away ordinary render performance.

The full post-change sweeps measured:

| Soundtrack | Before | After | Aggregate gain |
|---|---:|---:|---:|
| XM 1 | 49.53 MIPS | 72.25 MIPS | +45.9% |
| XM 2 (`BLUISH`) | 32.69 MIPS | 46.92 MIPS | +43.5% |

Every XM 1 window improved in this pass; the measured range was +1.1% to +106.1%. XM 2's
range was neutral to +57.1%. The largest XM 1 gains were order 6 rows 0–32, which rose from
about 42 MIPS to 86–87 MIPS. XM 1 order 9 rows 32–48 rose from 30.2 to 45.0 MIPS in the
full sweep and to 54.4 MIPS in a focused three-repeat run.

The original CSVs are preserved as:

- `out/bench/stash-xm1-rows-before-span.csv`
- `out/bench/stash-xm2-rows-before-span.csv`

## Validation and remaining work

- All 17 IXA container/reference checks pass.
- The XM 2 order-3 hotspot produced identical interpreter/JIT instruction counts, frames,
  row boundary and final architectural fingerprint.
- Jizz orders 1 and 2, retained as browser-sensitive 3D controls, also pass the same
  interpreter/JIT comparison.
- The XM checkpoints are architectural snapshots and remain valid across cache-policy
  changes; decoder and JIT caches are deliberately cold after every restore.

The optimized XM 2 hotspot still measured 42.1 MIPS in the interpreter and 38.3 MIPS in the
JIT during the differential run. Finer invalidation removed most of the avoidable loss but
did not make this self-modifying workload a natural JIT win. Remaining callouts are led by
`FFREE` and `FSQRT`, but callout count does not correlate with the fast control. Any future
x87 experiment should remain one-form-at-a-time and browser-tested; the broad x87 inlining
bundle that regressed Jizz in Chrome and Safari should not be reintroduced.
