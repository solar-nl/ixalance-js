# Square iXalance port

This directory rebuilds the active production sequence of **Square by Pulse**
from the Win32 source under `source/squarewin32src/square_w32/source/` as a
freestanding i386 DOS/32A image, then packages it as `square.ixa`.

## Build

The build expects `nasm`, `i686-elf-gcc`, `i686-elf-g++`, `i686-elf-ld`,
`i686-elf-ar`, `i686-elf-objcopy`, and Node.js:

```sh
cd sdk/ixalance-sdk/ports/square
./build.sh
```

`build.sh` builds and links `sdk/ixalance-sdk`, copies the selected original
C++ files into `parts/`, applies only the few source-compatibility edits
documented inline, and assembles the translated pixel loops. The SDK owns the
guest entry/exit veneer, host calls, display conversion, timing/music access,
heap, mini-libc, x87 math, C++ allocation, linker script, and container
packaging.

- `square.ixa` — self-verified iXalance container

The remaining code in `src/` is Square-specific: its packed-file/LZW reader,
legacy fproc scheduler, 320×480 compositor, production startup, and the small
compatibility helpers used by the original sources. `asm/` contains only
Square's rasterizers, embedded data, and the register bridge to its original
radial-blur routine.

The soundtrack and packed demo assets remain embedded in the guest image. The
guest calls `ixa_music_start()` only after its original precalculation, so
audio and visuals begin at the same boundary as the 1997 production.

## Run and verify

Preview the opening and optionally dump frames:

```sh
node ../../../../run.mjs run square.ixa '' 1000000000 frames
```

Run every music-gated part with an accelerated virtual display:

```sh
node smoke.mjs
```

The smoke test succeeds only when the executable completes the title, Bjork,
sphere, tunnel/cubes, DNA, baby/greetings, landscape, final effects, and DCT
video sequence and far-returns to the container script.

Production playback uses the normal browser worker/audio path. The only
deliberately inert routines are mouse/editor and offline asset-authoring
facilities that the released sequence never calls.

After a successful build, the main page detects `square.ixa` and adds Square
to the production selector automatically. If the container is absent, public
deployments keep the original selector unchanged.
