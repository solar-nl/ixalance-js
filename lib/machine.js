// The iXalance host: a flat address space, the gfxmodeinfo struct the demos read
// directly, the callback trampolines they call, and the stack frame startdemo builds.
//
// Everything here mirrors d32load.c / code.asm / main.cpp. The demos never touch DOS,
// the BIOS or VGA registers, so this is the whole hardware surface they see.

import { parseD32, relocate } from './d32.js';

// worker.js imports this module with an explicit browser revision. Keeping the revision
// beside the implementation makes the worker log prove which timer semantics it loaded.
export const MACHINE_REVISION = 'prod-switching-v15';

// Trampoline addresses live above the address space so the CPU can spot a call into
// the host by range check alone. code.asm has four distinct trampolines plus the
// far return address startdemo's `call far` pushes.
export const MAGIC_BASE = 0xf0000000;
export const TRAMP = {
  basic: MAGIC_BASE + 0x00,        // basictramp   -> farbank()
  showp: MAGIC_BASE + 0x10,        // farshowptramp-> farshowp()
  malloc: MAGIC_BASE + 0x20,       // farmalloctramp
  doint: MAGIC_BASE + 0x30,        // fardointtramp
  hostReturn: MAGIC_BASE + 0x40,   // `retadr` in startdemo
};

// Segment selectors. Flat model: every selector has base 0, so these are only ever
// stored, compared, or added by segment fixups.
export const SEL_CS = 0x1c;
export const SEL_DS = 0x24;

// Tgfxmodeinfo, #pragma pack(1). Field order from ixalance.h; the comment there warns
// this layout must match byte for byte because the demos read it directly.
export const GFX = {
  curmode: 0, tempstat: 1, forcebuf: 2, forcevr: 3,
  tclfb: 4, htclfb: 8, gfxlfb: 12,
  xres: 16, yres: 20, gfxscanlen: 24, gfxbanksize: 28, gfxmode: 32,
  tcscanlen: 34, tcxres: 38, tcyres: 42, tcbanksize: 46, tcmode: 50,
  tcbitmode: 52, rcomp: 53, gcomp: 54, bcomp: 55,
  rmask: 56, gmask: 57, bmask: 58, tcstatus: 59,
  htcscanlen: 60, htcbanksize: 64, htcmode: 68, htcbitmode: 70,
  hrcomp: 71, hgcomp: 72, hbcomp: 73, hrmask: 74, hgmask: 75, hbmask: 76,
  panproc: 77, bankproc: 81, vgaofs: 85, convtab: 89, reallfb: 93, dummyadd: 97,
  SIZE: 101,
};

const MAX_W = 800, MAX_H = 600;

/**
 * Size of the part-memory heap for a given demo, in bytes.
 *
 * d32load.c allocates 13 MB, then special-cases exactly one title by name:
 * `if (!strcmp(" Astral Blur", IXA_Name)) PARTMEM = 1024 * 1024 * 6;` — note the leading
 * space, which is how the name is actually stored in the container header.
 */
export function partmemFor(demoname) {
  return (demoname.trim() === 'Astral Blur' ? 6 : 13) * 1024 * 1024;
}

export class Machine {
  /** @param {object} opts {size, partmem, onFrame, onDebug} */
  constructor(opts = {}) {
    this.size = opts.size ?? 64 * 1024 * 1024;
    this.buf = new ArrayBuffer(this.size);
    this.u8 = new Uint8Array(this.buf);
    this.mem = new DataView(this.buf);

    // Leave the first megabyte unused so a null dereference is obvious.
    this.brk = 0x00100000;
    this.onFrame = opts.onFrame ?? (() => {});
    this.onDebug = opts.onDebug ?? (() => {});
    this.onMusic = opts.onMusic ?? null;

    this.gfx = this.alloc(GFX.SIZE);
    this.fb = this.alloc(MAX_W * MAX_H * 2);

    // code.asm does `mov esi, balmodeinfo`, which in NASM loads the ADDRESS of the C
    // variable rather than its value — so the demo receives a pointer to a pointer and
    // dereferences it (`mov esi, [esi]`) before snapshotting 101 bytes of struct.
    this.pGfx = this.alloc(4);
    this.pHerzcount = this.alloc(4);
    this.pMustime = this.alloc(4);       // {u8 timepos; u8 timerow}

    // PARTMEM: 13 MB, or 6 MB for Astral Blur (d32load.c special-cases it by name).
    this.partmemSize = opts.partmem ?? 13 * 1024 * 1024;
    this.partmem = this.alloc(this.partmemSize);
    this.partmemUsed = 0;

    this.mem.setUint32(this.pGfx, this.gfx, true);

    this.width = 0;
    this.height = 0;
    this.frames = 0;
    this.escaped = false;
    this.startTime = 0;

    // Clock source. 'wall' matches the real loader, which drives everything from real
    // time. 'virtual' advances a fixed step per presented frame, so a slow interpreter
    // still walks the whole timeline instead of having the music race ahead of it.
    this.clock = opts.clock ?? 'wall';
    this.fps = opts.fps ?? 50;
    this.virtualMs = 0;

    // UpdateMusic() state. timerrate is 70 until a TBL1 request bumps it to 140.
    // herzcount itself lives in emulated memory: the parts receive its address and use it
    // as a consumable tick accumulator, commonly writing zero after each frame.
    this.timerRate = 70;
    this.lastTick = 0;
    this.herzcount = 0;
    this.xm = null;
    // Set once a real player starts reporting positions; until then the position is
    // derived from the module's own tempo, which is only an approximation.
    this.externalMusic = false;
    this.musicPos = 0;
    this.musicRow = 0;
    this.musicGeneration = 0;

    this.setVideoResolution(320, 200);
  }

  /** Permanent bump allocation, 4 KB aligned like AllocPartmem. */
  alloc(bytes) {
    const at = (this.brk + 0xfff) & ~0xfff;
    this.brk = at + ((bytes + 0xfff) & ~0xfff);
    if (this.brk > this.size) throw new Error('flat address space exhausted');
    return at;
  }

  /** AllocPartmem: bump inside the part heap, reset wholesale by freeAllPartmem. */
  allocPartmem(bytes) {
    const need = (bytes + 4096) & 0xfffff000;
    const at = this.partmem + this.partmemUsed;
    this.partmemUsed += need;
    if (this.partmemUsed > this.partmemSize) {
      throw new Error(`part memory exhausted (wanted ${bytes})`);
    }
    return at;
  }

  freeAllPartmem() { this.partmemUsed = 0; }

  // ---------------------------------------------------------------- gfxmodeinfo

  /** IXDRV_SetVideoResolution + IXDRV_InitScreen, for 16-bit RGB565. */
  setVideoResolution(width, height) {
    this.width = width;
    this.height = height;
    const g = this.gfx, m = this.mem;

    for (const f of ['tclfb', 'htclfb', 'gfxlfb']) m.setUint32(g + GFX[f], this.fb, true);

    m.setUint32(g + GFX.tcxres, width, true);
    m.setUint32(g + GFX.tcyres, height, true);
    m.setUint32(g + GFX.tcscanlen, width * 2, true);
    m.setUint32(g + GFX.xres, width, true);
    m.setUint32(g + GFX.yres, height, true);
    m.setUint32(g + GFX.gfxscanlen, width * 2, true);

    // RGB565 component shifts and widths, as main.cpp's non-SDL branch sets them.
    const comps = { rcomp: 11, rmask: 5, gcomp: 5, gmask: 6, bcomp: 0, bmask: 5 };
    for (const [k, v] of Object.entries(comps)) m.setUint8(g + GFX[k], v);
    // Mirror into the hi-colour set; Astral Blur probes these for 800x600.
    const hi = { hrcomp: 11, hrmask: 5, hgcomp: 5, hgmask: 6, hbcomp: 0, hbmask: 5 };
    for (const [k, v] of Object.entries(hi)) m.setUint8(g + GFX[k], v);
    m.setUint32(g + GFX.htcscanlen, width * 2, true);
    m.setUint8(g + GFX.tcbitmode, 16);
    m.setUint8(g + GFX.htcbitmode, 16);
  }

  /** Report where the audio player actually is, in order position and row. */
  setMusicPosition(pos, row, generation = null) {
    if (generation !== null && generation !== this.musicGeneration) return false;
    this.externalMusic = true;
    this.musicPos = pos;
    this.musicRow = row;
    return true;
  }

  /** IXDRV_GetTime: a 1000 Hz counter. */
  getTime() { return (this.now() - this.startTime) | 0; }

  now() {
    if (this.clock === 'virtual') return this.virtualMs;
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  // This must remain one shared variable, as it is in d32load.c. Keeping a second JS-side
  // total loses writes made through the pointer startdemo gives the executable: Astral
  // Blur clears the counter after consuming a frame's ticks, and restoring the cumulative
  // total makes several effects accelerate dramatically.
  get herzcount() { return this.mem.getInt32(this.pHerzcount, true); }
  set herzcount(value) { this.mem.setInt32(this.pHerzcount, value | 0, true); }

  // ---------------------------------------------------------------- trampolines

  /**
   * Dispatch a call that landed on a trampoline address. Returns register effects for
   * the CPU to apply before the implicit retf, matching what each tramp does after
   * its popad in code.asm.
   */
  callTrampoline(addr, regs) {
    switch (addr) {
      case TRAMP.basic:                       // farbank(): housekeeping only
        this.checkMessages();
        this.updateMusic();
        return null;

      case TRAMP.showp:                       // farshowp(): also flips the buffer
        this.checkMessages();
        this.copyScreen();
        this.updateMusic();
        return null;

      case TRAMP.malloc: {                    // farmalloc(): temp1 = edx on entry
        this.checkMessages();
        this.updateMusic();
        const size = regs.edx >>> 0;
        const ptr = size > 0 ? this.allocPartmem(size) : 0;
        this.onDebug(`farmalloc(${size}) -> 0x${ptr.toString(16)}`);
        return { eax: 0, edx: ptr, cf: 0 };   // xor eax,eax / mov edx,[tmpptr1] / clc
      }

      case TRAMP.doint: {                     // fardoint(): temp1 = eax on entry
        this.checkMessages();
        this.updateMusic();
        const eax = regs.eax >>> 0;
        // 'TBL1': start a new XM, held at esi with length ecx.
        if (eax === 0x54424c31) {
          this.onDebug(`fardoint TBL1: new XM at 0x${(regs.esi >>> 0).toString(16)} len ${regs.ecx >>> 0}`);
          this.startXm(regs.esi >>> 0, regs.ecx >>> 0);
          return { eax };
        }
        // 'TBL3': get position in music, as (row + 1) + (pos << 8). Returning eax
        // unchanged here reads as an enormous position and makes a demo quit at once.
        if (eax === 0x54424c33) {
          return { eax: this.xm ? ((this.musicRow + 1) + (this.musicPos << 8)) : 0 };
        }
        // TBL2 and TBL4 exist; d32load.c says "forgot what they do" and leaves eax
        // alone, so do the same. Anything else is a leftover DOS interrupt request.
        return { eax };                       // mov eax,[temp1]
      }

      default:
        throw new Error(`call to unknown host address 0x${addr.toString(16)}`);
    }
  }

  // ------------------------------------------------------------------- drivers

  checkMessages() {}

  copyScreen() {
    this.frames++;
    if (this.clock === 'virtual') this.virtualMs += 1000 / this.fps;
    this.onFrame(this.u8.subarray(this.fb, this.fb + this.width * this.height * 2),
                 this.width, this.height);
  }

  /**
   * Port of UpdateMusic(). herzcount advances at timerrate Hz; mustime carries the
   * module's pattern position and row, which the real loader reads out of MIDAS.
   *
   * With no audio backend the position is derived from the clock and the module's own
   * tempo and pattern lengths. That is an approximation — tempo and BPM changes made by
   * pattern effects are not tracked — but it is enough to drive a demo's timeline and
   * to make WaitMusic terminate.
   */
  updateMusic() {
    // Both operands are ints in the original C, so 70 Hz uses a 14 ms quantum and the
    // TBL1 140 Hz mode uses 7 ms. Preserve that integer division rather than silently
    // turning them into exact floating-point rates.
    const tick = Math.floor(this.getTime() / Math.floor(1000 / this.timerRate));
    if (tick > this.lastTick) {
      this.herzcount += tick - this.lastTick;
      this.lastTick = tick;
    }
    if (this.herzcount < 0) this.herzcount = 0;

    let pos = 0, row = 0;
    if (this.externalMusic) {
      // A real player is running and reporting where it actually is. Preferred, because
      // the demo steers its timeline by this and the audio is the authority on it.
      pos = this.musicPos; row = this.musicRow;
      this.mem.setUint8(this.pMustime, pos & 0xff);
      this.mem.setUint8(this.pMustime + 1, row & 0xff);
      return;
    }
    if (this.xm) {
      const rowsPerSecond = (this.xm.bpm * 2 / 5) / this.xm.speed;
      let rows = Math.floor((this.getTime() / 1000) * rowsPerSecond);
      const { rowCounts } = this.xm;
      for (let i = 0; i < rowCounts.length; i++) {
        if (rows < rowCounts[i]) { pos = i; row = rows; break; }
        rows -= rowCounts[i];
        pos = i; row = rowCounts[i] - 1;      // hold at the end of the song
      }
    }
    this.mem.setUint8(this.pMustime, pos & 0xff);
    this.mem.setUint8(this.pMustime + 1, row & 0xff);
    this.musicPos = pos;
    this.musicRow = row;
  }

  /**
   * A 'TBL1' request: the demo hands over an XM module it generated in memory. Parse
   * enough of the header to run the clock, and pass the bytes to any audio backend.
   */
  startXm(ptr, len) {
    this.timerRate = 140;                     // as fardoint does for TBL1
    const bytes = this.u8.subarray(ptr, ptr + len);
    const m = this.mem;

    const headerSize = m.getUint32(ptr + 0x3c, true);
    const songLength = m.getUint16(ptr + 0x40, true);
    const numPatterns = m.getUint16(ptr + 0x46, true);
    const speed = m.getUint16(ptr + 0x4c, true) || 6;
    const bpm = m.getUint16(ptr + 0x4e, true) || 125;

    // Walk the pattern headers for exact row counts, then map the order table onto them.
    const patternRows = [];
    let at = ptr + 60 + headerSize;
    for (let i = 0; i < numPatterns; i++) {
      const hdrLen = m.getUint32(at, true);
      const rows = m.getUint16(at + 5, true);
      patternRows.push(rows || 64);
      at += hdrLen + m.getUint16(at + 7, true);
    }
    const order = [];
    for (let i = 0; i < songLength; i++) order.push(m.getUint8(ptr + 0x50 + i));
    const rowCounts = order.map((p) => patternRows[p] ?? 64);

    this.xm = { bytes, speed, bpm, songLength, numPatterns, rowCounts };
    this.musicGeneration++;
    this.lastTick = 0;
    this.herzcount = 0;
    this.startTime = this.now();
    // TBL1 replaces the currently playing module. If an audio backend was already
    // reporting XM 1, keep externalMusic enabled but synchronously reset the public
    // position before handing XM 2 to that asynchronous backend. Otherwise the demo can
    // observe XM 1's terminal order for up to a report interval and skip the opening of
    // the new scene.
    this.musicPos = 0;
    this.musicRow = 0;
    this.mem.setUint8(this.pMustime, 0);
    this.mem.setUint8(this.pMustime + 1, 0);
    this.onDebug(`XM: ${len} bytes, ${songLength} orders, ${numPatterns} patterns, `
                 + `speed ${speed}, ${bpm} BPM, ${rowCounts.reduce((a, b) => a + b, 0)} rows`);
    this.onMusic?.(bytes);
  }

  // ------------------------------------------------------------------ part load

  /**
   * PushExe: load a block's DOS/32A image into the flat space, relocate it, and build
   * the stack frame startdemo hands the demo. Returns the initial CPU state.
   */
  loadExe(block) {
    const d32 = parseD32(block);
    const base = this.alloc(d32.memrequired);
    this.u8.set(d32.image, base);
    const counts = relocate(this.mem, base, d32.fixups, SEL_DS);

    // PopExe allocates a fresh 64000-byte stack and ignores the header's SP.
    const stackBase = this.alloc(64000);
    let esp = stackBase + 63900;

    const pushDword = (v) => { esp -= 4; this.mem.setUint32(esp, v >>> 0, true); };
    const pushWord = (v) => { esp -= 2; this.mem.setUint16(esp, v & 0xffff, true); };
    const pushFar = (off) => { pushDword(off); pushWord(SEL_CS); };

    // Exactly the push order in startdemo.
    pushFar(TRAMP.basic);
    pushFar(TRAMP.basic);
    pushFar(TRAMP.showp);
    pushFar(TRAMP.basic);
    pushFar(TRAMP.basic);
    pushDword(this.pHerzcount);
    pushDword(this.pMustime);
    pushFar(TRAMP.doint);
    pushFar(TRAMP.malloc);

    // `call far [runexe]` pushes CS then EIP.
    pushDword(SEL_CS);
    pushDword(TRAMP.hostReturn);

    this.startTime = this.now();

    return {
      base,
      entry: (base + d32.startip) >>> 0,
      d32,
      relocs: counts,
      regs: {
        eax: 0, ecx: 0, edx: 0, ebx: SEL_CS,
        esp, ebp: 0, esi: this.pGfx, edi: 0,
        cs: SEL_CS, ds: SEL_DS, es: SEL_DS, fs: SEL_DS, gs: SEL_DS, ss: SEL_DS,
      },
    };
  }
}
