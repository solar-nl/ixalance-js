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

// ------------------------------------------------------------------ predecode
//
// Everything the fetch/decode half of step() derives is a pure function of the bytes at
// an address, and the demos' inner loops run the same few hundred addresses billions of
// times. So decode each address once into a record and keep it, keyed on the eip it
// starts at. What may NOT be cached is anything read out of the register file — the
// effective address above all — which is why a record names base and index registers
// rather than holding an address.
//
// One table entry per opcode: 0x00..0xff is the one-byte map, 0x100..0x1ff the 0x0f
// map. Low three bits are flags, the rest names the immediate that trails the ModRM.
// F_BAD is the default and covers everything execute() does not implement plus the
// 0x67 address-size prefix; those addresses are never cached and keep being run by
// step(), so they raise the exact Unimplemented they raise today.
const F_MODRM = 1, F_END = 2, F_BAD = 4;
const I_NONE = 0, I_8 = 1, I_16 = 2, I_Z = 3, I_32 = 4, I_PTR = 5, I_G3 = 6;

const DEC = new Uint8Array(512).fill(F_BAD);
const dec = (op, flags, imm = I_NONE) => { DEC[op] = flags | (imm << 3); };
const decRange = (lo, hi, flags, imm = I_NONE) => { for (let o = lo; o <= hi; o++) dec(o, flags, imm); };

// ALU r/m,r · r,r/m · AL/eAX,imm. Forms 6 and 7 are the segment pushes and the BCD
// adjusts, which execute() does not implement, so they stay F_BAD.
for (let op = 0; op < 0x40; op++) {
  const form = op & 7;
  if (form < 4) dec(op, F_MODRM);
  else if (form === 4) dec(op, 0, I_8);
  else if (form === 5) dec(op, 0, I_Z);
}
decRange(0x40, 0x61, 0);                          // inc/dec, push/pop r32, pushad, popad
dec(0x68, 0, I_Z); dec(0x6a, 0, I_8);             // push imm
dec(0x69, F_MODRM, I_Z); dec(0x6b, F_MODRM, I_8); // imul r, r/m, imm
decRange(0x70, 0x7f, F_END, I_8);                 // jcc rel8
dec(0x80, F_MODRM, I_8); dec(0x81, F_MODRM, I_Z); dec(0x83, F_MODRM, I_8);
decRange(0x84, 0x8e, F_MODRM);                    // test, xchg, mov, lea, mov sreg
decRange(0x90, 0x99, 0);                          // nop, xchg eAX, cwde, cdq
dec(0x9a, F_END, I_PTR);                          // call far ptr16:32
decRange(0x9b, 0x9d, 0);                          // fwait, pushfd, popfd
decRange(0xa0, 0xa3, 0, I_32);                    // mov AL/eAX, moffs32 — always 4 bytes
decRange(0xa4, 0xa7, 0); decRange(0xaa, 0xaf, 0); // string ops
dec(0xa8, 0, I_8); dec(0xa9, 0, I_Z);             // test AL/eAX, imm
decRange(0xb0, 0xb7, 0, I_8); decRange(0xb8, 0xbf, 0, I_Z);
dec(0xc0, F_MODRM, I_8); dec(0xc1, F_MODRM, I_8); // shift r/m, imm8
dec(0xc2, F_END, I_16); dec(0xc3, F_END);
dec(0xc6, F_MODRM, I_8); dec(0xc7, F_MODRM, I_Z); // mov r/m, imm
dec(0xca, F_END, I_16); dec(0xcb, F_END);         // retf — can halt the part
decRange(0xd0, 0xd3, F_MODRM);                    // shift r/m, 1 / CL
decRange(0xd8, 0xdf, F_MODRM);                    // x87: ModRM and nothing after it
decRange(0xe0, 0xe3, F_END, I_8);                 // loop/loope/loopne/jecxz
dec(0xe8, F_END, I_Z); dec(0xe9, F_END, I_Z); dec(0xeb, F_END, I_8);
dec(0xf5, 0); dec(0xf8, 0); dec(0xf9, 0); dec(0xfc, 0); dec(0xfd, 0);
dec(0xf6, F_MODRM, I_G3); dec(0xf7, F_MODRM, I_G3);
dec(0xfe, F_MODRM);
dec(0xff, F_MODRM);                               // /2../5 transfer; decodeOne ends there

decRange(0x140, 0x14f, F_MODRM);                  // cmovcc
dec(0x131, 0); dec(0x1a2, 0);                     // rdtsc, cpuid
decRange(0x180, 0x18f, F_END, I_Z);               // jcc rel32
decRange(0x190, 0x19f, F_MODRM);                  // setcc
dec(0x1a3, F_MODRM); dec(0x1ab, F_MODRM); dec(0x1b3, F_MODRM); dec(0x1bb, F_MODRM);
dec(0x1a4, F_MODRM, I_8); dec(0x1ac, F_MODRM, I_8);
dec(0x1a5, F_MODRM); dec(0x1ad, F_MODRM);         // shld/shrd by CL
dec(0x1af, F_MODRM);                              // imul r, r/m
dec(0x1b6, F_MODRM); dec(0x1b7, F_MODRM); dec(0x1be, F_MODRM); dec(0x1bf, F_MODRM);
dec(0x1bc, F_MODRM); dec(0x1bd, F_MODRM);         // bsf/bsr
decRange(0x1c8, 0x1cf, 0);                        // bswap

// Direct-mapped, tag-compared cache. A miss or a stale page generation just recompiles,
// so eviction needs no bookkeeping at all. 128 K slots covers a demo image without
// aliasing; the cap on ops keeps a block inside two 4 KB pages, which is what makes
// invalidation a two-generation compare.
const BLOCK_SLOTS = 1 << 17, BLOCK_MASK = BLOCK_SLOTS - 1;
const BLOCK_MAX_OPS = 64, BLOCK_MAX_BYTES = 1024;

const rd32le = (u8, p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) | 0;

// -------------------------------------------------------------------- handlers
//
// One function per instruction form, bound to the record when it is decoded. They exist
// to skip everything execute() re-derives per pass: the operand-size dispatch, the ModRM
// byte, the immediate fetch and the 256-way switch. execBlock has already set insStart,
// bumped count and pointed eip at the fall-through, so a handler writes eip only when it
// branches — and it may NOT read cpu.opsize, cpu.repPrefix or cpu.segOverride, which the
// fast path deliberately leaves stale. Everything else goes through the same helpers
// execute() uses, so the arithmetic is the same arithmetic.
//
// Only forms that pull their weight in the profile are here; pick() returns null for the
// rest and execBlock runs them through execute() exactly as before.

function ea(c, o) {
  const r = c.regs, b = o.base, x = o.index;
  return ((b < 0 ? 0 : r[b]) + (x < 0 ? 0 : r[x] << o.scale) + o.disp) >>> 0;
}

function h_jcc(c, o) { if (c.cond(o.id & 0xf)) c.eip = o.target; }
function h_jmp(c, o) { c.eip = o.target; }
function h_call(c, o) { c.push(o.fall, 4); c.eip = o.target; }
function h_ret(c) { c.eip = c.pop(4); }

function h_movRM32(c, o) { c.regs[o.reg] = c.rd32(ea(c, o)) | 0; }     // 8b mem
function h_movMR32(c, o) { c.wr32(ea(c, o), c.regs[o.reg]); }          // 89 mem
function h_movRR32(c, o) { c.regs[o.reg] = c.regs[o.rm]; }             // 8b reg
function h_movRR32r(c, o) { c.regs[o.rm] = c.regs[o.reg]; }            // 89 reg
function h_movAxM32(c, o) { c.regs[0] = c.rd32(o.imm) | 0; }           // a1
function h_movM32Ax(c, o) { c.wr32(o.imm, c.regs[0]); }                // a3
function h_movAlM8(c, o) { c.set8(0, c.rd(o.imm, 1)); }                // a0
function h_movM8Al(c, o) { c.wr(o.imm, 1, c.get8(0)); }                // a2
function h_movRImm32(c, o) { c.regs[o.id & 7] = o.imm; }               // b8..bf
function h_movRImm8(c, o) { c.set8(o.id & 7, o.imm); }                 // b0..b7
function h_movMImm32(c, o) { c.wr32(ea(c, o), o.imm); }                // c7 mem
function h_movRImm32b(c, o) { c.regs[o.rm] = o.imm; }                  // c7 reg
function h_movM8R8(c, o) { c.wr(ea(c, o), 1, c.get8(o.reg)); }         // 88 mem
function h_movR8M8(c, o) { c.set8(o.reg, c.rd(ea(c, o), 1)); }         // 8a mem
function h_lea32(c, o) { c.regs[o.reg] = ea(c, o) | 0; }               // 8d

// The ALU form is in the opcode, the operation in bits 3..5 of it — except for group 1,
// where it is the ModRM reg field. alu32() keeps the eight-way choice; folding it in as
// well would need 8 copies of each of these for no measurable gain.
function h_aluMR32(c, o) {                                             // 01/09/… r/m, r
  const a = ea(c, o);
  const r = c.alu32(o.id >> 3, c.rd32(a), c.regs[o.reg]);
  if (r !== null) c.wr32(a, r);
}
function h_aluRR32(c, o) {
  const r = c.alu32(o.id >> 3, c.regs[o.rm], c.regs[o.reg]);
  if (r !== null) c.regs[o.rm] = r;
}
function h_aluRM32(c, o) {                                             // 03/0b/… r, r/m
  const r = c.alu32(o.id >> 3, c.regs[o.reg], c.rd32(ea(c, o)));
  if (r !== null) c.regs[o.reg] = r;
}
function h_aluRR32r(c, o) {
  const r = c.alu32(o.id >> 3, c.regs[o.reg], c.regs[o.rm]);
  if (r !== null) c.regs[o.reg] = r;
}
function h_aluAxImm32(c, o) {                                          // 05/0d/… eAX, imm
  const r = c.alu32(o.id >> 3, c.regs[0], o.imm);
  if (r !== null) c.regs[0] = r;
}
function h_grp1M32(c, o) {                                             // 81/83 r/m32, imm
  const a = ea(c, o);
  const r = c.alu32(o.reg, c.rd32(a), o.simm);
  if (r !== null) c.wr32(a, r);
}
function h_grp1R32(c, o) {
  const r = c.alu32(o.reg, c.regs[o.rm], o.simm);
  if (r !== null) c.regs[o.rm] = r;
}
function h_grp1M8(c, o) {                                              // 80 r/m8, imm8
  const a = ea(c, o);
  const r = c.alu(o.reg, c.rd(a, 1), o.imm, 1);
  if (r !== null) c.wr(a, 1, r);
}
function h_testM32(c, o) { c.setLogicFlags32(c.rd32(ea(c, o)) & c.regs[o.reg]); }
function h_testR32(c, o) { c.setLogicFlags32(c.regs[o.rm] & c.regs[o.reg]); }

// The 8- and 16-bit tail. These stay on the generic alu()/rd()/wr() helpers — they are
// here for the dispatch, not for specialised arithmetic, and between them they cover the
// byte compares and word counters the parts lean on.
function h_aluM8R8(c, o) { const a = ea(c, o); const r = c.alu(o.id >> 3, c.rd(a, 1), c.get8(o.reg), 1); if (r !== null) c.wr(a, 1, r); }
function h_aluR8R8(c, o) { const r = c.alu(o.id >> 3, c.get8(o.rm), c.get8(o.reg), 1); if (r !== null) c.set8(o.rm, r); }
function h_aluR8M8(c, o) { const r = c.alu(o.id >> 3, c.get8(o.reg), c.rd(ea(c, o), 1), 1); if (r !== null) c.set8(o.reg, r); }
function h_aluR8R8r(c, o) { const r = c.alu(o.id >> 3, c.get8(o.reg), c.get8(o.rm), 1); if (r !== null) c.set8(o.reg, r); }
function h_aluAlImm8(c, o) { const r = c.alu(o.id >> 3, c.get8(0), o.imm, 1); if (r !== null) c.set8(0, r); }
function h_aluM16R16(c, o) { const a = ea(c, o); const r = c.alu(o.id >> 3, c.rd(a, 2), c.get16(o.reg), 2); if (r !== null) c.wr(a, 2, r); }
function h_aluR16R16(c, o) { const r = c.alu(o.id >> 3, c.get16(o.rm), c.get16(o.reg), 2); if (r !== null) c.set16(o.rm, r); }
function h_aluR16M16(c, o) { const r = c.alu(o.id >> 3, c.get16(o.reg), c.rd(ea(c, o), 2), 2); if (r !== null) c.set16(o.reg, r); }
function h_aluR16R16r(c, o) { const r = c.alu(o.id >> 3, c.get16(o.reg), c.get16(o.rm), 2); if (r !== null) c.set16(o.reg, r); }
function h_aluAxImm16(c, o) { const r = c.alu(o.id >> 3, c.get16(0), o.imm, 2); if (r !== null) c.set16(0, r); }
function h_grp1R8(c, o) { const r = c.alu(o.reg, c.get8(o.rm), o.imm, 1); if (r !== null) c.set8(o.rm, r); }
function h_grp1M16(c, o) { const a = ea(c, o); const r = c.alu(o.reg, c.rd(a, 2), o.simm, 2); if (r !== null) c.wr(a, 2, r); }
function h_grp1R16(c, o) { const r = c.alu(o.reg, c.get16(o.rm), o.simm, 2); if (r !== null) c.set16(o.rm, r); }
function h_testM8(c, o) { c.setLogicFlags(c.rd(ea(c, o), 1) & c.get8(o.reg), 1); }
function h_testR8(c, o) { c.setLogicFlags(c.get8(o.rm) & c.get8(o.reg), 1); }
function h_testM16(c, o) { c.setLogicFlags(c.rd(ea(c, o), 2) & c.get16(o.reg), 2); }
function h_testR16(c, o) { c.setLogicFlags(c.get16(o.rm) & c.get16(o.reg), 2); }
function h_movR8R8(c, o) { c.set8(o.rm, c.get8(o.reg)); }              // 88 reg
function h_movR8R8r(c, o) { c.set8(o.reg, c.get8(o.rm)); }             // 8a reg
function h_movM16R16(c, o) { c.wr(ea(c, o), 2, c.get16(o.reg)); }
function h_movR16R16(c, o) { c.set16(o.rm, c.get16(o.reg)); }
function h_movR16M16(c, o) { c.set16(o.reg, c.rd(ea(c, o), 2)); }
function h_movR16R16r(c, o) { c.set16(o.reg, c.get16(o.rm)); }
function h_movAxM16(c, o) { c.set16(0, c.rd(o.imm, 2)); }
function h_movM16Ax(c, o) { c.wr(o.imm, 2, c.get16(0)); }
function h_movM8Imm(c, o) { c.wr(ea(c, o), 1, o.imm); }                // c6
function h_movR8Imm(c, o) { c.set8(o.rm, o.imm); }
function h_movM16Imm(c, o) { c.wr(ea(c, o), 2, o.imm); }               // c7, 16-bit
function h_movR16Imm(c, o) { c.set16(o.rm, o.imm); }
function h_incM16(c, o) { const a = ea(c, o), cf = c.cf; c.wr(a, 2, c.doAdd(c.rd(a, 2), 1, 2)); c.cf = cf; }
function h_decM16(c, o) { const a = ea(c, o), cf = c.cf; c.wr(a, 2, c.doSub(c.rd(a, 2), 1, 2)); c.cf = cf; }
function h_incM32(c, o) { const a = ea(c, o), cf = c.cf; c.wr32(a, c.doAdd32(c.rd32(a), 1)); c.cf = cf; }
function h_decM32(c, o) { const a = ea(c, o), cf = c.cf; c.wr32(a, c.doSub32(c.rd32(a), 1)); c.cf = cf; }
function h_pushM32(c, o) { c.push(c.rd32(ea(c, o)), 4); }

// inc and dec are the one pair that has to put CF back: the flag they leave alone is the
// only thing separating them from add/sub 1.
function h_inc32(c, o) { const i = o.id & 7, cf = c.cf; c.regs[i] = c.doAdd32(c.regs[i], 1); c.cf = cf; }
function h_dec32(c, o) { const i = o.id & 7, cf = c.cf; c.regs[i] = c.doSub32(c.regs[i], 1); c.cf = cf; }
function h_push32(c, o) { c.push(c.regs[o.id & 7], 4); }
function h_pop32(c, o) { c.regs[o.id & 7] = c.pop(4); }

// x87 is a third of jizz's instruction stream, and none of its opcodes carry an
// immediate, so eip is already final and the decoded ModRM can go straight in.
function h_fpuM(c, o) {
  const m = c._m;
  m.mod = o.mod; m.reg = o.reg; m.rm = o.rm; m.raw = o.raw; m.addr = ea(c, o);
  c.fpu.execute(o.op, m);
}
function h_fpuR(c, o) {
  const m = c._m;
  m.mod = 3; m.reg = o.reg; m.rm = o.rm; m.raw = o.raw; m.addr = null;
  c.fpu.execute(o.op, m);
}

function h_movzx8(c, o) { c.regs[o.reg] = c.rd(ea(c, o), 1); }
function h_movzx16(c, o) { c.regs[o.reg] = c.rd(ea(c, o), 2); }
function h_movsx8(c, o) { c.regs[o.reg] = (c.rd(ea(c, o), 1) << 24) >> 24; }
function h_movsx16(c, o) { c.regs[o.reg] = (c.rd(ea(c, o), 2) << 16) >> 16; }

/** Choose the handler for a finished decode record, or null to leave it to execute(). */
function pick(o) {
  const id = o.id, S = o.opsize, mem = o.mod !== 3;
  if (o.rep !== 0) return null;                    // a stray rep: let execute() ignore it

  if (id >= 0x70 && id <= 0x7f) return h_jcc;
  if (id >= 0xd8 && id <= 0xdf) return mem ? h_fpuM : h_fpuR;   // size never reaches x87

  if (id < 0x40) {                                 // the ALU block, forms 0..5
    switch (id & 7) {
      case 0: return mem ? h_aluM8R8 : h_aluR8R8;
      case 1: return S === 4 ? (mem ? h_aluMR32 : h_aluRR32) : (mem ? h_aluM16R16 : h_aluR16R16);
      case 2: return mem ? h_aluR8M8 : h_aluR8R8r;
      case 3: return S === 4 ? (mem ? h_aluRM32 : h_aluRR32r) : (mem ? h_aluR16M16 : h_aluR16R16r);
      case 4: return h_aluAlImm8;
      default: return S === 4 ? h_aluAxImm32 : h_aluAxImm16;
    }
  }
  if (id >= 0x180 && id <= 0x18f) return S === 4 ? h_jcc : null;
  if (id >= 0xb0 && id <= 0xb7) return h_movRImm8;

  switch (id) {                                    // size-independent byte forms
    case 0x80: return mem ? h_grp1M8 : h_grp1R8;
    case 0x84: return mem ? h_testM8 : h_testR8;
    case 0x88: return mem ? h_movM8R8 : h_movR8R8;
    case 0x8a: return mem ? h_movR8M8 : h_movR8R8r;
    case 0xa0: return h_movAlM8;
    case 0xa2: return h_movM8Al;
    case 0xc6: return mem ? h_movM8Imm : h_movR8Imm;
  }

  if (S !== 4) {
    switch (id) {
      case 0x81: case 0x83: return mem ? h_grp1M16 : h_grp1R16;
      case 0x85: return mem ? h_testM16 : h_testR16;
      case 0x89: return mem ? h_movM16R16 : h_movR16R16;
      case 0x8b: return mem ? h_movR16M16 : h_movR16R16r;
      case 0xa1: return h_movAxM16;
      case 0xa3: return h_movM16Ax;
      case 0xc7: return mem ? h_movM16Imm : h_movR16Imm;
      case 0xff: return mem && o.reg === 0 ? h_incM16 : mem && o.reg === 1 ? h_decM16 : null;
    }
    return null;
  }

  if (id <= 0x47) return h_inc32;
  if (id <= 0x4f) return h_dec32;
  if (id <= 0x57) return h_push32;
  if (id <= 0x5f) return h_pop32;
  if (id >= 0xb8 && id <= 0xbf) return h_movRImm32;
  switch (id) {
    case 0x81: case 0x83: return mem ? h_grp1M32 : h_grp1R32;
    case 0x85: return mem ? h_testM32 : h_testR32;
    case 0x89: return mem ? h_movMR32 : h_movRR32r;
    case 0x8b: return mem ? h_movRM32 : h_movRR32;
    case 0x8d: return mem ? h_lea32 : null;        // lea on a register form faults
    case 0xa1: return h_movAxM32;
    case 0xa3: return h_movM32Ax;
    case 0xc3: return h_ret;
    case 0xc7: return mem ? h_movMImm32 : h_movRImm32b;
    case 0xe8: return h_call;
    case 0xe9: case 0xeb: return h_jmp;
    case 0xff:
      if (!mem) return null;
      return o.reg === 0 ? h_incM32 : o.reg === 1 ? h_decM32 : o.reg === 6 ? h_pushM32 : null;
    case 0x1b6: return mem ? h_movzx8 : null;
    case 0x1b7: return mem ? h_movzx16 : null;
    case 0x1be: return mem ? h_movsx8 : null;
    case 0x1bf: return mem ? h_movsx16 : null;
  }
  return null;
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
    // Host calls. Astral Blur sits in a farmalloc() spin loop and reaches a trampoline
    // millions of times a second, so nothing on that path may allocate per call: the
    // argument snapshot is refilled in place — callTrampoline only reads scalars off it
    // and never keeps a reference — and a caller that wants how many rather than which
    // clears retainTrampolineHits. run.mjs prints the log, so the default keeps it.
    this.trampolineHits = [];
    this.trampolineCount = 0;
    this.retainTrampolineHits = true;
    // Held signed, exactly as Int32Array yields them. Storing `>>> 0` here would put
    // values above 2^31 into these fields, transition the map off Smi and deopt the whole
    // opcode switch — 33 M ips down to 14. Signed they never leave Smi range, so the shape
    // is stable by construction rather than by a seeding trick. callTrampoline masks every
    // field it reads with `>>> 0` itself, so it cannot tell the difference.
    this._trampRegs = { eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 0, ebp: 0, esi: 0, edi: 0 };

    // Per-instruction decode state. _m is the one ModRM result, refilled in place: at
    // 0.68 decodes per instruction a fresh literal was ~20 M allocations a second and
    // most of the GC time. Safe because every consumer decodes at most once per
    // instruction and none of them holds the result past it — including fpu.execute,
    // which is why the shape stays {mod, reg, rm, raw, addr}. addr is seeded null so
    // the field is tagged from the start rather than migrating off Smi on first use.
    this._m = { mod: 0, reg: 0, rm: 0, raw: 0, addr: null };
    this.insStart = 0;
    this.opsize = 4;
    this.addrsize = 4;
    this.segOverride = null;
    this.repPrefix = 0;

    // Block cache. _d is the record execBlock is currently running; modrm() consults it
    // instead of re-reading the ModRM byte, and it is null whenever step() is driving.
    this._d = null;
    this.blockTab = new Array(BLOCK_SLOTS).fill(null);
    this.codeBits = new Uint8Array((machine.size >> 4) + 2);
    this.pageGen = new Uint32Array((machine.size >> 12) + 2);
    this.codeDirty = 0;
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
    // A part is loaded into freshly bumped address space, but reset() is the one place
    // where the bytes under an address can change wholesale, so start from an empty cache.
    this.blockTab.fill(null);
    this.codeBits.fill(0);
    this._d = null;
    this.codeDirty = 0;
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
    this.codeWrite(addr, size);
    try {
      if (size === 1) this.mem.setUint8(addr, v & 0xff);
      else if (size === 2) this.mem.setUint16(addr, v & 0xffff, true);
      else this.mem.setUint32(addr, v >>> 0, true);
    } catch { throw new Fault(`write fault at 0x${addr.toString(16)}`, this.context()); }
  }

  /**
   * Write barrier for the block cache; the FPU calls it too, because it reaches
   * cpu.mem directly and would otherwise be a hole in it.
   *
   * codeBits marks the 16-byte chunks a live block was decoded from, so an ordinary data
   * write is one typed-array load that misses. Granularity is the whole point: these
   * images put code and data in the same 4 KB page, and at page granularity the demo's
   * own buffer writes were invalidating 80% of all lookups.
   *
   * A hit bumps the generation of the 4 KB page the write lands in — coarse on purpose,
   * because a block only has to remember two of them — and raises codeDirty so a block
   * that patched itself stops after the offending instruction instead of running on from
   * stale records. Chunks past the map read undefined, which fails === 1 and leaves the
   * fault to the DataView.
   */
  codeWrite(addr, size) {
    const k = addr >> 4;
    if (this.codeBits[k] === 1) this.codeTouch(addr, size);
    else if ((addr & 15) + size > 16 && this.codeBits[k + 1] === 1) this.codeTouch(addr, size);
  }

  codeTouch(addr, size) {
    const p = addr >>> 12, q = (addr + size - 1) >>> 12;
    this.pageGen[p] = (this.pageGen[p] + 1) >>> 0;
    if (q !== p) this.pageGen[q] = (this.pageGen[q] + 1) >>> 0;
    this.codeDirty = 1;
  }

  // The size-4 arms lifted out whole. Flat 32-bit code takes them for all but a
  // handful of instructions, and hoisting the size test to the call site turns two
  // unpredictable branches per access into none. The try/catch costs nothing in V8
  // and the Fault it raises is load-bearing — it is what run.mjs and worker.js report.
  rd32(addr) {
    addr = addr >>> 0;
    try { return this.mem.getUint32(addr, true) >>> 0; }
    catch { throw new Fault(`read fault at 0x${addr.toString(16)}`, this.context()); }
  }

  wr32(addr, v) {
    addr = addr >>> 0;
    this.codeWrite(addr, 4);
    try { this.mem.setUint32(addr, v >>> 0, true); }
    catch { throw new Fault(`write fault at 0x${addr.toString(16)}`, this.context()); }
  }

  // ------------------------------------------------------------------- fetching

  fetch8() { return this.mem.getUint8(this.eip++); }
  fetch16() { const v = this.mem.getUint16(this.eip, true); this.eip += 2; return v; }
  fetch32() { const v = this.mem.getUint32(this.eip, true) >>> 0; this.eip += 4; return v; }
  fetchImm(size) { return size === 1 ? this.fetch8() : size === 2 ? this.fetch16() : this.fetch32(); }
  fetchS8() { return (this.fetch8() << 24) >> 24; }

  // --------------------------------------------------------------------- modrm

  /**
   * Decode ModRM. Returns this._m — {mod, reg, rm, raw, addr}, valid only until the
   * next decode — where addr is null for the register form. `raw` is the undecoded
   * byte, which the x87 block needs because its register-form opcodes are identified
   * by the whole byte.
   */
  modrm() {
    const d = this._d;
    if (d !== null) {
      // Running out of the block cache: the byte fields are already decoded, but the
      // address is not and must not be — base and index name registers whose contents
      // change under the very loop this record was cached for. eip lands on the trailing
      // immediate by assignment rather than by addition, so it is right whether the
      // caller entered at the opcode or, as the x87 arm does, already past the whole
      // instruction.
      const m = this._m;
      m.mod = d.mod; m.reg = d.reg; m.rm = d.rm; m.raw = d.raw;
      this.eip = d.ipos;
      if (d.mod === 3) { m.addr = null; return m; }
      const r = this.regs, b = d.base, x = d.index;
      m.addr = ((b < 0 ? 0 : r[b]) + (x < 0 ? 0 : r[x] << d.scale) + d.disp) >>> 0;
      return m;
    }

    const b = this.fetch8();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    const m = this._m;
    m.mod = mod; m.reg = reg; m.rm = rm; m.raw = b;
    if (mod === 3) { m.addr = null; return m; }
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

    m.addr = addr >>> 0;
    return m;
  }

  readRM(m, size) { return m.addr === null ? this.getReg(m.rm, size) : this.rd(m.addr, size); }
  writeRM(m, size, v) { m.addr === null ? this.setReg(m.rm, size, v) : this.wr(m.addr, size, v); }
  readRM32(m) { return m.addr === null ? this.get32(m.rm) : this.rd32(m.addr); }
  writeRM32(m, v) { m.addr === null ? this.set32(m.rm, v) : this.wr32(m.addr, v); }

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

  // The same three, specialised to size 4 with mask and sign folded to constants. The
  // arithmetic is character-for-character the generic version — only mask()/signBit()
  // and their size tests are gone. `full` stays a double on purpose: a+b+carry of two
  // 32-bit operands is exact in one, which is what makes the CF test a plain compare.
  setLogicFlags32(r) {
    r = (r & 0xffffffff) >>> 0;
    this.cf = 0; this.of = 0; this.af = 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = (r & 0x80000000) ? 1 : 0;
    this.pf = PARITY[r & 0xff];
    return r;
  }

  doAdd32(a, b, carry = 0) {
    a = (a & 0xffffffff) >>> 0; b = (b & 0xffffffff) >>> 0;
    const full = a + b + carry;
    const r = (full & 0xffffffff) >>> 0;
    this.cf = full > 0xffffffff ? 1 : 0;
    this.of = ((a ^ r) & (b ^ r) & 0x80000000) ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = (r & 0x80000000) ? 1 : 0;
    this.pf = PARITY[r & 0xff];
    return r;
  }

  doSub32(a, b, borrow = 0) {
    a = (a & 0xffffffff) >>> 0; b = (b & 0xffffffff) >>> 0;
    const full = a - b - borrow;
    const r = (full & 0xffffffff) >>> 0;
    this.cf = full < 0 ? 1 : 0;
    this.of = ((a ^ b) & (a ^ r) & 0x80000000) ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = (r & 0x80000000) ? 1 : 0;
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

  alu32(op, a, b) {
    switch (op) {
      case 0: return this.doAdd32(a, b);
      case 1: return this.setLogicFlags32(a | b);
      case 2: return this.doAdd32(a, b, this.cf);
      case 3: return this.doSub32(a, b, this.cf);
      case 4: return this.setLogicFlags32(a & b);
      case 5: return this.doSub32(a, b);
      case 6: return this.setLogicFlags32(a ^ b);
      case 7: this.doSub32(a, b); return null;
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
    let remaining = budget;
    while (remaining > 0 && !this.halted) {
      const b = this.block(this.eip);
      // A block is only ever entered whole. The last instructions of a budget are
      // therefore always reached by single-stepping, which is what keeps a caller that
      // cuts the stream at a fixed count seeing exactly the state step() alone produced.
      if (b !== null && b.len <= remaining) remaining -= this.execBlock(b);
      else { this.step(); remaining--; }
    }
    return this.count;
  }

  /**
   * Run a whole cached block, returning how many instructions actually went by — fewer
   * than its length only if it overwrote its own remaining records part way through.
   *
   * Every address in here is a constant: only an F_END instruction can move eip, and one
   * of those can only be the last op in a block, so op i always starts where op i-1
   * ended. The per-instruction contract is step()'s to the letter — insStart set, count
   * incremented before execution — and the slow arm additionally restores the prefix
   * state and leaves eip just past the opcode so execute()'s own fetches still line up.
   */
  execBlock(b) {
    const ops = b.ops, n = ops.length;
    const before = this.count;
    for (let i = 0; i < n; i++) {
      const o = ops[i];
      const h = o.h;
      this.insStart = o.at;
      this.count++;
      if (h !== null) {
        this.eip = o.fall;
        h(this, o);
      } else {
        this.opsize = o.opsize;
        this.repPrefix = o.rep;
        this.segOverride = o.seg;
        this.eip = o.mid;
        this._d = o;
        this.execute(o.op);
      }
      // Only codeDirty is worth testing per instruction. The two sites that halt are both
      // retf, both F_END, so halting can only ever happen on the last op of a block —
      // run()'s own loop catches it and the count delta is n either way.
      if (this.codeDirty !== 0) { this._d = null; return this.count - before; }
    }
    this._d = null;
    return n;
  }

  /**
   * The block starting at `eip`, or null when this address has to be single-stepped —
   * either because the predecoder does not model the instruction there, or because it
   * is one of the prefixes that changes addressing.
   */
  block(eip) {
    this.codeDirty = 0;
    const slot = (eip ^ (eip >>> 17)) & BLOCK_MASK;
    const b = this.blockTab[slot];
    if (b !== null && b.start === eip
        && b.g0 === this.pageGen[b.p0] && b.g1 === this.pageGen[b.p1]) {
      return b.ops === null ? null : b;
    }
    return this.compile(eip, slot);
  }

  compile(eip, slot) {
    const ops = [];
    let p = eip;
    for (let i = 0; i < BLOCK_MAX_OPS; i++) {
      const o = this.decodeOne(p);
      if (o === null) break;
      ops.push(o);
      p = (p + o.len) >>> 0;
      if (o.end || p - eip > BLOCK_MAX_BYTES) break;
    }
    // A negative answer is cached too, otherwise every pass over an unmodelled opcode
    // would try to decode it again. Nothing marks its pages, so its generations never
    // move and the entry stands until the slot is claimed by another address.
    const p0 = eip >>> 12;
    const p1 = ops.length === 0 ? p0 : (p - 1) >>> 12;
    for (let k = eip >> 4, last = (p - 1) >> 4; k <= last; k++) this.codeBits[k] = 1;
    const b = {
      start: eip, len: ops.length, ops: ops.length === 0 ? null : ops,
      p0, p1, g0: this.pageGen[p0], g1: this.pageGen[p1],
    };
    this.blockTab[slot] = b;
    return b.ops === null ? null : b;
  }

  /**
   * Decode one instruction at `p` into a cache record, or null when it is not one the
   * predecoder models. Byte-derived facts only. `imm` holds the immediate's raw bits —
   * a byte for I_8, a word for I_16, a signed dword otherwise — so a consumer applies
   * whichever of fetchImm's and fetchS8's conventions its opcode uses.
   */
  decodeOne(p) {
    const u8 = this.u8;
    if (p + 24 > u8.length) return null;

    const start = p;
    let opsize = 4, rep = 0, seg = null;
    for (let i = 0; ; i++) {
      if (i === 8) return null;                    // absurd prefix run: let step() have it
      const b = u8[p];
      if (b === 0x66) { opsize = 2; p++; }
      else if (b === 0xf2 || b === 0xf3) { rep = b; p++; }
      else if (b === 0x2e || b === 0x36 || b === 0x3e || b === 0x26 || b === 0x64 || b === 0x65) { seg = b; p++; }
      else if (b === 0xf0) { p++; }
      else if (b === 0x67) return null;            // 16-bit addressing: modrm() faults
      else break;
    }

    const op = u8[p++];
    const hlen = p - start;          // execute() is entered here and fetches the rest,
    const id = op === 0x0f ? 0x100 | u8[p++] : op;   // twoByte() included
    const d = DEC[id];
    if ((d & F_BAD) !== 0) return null;

    let mod = 0, reg = 0, rm = 0, raw = 0, mlen = 0;
    let base = -1, index = -1, scale = 0, disp = 0;
    if ((d & F_MODRM) !== 0) {
      raw = u8[p];
      mod = raw >> 6; reg = (raw >> 3) & 7; rm = raw & 7;
      let q = p + 1;
      if (mod !== 3) {
        if (rm === 4) {
          const sib = u8[q++];
          scale = sib >> 6;
          const x = (sib >> 3) & 7, bs = sib & 7;
          if (x !== 4) index = x;
          if (bs === 5 && mod === 0) { disp = rd32le(u8, q); q += 4; }
          else base = bs;
        } else if (rm === 5 && mod === 0) {
          disp = rd32le(u8, q); q += 4;
        } else {
          base = rm;
        }
        // At most one of these ever fires: the two disp32-only forms are both mod 0.
        if (mod === 1) { disp = (u8[q] << 24) >> 24; q++; }
        else if (mod === 2) { disp = rd32le(u8, q); q += 4; }
      }
      mlen = q - p;
      p = q;
    }
    const ipos = p >>> 0;            // where the immediate starts, and where modrm parks eip

    let imm = 0;
    switch (d >>> 3) {
      case I_8: imm = u8[p]; p += 1; break;
      case I_16: imm = u8[p] | (u8[p + 1] << 8); p += 2; break;
      case I_Z: imm = opsize === 2 ? (u8[p] | (u8[p + 1] << 8)) : rd32le(u8, p); p += opsize; break;
      case I_32: imm = rd32le(u8, p); p += 4; break;
      case I_PTR: p += 6; break;
      case I_G3: if (reg < 2) p += (id === 0xf6 ? 1 : opsize); break;   // only /0 and /1 take one
    }

    // group 5 is the one opcode whose ModRM decides whether it transfers control.
    const end = (d & F_END) !== 0 || (id === 0xff && reg >= 2 && reg <= 5);
    // simm is imm under fetchS8's convention rather than fetchImm's; the branch targets
    // are relative to the end of the instruction, which is where eip is when they run.
    const simm = (d >>> 3) === I_8 ? (imm << 24) >> 24 : imm;
    const o = {
      id, op, at: start >>> 0, mid: (start + hlen) >>> 0, ipos, fall: p >>> 0,
      target: (p + simm) >>> 0, len: p - start, opsize, rep, seg,
      mlen, mod, reg, rm, raw, base, index, scale, disp, imm, simm, end, h: null,
    };
    o.h = pick(o);
    return o;
  }

  step() {
    this._d = null;
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
        if (size === 4) {
          const r = this.alu32(aluOp, this.readRM32(m), this.get32(m.reg));
          if (r !== null) this.writeRM32(m, r);
          return;
        }
        const r = this.alu(aluOp, this.readRM(m, size), this.getReg(m.reg, size), size);
        if (r !== null) this.writeRM(m, size, r);
        return;
      }
      if (form === 2 || form === 3) {                 // r, r/m
        const size = form === 2 ? 1 : S;
        const m = this.modrm();
        if (size === 4) {
          const r = this.alu32(aluOp, this.get32(m.reg), this.readRM32(m));
          if (r !== null) this.set32(m.reg, r);
          return;
        }
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
        if (S === 4) this.set32(i, this.doAdd32(this.get32(i), 1));
        else this.setReg(i, S, this.doAdd(this.getReg(i, S), 1, S));
        this.cf = cf;                                  // inc preserves CF
        return;
      }
      case 0x48: case 0x49: case 0x4a: case 0x4b:
      case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
        const i = op & 7, cf = this.cf;
        if (S === 4) this.set32(i, this.doSub32(this.get32(i), 1));
        else this.setReg(i, S, this.doSub(this.getReg(i, S), 1, S));
        this.cf = cf;
        return;
      }

      // --- push/pop r32 -------------------------------------------------------
      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57:
        this.push(S === 4 ? this.get32(op & 7) : this.getReg(op & 7, S)); return;
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        if (S === 4) this.set32(op & 7, this.pop());
        else this.setReg(op & 7, S, this.pop());
        return;

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
        if (size === 4) {
          const a = this.readRM32(m);
          const b = op === 0x83 ? (this.fetchS8() >>> 0) : this.fetch32();
          const r = this.alu32(m.reg, a, b);
          if (r !== null) this.writeRM32(m, r);
          return;
        }
        const a = this.readRM(m, size);
        const b = op === 0x83 ? (this.fetchS8() >>> 0) : this.fetchImm(size);
        const r = this.alu(m.reg, a, b, size);
        if (r !== null) this.writeRM(m, size, r);
        return;
      }

      case 0x84: case 0x85: {                          // test r/m, r
        const size = op === 0x84 ? 1 : S;
        const m = this.modrm();
        if (size === 4) { this.setLogicFlags32(this.readRM32(m) & this.get32(m.reg)); return; }
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
        if (size === 4) { this.writeRM32(m, this.get32(m.reg)); return; }
        this.writeRM(m, size, this.getReg(m.reg, size));
        return;
      }
      case 0x8a: case 0x8b: {                          // mov r, r/m
        const size = op === 0x8a ? 1 : S;
        const m = this.modrm();
        if (size === 4) { this.set32(m.reg, this.readRM32(m)); return; }
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
        if (S === 4) this.set32(op & 7, this.fetch32());
        else this.setReg(op & 7, S, this.fetchImm(S));
        return;

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
      const regs = this._trampRegs;
      regs.eax = this.regs[0]; regs.ecx = this.regs[1];
      regs.edx = this.regs[2]; regs.ebx = this.regs[3];
      regs.esp = this.regs[4]; regs.ebp = this.regs[5];
      regs.esi = this.regs[6]; regs.edi = this.regs[7];
      const effects = this.machine.callTrampoline(off, regs);
      this.trampolineCount++;
      if (this.retainTrampolineHits) {
        this.trampolineHits.push({ addr: off, count: this.count, eip: this.insStart });
      }
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
