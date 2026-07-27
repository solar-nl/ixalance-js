// x87 FPU core.
//
// The register stack is held as JS doubles rather than 80-bit extended precision. That
// is the one deliberate fidelity compromise in this port: intermediates that the real
// FPU keeps at 64-bit mantissa are rounded to 53 bits here. For the integer-and-texture
// math these demos do it should be invisible, but it is the first thing to suspect if
// geometry ever drifts.
//
// Rounding for the integer stores (fist/fistp) does honour the control word's RC field,
// because demos routinely switch it to truncate and that changes visible results.
//
// Every store is preceded by cpu.codeWrite(). This code reaches cpu.mem directly rather
// than going through cpu.wr(), so without it an x87 store into a page the CPU has cached
// predecoded blocks from would go unnoticed. It is one typed-array load that misses.

const RC_NEAREST = 0, RC_DOWN = 1, RC_UP = 2, RC_TRUNC = 3;

export class FPU {
  constructor(cpu) {
    this.cpu = cpu;
    this.st = new Float64Array(8);
    this.empty = new Uint8Array(8).fill(1);
    this.top = 0;
    this.cw = 0x037f;         // default control word: round nearest, all exceptions masked
    this.sw = 0;
    this.c0 = 0; this.c1 = 0; this.c2 = 0; this.c3 = 0;
  }

  init() {
    this.empty.fill(1);
    this.top = 0;
    this.cw = 0x037f;
    this.sw = 0;
    this.c0 = this.c1 = this.c2 = this.c3 = 0;
  }

  get rc() { return (this.cw >> 10) & 3; }

  idx(i) { return (this.top + i) & 7; }
  get(i) { return this.st[this.idx(i)]; }
  set(i, v) { const k = this.idx(i); this.st[k] = v; this.empty[k] = 0; }

  push(v) {
    this.top = (this.top - 1) & 7;
    this.st[this.top] = v;
    this.empty[this.top] = 0;
  }
  pop() {
    const v = this.st[this.top];
    this.empty[this.top] = 1;
    this.top = (this.top + 1) & 7;
    return v;
  }

  statusWord() {
    return (this.sw & ~0x4700) | (this.c0 << 8) | (this.c1 << 9) | (this.c2 << 10)
           | (this.c3 << 14) | ((this.top & 7) << 11);
  }

  compare(a, b, popCount = 0) {
    if (Number.isNaN(a) || Number.isNaN(b)) { this.c3 = 1; this.c2 = 1; this.c0 = 1; }
    else if (a > b) { this.c3 = 0; this.c2 = 0; this.c0 = 0; }
    else if (a < b) { this.c3 = 0; this.c2 = 0; this.c0 = 1; }
    else { this.c3 = 1; this.c2 = 0; this.c0 = 0; }
    this.c1 = 0;
    for (let i = 0; i < popCount; i++) this.pop();
  }

  round(v) {
    switch (this.rc) {
      case RC_TRUNC: return Math.trunc(v);
      case RC_DOWN: return Math.floor(v);
      case RC_UP: return Math.ceil(v);
      case RC_NEAREST:
      default: {
        // Round half to even, which is what the FPU does in the default mode.
        const f = Math.floor(v);
        const diff = v - f;
        if (diff > 0.5) return f + 1;
        if (diff < 0.5) return f;
        return (f % 2 === 0) ? f : f + 1;
      }
    }
  }

  // ------------------------------------------------------- 80-bit extended format

  readExtended(addr) {
    const m = this.cpu.mem;
    const lo = m.getUint32(addr, true) >>> 0;
    const hi = m.getUint32(addr + 4, true) >>> 0;
    const se = m.getUint16(addr + 8, true);
    const sign = (se & 0x8000) ? -1 : 1;
    const exp = se & 0x7fff;
    const mant = hi * 4294967296 + lo;
    if (exp === 0 && mant === 0) return sign * 0;
    if (exp === 0x7fff) return mant === 0x8000000000000000 ? sign * Infinity : NaN;
    return sign * mant * Math.pow(2, exp - 16383 - 63);
  }

  writeExtended(addr, v) {
    this.cpu.codeWrite(addr, 10);
    const m = this.cpu.mem;
    const sign = (v < 0 || Object.is(v, -0)) ? 0x8000 : 0;
    v = Math.abs(v);
    let exp = 0, mant = 0;
    if (v === 0) { exp = 0; mant = 0; }
    else if (!Number.isFinite(v)) { exp = 0x7fff; mant = 0x8000000000000000; }
    else if (Number.isNaN(v)) { exp = 0x7fff; mant = 0xc000000000000000; }
    else {
      exp = Math.floor(Math.log2(v));
      let frac = v / Math.pow(2, exp);
      if (frac >= 2) { frac /= 2; exp++; } else if (frac < 1) { frac *= 2; exp--; }
      mant = frac * Math.pow(2, 63);
      exp += 16383;
    }
    const lo = mant % 4294967296;
    const hi = Math.floor(mant / 4294967296);
    m.setUint32(addr, lo >>> 0, true);
    m.setUint32(addr + 4, hi >>> 0, true);
    m.setUint16(addr + 8, sign | exp, true);
  }

  // ----------------------------------------------------------------- arithmetic

  /** The eight arithmetic slots shared by D8/DC/DA/DE, in encoding order. */
  arith(slot, a, b) {
    switch (slot) {
      case 0: return a + b;          // fadd
      case 1: return a * b;          // fmul
      case 4: return a - b;          // fsub
      case 5: return b - a;          // fsubr
      case 6: return a / b;          // fdiv
      case 7: return b / a;          // fdivr
    }
    return NaN;
  }

  /**
   * Execute one x87 instruction. `op` is the primary opcode (0xd8..0xdf); the ModRM byte
   * has not been consumed yet, unless the caller has already decoded it and hands the
   * result in — which is what the CPU's block cache does, having decoded it once.
   */
  execute(op, pre) {
    const cpu = this.cpu;
    const m = pre === undefined ? cpu.modrm() : pre;
    const reg = m.reg;
    const isMem = m.addr !== null;

    switch (op) {
      // --- D8: single-precision memory, or ST(0) op ST(i) ---------------------
      case 0xd8: {
        const b = isMem ? cpu.mem.getFloat32(m.addr, true) : this.get(m.rm);
        if (reg === 2) { this.compare(this.get(0), b); return; }        // fcom
        if (reg === 3) { this.compare(this.get(0), b, 1); return; }     // fcomp
        this.set(0, this.arith(reg, this.get(0), b));
        return;
      }

      // --- DC: double-precision memory, or ST(i) op ST(0) --------------------
      case 0xdc: {
        if (isMem) {
          const b = cpu.mem.getFloat64(m.addr, true);
          if (reg === 2) { this.compare(this.get(0), b); return; }
          if (reg === 3) { this.compare(this.get(0), b, 1); return; }
          this.set(0, this.arith(reg, this.get(0), b));
          return;
        }
        // Register form targets ST(i), and the reverse-subtract/divide slots swap.
        const slot = reg === 4 ? 5 : reg === 5 ? 4 : reg === 6 ? 7 : reg === 7 ? 6 : reg;
        this.set(m.rm, this.arith(slot, this.get(m.rm), this.get(0)));
        return;
      }

      // --- DE: 16-bit integer memory, or ST(i) op ST(0) with pop -------------
      case 0xde: {
        if (isMem) {
          const b = cpu.mem.getInt16(m.addr, true);
          if (reg === 2) { this.compare(this.get(0), b); return; }
          if (reg === 3) { this.compare(this.get(0), b, 1); return; }
          this.set(0, this.arith(reg, this.get(0), b));
          return;
        }
        if (m.raw === 0xd9) { this.compare(this.get(0), this.get(1), 2); return; }  // fcompp
        const slot = reg === 4 ? 5 : reg === 5 ? 4 : reg === 6 ? 7 : reg === 7 ? 6 : reg;
        this.set(m.rm, this.arith(slot, this.get(m.rm), this.get(0)));
        this.pop();
        return;
      }

      // --- DA: 32-bit integer memory, or fcmov / fucompp --------------------
      case 0xda: {
        if (isMem) {
          const b = cpu.mem.getInt32(m.addr, true);
          if (reg === 2) { this.compare(this.get(0), b); return; }
          if (reg === 3) { this.compare(this.get(0), b, 1); return; }
          this.set(0, this.arith(reg, this.get(0), b));
          return;
        }
        if (m.raw === 0xe9) { this.compare(this.get(0), this.get(1), 2); return; }  // fucompp
        throw cpu.unimplemented(`x87 da /${reg} reg form (raw 0x${m.raw.toString(16)})`);
      }

      // --- D9: loads/stores, control word, and the transcendental block ------
      case 0xd9: {
        if (isMem) {
          switch (reg) {
            case 0: this.push(cpu.mem.getFloat32(m.addr, true)); return;      // fld m32
            case 2: cpu.codeWrite(m.addr, 4); cpu.mem.setFloat32(m.addr, this.get(0), true); return;  // fst m32
            case 3: cpu.codeWrite(m.addr, 4); cpu.mem.setFloat32(m.addr, this.pop(), true); return;   // fstp m32
            case 5: this.cw = cpu.mem.getUint16(m.addr, true); return;        // fldcw
            case 7: cpu.codeWrite(m.addr, 2); cpu.mem.setUint16(m.addr, this.cw, true); return;       // fnstcw
            case 4: return;   // fldenv: environment is not modelled
            case 6: return;   // fnstenv
          }
          throw cpu.unimplemented(`x87 d9 /${reg} memory form`);
        }
        const raw = m.raw;
        if (raw >= 0xc0 && raw <= 0xc7) { this.push(this.get(raw - 0xc0)); return; }   // fld st(i)
        if (raw >= 0xc8 && raw <= 0xcf) {                                              // fxch
          const i = raw - 0xc8, a = this.get(0);
          this.set(0, this.get(i)); this.set(i, a);
          return;
        }
        switch (raw) {
          case 0xd0: return;                                     // fnop
          case 0xe0: this.set(0, -this.get(0)); return;           // fchs
          case 0xe1: this.set(0, Math.abs(this.get(0))); return;  // fabs
          case 0xe4: this.compare(this.get(0), 0); return;        // ftst
          case 0xe5: {                                            // fxam
            const v = this.get(0);
            this.c1 = (v < 0 || Object.is(v, -0)) ? 1 : 0;
            if (this.empty[this.idx(0)]) { this.c3 = 1; this.c2 = 0; this.c0 = 1; }
            else if (Number.isNaN(v)) { this.c3 = 0; this.c2 = 0; this.c0 = 1; }
            else if (!Number.isFinite(v)) { this.c3 = 0; this.c2 = 1; this.c0 = 1; }
            else if (v === 0) { this.c3 = 1; this.c2 = 0; this.c0 = 0; }
            else { this.c3 = 0; this.c2 = 1; this.c0 = 0; }
            return;
          }
          case 0xe8: this.push(1); return;                        // fld1
          case 0xe9: this.push(Math.log2(10)); return;            // fldl2t
          case 0xea: this.push(Math.LOG2E); return;               // fldl2e
          case 0xeb: this.push(Math.PI); return;                  // fldpi
          case 0xec: this.push(Math.log10(2)); return;            // fldlg2
          case 0xed: this.push(Math.LN2); return;                 // fldln2
          case 0xee: this.push(0); return;                        // fldz
          case 0xf0: this.set(0, Math.pow(2, this.get(0)) - 1); return;   // f2xm1
          case 0xf1: {                                            // fyl2x
            const x = this.get(0), y = this.get(1);
            this.pop();
            this.set(0, y * Math.log2(x));
            return;
          }
          case 0xf2: {                                            // fptan
            this.set(0, Math.tan(this.get(0)));
            this.push(1);
            this.c2 = 0;
            return;
          }
          case 0xf3: {                                            // fpatan
            const x = this.get(0), y = this.get(1);
            this.pop();
            this.set(0, Math.atan2(y, x));
            return;
          }
          case 0xf4: {                                            // fxtract
            const v = this.get(0);
            const e = v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v)));
            this.set(0, e);
            this.push(v / Math.pow(2, e));
            return;
          }
          case 0xf5: case 0xf8: {                                 // fprem1 / fprem
            const a = this.get(0), b = this.get(1);
            this.set(0, a - b * Math.trunc(a / b));
            this.c2 = 0;
            return;
          }
          case 0xf6: this.top = (this.top - 1) & 7; return;        // fdecstp
          case 0xf7: this.top = (this.top + 1) & 7; return;        // fincstp
          case 0xf9: {                                            // fyl2xp1
            const x = this.get(0), y = this.get(1);
            this.pop();
            this.set(0, y * Math.log2(x + 1));
            return;
          }
          case 0xfa: this.set(0, Math.sqrt(this.get(0))); return;  // fsqrt
          case 0xfb: {                                            // fsincos
            const v = this.get(0);
            this.set(0, Math.sin(v));
            this.push(Math.cos(v));
            this.c2 = 0;
            return;
          }
          case 0xfc: this.set(0, this.round(this.get(0))); return; // frndint
          case 0xfd: {                                            // fscale
            this.set(0, this.get(0) * Math.pow(2, Math.trunc(this.get(1))));
            return;
          }
          case 0xfe: this.set(0, Math.sin(this.get(0))); this.c2 = 0; return;  // fsin
          case 0xff: this.set(0, Math.cos(this.get(0))); this.c2 = 0; return;  // fcos
        }
        throw cpu.unimplemented(`x87 d9 raw 0x${raw.toString(16)}`);
      }

      // --- DB: 32-bit integer load/store, 80-bit, and the control block -----
      case 0xdb: {
        if (isMem) {
          switch (reg) {
            case 0: this.push(cpu.mem.getInt32(m.addr, true)); return;         // fild m32
            case 1: cpu.codeWrite(m.addr, 4); cpu.mem.setInt32(m.addr, this.round(this.get(0)) | 0, true); this.pop(); return; // fisttp
            case 2: cpu.codeWrite(m.addr, 4); cpu.mem.setInt32(m.addr, this.round(this.get(0)) | 0, true); return; // fist
            case 3: cpu.codeWrite(m.addr, 4); cpu.mem.setInt32(m.addr, this.round(this.pop()) | 0, true); return;  // fistp
            case 5: this.push(this.readExtended(m.addr)); return;              // fld m80
            case 7: this.writeExtended(m.addr, this.pop()); return;            // fstp m80
          }
          throw cpu.unimplemented(`x87 db /${reg} memory form`);
        }
        switch (m.raw) {
          case 0xe0: case 0xe1: case 0xe4: return;      // feni / fdisi / fsetpm: obsolete
          case 0xe2: this.sw = 0; this.c0 = this.c1 = this.c2 = this.c3 = 0; return;  // fnclex
          case 0xe3: this.init(); return;               // fninit
        }
        // fcmovcc / fucomi / fcomi (P6). Treat fucomi/fcomi as ordinary compares.
        if (m.raw >= 0xe8 && m.raw <= 0xf7) {
          this.compare(this.get(0), this.get(m.raw & 7));
          cpu.zf = this.c3; cpu.pf = this.c2; cpu.cf = this.c0; cpu.of = 0; cpu.sf = 0;
          return;
        }
        throw cpu.unimplemented(`x87 db raw 0x${m.raw.toString(16)}`);
      }

      // --- DD: double load/store, ffree, fucom, status word -----------------
      case 0xdd: {
        if (isMem) {
          switch (reg) {
            case 0: this.push(cpu.mem.getFloat64(m.addr, true)); return;       // fld m64
            case 2: cpu.codeWrite(m.addr, 8); cpu.mem.setFloat64(m.addr, this.get(0), true); return;  // fst m64
            case 3: cpu.codeWrite(m.addr, 8); cpu.mem.setFloat64(m.addr, this.pop(), true); return;   // fstp m64
            case 4: return;                                                    // frstor
            case 6: return;                                                    // fnsave
            case 7: cpu.codeWrite(m.addr, 2); cpu.mem.setUint16(m.addr, this.statusWord(), true); return; // fnstsw
          }
          throw cpu.unimplemented(`x87 dd /${reg} memory form`);
        }
        const raw = m.raw;
        if (raw >= 0xc0 && raw <= 0xc7) { this.empty[this.idx(raw - 0xc0)] = 1; return; }  // ffree
        if (raw >= 0xd0 && raw <= 0xd7) { this.set(raw - 0xd0, this.get(0)); return; }     // fst st(i)
        if (raw >= 0xd8 && raw <= 0xdf) { this.set(raw - 0xd8, this.get(0)); this.pop(); return; } // fstp st(i)
        if (raw >= 0xe0 && raw <= 0xe7) { this.compare(this.get(0), this.get(raw - 0xe0)); return; }     // fucom
        if (raw >= 0xe8 && raw <= 0xef) { this.compare(this.get(0), this.get(raw - 0xe8), 1); return; }  // fucomp
        throw cpu.unimplemented(`x87 dd raw 0x${raw.toString(16)}`);
      }

      // --- DF: 16/64-bit integer load/store, fnstsw ax ----------------------
      case 0xdf: {
        if (isMem) {
          switch (reg) {
            case 0: this.push(cpu.mem.getInt16(m.addr, true)); return;         // fild m16
            case 2: cpu.codeWrite(m.addr, 2); cpu.mem.setInt16(m.addr, this.round(this.get(0)), true); return;  // fist m16
            case 3: cpu.codeWrite(m.addr, 2); cpu.mem.setInt16(m.addr, this.round(this.pop()), true); return;   // fistp m16
            case 5: {                                                          // fild m64
              const lo = cpu.mem.getUint32(m.addr, true) >>> 0;
              const hi = cpu.mem.getInt32(m.addr + 4, true);
              this.push(hi * 4294967296 + lo);
              return;
            }
            case 7: {                                                          // fistp m64
              const v = this.round(this.pop());
              cpu.codeWrite(m.addr, 8);
              cpu.mem.setUint32(m.addr, v >>> 0, true);
              cpu.mem.setInt32(m.addr + 4, Math.floor(v / 4294967296), true);
              return;
            }
          }
          throw cpu.unimplemented(`x87 df /${reg} memory form`);
        }
        if (m.raw === 0xe0) { cpu.set16(0, this.statusWord()); return; }        // fnstsw ax
        if (m.raw >= 0xe8 && m.raw <= 0xf7) {
          this.compare(this.get(0), this.get(m.raw & 7), 1);
          cpu.zf = this.c3; cpu.pf = this.c2; cpu.cf = this.c0; cpu.of = 0; cpu.sf = 0;
          return;
        }
        throw cpu.unimplemented(`x87 df raw 0x${m.raw.toString(16)}`);
      }
    }

    throw cpu.unimplemented(`x87 opcode 0x${op.toString(16)}`);
  }
}
