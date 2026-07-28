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

## Direct decoded-block reuse

The 256-byte span removed most false invalidations, but the JIT still called `CPU.block()`
before it could compare a compiled entry's saved bytes. Every stale generation therefore
paid for a fresh x86 decode even when the code was unchanged.

Compiled JIT entries now retain their last decoded block. The dispatch path:

1. Reuses it immediately when its generation values match.
2. Compares its byte snapshot when a generation is stale and reuses it if identical.
3. Falls through to the existing decoder, version map and live-immediate shape check only
   when bytes genuinely changed.

On XM 2 order 3 rows 32–64, 191.9M of 195.6M compiled-block dispatches use this path.
That includes 12.09M stale-generation byte proofs that no longer decode. The 3.69M genuine
dynamic variants still use the existing shape-checked machinery.

A three-repeat counter-free test improved that window from 37.6 to 43.0 MIPS. The
interpreter/JIT differential run measured 41.4 versus 43.0 MIPS, so this phase changed from
a JIT loss into a small JIT win while retaining an identical fingerprint.

The final full sweeps measured:

| Soundtrack | Original 4 KiB | 256-byte span | Span + direct reuse |
|---|---:|---:|---:|
| XM 1 | 49.53 MIPS | 72.25 MIPS | 88.72 MIPS |
| XM 2 (`BLUISH`) | 32.69 MIPS | 46.92 MIPS | 51.95 MIPS |

Direct reuse adds 22.8% to XM 1 and 10.7% to XM 2. Cumulative gains over the original cache
are 79.1% and 58.9%. XM 1 order 6 rows 0–32 rose again from 86–87 to 145–148 MIPS. XM 2's
full-sweep windows all improved by 6.6–19.9%.

XM 1 order 0 rows 32–48 recorded one low 189.5-MIPS sample during the long sweep. It does
not reproduce: a saved three-repeat focused run measures 302.7 MIPS, versus 254.5 before
direct reuse. Use `out/bench/stash-xm1-order0-row32-direct-repeat3.csv` for that control.

The span-only CSVs are preserved as:

- `out/bench/stash-xm1-rows-before-direct.csv`
- `out/bench/stash-xm2-rows-before-direct.csv`

### Rejected 128-byte span

A separate 128-byte experiment reduced identical byte checks from 12.1M to 7.3M in the
XM 2 hotspot. It also split enough blocks to raise dispatches from 195.6M to 226.0M,
increased callouts, and reduced diagnostic throughput from 42.2 to 41.0 MIPS. It was
reverted; 256 bytes remains the measured optimum.

## Browser frame delivery

The CPU worker previously converted every RGB565 demo frame to a newly allocated RGBA
buffer and posted it, even when the main thread still had an older frame waiting for
`requestAnimationFrame()`. The main thread kept only the newest message, so the discarded
conversions, allocations and transfers could never become visible.

Frame delivery now permits one buffer in flight. After `putImageData()` synchronously
copies it, the main thread transfers that storage back to the worker for reuse. While a
frame is outstanding, later emulated frames still complete and advance time but skip the
RGBA conversion and post. This is intentionally a browser smoothness/GC optimization and
is not represented in the headless MIPS CSVs.

## Validation and remaining work

- All 17 IXA container/reference checks pass.
- The XM 2 order-3 hotspot produced identical interpreter/JIT instruction counts, frames,
  row boundary and final architectural fingerprint.
- Jizz orders 1 and 2, retained as browser-sensitive 3D controls, also pass the same
  interpreter/JIT comparison.
- The XM checkpoints are architectural snapshots and remain valid across cache-policy
  changes; decoder and JIT caches are deliberately cold after every restore.

The optimized XM 2 hotspot now measures 41.4 MIPS in the interpreter and 43.0 MIPS in the
JIT during the differential run. Remaining callouts are led by `FFREE` and `FSQRT`, but
callout count does not correlate with the fast control. Any future x87 experiment should
remain one-form-at-a-time and browser-tested; the broad x87 inlining bundle that regressed
Jizz in Chrome and Safari should not be reintroduced.
