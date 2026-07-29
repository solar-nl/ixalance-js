# iXalance browser build

This directory is the self-contained static build of the iXalance JavaScript port. It runs
The Black Lotus' original protected-mode x86/x87 payloads from:

- Jizz, Wired 1997
- Stash, The Party 1997
- Astral Blur, The Gathering 1997

The payloads are not rewritten ports or video captures. A JavaScript 386/x87 runtime loads
and executes the original `.IXA` files. Hot decoded blocks are translated to straight-line
JavaScript by the block JIT; uncommon forms retain the interpreter as their correctness
fallback.

## Share or run

Upload the contents of this directory to any static HTTP host. For a local test:

```sh
python3 -m http.server 8731 --bind 127.0.0.1 --directory deploy
```

Then open <http://127.0.0.1:8731/>. Opening `index.html` through `file://` will not work
because the page uses ES modules, a module worker, `fetch`, and an AudioWorklet.

There is no build step and there are no package dependencies.

## Controls and timing

- The production selector remains live during loading and playback. Choose another title
  and press **Switch and run** to replace the current run without reloading the page.
- **JIT on** is the production path.
- **JIT off** selects the reference interpreter for comparison.
- `?engine=cpu` and `?engine=jit` select an engine in the URL.
- **Sound on** uses the real audio-thread tracker position. Visuals may skip when execution
  cannot keep up, matching the original demo's music-authoritative timing.
- **Sound off** uses a virtual frame clock for smooth but silent playback.
- The status line separates active emulation MIPS from paced wall-clock MIPS. A lightweight
  scene can show a low paced rate because it finishes early and sleeps to hold 50 fps; use
  the active rate when comparing CPU/JIT performance.

Jizz generates all graphics and its 940 KiB XM module at runtime. The initial decrunch bar
is therefore expected; music starts only after the generated XM is handed to the host.
Stash generates two XM modules during its run; the browser follows the handoff and tracker
position from each one. Astral is a 4.5 MiB multi-part demo with a stored XM; its IXA is
streamed with byte and percentage progress before execution starts.

At Stash's second-module handoff, the emulated tracker position is reset to order 0, row 0
synchronously. Audio position reports carry a module generation, so a report already queued
by XM 1 cannot overwrite XM 2's initial position and skew the timing of the next part.

When a production exits, its independently running AudioWorklet is stopped, pending frames
are discarded, and the canvas is painted black. The final module must not restart after the
demo has ended.

Starting another production performs the same cleanup synchronously. Each run owns its
worker, download cancellation signal and AudioContext, and stale callbacks are ignored, so
rapid switches cannot leak an old frame, progress update or soundtrack into the new run.

## Safari sound fix

The AudioContext and AudioWorklet preparation begin synchronously from the **Load and run**
click, before the click handler's first `await`. The context is resumed while Safari still
recognizes the user activation, and the worklet module is loaded from a Blob assembled from
the same `lib/xm.js` used by the worker and Node paths.

This avoids the delayed initialization that worked in Chrome but left Safari's audio
context suspended. Audio failures remain non-fatal: the page reports the error and continues
with its silent virtual clock.

## Astral Blur and FT2 replay

Astral's complete 20-block script now runs executable parts, pictures, stored music and four
music-position waits end to end. Its animation counter and XM position use separate clocks:
the AudioWorklet owns music position, while a 70 Hz virtual display timer prevents multiple
screen flips in one CPU slice from observing a zero delta.

The XM replayer now follows ft2-clone's FT2 replay routines for note/instrument ordering,
effect memory, normal and extended effects, volume-column effects, shared pattern-control
flags, exact period conversion, volume and panning envelopes, fadeout, vibrato, instrument
auto-vibrato, silent cursor advancement and loop phase. This includes FT2 quirks such as
`E8x` being a no-op rather than set-panning. Jizz, both Stash modules and Astral complete a
full music cycle without unsupported effects or invalid channel state.

Volume and panning envelope loops wrap on FT2's loop-end tick instead of one tick later.
Sustain release repeats the held point on its key-off tick, and interpolation uses FT2's
signed 8.8 slope. In particular, Stash XM 2's short gate now has its intended six-tick
cycle instead of the previous seven-tick cycle.

The complete code-to-code map, corrected quirks, full-song timings and intentionally
retained browser-mixer differences are in
[FT2_COMPATIBILITY_AUDIT.md](FT2_COMPATIBILITY_AUDIT.md).

## Browser frame delivery

The worker keeps at most one converted frame in flight. Once the main thread has copied it
to the canvas, it transfers the RGBA storage back for reuse. Emulation and music timing
continue normally while an undrawn frame is outstanding, but redundant pixel conversion,
allocation and message queueing are skipped.

## Jizz optimization result

The JIT was profiled using exact cold snapshots at every XM order rather than treating the
intro as one aggregate workload. The final CPU/JIT sweep covered 22 orders and
21,270,723,531 instructions:

| Engine | Aggregate rate |
|---|---:|
| Reference interpreter | 39.6 MIPS |
| JIT | 72.9 MIPS |
| Overall speedup | 1.84x |

The slow clusters were orders 9-10 and 17-20. Exact-form attribution led to two narrow
templates:

- `FXCH ST(i)`
- near indirect memory call/jump (`FF /2` and `FF /4`)

For order 18 they reduce interpreter callouts from 32.1 million to 9.1 million and increase
template coverage from 97.78% to 99.37%. A broader miscellaneous-x87 experiment was removed
after it made 3D scenes slower in both Chrome and Safari.

The detailed measurements and future optimization backlog are in
[JIZZ_OPTIMIZATION_NOTES.md](JIZZ_OPTIMIZATION_NOTES.md). The complete 22-order result is
available as [results/jizz-orders.csv](results/jizz-orders.csv).

## Stash optimization result

Stash was profiled by XM order and row window because its two generated soundtracks use
slower tracker speeds and individual orders span several visual workloads. The retained
changes use 256-byte generated-code invalidation spans and reuse decoded blocks after a
generation change when their saved instruction bytes still match.

| Soundtrack | Original JIT | Current JIT | Gain |
|---|---:|---:|---:|
| XM 1 | 49.53 MIPS | 88.72 MIPS | +79.1% |
| XM 2 (`BLUISH`) | 32.69 MIPS | 51.95 MIPS | +58.9% |

The full analysis, correctness evidence and rejected 128-byte experiment are in
[STASH_OPTIMIZATION_NOTES.md](STASH_OPTIMIZATION_NOTES.md). Current row-window results are
[results/stash-xm1-rows.csv](results/stash-xm1-rows.csv) and
[results/stash-xm2-rows.csv](results/stash-xm2-rows.csv).

## Validation

- The full optimized CPU/JIT order sweep produced matching instruction counts, frame counts,
  and final architectural fingerprints across all 21.27 billion instructions.
- Stash's generated-code hotspot and Jizz's browser-sensitive 3D controls also produce
  matching interpreter/JIT boundaries and architectural fingerprints.
- The source container, timer, self-modifying-code, Astral tunnel and FT2 replay verification
  suite passes all 25 checks, including browser production handoff, differential note-off,
  loop-phase, tick-carry, pattern-control, period-table and envelope-state fixtures.
- Jizz, Stash XM 1, Stash XM 2 and Astral Blur each reach a clean first song loop with
  finite replay state and no unsupported effects.
- Emitted-template profiling reported zero faults in the measured Jizz orders.
- Chrome and Safari both play sound with the current Start-click initialization path.
- A throttled Chrome test observed Astral's progress UI at 1.3 MiB / 4.5 MiB (29%), followed
  by normal startup at 100%.

Performance numbers are from the development machine and will vary by browser and hardware.
The interpreter remains available specifically so visual or behavioral differences can be
compared without changing the hosted files.

## Contents

| Path | Role |
|---|---|
| `index.html` | Canvas, controls, logs, and browser integration |
| `worker.js` | Sequencer, CPU/JIT execution and backpressured frame conversion |
| `audio.js` | Safari-compatible AudioWorklet setup and transport |
| `lib/run-session.js` | Atomic worker/audio ownership for in-page production switching |
| `lib/cpu.js` | Reference 386 interpreter and block decoder |
| `lib/jit.js` | Profile-guided block JIT |
| `lib/fpu.js` | x87 oracle |
| `lib/xm.js` | FastTracker II replay core |
| `data/*.ixa` | Original unmodified Jizz, Stash and Astral Blur containers |
| `results/jizz-orders.csv` | Per-XM-order performance data |
| `results/stash-*-rows.csv` | Per-order, row-window performance for Stash's two XMs |
| `FT2_COMPATIBILITY_AUDIT.md` | ft2-clone comparison, corrected quirks and retained differences |
| `BUILD.txt` | Tester-build version, validation summary and container hashes |
| `MANIFEST.sha256` | Integrity hashes for every packaged file |
| `FT2_CLONE_LICENSE.txt` | BSD 3-Clause license for the FT2 replay reference |

## Redistribution

The runtime derives from GPL-2 iXalance source. The demo data remains TBL's and is included
unmodified for non-commercial sharing; Stash's documentation permits copying and spreading
but forbids modification and commercial sale. XM replay behavior is based on ft2-clone,
copyright 2016–2026 Olav Sørensen, under the BSD 3-Clause License included in this package.
