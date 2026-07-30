# iXalance SDK

A freestanding toolkit for authoring `.ixa` productions.

An initial ABI proof established that the pipeline could produce a running
guest, and `ports/square/` proved it could carry a real 1997 production. This
directory is what was left once the production-specific parts were removed:
the entry veneer, a portable presenter, timing and music sync, an allocator,
a mini-libc and x87 math — everything a *new* guest needs and nothing that
belongs to any particular demo.

## What it gives you

| | |
|---|---|
| `src/crt0.asm` | the entry veneer. Captures the host's argument frame in the first instructions, before a single push can invalidate it. |
| `src/video.c` | the format-negotiating presenter. Draw into an 8-bit paletted or ARGB32 canvas; the SDK converts to the host's declared or implied mode. |
| `src/time.c` | the tick accumulator, a rate-change-safe wall clock, and music position. |
| `src/heap.c` | a first-fit allocator with coalescing over the host's bump-only arena. |
| `src/libc.c` | `mem*`, `str*`, `rand` (Watcom's LCG, as the corpus expects). |
| `src/math.c` | libm on the bare x87 — no SSE on an i486 target. |
| `src/cxx.cpp` | `operator new`/`delete`, for C++ guests. Its own archive member, so C guests never pull it in. |

Plus `ixa-package.sh`, which runs the three back-end stages (`ld` →
`elf2d32` → `mkixa`) that every guest needs.

## Requirements

`nasm`, `i686-elf-gcc`, `i686-elf-g++`, `i686-elf-ld`, `i686-elf-ar`, and
Node.js.

## Quick start

```sh
./build.sh                  # builds lib/libixa.a and lib/crt0.o
cd examples/hello && ./build.sh
node ../../../../run.mjs run hello.ixa '' 1000000000
```

Run the native-driver compatibility regression:

```sh
cd tests && ./build.sh
```

It deliberately clears `gfxmodeinfo.tcbitmode` while retaining the historical
RGB masks, pitch, and resolution, then verifies that an SDK guest presents the
expected RGB565 pixels instead of treating the display as an 8-bit mode.

`run.mjs` accepts a trailing `frames` argument to dump PNGs of every presented
frame, which is the fastest way to check a guest is drawing what you think.

## Writing a guest

```c
#include <ixalance.h>

static unsigned char screen[320 * 200];
static unsigned char palette[256 * 3];      /* 6-bit VGA components */

int ixa_main(void)
{
    ixa_canvas c;
    ixa_canvas_init(&c, screen, 320, 200, IXA_INDEX8);
    c.palette = palette;
    c.palette_bits = 6;

    while (ixa_seconds() < 10.0) {
        /* ... draw into screen[] ... */
        ixa_present(&c);                    /* convert, present, pump clocks */
        ixa_ticks();                        /* consume the tick counter */
    }
    return 0;                               /* ends the part */
}
```

Build it:

```sh
IXA_SDK=/path/to/ixalance-sdk; export IXA_SDK
. "$IXA_SDK/ixa-env.sh"
$IXA_CC -c mydemo.c -o mydemo.o
"$IXA_SDK/ixa-package.sh" -o mydemo.ixa --name "My Demo" mydemo.o
```

`ixa-env.sh` exports `$IXA_CC`, `$IXA_CXX`, `$IXA_AS` and `$IXA_LD` with the
required flags already set. They are not stylistic — see the comments in that
file for why each one is load-bearing.

## The four things that will bite you

**1. Nothing about the display may be assumed.** Not the resolution, not the
pixel format, not the bytes per scanline. `ixalance-js` pins the mode to
320×200 RGB565, but native players negotiate a real display and may omit a
redundant field such as `tcbitmode`. Draw into a canvas and let
`ixa_present()` negotiate or infer the complete mode.

**2. The tick rate doubles when the music starts.** `herzcount` runs at 70 Hz
until the guest calls `ixa_music_start()`, then at 140 Hz. Use `ixa_seconds()`
or divide by `ixa_tick_rate()`; a hardcoded 70 runs at half speed for the
entire soundtrack.

**3. Time only advances when the host runs.** `herzcount` is incremented by the
host during a host call, so a loop that never presents a frame sees no time
pass — and the music stalls with it. Call `ixa_tick_update()` inside long
precalculation loops.

**4. Palettes are 6-bit.** VGA components run 0–63. Set `palette_bits = 6` or
everything renders at a quarter brightness, silently.

## Portability of the result

A `.ixa` built with this SDK is a plain container holding a DOS/32A executable.
It uses only the host calls the 1997-era productions used, negotiates the
display rather than assuming it, and does not depend on anything specific to
`ixalance-js`. That is deliberate: the output targets the native players as
well as the browser implementation, even where surviving native source leaves
recoverable mode fields unset.

## Relationship to the rest of `sdk/`

- `ports/square/` — the Square port. It consumes this SDK directly; its
  remaining compatibility layer contains only production-specific code. The
  SDK was originally extracted from the production-agnostic half of its old
  shim.
- `sdk/tools/` — `elf2d32.mjs` and `mkixa.mjs`, the container back end. Both
  self-verify: `elf2d32` re-parses its own output through `lib/d32.js` and
  checks every fixup site, and `mkixa` round-trips every block through
  `lib/ixa.js` before writing.

See [ABI.md](ABI.md) for the raw host contract underneath all of this.
