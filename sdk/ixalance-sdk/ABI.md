# The iXalance guest ABI

What the host promises a guest, and what a guest must do to hold up its end.
This is the contract `src/crt0.asm` implements; everything else in the SDK is
built on top of it. Offsets here are verified against `lib/machine.js`
(`loadExe`, `callTrampoline`) and the original `code.asm` / `d32load.c`.

## The image

A guest is a **DOS/32A "Adam" linear executable**: a flat 32-bit image plus a
fixup stream, with no sections, no imports and no loader services. The host
unpacks it, allocates `memrequired` bytes of fresh (zeroed) memory, copies the
image in, and walks the fixup stream adding the load base to every recorded
site. Then it far-calls the entry point.

The toolchain reaches that format via ELF:

```
  .c/.cpp/.asm  →  i686-elf-ld --emit-relocs  →  elf2d32.mjs  →  mkixa.mjs
                            .elf                     .exe          .ixa
```

`--emit-relocs` is not optional. The retained `R_386_32` entries *are* the D32
fixup stream — drop them and the image loads at the wrong base and jumps into
nothing. (`R_386_PC32` is already image-relative and needs no fixup.)

## Entry

The host far-calls the guest **once**. On entry:

| Register | Meaning |
|---|---|
| `ebx` | the guest's CS selector — the segment half of every far pointer below |
| `esi` | a pointer to a **pointer to** `gfxmodeinfo` — one indirection (`mov eax,[esi]`), not two |

The `esi` double indirection is a historical accident worth knowing about:
`code.asm` does `mov esi, balmodeinfo`, which in NASM loads the *address* of
the C variable rather than its value.

### The argument frame

Nine far-pointer slots and two data pointers are already on the stack.
`pushFar` stores the 32-bit offset **first** and the 16-bit selector at the
**lower** address, so each slot reads `{word sel; dword offset}`:

| Offset from entry `esp` | Contents |
|---|---|
| `+0`  | dword — return EIP (host return address) |
| `+4`  | dword — return CS |
| `+8` / `+10` | sel / offset — **farmalloc** |
| `+14` / `+16` | sel / offset — **fardoint** |
| `+20` | dword — `&mustime`, a `{u8 order; u8 row}` pair |
| `+24` | dword — `&herzcount`, the tick accumulator |
| `+28` / `+30` | sel / offset — call slot 0 (`farbasic`) |
| `+34` / `+36` | sel / offset — call slot 1 (`farbasic`) |
| `+40` / `+42` | sel / offset — call slot 2 (**`farshowp`**) |
| `+46` / `+48` | sel / offset — call slot 3 (`farbasic`) |
| `+52` / `+54` | sel / offset — call slot 4 (`farbasic`) |

**This must be read before the guest pushes anything.** One `push` and every
offset above is stale. That is the entire reason `crt0.asm` exists and cannot
be written in C.

Only **slot 2** presents a frame. The other four are housekeeping-only and are
all the same address in practice — the host pushes `basic, basic, showp,
basic, basic` (`lib/machine.js:384-392`). The SDK captures all five into
`ixa_slot[]` so the shape is visible, and calls slot 2 for `ixa_show()` and
slot 0 for `ixa_poll()`.

## Host calls

Every call is a `call far` through one of the captured pointers. The host's
trampoline preserves all registers except the effects listed here, and each
call implicitly pumps messages and advances the music clock.

| Call | In | Out | Effect |
|---|---|---|---|
| slot 2 (`farshowp`) | — | — | present the framebuffer, pump clocks |
| slots 0/1/3/4 (`farbasic`) | — | — | pump clocks only, no present |
| `farmalloc` | `edx` = bytes | `eax=0`, `edx` = block, `cf=0` | bump-allocate from part memory |
| `fardoint` | `eax` = code, `esi`/`ecx` = buffer | `eax` = result | the general request gate |

### fardoint codes

| Code | ASCII | Meaning |
|---|---|---|
| `0x54424C31` | `TBL1` | start the XM module at `esi`, length `ecx`. **Also raises the tick rate to 140 Hz.** |
| `0x54424C33` | `TBL3` | returns `(row + 1) \| (order << 8)`, or `0` if nothing is playing |
| `TBL2`, `TBL4` | | exist, purpose unrecorded; `d32load.c` leaves `eax` alone and so does the host |

`TBL3` returning `eax` *unchanged* (rather than `0`) is what a naive host does,
and it reads as an enormous song position — which makes a guest conclude the
music has ended and quit instantly. Worth knowing when porting to another host.

## Time

`herzcount` is an `int` in shared memory. The host increments it; **the guest
is expected to zero it** after reading. That read-then-zero protocol is what
every original part does, and the SDK's `ixa_ticks()` implements it.

Two consequences:

1. **The counter only advances when the host runs.** A loop that never calls
   `farshowp` or `farbasic` sees time stand still. Long precalculation must
   pump the host or the music stalls with it.
2. **The rate changes mid-run.** It is 70 Hz until the guest issues `TBL1`,
   then 140 Hz (`lib/machine.js:314`). A guest that divides by a literal 70
   runs at half speed for the whole soundtrack. `ixa_seconds()` folds the
   change in as it happens; `ixa_tick_rate()` reports the current value.

`mustime` is two bytes: `[0]` = pattern order, `[1]` = row. It is refreshed by
any host call, so reading it is free once you have already presented a frame.

## Memory

`farmalloc` is a **bump allocator with no free**. The host reclaims the whole
part-memory arena between parts (`freeAllPartmem`), and that is the only way
memory comes back. The arena is 13 MiB, except for one title the original
`d32load.c` special-cases by name (`" Astral Blur"`, leading space included),
which gets 6 MiB.

One rounding quirk: the host computes `(bytes + 4096) & 0xfffff000`, so an
exactly page-sized request consumes **one extra page**. Asking for exactly
13 MiB fails; ask for `13 MiB - 4096`.

Because bump-only allocation is unusable for a guest that churns short-lived
buffers, the SDK reserves one large block and runs its own first-fit allocator
inside it (`src/heap.c`). `ixa_partmem()` remains available for guests that
want the raw arena.

## Video

`gfxmodeinfo` is `#pragma pack(1)`, so several 32-bit fields sit at odd
offsets — read it byte-wise, not through casts. The fields the SDK uses:

| Offset | Field | Meaning |
|---|---|---|
| `4` | `tclfb` | linear framebuffer address |
| `34` | `tcscanlen` | **bytes** per scanline, not pixels |
| `38` / `42` | `tcxres` / `tcyres` | resolution |
| `52` | `tcbitmode` | 15, 16, 24 or 32 |
| `53`–`55` | `rcomp` / `gcomp` / `bcomp` | left shift per component |
| `56`–`58` | `rmask` / `gmask` / `bmask` | component **widths** in bits |

None of this may be assumed. `ixalance-js` pins the mode to 320×200 RGB565, but
native players negotiate a real display. Some drivers leave `tcbitmode` zero
while still providing the framebuffer, pitch, resolution, component shifts,
and component widths. `ixa_display_query()` therefore infers the storage width
from the RGB widths and `tcscanlen / tcxres` when the declared bit mode is not
15, 16, 24, or 32. A guest that hardcodes 565 is not portable to the players
this format came from.

## Ending a part

The guest ends by far-returning to the address at entry `esp+0`. `crt0.asm`
saves the entry `esp` so `ixa_exit()` can unwind from any call depth, and
`ixa_main()` returning does the same thing. Control resumes at the next command
in the container script.
