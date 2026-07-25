// A 32-bit x86 interpreter for flat protected mode.
//
// Scope is deliberately narrow: the demo parts run with a single flat segment, no
// paging, no privilege transitions, no interrupts and no I/O ports, because iXalance
// already isolates them from the hardware. What they do use is 386 integer code plus
// heavy x87 — see ../../README.md. x87 is not implemented yet; every unimplemented
// opcode raises an Unimplemented carrying enough context to go and add it.

import { MAGIC_BASE, TRAMP } from './machine.js';
import { FPU } from './fpu.js';

// Register file order matches the x86 encoding: EAX ECX EDX EBX ESP EBP ESI EDI.
export const REG = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };
const REG_NAMES = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const SEG_NAMES = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];

export class Unimplemented extends Error {
  constructor(message, ctx) { super(message); this.name = 'Unimplemented'; Object.assign(this, ctx); }
}
export class Fault extends Error {
  constructor(message, ctx) { super(message); this.name = 'Fault'; Object.assign(this, ctx); }
}

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let bits = 0, v = i;
  while (v) { bits ^= v & 1; v >>= 1; }
  PARITY[i] = bits ? 0 : 1;
}

export class CPU {
  constructor(machine) {
    this.machine = machine;
    this.mem = machine.mem;
    this.u8 = machine.u8;

    this.regs = new Int32Array(8);
    this.seg = { es: 0, cs: 0, ss: 0, ds: 0, fs: 0, gs: 0 };
    this.eip = 0;
    this.cf = 0; this.pf = 0; this.af = 0; this.zf = 0; this.sf = 0; this.of = 0; this.df = 0;

    this.fpu = new FPU(this);

    this.count = 0;
    this.halted = false;
    this.haltReason = null;
    this.trampolineHits = [];

    // Per-instruction decode state.
    this.insStart = 0;
    this.opsize = 4;
    this.addrsize = 4;
    this.segOverride = null;
    this.repPrefix = 0;
  }

  /** Load the initial state produced by Machine.loadExe(). */
  reset(loaded) {
    const r = loaded.regs;
    for (const name of REG_NAMES) this.regs[REG[name]] = r[name] | 0;
    for (const s of SEG_NAMES) this.seg[s] = r[s] ?? 0;
    this.seg.ss = r.ss ?? r.ds;
    this.eip = loaded.entry >>> 0;
    this.halted = false;
    this.haltReason = null;
    this.count = 0;
  }

  // -------------------------------------------------------------- register access

  get32(i) { return this.regs[i] | 0; }
  set32(i, v) { this.regs[i] = v | 0; }
  get16(i) { return this.regs[i] & 0xffff; }
  set16(i, v) { this.regs[i] = (this.regs[i] & ~0xffff) | (v & 0xffff); }
  get8(i) {
    return i < 4 ? this.regs[i] & 0xff : (this.regs[i - 4] >>> 8) & 0xff;
  }
  set8(i, v) {
    if (i < 4) this.regs[i] = (this.regs[i] & ~0xff) | (v & 0xff);
    else this.regs[i - 4] = (this.regs[i - 4] & ~0xff00) | ((v & 0xff) << 8);
  }
  getReg(i, size) { return size === 1 ? this.get8(i) : size === 2 ? this.get16(i) : this.get32(i); }
  setReg(i, size, v) { size === 1 ? this.set8(i, v) : size === 2 ? this.set16(i, v) : this.set32(i, v); }

  // ------------------------------------------------------------------ memory I/O

  rd(addr, size) {
    addr = addr >>> 0;
    try {
      if (size === 1) return this.mem.getUint8(addr);
      if (size === 2) return this.mem.getUint16(addr, true);
      return this.mem.getUint32(addr, true) >>> 0;
    } catch { throw new Fault(`read fault at 0x${addr.toString(16)}`, this.context()); }
  }

  wr(addr, size, v) {
    addr = addr >>> 0;
    try {
      if (size === 1) this.mem.setUint8(addr, v & 0xff);
      else if (size === 2) this.mem.setUint16(addr, v & 0xffff, true);
      else this.mem.setUint32(addr, v >>> 0, true);
    } catch { throw new Fault(`write fault at 0x${addr.toString(16)}`, this.context()); }
  }

  // ------------------------------------------------------------------- fetching

  fetch8() { return this.mem.getUint8(this.eip++); }
  fetch16() { const v = this.mem.getUint16(this.eip, true); this.eip += 2; return v; }
  fetch32() { const v = this.mem.getUint32(this.eip, true) >>> 0; this.eip += 4; return v; }
  fetchImm(size) { return size === 1 ? this.fetch8() : size === 2 ? this.fetch16() : this.fetch32(); }
  fetchS8() { return (this.fetch8() << 24) >> 24; }

  // --------------------------------------------------------------------- modrm

  /**
   * Decode ModRM. Returns {mod, reg, rm, raw, addr}, where addr is null for the
   * register form. `raw` is the undecoded byte, which the x87 block needs because its
   * register-form opcodes are identified by the whole byte.
   */
  modrm() {
    const b = this.fetch8();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    if (mod === 3) return { mod, reg, rm, raw: b, addr: null };
    if (this.addrsize !== 4) throw new Unimplemented('16-bit addressing', this.context());

    let addr = 0;
    if (rm === 4) {
      const sib = this.fetch8();
      const scale = sib >> 6, index = (sib >> 3) & 7, base = sib & 7;
      if (index !== 4) addr += this.get32(index) * (1 << scale);
      if (base === 5 && mod === 0) addr += this.fetch32();
      else addr += this.get32(base);
    } else if (rm === 5 && mod === 0) {
      addr += this.fetch32();
    } else {
      addr += this.get32(rm);
    }
    if (mod === 1) addr += this.fetchS8();
    else if (mod === 2) addr += this.fetch32();

    return { mod, reg, rm, raw: b, addr: addr >>> 0 };
  }

  readRM(m, size) { return m.addr === null ? this.getReg(m.rm, size) : this.rd(m.addr, size); }
  writeRM(m, size, v) { m.addr === null ? this.setReg(m.rm, size, v) : this.wr(m.addr, size, v); }

  // --------------------------------------------------------------------- flags

  mask(size) { return size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff; }
  signBit(size) { return size === 4 ? 0x80000000 : size === 2 ? 0x8000 : 0x80; }

  setLogicFlags(r, size) {
    const mask = this.mask(size);
    r = (r & mask) >>> 0;
    this.cf = 0; this.of = 0; this.af = 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = (r & this.signBit(size)) ? 1 : 0;
    this.pf = PARITY[r & 0xff];
    return r;
  }

  doAdd(a, b, size, carry = 0) {
    const mask = this.mask(size), sign = this.signBit(size);
    a = (a & mask) >>> 0; b = (b & mask) >>> 0;
    const full = a + b + carry;
    const r = (full & mask) >>> 0;
    this.cf = full > mask ? 1 : 0;
    this.of = ((a ^ r) & (b ^ r) & sign) ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = (r & sign) ? 1 : 0;
    this.pf = PARITY[r & 0xff];
    return r;
  }

  doSub(a, b, size, borrow = 0) {
    const mask = this.mask(size), sign = this.signBit(size);
    a = (a & mask) >>> 0; b = (b & mask) >>> 0;
    const full = a - b - borrow;
    const r = (full & mask) >>> 0;
    this.cf = full < 0 ? 1 : 0;
    this.of = ((a ^ b) & (a ^ r) & sign) ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = (r & sign) ? 1 : 0;
    this.pf = PARITY[r & 0xff];
    return r;
  }

  /** The eight ALU ops in encoding order: add or adc sbb and sub xor cmp. */
  alu(op, a, b, size) {
    switch (op) {
      case 0: return this.doAdd(a, b, size);
      case 1: return this.setLogicFlags(a | b, size);
      case 2: return this.doAdd(a, b, size, this.cf);
      case 3: return this.doSub(a, b, size, this.cf);
      case 4: return this.setLogicFlags(a & b, size);
      case 5: return this.doSub(a, b, size);
      case 6: return this.setLogicFlags(a ^ b, size);
      case 7: this.doSub(a, b, size); return null;   // cmp discards the result
    }
  }

  cond(c) {
    switch (c) {
      case 0x0: return this.of;
      case 0x1: return this.of ? 0 : 1;
      case 0x2: return this.cf;
      case 0x3: return this.cf ? 0 : 1;
      case 0x4: return this.zf;
      case 0x5: return this.zf ? 0 : 1;
      case 0x6: return (this.cf || this.zf) ? 1 : 0;
      case 0x7: return (this.cf || this.zf) ? 0 : 1;
      case 0x8: return this.sf;
      case 0x9: return this.sf ? 0 : 1;
      case 0xa: return this.pf;
      case 0xb: return this.pf ? 0 : 1;
      case 0xc: return (this.sf !== this.of) ? 1 : 0;
      case 0xd: return (this.sf === this.of) ? 1 : 0;
      case 0xe: return (this.zf || this.sf !== this.of) ? 1 : 0;
      case 0xf: return (!this.zf && this.sf === this.of) ? 1 : 0;
    }
  }

  packFlags() {
    return (this.cf) | (1 << 1) | (this.pf << 2) | (this.af << 4) | (this.zf << 6) |
           (this.sf << 7) | (this.df << 10) | (this.of << 11);
  }
  unpackFlags(v) {
    this.cf = v & 1; this.pf = (v >> 2) & 1; this.af = (v >> 4) & 1;
    this.zf = (v >> 6) & 1; this.sf = (v >> 7) & 1; this.df = (v >> 10) & 1;
    this.of = (v >> 11) & 1;
  }

  // ---------------------------------------------------------------- stack

  push(v, size = this.opsize) {
    const esp = (this.get32(REG.esp) - size) >>> 0;
    this.set32(REG.esp, esp);
    this.wr(esp, size, v);
  }
  pop(size = this.opsize) {
    const esp = this.get32(REG.esp) >>> 0;
    const v = this.rd(esp, size);
    this.set32(REG.esp, (esp + size) >>> 0);
    return v;
  }

  // ---------------------------------------------------------------- diagnostics

  context() {
    const bytes = [];
    for (let i = 0; i < 12; i++) {
      try { bytes.push(this.mem.getUint8(this.insStart + i)); } catch { break; }
    }
    return {
      eip: this.insStart >>> 0,
      bytes: bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '),
      count: this.count,
      regs: Object.fromEntries(REG_NAMES.map((n, i) => [n, (this.regs[i] >>> 0).toString(16)])),
    };
  }

  // ------------------------------------------------------------------ execution

  /** Run up to `budget` instructions, or until halt. */
  run(budget = 1e7) {
    for (let i = 0; i < budget && !this.halted; i++) this.step();
    return this.count;
  }

  step() {
    this.insStart = this.eip;
    this.opsize = 4;
    this.addrsize = 4;
    this.segOverride = null;
    this.repPrefix = 0;
    this.count++;

    // Prefixes. Segment overrides are recorded but do not change addressing, because
    // every selector has base 0 in the flat model the demos run under.
    for (;;) {
      const b = this.mem.getUint8(this.eip);
      if (b === 0x66) { this.opsize = 2; this.eip++; }
      else if (b === 0x67) { this.addrsize = 2; this.eip++; }
      else if (b === 0xf2 || b === 0xf3) { this.repPrefix = b; this.eip++; }
      else if (b === 0x2e || b === 0x36 || b === 0x3e || b === 0x26 || b === 0x64 || b === 0x65) {
        this.segOverride = b; this.eip++;
      } else if (b === 0xf0) { this.eip++; }        // lock: no-op, single threaded
      else break;
    }

    const op = this.fetch8();
    this.execute(op);
  }

  execute(op) {
    const S = this.opsize;

    // --- ALU r/m,r and r,r/m plus the AL/eAX immediate forms (00..3F) -----------
    if (op < 0x40 && (op & 7) < 6) {
      const aluOp = op >> 3;
      const form = op & 7;
      if (form === 0 || form === 1) {                 // r/m, r
        const size = form === 0 ? 1 : S;
        const m = this.modrm();
        const r = this.alu(aluOp, this.readRM(m, size), this.getReg(m.reg, size), size);
        if (r !== null) this.writeRM(m, size, r);
        return;
      }
      if (form === 2 || form === 3) {                 // r, r/m
        const size = form === 2 ? 1 : S;
        const m = this.modrm();
        const r = this.alu(aluOp, this.getReg(m.reg, size), this.readRM(m, size), size);
        if (r !== null) this.setReg(m.reg, size, r);
        return;
      }
      // form 4/5: AL/eAX, imm
      const size = form === 4 ? 1 : S;
      const r = this.alu(aluOp, this.getReg(REG.eax, size), this.fetchImm(size), size);
      if (r !== null) this.setReg(REG.eax, size, r);
      return;
    }

    switch (op) {
      // --- inc/dec r32 --------------------------------------------------------
      case 0x40: case 0x41: case 0x42: case 0x43:
      case 0x44: case 0x45: case 0x46: case 0x47: {
        const i = op & 7, cf = this.cf;
        this.setReg(i, S, this.doAdd(this.getReg(i, S), 1, S));
        this.cf = cf;                                  // inc preserves CF
        return;
      }
      case 0x48: case 0x49: case 0x4a: case 0x4b:
      case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
        const i = op & 7, cf = this.cf;
        this.setReg(i, S, this.doSub(this.getReg(i, S), 1, S));
        this.cf = cf;
        return;
      }

      // --- push/pop r32 -------------------------------------------------------
      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57:
        this.push(this.getReg(op & 7, S)); return;
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        this.setReg(op & 7, S, this.pop()); return;

      case 0x60: {                                    // pushad
        const esp = this.get32(REG.esp);
        for (const i of [0, 1, 2, 3]) this.push(this.get32(i));
        this.push(esp);
        for (const i of [5, 6, 7]) this.push(this.get32(i));
        return;
      }
      case 0x61: {                                    // popad
        for (const i of [7, 6, 5]) this.set32(i, this.pop());
        this.pop();                                   // discard saved ESP
        for (const i of [3, 2, 1, 0]) this.set32(i, this.pop());
        return;
      }

      case 0x68: this.push(this.fetchImm(S)); return;             // push imm32
      case 0x6a: this.push(this.fetchS8()); return;               // push imm8

      case 0x69: {                                    // imul r, r/m, imm32
        const m = this.modrm();
        const a = this.readRM(m, S) | 0, b = this.fetchImm(S) | 0;
        const r = Math.imul(a, b);
        this.setReg(m.reg, S, r);
        this.setLogicFlags(r, S);
        this.of = this.cf = (a !== 0 && (r / a | 0) !== b) ? 1 : 0;
        return;
      }
      case 0x6b: {                                    // imul r, r/m, imm8
        const m = this.modrm();
        const a = this.readRM(m, S) | 0, b = this.fetchS8();
        const r = Math.imul(a, b);
        this.setReg(m.reg, S, r);
        this.setLogicFlags(r, S);
        return;
      }

      // --- jcc rel8 -----------------------------------------------------------
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
        const d = this.fetchS8();
        if (this.cond(op & 0xf)) this.eip = (this.eip + d) >>> 0;
        return;
      }

      // --- group 1: ALU r/m, imm ---------------------------------------------
      case 0x80: case 0x81: case 0x83: {
        const size = op === 0x80 ? 1 : S;
        const m = this.modrm();
        const a = this.readRM(m, size);
        const b = op === 0x83 ? (this.fetchS8() >>> 0) : this.fetchImm(size);
        const r = this.alu(m.reg, a, b, size);
        if (r !== null) this.writeRM(m, size, r);
        return;
      }

      case 0x84: case 0x85: {                          // test r/m, r
        const size = op === 0x84 ? 1 : S;
        const m = this.modrm();
        this.setLogicFlags(this.readRM(m, size) & this.getReg(m.reg, size), size);
        return;
      }

      case 0x86: case 0x87: {                          // xchg r/m, r
        const size = op === 0x86 ? 1 : S;
        const m = this.modrm();
        const a = this.readRM(m, size), b = this.getReg(m.reg, size);
        this.writeRM(m, size, b); this.setReg(m.reg, size, a);
        return;
      }

      // --- mov ----------------------------------------------------------------
      case 0x88: case 0x89: {                          // mov r/m, r
        const size = op === 0x88 ? 1 : S;
        const m = this.modrm();
        this.writeRM(m, size, this.getReg(m.reg, size));
        return;
      }
      case 0x8a: case 0x8b: {                          // mov r, r/m
        const size = op === 0x8a ? 1 : S;
        const m = this.modrm();
        this.setReg(m.reg, size, this.readRM(m, size));
        return;
      }
      case 0x8c: {                                     // mov r/m16, sreg
        const m = this.modrm();
        this.writeRM(m, 2, this.seg[SEG_NAMES[m.reg]] ?? 0);
        return;
      }
      case 0x8e: {                                     // mov sreg, r/m16
        const m = this.modrm();
        this.seg[SEG_NAMES[m.reg]] = this.readRM(m, 2) & 0xffff;
        return;
      }
      case 0x8d: {                                     // lea
        const m = this.modrm();
        if (m.addr === null) throw new Fault('lea with register operand', this.context());
        this.setReg(m.reg, S, m.addr);
        return;
      }

      case 0x90: return;                               // nop

      case 0x91: case 0x92: case 0x93:
      case 0x94: case 0x95: case 0x96: case 0x97: {     // xchg eAX, r
        const i = op & 7;
        const a = this.getReg(REG.eax, S), b = this.getReg(i, S);
        this.setReg(REG.eax, S, b); this.setReg(i, S, a);
        return;
      }

      case 0x98: {                                     // cwde / cbw
        if (S === 4) this.set32(REG.eax, (this.get16(REG.eax) << 16) >> 16);
        else this.set16(REG.eax, (this.get8(0) << 24) >> 24);
        return;
      }
      case 0x99: {                                     // cdq / cwd
        if (S === 4) this.set32(REG.edx, this.get32(REG.eax) >> 31);
        else this.set16(REG.edx, (this.get16(REG.eax) & 0x8000) ? 0xffff : 0);
        return;
      }

      case 0x9c: this.push(this.packFlags()); return;   // pushfd
      case 0x9d: this.unpackFlags(this.pop()); return;  // popfd

      case 0xa0: case 0xa1: {                           // mov AL/eAX, moffs
        const size = op === 0xa0 ? 1 : S;
        this.setReg(REG.eax, size, this.rd(this.fetch32(), size));
        return;
      }
      case 0xa2: case 0xa3: {                           // mov moffs, AL/eAX
        const size = op === 0xa2 ? 1 : S;
        this.wr(this.fetch32(), size, this.getReg(REG.eax, size));
        return;
      }

      case 0xa8: case 0xa9: {                           // test AL/eAX, imm
        const size = op === 0xa8 ? 1 : S;
        this.setLogicFlags(this.getReg(REG.eax, size) & this.fetchImm(size), size);
        return;
      }

      // --- string ops ---------------------------------------------------------
      case 0xa4: case 0xa5: return this.stringOp('movs', op === 0xa4 ? 1 : S);
      case 0xaa: case 0xab: return this.stringOp('stos', op === 0xaa ? 1 : S);
      case 0xac: case 0xad: return this.stringOp('lods', op === 0xac ? 1 : S);
      case 0xae: case 0xaf: return this.stringOp('scas', op === 0xae ? 1 : S);
      case 0xa6: case 0xa7: return this.stringOp('cmps', op === 0xa6 ? 1 : S);

      // --- mov imm ------------------------------------------------------------
      case 0xb0: case 0xb1: case 0xb2: case 0xb3:
      case 0xb4: case 0xb5: case 0xb6: case 0xb7:
        this.set8(op & 7, this.fetch8()); return;
      case 0xb8: case 0xb9: case 0xba: case 0xbb:
      case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        this.setReg(op & 7, S, this.fetchImm(S)); return;

      case 0xc6: case 0xc7: {                           // mov r/m, imm
        const size = op === 0xc6 ? 1 : S;
        const m = this.modrm();
        this.writeRM(m, size, this.fetchImm(size));
        return;
      }

      // --- shifts -------------------------------------------------------------
      case 0xc0: case 0xc1: {
        const size = op === 0xc0 ? 1 : S;
        const m = this.modrm();
        this.shift(m, size, this.fetch8() & 31);
        return;
      }
      case 0xd0: case 0xd1: {
        const size = op === 0xd0 ? 1 : S;
        this.shift(this.modrm(), size, 1);
        return;
      }
      case 0xd2: case 0xd3: {
        const size = op === 0xd2 ? 1 : S;
        this.shift(this.modrm(), size, this.get8(1) & 31);
        return;
      }

      // --- returns and calls --------------------------------------------------
      case 0xc2: { const n = this.fetch16(); this.eip = this.pop(); this.set32(REG.esp, (this.get32(REG.esp) + n) >>> 0); return; }
      case 0xc3: this.eip = this.pop(); return;
      case 0xcb: {                                      // retf
        const ip = this.pop(4), cs = this.pop(4);
        if (ip === TRAMP.hostReturn) {
          this.halted = true;
          this.haltReason = 'part returned to host';
          return;
        }
        this.eip = ip >>> 0; this.seg.cs = cs & 0xffff;
        return;
      }
      case 0xca: {
        const n = this.fetch16();
        const ip = this.pop(4), cs = this.pop(4);
        this.set32(REG.esp, (this.get32(REG.esp) + n) >>> 0);
        if (ip === TRAMP.hostReturn) { this.halted = true; this.haltReason = 'part returned to host'; return; }
        this.eip = ip >>> 0; this.seg.cs = cs & 0xffff;
        return;
      }

      case 0xe8: {                                      // call rel32
        const d = this.fetchImm(S) | 0;
        this.push(this.eip);
        this.eip = (this.eip + d) >>> 0;
        return;
      }
      case 0xe9: { const d = this.fetchImm(S) | 0; this.eip = (this.eip + d) >>> 0; return; }
      case 0xeb: { const d = this.fetchS8(); this.eip = (this.eip + d) >>> 0; return; }

      case 0x9a: {                                      // call far ptr16:32
        const off = this.fetch32(), sel = this.fetch16();
        return this.farCall(off, sel);
      }

      case 0xe3: { const d = this.fetchS8(); if (this.get32(REG.ecx) === 0) this.eip = (this.eip + d) >>> 0; return; }
      case 0xe2: {                                      // loop
        const d = this.fetchS8();
        this.set32(REG.ecx, this.get32(REG.ecx) - 1);
        if (this.get32(REG.ecx) !== 0) this.eip = (this.eip + d) >>> 0;
        return;
      }
      case 0xe1: {                                      // loope
        const d = this.fetchS8();
        this.set32(REG.ecx, this.get32(REG.ecx) - 1);
        if (this.get32(REG.ecx) !== 0 && this.zf) this.eip = (this.eip + d) >>> 0;
        return;
      }
      case 0xe0: {                                      // loopne
        const d = this.fetchS8();
        this.set32(REG.ecx, this.get32(REG.ecx) - 1);
        if (this.get32(REG.ecx) !== 0 && !this.zf) this.eip = (this.eip + d) >>> 0;
        return;
      }

      case 0xf5: this.cf ^= 1; return;                  // cmc
      case 0xf8: this.cf = 0; return;                   // clc
      case 0xf9: this.cf = 1; return;                   // stc
      case 0xfc: this.df = 0; return;                   // cld
      case 0xfd: this.df = 1; return;                   // std

      case 0xf6: case 0xf7: return this.group3(op === 0xf6 ? 1 : S);
      case 0xfe: return this.groupInc(1);
      case 0xff: return this.groupInc(S, true);

      case 0x0f: return this.twoByte();

      case 0x9b: return;                                // fwait: no exceptions modelled

      default:
        if (op >= 0xd8 && op <= 0xdf) return this.fpu.execute(op);
        throw new Unimplemented(`opcode 0x${op.toString(16)}`, this.context());
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Build an Unimplemented carrying decode context; used by the FPU too. */
  unimplemented(message) { return new Unimplemented(message, this.context()); }

  farCall(off, sel) {
    if (off >= MAGIC_BASE) {
      // A call into the host. The real trampolines end in retf, which would undo the
      // call's pushes, so emulate the whole call/return here and fall through.
      const regs = Object.fromEntries(REG_NAMES.map((n, i) => [n, this.regs[i] >>> 0]));
      const effects = this.machine.callTrampoline(off, regs);
      this.trampolineHits.push({ addr: off, count: this.count, eip: this.insStart });
      if (effects) {
        for (const [k, v] of Object.entries(effects)) {
          if (k === 'cf') this.cf = v;
          else if (k in REG) this.set32(REG[k], v);
        }
      }
      return;
    }
    this.push(this.seg.cs, 4);
    this.push(this.eip, 4);
    this.eip = off >>> 0;
    this.seg.cs = sel & 0xffff;
  }

  shift(m, size, amount) {
    const mask = this.mask(size), sign = this.signBit(size);
    const bits = size * 8;
    let v = this.readRM(m, size) >>> 0;
    if (amount === 0) return;

    switch (m.reg) {
      case 4: case 6: {                                  // shl / sal
        const full = v << amount;
        this.cf = (amount <= bits) ? ((v >>> (bits - amount)) & 1) : 0;
        v = (full & mask) >>> 0;
        this.of = ((v & sign) ? 1 : 0) ^ this.cf;
        break;
      }
      case 5: {                                          // shr
        this.cf = (v >>> (amount - 1)) & 1;
        v = (v >>> amount) & mask;
        break;
      }
      case 7: {                                          // sar
        const s = size === 4 ? (v | 0) : ((v & sign) ? v | ~mask : v);
        this.cf = (s >> (amount - 1)) & 1;
        v = (s >> amount) & mask;
        break;
      }
      // Rotates leave ZF, SF, PF and AF alone — only CF and OF are defined.
      case 0: {                                          // rol
        const n = amount % bits;
        if (n !== 0) v = (((v << n) | (v >>> (bits - n))) & mask) >>> 0;
        this.cf = v & 1;
        this.of = (((v & sign) ? 1 : 0) ^ this.cf);
        this.writeRM(m, size, v);
        return;
      }
      case 1: {                                          // ror
        const n = amount % bits;
        if (n !== 0) v = (((v >>> n) | (v << (bits - n))) & mask) >>> 0;
        this.cf = (v & sign) ? 1 : 0;
        this.writeRM(m, size, v);
        return;
      }
      case 2: {                                          // rcl, through CF
        for (let i = 0; i < amount % (bits + 1); i++) {
          const next = (v >>> (bits - 1)) & 1;
          v = (((v << 1) & mask) | this.cf) >>> 0;
          this.cf = next;
        }
        this.of = (((v & sign) ? 1 : 0) ^ this.cf);
        this.writeRM(m, size, v);
        return;
      }
      case 3: {                                          // rcr, through CF
        for (let i = 0; i < amount % (bits + 1); i++) {
          const next = v & 1;
          v = ((v >>> 1) | (this.cf ? sign : 0)) >>> 0;
          this.cf = next;
        }
        this.writeRM(m, size, v);
        return;
      }
      default:
        throw new Unimplemented(`shift group op ${m.reg}`, this.context());
    }

    this.zf = v === 0 ? 1 : 0;
    this.sf = (v & sign) ? 1 : 0;
    this.pf = PARITY[v & 0xff];
    this.writeRM(m, size, v);
  }

  group3(size) {
    const m = this.modrm();
    switch (m.reg) {
      case 0: case 1:                                    // test r/m, imm
        this.setLogicFlags(this.readRM(m, size) & this.fetchImm(size), size);
        return;
      case 2:                                            // not
        this.writeRM(m, size, ~this.readRM(m, size));
        return;
      case 3: {                                          // neg
        const a = this.readRM(m, size);
        this.writeRM(m, size, this.doSub(0, a, size));
        this.cf = (a & this.mask(size)) !== 0 ? 1 : 0;
        return;
      }
      case 4: {                                          // mul (unsigned)
        if (size === 1) {
          const r = this.get8(0) * this.readRM(m, 1);
          this.set8(0, r & 0xff); this.set8(4, (r >>> 8) & 0xff);
          this.cf = this.of = (r >>> 8) !== 0 ? 1 : 0;
        } else if (size === 2) {
          const r = this.get16(REG.eax) * this.readRM(m, 2);
          this.set16(REG.eax, r & 0xffff); this.set16(REG.edx, (r >>> 16) & 0xffff);
          this.cf = this.of = (r >>> 16) !== 0 ? 1 : 0;
        } else {
          const a = this.get32(REG.eax) >>> 0, b = this.readRM(m, 4) >>> 0;
          const hi = Math.floor((a * b) / 4294967296) >>> 0;
          this.set32(REG.eax, Math.imul(a, b) >>> 0); this.set32(REG.edx, hi);
          this.cf = this.of = hi !== 0 ? 1 : 0;
        }
        return;
      }
      case 5: {                                          // imul (signed)
        if (size === 1) {
          const a = (this.get8(0) << 24) >> 24, b = (this.readRM(m, 1) << 24) >> 24;
          const r = a * b;
          this.set8(0, r & 0xff); this.set8(4, (r >> 8) & 0xff);
          this.cf = this.of = (r < -128 || r > 127) ? 1 : 0;
        } else if (size === 2) {
          const a = (this.get16(REG.eax) << 16) >> 16, b = (this.readRM(m, 2) << 16) >> 16;
          const r = a * b;
          this.set16(REG.eax, r & 0xffff); this.set16(REG.edx, (r >> 16) & 0xffff);
          this.cf = this.of = (r < -32768 || r > 32767) ? 1 : 0;
        } else {
          const a = this.get32(REG.eax) | 0, b = this.readRM(m, 4) | 0;
          const prod = a * b;
          this.set32(REG.eax, Math.imul(a, b));
          this.set32(REG.edx, Math.floor(prod / 4294967296));
          this.cf = this.of = (prod < -2147483648 || prod > 2147483647) ? 1 : 0;
        }
        return;
      }
      case 6: {                                          // div (unsigned)
        const d = this.readRM(m, size) >>> 0;
        if (d === 0) throw new Fault('divide by zero', this.context());
        if (size === 1) {
          const n = this.get16(REG.eax);
          const q = Math.floor(n / d);
          if (q > 0xff) throw new Fault('divide overflow', this.context());
          this.set8(0, q); this.set8(4, n % d);
        } else if (size === 2) {
          const n = ((this.get16(REG.edx) << 16) | this.get16(REG.eax)) >>> 0;
          const q = Math.floor(n / d);
          if (q > 0xffff) throw new Fault('divide overflow', this.context());
          this.set16(REG.eax, q); this.set16(REG.edx, n % d);
        } else {
          const n = (this.get32(REG.edx) >>> 0) * 4294967296 + (this.get32(REG.eax) >>> 0);
          const q = Math.floor(n / d);
          if (q > 0xffffffff) throw new Fault('divide overflow', this.context());
          this.set32(REG.eax, q >>> 0); this.set32(REG.edx, (n - q * d) >>> 0);
        }
        return;
      }
      case 7: {                                          // idiv (signed)
        if (size === 1) {
          const d = (this.readRM(m, 1) << 24) >> 24;
          if (d === 0) throw new Fault('divide by zero', this.context());
          const n = (this.get16(REG.eax) << 16) >> 16;
          const q = Math.trunc(n / d);
          this.set8(0, q & 0xff); this.set8(4, (n - q * d) & 0xff);
        } else if (size === 2) {
          const d = (this.readRM(m, 2) << 16) >> 16;
          if (d === 0) throw new Fault('divide by zero', this.context());
          const n = ((this.get16(REG.edx) << 16) | this.get16(REG.eax)) | 0;
          const q = Math.trunc(n / d);
          this.set16(REG.eax, q & 0xffff); this.set16(REG.edx, (n - q * d) & 0xffff);
        } else {
          const d = this.readRM(m, 4) | 0;
          if (d === 0) throw new Fault('divide by zero', this.context());
          const n = (this.get32(REG.edx) | 0) * 4294967296 + (this.get32(REG.eax) >>> 0);
          const q = Math.trunc(n / d);
          this.set32(REG.eax, q | 0); this.set32(REG.edx, (n - q * d) | 0);
        }
        return;
      }
    }
  }

  groupInc(size, allowCalls = false) {
    const m = this.modrm();
    switch (m.reg) {
      case 0: { const cf = this.cf; this.writeRM(m, size, this.doAdd(this.readRM(m, size), 1, size)); this.cf = cf; return; }
      case 1: { const cf = this.cf; this.writeRM(m, size, this.doSub(this.readRM(m, size), 1, size)); this.cf = cf; return; }
      case 2:                                            // call r/m (near indirect)
        if (!allowCalls) break;
        { const t = this.readRM(m, 4); this.push(this.eip); this.eip = t >>> 0; return; }
      case 3: {                                          // call far m16:32
        if (!allowCalls) break;
        if (m.addr === null) throw new Fault('call far with register operand', this.context());
        const off = this.rd(m.addr, 4), sel = this.rd((m.addr + 4) >>> 0, 2);
        return this.farCall(off, sel);
      }
      case 4:                                            // jmp r/m
        if (!allowCalls) break;
        this.eip = this.readRM(m, 4) >>> 0; return;
      case 5: {                                          // jmp far m16:32
        if (!allowCalls) break;
        if (m.addr === null) throw new Fault('jmp far with register operand', this.context());
        const off = this.rd(m.addr, 4), sel = this.rd((m.addr + 4) >>> 0, 2);
        if (off >= MAGIC_BASE) return this.farCall(off, sel);
        this.eip = off >>> 0; this.seg.cs = sel & 0xffff; return;
      }
      case 6: this.push(this.readRM(m, size)); return;    // push r/m
    }
    throw new Unimplemented(`group ${size === 1 ? 'FE' : 'FF'} /${m.reg}`, this.context());
  }

  stringOp(kind, size) {
    const step = this.df ? -size : size;
    let count = 1;
    let repeat = false;
    if (this.repPrefix) {
      count = this.get32(REG.ecx) >>> 0;
      repeat = true;
      if (count === 0) return;
    }

    for (let i = 0; i < count; i++) {
      const si = this.get32(REG.esi) >>> 0, di = this.get32(REG.edi) >>> 0;
      if (kind === 'movs') { this.wr(di, size, this.rd(si, size)); this.set32(REG.esi, si + step); this.set32(REG.edi, di + step); }
      else if (kind === 'stos') { this.wr(di, size, this.getReg(REG.eax, size)); this.set32(REG.edi, di + step); }
      else if (kind === 'lods') { this.setReg(REG.eax, size, this.rd(si, size)); this.set32(REG.esi, si + step); }
      else if (kind === 'scas') {
        this.doSub(this.getReg(REG.eax, size), this.rd(di, size), size);
        this.set32(REG.edi, di + step);
      } else if (kind === 'cmps') {
        this.doSub(this.rd(si, size), this.rd(di, size), size);
        this.set32(REG.esi, si + step); this.set32(REG.edi, di + step);
      }

      if (repeat) {
        this.set32(REG.ecx, (this.get32(REG.ecx) >>> 0) - 1);
        if (kind === 'scas' || kind === 'cmps') {
          const wantZf = this.repPrefix === 0xf3 ? 1 : 0;
          if (this.zf !== wantZf) return;
        }
      }
    }
  }

  twoByte() {
    const op = this.fetch8();
    const S = this.opsize;

    // jcc rel32
    if (op >= 0x80 && op <= 0x8f) {
      const d = this.fetchImm(S) | 0;
      if (this.cond(op & 0xf)) this.eip = (this.eip + d) >>> 0;
      return;
    }
    // setcc r/m8
    if (op >= 0x90 && op <= 0x9f) {
      const m = this.modrm();
      this.writeRM(m, 1, this.cond(op & 0xf) ? 1 : 0);
      return;
    }
    // cmovcc
    if (op >= 0x40 && op <= 0x4f) {
      const m = this.modrm();
      const v = this.readRM(m, S);
      if (this.cond(op & 0xf)) this.setReg(m.reg, S, v);
      return;
    }

    switch (op) {
      case 0xb6: case 0xb7: {                            // movzx
        const src = op === 0xb6 ? 1 : 2;
        const m = this.modrm();
        this.setReg(m.reg, S, this.readRM(m, src));
        return;
      }
      case 0xbe: case 0xbf: {                            // movsx
        const src = op === 0xbe ? 1 : 2;
        const m = this.modrm();
        const v = this.readRM(m, src);
        this.setReg(m.reg, S, src === 1 ? (v << 24) >> 24 : (v << 16) >> 16);
        return;
      }
      case 0xaf: {                                       // imul r, r/m
        const m = this.modrm();
        const a = this.getReg(m.reg, S) | 0, b = this.readRM(m, S) | 0;
        const prod = a * b;
        this.setReg(m.reg, S, Math.imul(a, b));
        this.cf = this.of = (prod < -2147483648 || prod > 2147483647) ? 1 : 0;
        return;
      }
      case 0xa4: case 0xa5: case 0xac: case 0xad: {       // shld / shrd
        const left = op === 0xa4 || op === 0xa5;
        const m = this.modrm();
        const src = this.getReg(m.reg, S) >>> 0;
        const count = (op === 0xa4 || op === 0xac) ? (this.fetch8() & 31) : (this.get8(1) & 31);
        if (count === 0) return;
        const dest = this.readRM(m, S) >>> 0;
        const bits = S * 8;
        let r;
        if (left) {
          this.cf = (dest >>> (bits - count)) & 1;
          r = (((dest << count) | (src >>> (bits - count))) & this.mask(S)) >>> 0;
        } else {
          this.cf = (dest >>> (count - 1)) & 1;
          r = (((dest >>> count) | (src << (bits - count))) & this.mask(S)) >>> 0;
        }
        this.zf = r === 0 ? 1 : 0;
        this.sf = (r & this.signBit(S)) ? 1 : 0;
        this.pf = PARITY[r & 0xff];
        this.writeRM(m, S, r);
        return;
      }

      case 0xa2: return;                                 // cpuid: pretend nothing
      case 0x31: {                                       // rdtsc
        const t = this.count;
        this.set32(REG.eax, t >>> 0); this.set32(REG.edx, 0);
        return;
      }
      case 0xa3: case 0xab: case 0xb3: case 0xbb: {      // bt/bts/btr/btc r/m, r
        const m = this.modrm();
        const bit = this.getReg(m.reg, S) & (S * 8 - 1);
        const v = this.readRM(m, S) >>> 0;
        this.cf = (v >>> bit) & 1;
        if (op !== 0xa3) {
          const nv = op === 0xab ? (v | (1 << bit)) : op === 0xb3 ? (v & ~(1 << bit)) : (v ^ (1 << bit));
          this.writeRM(m, S, nv >>> 0);
        }
        return;
      }
      case 0xbc: case 0xbd: {                            // bsf / bsr
        const m = this.modrm();
        const v = this.readRM(m, S) >>> 0;
        if (v === 0) { this.zf = 1; return; }
        this.zf = 0;
        let idx = 0;
        if (op === 0xbc) { while (!((v >>> idx) & 1)) idx++; }
        else { idx = 31; while (!((v >>> idx) & 1)) idx--; }
        this.setReg(m.reg, S, idx);
        return;
      }
      case 0xc8: case 0xc9: case 0xca: case 0xcb:
      case 0xcc: case 0xcd: case 0xce: case 0xcf: {       // bswap
        const i = op & 7;
        const v = this.get32(i) >>> 0;
        this.set32(i, (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0);
        return;
      }
      case 0x77: throw new Unimplemented('emms — MMX is not implemented', this.context());
      default:
        throw new Unimplemented(`opcode 0x0f 0x${op.toString(16)}`, this.context());
    }
  }
}
