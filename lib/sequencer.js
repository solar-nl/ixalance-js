// The script interpreter: DemoMain's part sequencer, from d32load.c:664-696.
//
// A .IXA script is bytecode over a LIFO part stack. `exe` and `picture` only LOAD a block
// and push it; `pop` is what RUNS the top of the stack. So a demo that pushes 1,2,3,4,5 and
// then pops five times runs its parts in the order 5,4,3,2,1 — loading and running are
// deliberately separate phases, and Astral Blur depends on it. A 64K intro's script is
// `exe(1) pop`, for which all of this collapses to "load one block and run it", which is
// exactly what run.mjs and worker.js did before this file existed.
//
// The one structural departure from the C is that this is a STEPPER, not a loop. PopExe in
// d32load.c blocks until the part far-returns; a browser worker cannot block, because it
// owns pacing, message delivery and the stop button. So the script position, the part
// stack, the running CPU and a pending WaitMusic are all explicit state, and step() does
// one bounded unit of work and returns. run() is the Node-side convenience that spins
// step() flat out; the worker calls step() itself on its own schedule.
//
// Two host details leak in here because machine.js is a faithful port and must stay one:
//   * loadExe resets machine.startTime, which is right for a single part and wrong across
//     eleven — the music timeline is the demo's master clock and must be monotonic. Saved
//     and restored around the call rather than fixed in machine.js, because that reset is
//     what pins the first part's epoch to zero and the golden fingerprints ride on it.
//   * machine.virtualMs only advances inside copyScreen. Under the virtual clock a part
//     that waits on the music without drawing — Astral's blocks 1, 9 and 8 each open with
//     a farmalloc(0) spin on mustime — would freeze time and never be released. The
//     sequencer therefore owns the clock between slices.

import { readIxa, unpackBlock } from './ixa.js';
import { GFX } from './machine.js';

// Opcode byte -> operand-inclusive size, from the dispatch chain at d32load.c:666-693.
// Deliberately duplicated from ixa.js OPS rather than shared: this walks the raw script
// one opcode at a time as the C does, instead of disassembling it up front.
const SIZE = { 1: 2, 2: 1, 3: 2, 4: 2, 5: 3 };

/**
 * Decode a stored picture block: an "mhwanh"-signature header followed by raw RGB565.
 *
 * PopPicture (d32load.c:403-404) reads the dimensions as big-endian byte pairs out of the
 * header, then copies from SHORT offset 16 — byte 32 — straight into the framebuffer.
 */
export function parsePicture(data) {
  const sig = String.fromCharCode(...data.subarray(0, 6));
  if (sig !== 'mhwanh') throw new Error(`not a picture block (signature "${sig}")`);

  const width = data[8] * 256 + data[9];
  const height = data[10] * 256 + data[11];
  const pixels = width * height * 2;

  if (32 + pixels !== data.length) {
    throw new Error(`picture ${width}x${height} wants ${32 + pixels} bytes, block has ${data.length}`);
  }
  // machine.fb is exactly 800*600*2 and setVideoResolution does not bounds-check, so a
  // picture larger than the framebuffer would silently scribble over the part heap.
  if (pixels > 800 * 600 * 2) throw new Error(`picture ${width}x${height} exceeds the framebuffer`);

  return { width, height, pixels: data.subarray(32) };
}

export class Sequencer {
  /**
   * @param {object} opts
   *   bytes       Uint8Array of the whole container
   *   machine     a constructed Machine, already wired with onFrame/onDebug/onMusic
   *   makeCpu     () => CPU — called once per PopExe, so each part gets a fresh interpreter
   *   budget      total instruction budget across all parts
   *   shouldStop  () => boolean, polled by run()
   *   onOp        ({index, name, args, opsTotal}) => void, fired before each opcode
   *   onPart      ({kind, block, phase}) => void, fired on every push and pop
   */
  constructor(opts) {
    const { bytes, machine, makeCpu } = opts;
    this.bytes = bytes;
    this.machine = machine;
    this.makeCpu = makeCpu;
    this.budget = opts.budget ?? Infinity;
    this.shouldStop = opts.shouldStop ?? null;
    this.onOp = opts.onOp ?? null;
    this.onPart = opts.onPart ?? null;

    // How much virtual time a drawless slice and a WaitMusic iteration are worth. Both are
    // small on purpose: fast-forwarding the clock is not a free speed-up, because the parts
    // do catch-up work proportional to elapsed herzcount. Astral's block 3 costs ~4.7M
    // instructions per frame at a realistic rate and ~20x that if the clock races it.
    this.idleMs = opts.idleMsPerStep ?? 4;
    this.waitMs = opts.waitMsPerStep ?? null;
    this.sliceSize = opts.sliceSize ?? 2_000_000;

    const { entries } = readIxa(bytes);
    this.entries = entries;
    this.script = bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size);

    this.pos = 0;                  // IXAscriptpos
    this.opIndex = 0;              // the same position counted in opcodes, for onOp
    this.opsTotal = countOps(this.script);
    this.stack = [];               // partstack[256]; stack.length is partpointer
    this.part = null;              // {cpu, block} while a PopExe is in flight
    this.wait = null;              // {target} while a WaitMusic is in flight
    this.done = false;
    this.error = null;

    // cpu.reset() zeroes cpu.count and each part gets its own CPU, so both totals have to
    // be banked as parts finish; `executed` adds back whatever the live part has retired.
    this.instructions = 0;
    this.trampolines = 0;

    // The very first loadExe keeps the epoch loadExe itself sets, so a single-exe script
    // behaves exactly as the pre-sequencer path did, down to the derived music clock.
    this.firstLoad = true;
    this.warnedNoMusic = false;
  }

  get executed() { return this.instructions + (this.part ? this.part.cpu.count : 0); }
  get cpu() { return this.part ? this.part.cpu : null; }

  /** Drive step() to completion. Node has nothing better to do; the worker paces itself. */
  async run() {
    while (!this.done) {
      const room = this.budget - this.executed;
      if (room <= 0 || this.shouldStop?.()) break;
      // A wait with no music behind it retires no instructions, so the budget can never
      // end it and this loop would never return. step() itself keeps spinning, as
      // WaitMusic does; only the driver gives up.
      if (this.step(Math.min(this.sliceSize, room)).stalled) break;
    }
    return this;
  }

  /**
   * One bounded unit of work: a slice of the running part, one WaitMusic iteration, or
   * exactly one script opcode. Never blocks. Returns {state} for a driver that wants to
   * know what just happened; everything worth observing also goes through onOp/onPart.
   */
  step(maxInstructions = this.sliceSize) {
    const m = this.machine;
    if (this.done) return { state: 'done' };

    // BreakPart (d32load.c:247-255) sets escaped and, if a part is running, forces it
    // through the host return address. We drop the part between slices instead: it is
    // being thrown away either way, and unwinding the CPU would mean synthesising a far
    // return into an interpreter that is mid-instruction from its own point of view.
    if (m.escaped) {
      if (this.part) {
        this.instructions += this.part.cpu.count;
        this.trampolines += this.part.cpu.trampolineCount;
        this.part = null;
        m.freeAllPartmem();
      }
      this.wait = null;
      this.done = true;
      return { state: 'done', escaped: true };
    }

    if (this.part) return this.runSlice(maxInstructions);
    if (this.wait) return this.waitSlice();
    if (this.pos >= this.script.length) { this.done = true; return { state: 'done' }; }
    return this.dispatch();
  }

  // --------------------------------------------------------------- the script loop

  dispatch() {
    const s = this.script, m = this.machine;
    const op = s[this.pos];
    const index = this.opIndex;

    if (!SIZE[op]) {
      // The original advances nothing for an unrecognised opcode and therefore spins on it
      // forever. Stopping is the one deliberate divergence: a hang is not a behaviour worth
      // reproducing, and no shipped container has ever contained one.
      this.error = `unknown script opcode ${op} at byte ${this.pos}`;
      this.done = true;
      return { state: 'error', error: this.error };
    }

    const args = [...s.subarray(this.pos + 1, this.pos + SIZE[op])];
    const name = { 1: 'exe', 2: 'pop', 3: 'music', 4: 'picture', 5: 'waitmusic' }[op];
    this.onOp?.({ index, name, args, opsTotal: this.opsTotal });
    this.pos += SIZE[op];
    this.opIndex++;

    switch (op) {
      case 1: this.pushExe(args[0]); break;
      case 2:
        this.popPart();
        // PopPart only returns to the script loop once the part has finished, so the
        // CheckMessages that follows every opcode belongs at part completion, not here.
        if (this.part) return { state: 'part', block: this.part.block };
        break;
      case 3: this.playMusic(args[0]); break;
      case 4: this.pushPicture(args[0]); break;
      case 5:
        this.wait = { target: args[0] * 256 + args[1] };
        m.checkMessages();
        return { state: 'wait', target: this.wait.target };
    }

    m.checkMessages();                                   // d32load.c:691-693
    return { state: 'op', index, name, args };
  }

  // ------------------------------------------------------------------ push and pop

  /** PushExe (d32load.c:275-359): unpack, relocate, build startdemo's frame, push. */
  pushExe(n) {
    const image = unpackBlock(this.bytes, this.entries[n]);
    this.machine.freeAllPartmem();                       // d32load.c:306

    // See the header: the music clock has to survive eleven part loads.
    const keep = this.machine.startTime;
    const loaded = this.machine.loadExe(image);
    if (this.firstLoad) this.firstLoad = false;
    else this.machine.startTime = keep;

    // partstack[].esp is dead storage in the original too — PopExe reads it and then
    // overwrites it with a fresh 64000-byte block (d32load.c:374-376), which is what
    // loadExe already allocates. Only the loaded image is worth carrying.
    this.stack.push({ type: 1, block: n, loaded });
    this.onPart?.({ kind: 'exe', block: n, phase: 'push' });
  }

  /** PushPicture (d32load.c:496-542): unpack, remap the pixels, push. */
  pushPicture(n) {
    const pic = parsePicture(unpackBlock(this.bytes, this.entries[n]));
    this.machine.freeAllPartmem();                       // d32load.c:516

    // The C unpacks each RGB565 pixel and repacks it through hrcomp/hrmask & co, which
    // DemoMain copies out of gfxmodeinfo after probing the mode. machine.js pins both
    // component sets to plain RGB565, for which that remap is the identity, so the bytes
    // go through untouched. Assert the premise rather than assume it: on a framebuffer
    // that was ever not 565 this would silently produce swapped channels.
    const g = this.machine.mem, at = this.machine.gfx;
    const comps = [['hrcomp', 11], ['hrmask', 5], ['hgcomp', 5], ['hgmask', 6],
                   ['hbcomp', 0], ['hbmask', 5]];
    for (const [field, want] of comps) {
      if (g.getUint8(at + GFX[field]) !== want) {
        throw new Error(`picture blit assumes RGB565, but gfxmodeinfo.${field} is `
                        + `${g.getUint8(at + GFX[field])} not ${want}`);
      }
    }

    this.stack.push({ type: 2, block: n, pic });
    this.onPart?.({ kind: 'picture', block: n, phase: 'push' });
  }

  /** PopPart (d32load.c:419-426): partpointer--, then dispatch on the entry's type. */
  popPart() {
    const e = this.stack.pop();
    if (!e) throw new Error(`part stack underflow at script byte ${this.pos}`);
    if (e.type === 1) {
      // PopExe puts the mode back to 320x200 before every part, which is also what
      // restores it after a picture blit left it at 800x600 (d32load.c:367).
      this.machine.setVideoResolution(320, 200);
      const cpu = this.makeCpu();
      cpu.reset(e.loaded);
      // `loaded` is carried through so an observer can reach the relocated image base
      // while the part runs. The Pandora texture tables are image-relative, and their
      // addresses are only knowable once relocation has placed the image.
      this.part = { cpu, block: e.block, loaded: e.loaded };
    } else {
      this.popPicture(e);
    }
  }

  /** PopPicture (d32load.c:399-417): set the mode, blit, present. No x86 involved. */
  popPicture(e) {
    const m = this.machine;
    const { width, height, pixels } = e.pic;
    m.setVideoResolution(width, height);
    m.u8.set(pixels, m.mem.getUint32(m.gfx + GFX.tclfb, true));
    e.pic = null;                                        // IXDRV_Free(partstack[].memptr)
    // IXDRV_CopyScreen at d32load.c:416 — a picture is a presented frame like any other,
    // which is what makes the blits observable from outside.
    m.copyScreen();
    this.onPart?.({ kind: 'picture', block: e.block, phase: 'pop' });
  }

  // ----------------------------------------------------------------- part execution

  /**
   * A slice of the running part. A part ends by far-returning to the address startdemo
   * pushed (code.asm's `retadr`, TRAMP.hostReturn here), which the CPU reports as a halt.
   */
  runSlice(maxInstructions) {
    const m = this.machine;
    const { cpu, block } = this.part;
    const before = m.frames;

    cpu.run(maxInstructions);

    // copyScreen already advanced the virtual clock for every frame it presented; only a
    // slice that drew nothing needs a nudge, and only to keep a music-gated part moving.
    if (m.clock === 'virtual' && m.frames === before) m.virtualMs += this.idleMs;

    if (!cpu.halted) return { state: 'part', block };

    this.instructions += cpu.count;
    this.trampolines += cpu.trampolineCount;
    const reason = cpu.haltReason;
    this.part = null;
    // Mandatory, not hygiene: eleven Astral parts share one 6 MB heap that AllocPartmem
    // only ever bumps, and machine.js throws outright when it runs out (d32load.c:386).
    m.freeAllPartmem();
    this.onPart?.({ kind: 'exe', block, phase: 'pop' });
    m.checkMessages();                                   // deferred from the `pop` opcode
    return { state: 'part-done', block, reason };
  }

  /**
   * One iteration of WaitMusic (d32load.c:389-397). The C spins while the target is
   * strictly greater than the current position, so this exits when the target is reached
   * OR passed — a row can be stepped over entirely when the clock granularity is coarse.
   */
  waitSlice() {
    const m = this.machine;
    m.updateMusic();
    m.checkMessages();

    if (this.wait.target <= m.musicPos * 256 + m.musicRow) {
      this.wait = null;
      m.checkMessages();
      return { state: 'wait-done' };
    }

    // With no module playing UpdateMusic pins mustime at 0:0 forever (d32load.c:556-560),
    // so this wait provably cannot end on its own. Not a heuristic and not a timeout: it
    // is decidable from the absence of any music source, which is why run() acts on it.
    const stalled = !m.xm && !m.externalMusic;
    if (stalled && !this.warnedNoMusic) {
      this.warnedNoMusic = true;
      m.onDebug(`WaitMusic(${this.wait.target >> 8},${this.wait.target & 0xff}) with no `
                + 'music playing: the position is pinned at 0:0 and this will not end');
    }

    // WaitMusic presents nothing at all, so under the virtual clock it is the sequencer or
    // nobody. One frame's worth per iteration keeps the wait roughly real-time-shaped
    // rather than jumping to the target, which the parts' catch-up work would punish.
    if (m.clock === 'virtual') m.virtualMs += this.waitMs ?? (1000 / m.fps);
    return { state: 'wait', stalled };
  }

  // ---------------------------------------------------------------------- music

  /**
   * PlayMusic (d32load.c:447-493) for a stored module block.
   *
   * Not the same thing as fardoint's 'TBL1', which machine.startXm implements: TBL1 also
   * moves timerrate to 140 (d32load.c:196), where PlayMusic leaves it at 70. Restoring the
   * rate around the call is preferred over a flag on startXm, whose behaviour on the TBL1
   * path is fingerprinted. startXm's reset of lastTick/herzcount/startTime is wanted here:
   * in Astral the music opcode runs before any part has executed one instruction, so this
   * puts the derived sound-off position at 0:0 exactly when the song starts — which is what
   * the script's waitmusic ops and the parts' own in-code music gates are counting from.
   */
  playMusic(n) {
    const m = this.machine;
    const data = unpackBlock(this.bytes, this.entries[n]);
    m.freeAllPartmem();                                  // d32load.c:469

    // Permanent, not part memory: startXm keeps a live subarray of these bytes for as long
    // as the demo runs, and the part heap is recycled after every part. ~1 MB for Astral,
    // against 64 MB of address space and 6.4 MB of part images — affordable.
    const at = m.alloc(data.length);
    m.u8.set(data, at);

    const rate = m.timerRate;
    m.startXm(at, data.length);                          // also fires onMusic, which is how
    m.timerRate = rate;                                  // the browser gets its audio
    this.onPart?.({ kind: 'music', block: n, phase: 'push' });
  }
}

/** How many opcodes the script holds, for onOp's progress reporting. */
function countOps(script) {
  let i = 0, n = 0;
  while (i < script.length) { i += SIZE[script[i]] ?? 1; n++; }
  return n;
}
