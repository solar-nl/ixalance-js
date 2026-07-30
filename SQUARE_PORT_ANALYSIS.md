# Porting "Square" by Pulse to ixalance-js — Feasibility Analysis

> **Implementation status (July 2026): complete in
> `sdk/ixalance-sdk/ports/square/`.** The
> analysis below was written before implementation and is retained as the
> design record. The port now builds a self-verifying `square.ixa`, runs the
> original active sequence, starts its embedded XM after precalculation through
> `TBL1`, and completes an accelerated end-to-end smoke run. See
> `sdk/ixalance-sdk/ports/square/README.md` for build and verification commands.

**Question:** Can Square (Pulse, 1997; Win32 port by Alex "Statix" Evans, 2002 — source in
`source/squarewin32src/square_w32/`) be turned into an `.ixa` container and executed by the
ixalance-js runtime?

**Verdict: Yes — feasible, but it is a re-targeting project, not a conversion.**
Neither the DOS binary nor the Win32 binary can run as-is; the demo must be **recompiled from
source against the iXalance guest ABI**, and two missing pieces of tooling (an `.ixa` packer and
a D32 "Adam" executable emitter) must be written. One small runtime accommodation (video modes
other than 320×200 for exe parts) is required. The subsystem-by-subsystem fit is unusually good —
the two hardest demo-porting problems (music format and sync mechanism) happen to map 1:1 onto
what ixalance-js already provides.

Estimated effort: a multi-week project. Roughly 60% of the work is porting ~45 KB of MSVC inline
assembly and building the toolchain; the runtime itself needs almost nothing.

---

## 1. What the target actually is

ixalance-js is **not a PC emulator**. It reimplements the iXalance *host* (Paananen/Katsman,
1998): a 386 + x87 interpreter/JIT executing flat 32-bit protected-mode code, plus a five-entry
host ABI. Everything the guest can touch:

| Facility | Mechanism |
|---|---|
| Entry | `call far` into the part with `esi` → pointer-to-pointer to `Tgfxmodeinfo`, a 9-slot host stack frame (`lib/machine.js:355-397`, from `code.asm:193-245`) |
| Video | Host-allocated RGB565 buffer; guest reads the pointer + geometry out of `Tgfxmodeinfo` (`ixalance.h:4-49`, `lib/machine.js:32-43`). 16-bit RGB565 **only**; no palette hardware. Exe parts are pinned to 320×200 by `PopExe` (`lib/sequencer.js:252`) |
| Frame flip | far call to `0xf0000010` (`farshowp`) → `copyScreen()` |
| Yield / housekeeping | far call to `0xf0000000` (`basictramp`) or the idiom `farmalloc(0)` |
| Memory | `farmalloc` (`0xf0000020`) → bump allocator over a 13 MB PARTMEM heap; 64 MB total address space |
| Music | XM module played **natively in JS** (`lib/xm.js`, ft2-clone port); guest never mixes audio |
| Sync | Host writes current `(row, pos)` into guest memory at `mustime`; guest reads it directly or via `fardoint('TBL3')` → `(row+1) + (pos<<8)` |
| Timer | `herzcount` tick accumulator in guest memory, 70 Hz default (140 Hz after a TBL1 handoff) |
| Everything else | **Nothing.** No `int`, no I/O ports, no DOS services, no VGA/VESA, no keyboard, no files (`lib/cpu.js:1-7`) |

The CPU core covers the full 386 integer ISA plus CMOV/SETcc/MOVZX/BSF/BSWAP/RDTSC, with a
complete x87 (`lib/fpu.js`, doubles instead of 80-bit extended — a documented compromise).
**Not implemented, by design:** `int`, `in`/`out`, MMX, SSE, 16-bit addressing. Unknown
instructions raise a diagnostic `Unimplemented`, and the interpreter (`?engine=cpu`) remains the
oracle behind the JIT, so coverage gaps degrade to slow-but-correct or fail loudly — never
silently wrong.

The container is equally narrow: `"IXALANCE"` magic, a block directory, blocks compressed
LZSS(10-bit window)+RLE, and a 5-opcode script (`exe / pop / music / picture / waitmusic`).
Executable blocks must be **DOS/32A "Adam" linear executables** (`lib/d32.js:28` rejects
anything else) with the D32 variable-length fixup stream. **This repo contains only readers —
no packer, no compressors, no D32 emitter exist anywhere.**

## 2. What the source material is

The 2002 Win32 port is the practical starting point (the DOS originals — MASM `ASM1_dos.ASM`,
MIDAS audio, mode-13h + CRTC tweaking, PIT/IRQ0 hook — survive in the tree only as dead code).
What actually links (`source/h.plg:19-46`):

- **~120 KB of C++** (DEMO1–6, BJORK, DCT, UTILS, CELLTAB, MAIN, winmain): all geometry, camera
  splines, marching cubes, palette logic, LZW/DCT decode, sequencing.
- **~45 KB of 32-bit x86 assembly** doing all inner-loop pixel work: MSVC inline `__asm` in
  `asm1.cpp` (rasterizers, blurs, compositors, texture mappers) and `lzwasm.cpp` (LZW, rotozoom,
  crossfade), plus NASM `_BLUR.aSM` (radial blur, called with a hand-rolled register convention
  from `SHIT.CPP:62-74`).
- **tinyptc** (video: DirectDraw/GDI, MMX converters) and **minifmod** (audio: XM mixer on a
  time-critical thread, `waveOut` ring buffer).

Structure that matters for the port:

- **Rendering is entirely 8-bit palettized, 320 px wide** — 320×200 for most parts, 320×240
  (`swapscreens2`), 320×480 downsampled 2:1 (`title()`), 320×400 (`lines400` path). Frames go
  `screenbuf` → `wina000[480][320]` → `CopyPal2Screen` (palette → 32-bit ARGB, software) →
  tinyptc. The palette is software state (`winpal`), animated every frame by a fader.
- **Sync is (order, row) of the XM module.** `UpdateInfo()` computes
  `curpos = row + order*64` (`MAIN.CPP:49`); `SYNC.H` is 51 constants in exactly that unit;
  every part is a blocking loop `while (!kbhit() && curpos < CONSTANT)`. There is **no global
  main loop** and no frame limiter.
- **Animation speed** comes from a second clock: a 60 Hz multimedia timer incrementing
  `midastime`; render loops advance by `dt = midastime - lasttime` ticks per frame.
- **Data**: `SQUARE.PAK` (1.2 MB, `"ALEX"` magic, 67 LZW-compressed members: images, fade/ghost
  LUTs, camera paths, meshes, beat table), plus loose `ZEBOU.LZW` and `PEOPLE.LZW` (a
  117-frame DCT-compressed video), plus `SQUADEMO.XM`. All I/O is plain stdio, forward-only
  streaming for the LZW files.
- **Memory footprint**: ~9–10 MB steady state, dominated by the marching-cubes buffers
  (50 K verts × 64 B + 100 K faces × 24 B ≈ 5.6 MB).
- **CPU requirements of the effect code**: i486 integer + x87. Zero FPU instructions in
  `asm1.cpp`/`lzwasm.cpp` (all float math is C++); **zero MMX outside tinyptc**; no
  self-modifying code. MSVC-era instruction selection sits comfortably inside `lib/cpu.js`.
- The instruction-set requirements of the effect code (i486 integer + x87, no MMX, no SMC) sit
  comfortably inside what `lib/cpu.js`/`lib/fpu.js` already prove out on the TBL demos.

## 3. Gap analysis by subsystem

| Subsystem | Square (Win32 port) | ixalance-js provides | Gap / porting action |
|---|---|---|---|
| CPU integer | i486, MSVC codegen | Full 386+ integer, tested against 3 TBL demos | **None.** Recompile within i486/no-SSE envelope |
| FPU | C++ floats, sqrt/sin/exp; minifmod mixer | Complete x87 on doubles | **None** for demo math (minifmod is dropped entirely) |
| MMX | Only in tinyptc converters | Absent (`emms` throws) | **None** — tinyptc is replaced by the host framebuffer |
| Video | 8-bit palette → software 32-bit expand → DirectDraw; 320×200/240/400/480 | RGB565 host buffer, exe parts pinned 320×200 | Rewrite `CopyPal2Screen` to expand palette→RGB565 into `gfxlfb` + `farshowp`. **Runtime change needed:** allow ≠320×200 for exe parts (buffer already fits 800×600) |
| Audio | minifmod thread + waveOut | Native JS XM replayer (`lib/xm.js`), host-driven | **Delete minifmod entirely.** Ship `SQUADEMO.XM` as a `music` block. FT2-accurate replayer ≥ minifmod fidelity |
| Music sync | `FMUSIC_GetOrder/GetRow`, latency-corrected | `mustime.timepos/timerow` written into guest memory | **1:1 mapping.** `UpdateInfo()` becomes two byte reads; `curpos = timerow + timepos*64`. `SYNC.H` unchanged |
| Timing | 60 Hz `timeSetEvent` → `midastime` | `herzcount` at 70 Hz in guest memory | Shim: accumulate `herzcount`, scale ×6/7 (fixed-point) into `midastime`. Fader moves from timer thread to the per-frame path (already priority-based) |
| Input | `kbhit()` always false; ESC handled by host | No input at all; ESC = host stop | **None.** Stub `kbhit() → 0` — identical behavior |
| Threads | minifmod mixer thread + MM timer thread | Single-threaded guest | Both threads disappear with their subsystems. Removes an existing unsynchronized-palette race (`winpal` written by timer thread, read by render thread) |
| File I/O | stdio on `square.pak`, 2 LZW files, XM | None | Link all data into the exe image (Astral's exe blocks are MB-sized precedent); `openf`/`readf` become memory-window reads. Streaming LZW logic unchanged |
| Memory | ~10 MB, `malloc`/`new` | 13 MB PARTMEM via `farmalloc` | Fits. `malloc` shim over `farmalloc` (bump-only — free is a no-op, matching the demo's allocate-once pattern) |
| OS misc | `MessageBox`, `timeSetEvent`, `Sleep`, `printf` (void) | — | All deleted or stubbed; none are load-bearing |

**The two structural gaps are outside the demo entirely:**

1. **No `.ixa` writer exists.** Needs: LZSS encoder (10-bit window, `BREAK_EVEN 1`, MSB-first
   in 32-bit LE words), RLE encoder, directory + script serializer. Decoders in `lib/ixa.js:42-155`
   are the executable spec; the container is self-verifying, so a round-trip test
   (pack → `unpackBlock`) proves the encoder.
2. **No D32 "Adam" emitter exists.** Needs a tool that takes a flat 32-bit image + relocation
   list and emits the MZ stub + "Adam" header + the variable-length fixup stream
   (`lib/d32.js:64-95` documents the format precisely). Relocations are unavoidable — the load
   address depends on the runtime's bump allocator.

## 4. Recommended port strategy

**Rebuild from the 2002 source against the iXalance ABI**, treating iXalance as just another
platform target (which is exactly what `ixalance.h` was designed for — it's the portable driver
interface, with `IXDRV_*` as the host side).

### Phase 0 — Toolchain spike (de-risks everything)
Freestanding i386 "hello framebuffer": clang or GCC `-m32 -march=i486 -ffreestanding
-fno-pic -mno-sse -fsigned-char`, custom linker script producing a flat image at a nominal base,
a `crt0` that captures the `startdemo` stack frame (5 far pointers, `&herzcount`, `&mustime`,
`fardoint`, `farmalloc`) and `esi → &&gfxmodeinfo`, plus the D32 emitter and `.ixa` packer.
Success = a gradient animating in the ixalance-js page. Until this runs, nothing else matters.
(`-fsigned-char` matters: the 2002 source was already converted from Watcom's unsigned `char`
to MSVC's signed `char` — readme.txt:18-19 — so the port must preserve MSVC semantics.)

### Phase 1 — Platform shim (`ixa_shim.c`, replaces winmain.cpp + tinyptc + minifmod)
- `CopyPal2Screen`: 8-bit + `winpal` → RGB565 into `gfxlfb`, then `farshowp`. Keep the
  `wina000` letterboxing logic (`yofs` 0/20/40) verbatim.
- `UpdateInfo()`: read `mustime` bytes; `curord = timepos`, `currow = timerow`,
  `curpos = currow + curord*64`.
- `midastime`: drain `herzcount` (read, add, write 0 — the TBL convention,
  `lib/machine.js:185-190`), accumulate ×6/7 in fixed point for the 70→60 Hz rate conversion.
- `malloc`/`new` over `farmalloc`; `memcpy`/`memset`/math from a mini-libc (or link a
  freestanding libm for `sin/cos/sqrt/exp/pow` — x87 hardware handles the heavy ones).
- `kbhit() → 0`, `printf → fardoint` debug channel or void, `error() → basictramp` loop halt.
- Data access: `openlibf`/`openf` re-pointed at linker-embedded blobs of `square.pak`,
  `zebou.lzw`, `people.lzw`.

### Phase 2 — The assembly (the largest single work item)
~45 KB of MSVC inline `__asm` won't compile under GCC/clang. Three options, in order of
preference:

1. **Translate to NASM modules** with a small ABI veneer per routine. The MASM DOS originals
   (`ASM1_dos.ASM`, 39 KB) cover most of the same routines and are a working reference for the
   register conventions; `_BLUR.aSM` is already NASM and links as-is.
2. **Rewrite hot routines in C.** Performance headroom makes this viable: the JIT runs
   ~130 M ips — comfortably above the Pentium-class target hardware of 1997 — and C compiles to
   exactly the JIT-friendly integer code the runtime is optimized for. Risk: subtle behavior
   differences (carry-chain fixed point, partial-register tricks) change the look.
3. Mechanical `__asm` → GCC extended-asm conversion. Tedious, error-prone; not recommended.

Watch items regardless of option: `RADIALBLUR`'s hand-rolled register calling convention
(`SHIT.CPP:62-74`), `naked` `addedge_`, the four rasterizers that return values implicitly in
EAX (C4035 warnings in `h.plg:38-42`), and the NASM data table `divide21` that C++ rewrites at
runtime (`DEMO1.CPP:705-709`).

### Phase 3 — Runtime accommodation (ixalance-js side, deliberately minimal)
- **Per-part video mode.** Options: (a) define an unused `fardoint` service (TBL2/TBL4
  currently pass through untouched, `lib/cpu.js:1289-1310`) as "set mode from
  gfxmodeinfo.xres/yres", or (b) let the `.ixa` script's `exe` opcode carry a mode, or
  (c) simplest: have the guest write desired xres/yres into `gfxmodeinfo` and call a new far
  entry. All are ~20-line changes; `setVideoResolution` already accepts arbitrary sizes and the
  framebuffer is pre-sized 800×600×2 (`lib/sequencer.js:52`). Flag it clearly as a Square
  extension so TBL playback is untouched.
- Nothing else. Audio, sync, timer, memory all work unmodified. (`partmemFor()` gives the
  default 13 MB for any non-Astral name — 10 MB fits.)

### Phase 4 — Sequencing & packaging
Script: `music 2; exe 1; pop` — or split parts into separate exe blocks with `waitmusic`
between them for authenticity. Single-exe is simpler and matches Jizz/Stash precedent; the
demo's own `SYNC.H`-driven part loop already handles sequencing internally.

### Phase 5 — Verification
The repo's own methodology applies directly: run with sound off (deterministic virtual clock,
`lib/machine.js:286-295`), capture frames, compare against DOSBox captures of the DOS original /
the Win32 exe under Wine. Replace `rand()` with the Watcom LCG (`DEMO3.CPP:8-18` has it:
`next*1103515245+12345`) everywhere, not just in `calcmap` — this both fixes determinism and
restores the original's look (the readme names MSVC-vs-Watcom `rand()` as a known visual
difference).

## 5. Alternatives considered and rejected

- **Emulate Win32 / run the shipped `squarew32.exe`**: would require PE loading, DirectDraw,
  waveOut, threads, `timeSetEvent`, MMX — i.e. building a Windows emulator. Out of scope by
  orders of magnitude.
- **Emulate DOS / run the 1997 original**: needs mode 13h + CRTC tweaks, PIT/IRQ0, DOS
  extender services, and a MIDAS-compatible sound stack (GUS/SB). Equally out of scope, and
  contrary to ixalance-js's explicit "one struct and five entry points" design.
- **Emscripten/WASM port of the Win32 source**: easier and would run in a browser — but it
  produces a web app, not an `.ixa`, and exercises none of ixalance-js. Different project.

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Inline-asm translation fidelity (look-and-feel bugs) | High | Golden-frame diffing per effect vs Win32 exe; port routine-by-routine with the MASM originals as reference |
| Toolchain rabbit holes (flat binary, relocations, libc gaps) | Medium-high | Phase 0 spike before touching demo code; D32 fixup format is fully documented in `lib/d32.js` |
| JIT template gaps on modern-compiler codegen | Low-medium | Templates callout to the interpreter when unmatched — slower, never wrong; `?engine=cpu` as fallback; missing opcodes fail loudly with eip+bytes |
| x87 double vs 80-bit differences | Low | Demo math is visual, not bit-sensitive; same compromise already survives three TBL demos |
| Long synchronous startup (`calcmap`+`tracemap`, seconds of compute) without yields | Low | Insert `basictramp` calls in the precompute loops; worker-based runtime tolerates it anyway |
| 60↔70 Hz rate conversion drift | Low | Sync authority is the music position, not the tick clock; `dt` only scales animation speed |
| `screenbuf` under/overruns by design (negative offsets into guard slack) | Low | Reproduce the exact over-allocation (`+320*8` guard); no bounds checking exists in the runtime to trip |

## 7. Bottom line

**Possible: yes.** The iXalance ABI was explicitly designed as a portable demo-hosting
interface, and Square's actual needs — flat 32-bit x86 + x87, a linear framebuffer, an XM
module, and (order, row) music sync — are precisely the four things ixalance-js implements
well. The Win32 port already did the hard archaeological work (DOS-isms excised, asm
consolidated, MIDAS→XM-player swap proven).

**What it costs:** building the two missing tools (`.ixa` packer, D32 emitter), a freestanding
i386 toolchain + ~500-line platform shim, porting ~45 KB of inline assembly, and a ~20-line
runtime extension for 320×240/320×480 modes. The result would be a fourth dropdown entry — the
first non-TBL production ever packaged as an `.ixa`, 27 years after the format's last one.

**Recommended first step:** Phase 0 — a "hello framebuffer" `.ixa` built from scratch and
running in the existing page. It's a week-scale spike that converts every structural unknown
into a known.
