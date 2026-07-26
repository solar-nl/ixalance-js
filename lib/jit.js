// A JIT for the same machine lib/cpu.js interprets: hot basic blocks are turned into
// JavaScript source and handed to new Function(), so V8's optimizing compiler sees the
// block as a straight-line function. Registers become locals, flags become locals, and
// the per-instruction dispatch the block cache still pays — one indirect call every 5.6
// instructions, which is the measured dynamic block length — disappears inside a block.
//
// It is a SUBCLASS, not a fork. There is exactly one state object, so reset(), step(),
// execute(), block()/compile()/decodeOne(), the FPU wiring, farCall/trampolines,
// context() and codeWrite() are all inherited unchanged and lib/cpu.js stays the oracle
// this is checked against. What is overridden is run(): the same loop, with one extra
// tier between "cached block" and "interpret it".
//
// STAGE 2 — VERIFY, DO NOT RECOMPILE. The interpreter throws a block record away on every
// 4 KB page-generation bump, and jizz bumps generations 1.24 M times per 200 M instructions
// (peak 5,507,006 per 200 M in the 700-800 M window) against only ~500 distinct block
// starts. new Function() costs 20.4 us against a 37 ns 32-byte memcmp, so following the
// interpreter's invalidation would be one V8 compile every ~36 executed instructions.
// Measured over 1.2e9 instructions, 99.99976% of those recompiles found BYTE-IDENTICAL
// code — 18 genuine byte changes in total, all at one address, cycling three versions. So
// a compiled function is keyed on its BYTES: identical bytes prove identical semantics,
// because a decodeOne record holds byte-derived facts only (cpu.js:876-882). Tiers,
// cheapest first: generations match -> return fn; generations stale -> memcmp the
// emit-time snapshot and refresh; bytes differ -> hash and probe a per-address version
// map; more than 8 versions -> poisoned, interpreter forever.
//
// STAGE 3 — FULL INTEGER CODEGEN. Every block compiles now: an instruction with no
// template no longer refuses the block, it emits a CALLOUT to the very code execBlock
// would have run (the record's handler, or execute() with the prefix state restored).
// Templates cover the measured dynamic mix — the whole ALU block, group 1, the mov family,
// inc/dec, push/pop, test, movzx/movsx, lea, xchg eAX, cdq, grp3 not/neg and the
// jcc/jmp/call/ret terminators — at all three operand sizes, with the interpreter's flag
// algebra copied character for character including its non-architectural quirks (inc/dec
// preserve CF; neg's CF is the operand, not the borrow; mul/imul write only CF and OF;
// div/idiv and not write nothing).
//
// The set is bounded by what the demos execute, not by what the ISA has. A template arm no
// workload reaches has never been checked against the oracle, so shipping it is a liability
// with no measured return — and a missing template is never wrong, only slower, because the
// callout IS the interpreter. /tmp/ixa-jit/T3-cover.mjs attributes every executed
// instruction to an arm; 119 arms fire across jizz and astral, and cwde, xchg r/m, push
// imm, push r/m and the cmc/clc/stc/cld/std one-liners were written, measured at zero, and
// taken back out. test r/m,imm (f6/f7 /0,/1) is a callout for a different reason: I_G3
// advances past the immediate without recording it (cpu.js:868), so the bits exist only in
// memory and execute() is the only thing that reads them.
//
// STAGE 4 — x87 THROUGH THE EXISTING FPU, CLASSIFIED STATICALLY. lib/fpu.js is called, not
// re-implemented: rounding control (fpu.js:69-84), the 80-bit conversions (fpu.js:88-122)
// and the documented fidelity compromise are proven code, and JitCPU IS a CPU, so the FPU's
// view of it (cpu.mem, cpu.codeWrite, cpu.set16, cpu.unimplemented) keeps working untouched.
// What the emitter decides at compile time is what that call can do to integer state —
// x87Flags / x87Eax / x87Stores below — so the 24%+ dc/db/de/d9/d8/dd/da arithmetic bulk
// crosses the call with ZERO flag stores, zero register stores, no committed count or
// insStart, one write into a baked ModRM object, and no codeDirty test. Only fcomi/fucomi
// pay a flag barrier and only fnstsw ax pays a register one.
//
// Measured, and worth stating plainly because it contradicts the projection this stage was
// planned against: that removal is worth about 1%. jizz's generation phase is bound by the
// host call itself — fpu.execute plus its helpers are 39% of the phase's time in BOTH
// engines, doing identical work — so the reachable ceiling there is 1/0.39 = 2.5x with every
// other instruction free, and the phase's actual gain came from the dispatch loop instead
// (see run(), and the note on e.tmplIns). The x87 work's return is correctness, not speed:
// stage 3's fnstsw arm reloaded the whole register file having flushed none of it, and its
// catch decided flag ownership from a block-wide union of callout defs rather than from the
// callout that was actually on the stack. Both are fixed here; jizz reaches neither, so both
// are proven by /tmp/ixa-jit/S4-synth.mjs, whose six probes are themselves validated by
// /tmp/ixa-jit/S4-mutate.sh — four emitter defects injected one at a time, each caught by
// exactly the probe written for it. A clean run of a probe that was never shown a defect is
// worth nothing here: the first version of every one of those probes passed while broken.
//
// ---------------------------------------------------------------------------------
// THE EARLY-EXIT CONTRACT, which is what actually constrains the design
//
// A compiled block has three ways to stop before its last instruction, and each one
// publishes architectural state that golden.mjs and diff.mjs compare exactly:
//
//   a fault    an emitted DataView access is out of range and throws RangeError
//   own-SMC    a store lands in the bytes of the block that is running
//   callout    execute() raised codeDirty, i.e. it patched the rest of this block
//
// Flag liveness makes the first two hard: if op 1's flags were elided because op 3
// redefines them, then stopping at op 2 publishes op 0's flags where op 1's belong. The
// resolution is REPLAY, and it is free. A block that contains no callout never writes R[]
// or c.cf..c.of until it exits, so at any point before its exit the CPU object still holds
// the state the block was ENTERED with — no snapshot is needed, it was never overwritten.
// So a fault or an own-SMC store in such a block is answered with
//
//     c.count = base; c.eip = b.start; return c.execBlock(b);
//
// which re-runs the block through the oracle from its first instruction and produces
// exactly the interpreter's answer, including the real Fault with a real context(). Stores
// already committed by the emitted code are redone, which is a no-op: replay is
// deterministic from identical state, so the same bytes land at the same addresses. The
// one thing that would NOT survive being redone is a trampoline, and a trampoline can only
// be reached through farCall, whose three call sites (0x9a, ff /3, ff /5) are all F_END and
// therefore always the LAST instruction of a block — nothing can fault after one.
//
// A block that DOES contain a callout has had R[] and the flag fields overwritten by the
// callout — or, for x87, has had FPU state mutated, which replay could not undo — so replay
// is unavailable and every exit must publish exact flags. Such blocks are therefore compiled
// with EAGER flags — every bit computed, no liveness — and their exits flush and hand the
// offending instruction to step(). Statically decided, per block, at emit time. It costs
// nothing where it matters: the 300-600 M render phase is 0-3% x87 and its hot blocks are
// callout-free, and forcing EVERY block eager (IXA_JIT_EAGER=1) was measured at 1%.
//
// codeDirty is not tested after emitted stores at all. The interpreter stops the block on
// ANY write that hits ANY cached block's bytes, then re-dispatches and carries on with the
// same instructions — a difference in dispatch, not in architecture. Only a write into
// THIS block's own bytes can change what the rest of this block means, and that is a
// compile-time constant range, so the emitted store tests `xe < END && xe + n > START`
// (two never-taken compares) instead of loading a CPU field. codeDirty is still tested
// after a callout, because execute() can patch anything — and after an x87 callout only
// when the form can store at all, which x87Stores() decides from (op, mod, reg).
//
// ---------------------------------------------------------------------------------
// FLAG LIVENESS. duFor() gives def/use/weak per record; a backward pass seeded ALL-LIVE at
// the exit gives the bits each instruction must actually compute. 64.4% of computed bits
// are dead this way over 8e8 instructions of jizz. The exit stays eager — cross-block
// handoff is still the c.cf..c.of fields — so the LAST definer of every flag always
// computes it, which is what makes the exit flush correct. DF is never localized: 1.56 M
// cross-block reads and no arithmetic ever produces it, so it stays the c.df field.
//
// TERMINAL FUSION. A block ending in jcc whose producer strongly defines every bit the
// condition consumes emits the branch as a direct operand comparison (jz -> xa === xb,
// jb -> xa < xb on the unsigned masked operands, jl -> sign-extended <). With an eager
// exit the producer must still compute those flags for the flush, so this removes a test
// on a local and nothing more; it is here because it is the shape stage 6's deferred
// materialization needs, and because the predicates are worth proving once
// (/tmp/ixa-jit/fusetest.mjs checks all 16 conditions against cond() exhaustively).
//
// IXA_JIT_EAGER=1 forces every block eager — the debug ladder that separates a template
// bug from a liveness or fusion bug.
//
// EMITTED-CODE CONVENTIONS, fixed because they are load-bearing (cpu.js:347-352 records a
// 33 M -> 14 M ips loss from getting the second one wrong):
//   · a register local is ALWAYS signed — loaded `R[i] | 0`, written back raw. Arithmetic
//     converts to unsigned in a fresh `xa`/`xb` temporary instead.
//   · an address is ALWAYS a fresh `>>> 0` expression consumed immediately as a DataView
//     index. No variable ever holds both an address and a signed value.
//   · memory goes through the DataView `M`. Replacing the fetch path with u8 indexing was
//     measured 30% slower in this codebase; do not "optimize" it.
//   · nothing is assigned to a local until every memory access of that instruction has
//     succeeded, so a fault leaves the instruction untouched and re-executing it is exact.
//   · every CPU field the emitted code writes is one CPU already writes, with the same
//     signedness, so no map can migrate underneath the generated function.

import { CPU, Unimplemented, Fault } from './cpu.js';

// Same identities, not lookalikes: run.mjs:189 and worker.js:109 test `instanceof`, and a
// locally re-declared class of the same name would escape both as an unhandled error.
export { Unimplemented, Fault };

// PARITY is module-private in cpu.js and the oracle must not grow an export just to be
// read from here, so it is rebuilt identically: 1 when the low byte has even parity.
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let bits = 0, v = i;
  while (v) { bits ^= v & 1; v >>= 1; }
  PARITY[i] = bits ? 0 : 1;
}

// Compile on the 16th entry, not the first. Break-even for a 20.4 us compile against the
// ~120 ns an interpreted 5.6-instruction block costs is ~168 entries, so the threshold is
// not what pays for compilation — concentration is, top 20 blocks being 71% of the stream.
// What it buys is that a block reached once on a boot path never emits at all.
const JIT_HITS = 16;

// Distinct byte-versions kept per address before the address is abandoned to the
// interpreter. Measured: the one block in jizz that genuinely rewrites itself cycles 3
// versions, so 8 is slack, not a tuned number. It exists to bound the pathological case.
const JIT_VERSIONS = 8;

// A backstop, not a policy. Poisoning bounds emits per address at JIT_VERSIONS + 1 and
// only ~500 addresses ever execute, so a healthy run finishes three orders of magnitude
// under this; if some other image does not, it degrades to the interpreter instead of
// melting into V8's parser.
const EMIT_MAX = 1 << 16;

// Slots in the direct-mapped probe that fronts jitTab. ~500 addresses ever execute, so
// 32 K slots make an aliasing miss a curiosity rather than a cost, and a miss is only a
// Map lookup anyway.
const JIT_SLOTS = 1 << 15, JIT_SLOT_MASK = JIT_SLOTS - 1;

const ENV = globalThis.process?.env;
const STATS = ENV?.IXA_JIT_STATS === '1';
const EAGER = ENV?.IXA_JIT_EAGER === '1';
const WINDOW = 1e8;

/** FNV-1a over a byte span. Only ever a version-map key: every hit is confirmed by a full
 *  memcmp against the stored snapshot, so a collision costs a compile, never correctness. */
function fnv1a(u8, at, len) {
  let h = 0x811c9dc5;
  for (let k = 0; k < len; k++) { h ^= u8[at + k]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function bytesEq(u8, at, snap) {
  const n = snap.length;
  for (let k = 0; k < n; k++) if (u8[at + k] !== snap[k]) return false;
  return true;
}

// ------------------------------------------------------------------ flag dataflow

const C_ = 1, P_ = 2, A_ = 4, Z_ = 8, S_ = 16, O_ = 32;
const ALL6 = C_ | P_ | A_ | Z_ | S_ | O_;
const FLAG_ORDER = ['cf', 'pf', 'af', 'zf', 'sf', 'of'];
const FLAG_BIT = { cf: C_, pf: P_, af: A_, zf: Z_, sf: S_, of: O_ };

// What cond() reads per condition code, cpu.js:650-669.
const CONDUSE = [O_, O_, C_, C_, Z_, Z_, C_ | Z_, C_ | Z_,
                 S_, S_, P_, P_, S_ | O_, S_ | O_, Z_ | S_ | O_, Z_ | S_ | O_];

// shift(), cpu.js:1279-1347: AF is never touched, OF is left alone by shr/sar/ror, and the
// rotates leave Z/S/P. Indexed by the ModRM reg field: rol ror rcl rcr shl shr sal sar.
const SHIFTDEF = [C_ | O_, C_, C_ | O_, C_, C_ | O_ | Z_ | S_ | P_, C_ | Z_ | S_ | P_,
                  C_ | O_ | Z_ | S_ | P_, C_ | Z_ | S_ | P_];
const SHIFTUSE = [0, 0, C_, C_, 0, 0, 0, 0];

const DU_BARRIER = { use: ALL6, def: 0, weak: ALL6 };

/**
 * def/use/weak for one decode record. A STRONG def always overwrites and therefore kills
 * an earlier def; a WEAK def only may, so it can never be elided and never kills. Anything
 * not named here is a barrier — it reads everything and may write everything — which is
 * correct for an opcode this table has not been taught, and costs only elision.
 *
 * This is the census table from /tmp/ixa-jit/flaglive.mjs, which ran it over 8e8
 * instructions of jizz with zero unknown-op barriers, so every opcode the demos execute is
 * classified here rather than falling into the barrier arm.
 */
function duFor(o) {
  const id = o.id, reg = o.reg;
  if (id < 0x40 && (id & 7) < 6) {                    // ALU r/m,r · r,r/m · eAX,imm
    const a = id >> 3;
    return { use: (a === 2 || a === 3) ? C_ : 0, def: ALL6, weak: 0 };
  }
  if (id >= 0x40 && id <= 0x4f) return { use: 0, def: ALL6 & ~C_, weak: 0 };   // inc/dec keep CF
  if (id === 0x69 || id === 0x6b) return { use: 0, def: ALL6, weak: 0 };
  if (id >= 0x70 && id <= 0x7f) return { use: CONDUSE[id & 15], def: 0, weak: 0 };
  if (id === 0x80 || id === 0x81 || id === 0x83) {
    return { use: (reg === 2 || reg === 3) ? C_ : 0, def: ALL6, weak: 0 };
  }
  if (id === 0x84 || id === 0x85 || id === 0xa8 || id === 0xa9) return { use: 0, def: ALL6, weak: 0 };
  if (id === 0x9a) return { use: 0, def: 0, weak: C_ };                        // trampoline effects
  if (id === 0x9c) return DU_BARRIER;                                          // pushfd
  if (id === 0x9d) return { use: 0, def: ALL6, weak: 0 };                      // popfd
  if (id === 0xa6 || id === 0xa7 || id === 0xae || id === 0xaf) {              // cmps/scas
    return { use: o.rep !== 0 ? Z_ : 0, def: ALL6, weak: 0 };
  }
  if (id === 0xc0 || id === 0xc1) {
    return (o.imm & 31) === 0 ? { use: 0, def: 0, weak: 0 }
                              : { use: SHIFTUSE[reg], def: SHIFTDEF[reg], weak: 0 };
  }
  if (id === 0xd0 || id === 0xd1) return { use: SHIFTUSE[reg], def: SHIFTDEF[reg], weak: 0 };
  if (id === 0xd2 || id === 0xd3) return { use: SHIFTUSE[reg], def: 0, weak: SHIFTDEF[reg] };
  if (id === 0xe0 || id === 0xe1) return { use: Z_, def: 0, weak: 0 };
  if (id === 0xf5) return { use: C_, def: C_, weak: 0 };
  if (id === 0xf8 || id === 0xf9) return { use: 0, def: C_, weak: 0 };
  if (id === 0xf6 || id === 0xf7) {
    if (reg <= 1 || reg === 3) return { use: 0, def: ALL6, weak: 0 };          // test / neg
    if (reg === 4 || reg === 5) return { use: 0, def: C_ | O_, weak: 0 };      // mul/imul
    return { use: 0, def: 0, weak: 0 };                                        // not/div/idiv
  }
  if (id === 0xfe) return reg <= 1 ? { use: 0, def: ALL6 & ~C_, weak: 0 } : { use: 0, def: 0, weak: 0 };
  if (id === 0xff) {
    if (reg <= 1) return { use: 0, def: ALL6 & ~C_, weak: 0 };
    if (reg === 3 || reg === 5) return { use: 0, def: 0, weak: C_ };           // far -> trampoline
    return { use: 0, def: 0, weak: 0 };
  }
  if (id >= 0xd8 && id <= 0xdf) {
    // fcomi/fucomi write the integer flags out of the x87 condition codes (fpu.js:327,
    // :381); AF is left alone. Every other x87 form touches no integer flag at all. The
    // predicate is x87Flags() and only x87Flags(): the liveness chain and the emitted
    // barrier have to be the same decision, or one of them is silently wrong.
    if (x87Flags(o)) return { use: 0, def: C_ | P_ | Z_ | S_ | O_, weak: 0 };
    return { use: 0, def: 0, weak: 0 };
  }
  if ((id >= 0x140 && id <= 0x14f) || (id >= 0x180 && id <= 0x18f) || (id >= 0x190 && id <= 0x19f)) {
    return { use: CONDUSE[id & 15], def: 0, weak: 0 };
  }
  if (id === 0x1a3 || id === 0x1ab || id === 0x1b3 || id === 0x1bb) return { use: 0, def: C_, weak: 0 };
  if (id === 0x1a4 || id === 0x1ac) {
    return (o.imm & 31) === 0 ? { use: 0, def: 0, weak: 0 }
                              : { use: 0, def: C_ | Z_ | S_ | P_, weak: 0 };
  }
  if (id === 0x1a5 || id === 0x1ad) return { use: 0, def: 0, weak: C_ | Z_ | S_ | P_ };
  if (id === 0x1af) return { use: 0, def: C_ | O_, weak: 0 };
  if (id === 0x1bc || id === 0x1bd) return { use: 0, def: Z_, weak: 0 };
  // moves, push/pop, lea, cwde/cdq, rets, jmp/call, xchg, nop, movs/stos/lods, movzx/movsx,
  // bswap, rdtsc, cpuid: no integer flag is written or read. cld/std touch DF only, which
  // is never localized.
  const NONE = (id >= 0x50 && id <= 0x68) || id === 0x6a || (id >= 0x86 && id <= 0x99)
    || id === 0x9b || (id >= 0xa0 && id <= 0xa5) || (id >= 0xaa && id <= 0xad)
    || (id >= 0xb0 && id <= 0xbf) || id === 0xc2 || id === 0xc3 || id === 0xc6 || id === 0xc7
    || id === 0xca || id === 0xcb || id === 0xe2 || id === 0xe3 || id === 0xe8 || id === 0xe9
    || id === 0xeb || id === 0xfc || id === 0xfd || id === 0x131 || id === 0x1a2
    || id === 0x1b6 || id === 0x1b7 || id === 0x1be || id === 0x1bf
    || (id >= 0x1c8 && id <= 0x1cf);
  return NONE ? { use: 0, def: 0, weak: 0 } : DU_BARRIER;
}

/** Backward pass, exit seeded ALL-LIVE. Returns the bits each instruction must compute. */
function liveness(du, n) {
  const keep = new Int32Array(n);
  let live = ALL6;
  for (let k = n - 1; k >= 0; k--) {
    const d = du[k];
    keep[k] = (d.def & live) | d.weak;
    live = (live & ~d.def) | d.use;
  }
  return keep;
}

// -------------------------------------------------------------------- emission
//
// Everything below produces source text. An emitter records, through E, every register and
// flag local it touches; both sets are conservative and symmetric, so everything referenced
// either way is declared, loaded at entry and stored at every exit.

const hexu = (v) => '0x' + (v >>> 0).toString(16);
const MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const SIGN = { 1: 0x80, 2: 0x8000, 4: 0x80000000 };

function newEmit(b) {
  const ops = b.ops;
  return {
    regs: new Set(), flags: new Set(), stores: false,
    start: b.start, end: ops[ops.length - 1].fall,
    u(i) { this.regs.add(i); },
    f(n) { this.flags.add(n); },
  };
}

/** An 8-bit operand lives in the low or the high byte of one of the first four locals. */
function regRd(E, i, size) {
  if (size === 4) { E.u(i); return `(r${i} >>> 0)`; }
  if (size === 2) { E.u(i); return `(r${i} & 0xffff)`; }
  if (i < 4) { E.u(i); return `(r${i} & 0xff)`; }
  E.u(i - 4); return `((r${i - 4} >>> 8) & 0xff)`;
}

/** set32/set16/set8, cpu.js:397-406, as one statement over the locals. */
function regWr(E, i, size, v) {
  if (size === 4) { E.u(i); return `r${i} = ${v} | 0;`; }
  if (size === 2) { E.u(i); return `r${i} = (r${i} & -65536) | (${v} & 0xffff);`; }
  if (i < 4) { E.u(i); return `r${i} = (r${i} & -256) | (${v} & 0xff);`; }
  E.u(i - 4); return `r${i - 4} = (r${i - 4} & -65281) | ((${v} & 0xff) << 8);`;
}

const memRd = (size, a) => size === 4 ? `M.getUint32(${a}, true)`
  : size === 2 ? `M.getUint16(${a}, true)` : `M.getUint8(${a})`;
const memWr = (size, a, v) => size === 4 ? `M.setUint32(${a}, ${v}, true);`
  : size === 2 ? `M.setUint16(${a}, ${v}, true);` : `M.setUint8(${a}, ${v});`;

/** The effective address, as ea() computes it at cpu.js:120-123 with the zero terms gone. */
function eaSrc(E, o) {
  let s = '';
  if (o.base >= 0) { E.u(o.base); s = `r${o.base}`; }
  if (o.index >= 0) {
    E.u(o.index);
    const t = o.scale === 0 ? `r${o.index}` : `(r${o.index} << ${o.scale})`;
    s = s === '' ? t : `${s} + ${t}`;
  }
  if (o.disp !== 0) s = s === '' ? String(o.disp) : (o.disp < 0 ? `${s} - ${-o.disp}` : `${s} + ${o.disp}`);
  return `(${s === '' ? '0' : s}) >>> 0`;
}

/**
 * codeWrite() inlined (cpu.js:446-450). One typed-array load that normally misses; the
 * straddle arm only exists for sizes that can cross a 16-byte chunk. `av` must already be
 * an unsigned address held in a const.
 */
function barrierSrc(E, av, size) {
  E.stores = true;
  const straddle = size > 1 ? ` || ((${av} & 15) + ${size} > 16 && CB[(${av} >> 4) + 1] === 1)` : '';
  return `if (CB[${av} >> 4] === 1${straddle}) c.codeTouch(${av}, ${size});`;
}

/** Does this store land in the bytes of the block that is running? A constant range. */
function smcSrc(E, av, size, k) {
  return `if (${av} < ${hexu(E.end)} && ${av} + ${size} > ${hexu(E.start)}) { @@SMC${k}@@ }`;
}

/**
 * doAdd/doSub/setLogicFlags inlined for one operand size, computing only `keep`.
 *
 * `xf` stays a double on purpose: the sum or difference of two masked operands is exact in
 * one, which is what makes the CF test a plain compare — the same reason cpu.js:587 gives.
 * `dst` is null for cmp and test, which keep the flags and drop the result.
 */
function aluSrc(E, aluOp, size, a, b, keep, dst, fuse) {
  const mask = MASK[size], sign = SIGN[size];
  const s = [`const xa = ${a}, xb = ${b};`];
  if (aluOp === 1 || aluOp === 4 || aluOp === 6) {
    const op = aluOp === 1 ? '|' : aluOp === 4 ? '&' : '^';
    s.push(size === 4 ? `const xq = (xa ${op} xb) >>> 0;` : `const xq = xa ${op} xb;`);
    if (keep & C_) { E.f('cf'); s.push('cf = 0;'); }
    if (keep & O_) { E.f('of'); s.push('of = 0;'); }
    if (keep & A_) { E.f('af'); s.push('af = 0;'); }
  } else {
    const add = aluOp === 0 || aluOp === 2;
    let expr = `xa ${add ? '+' : '-'} xb`;
    if (aluOp === 2 || aluOp === 3) { E.f('cf'); expr += ` ${add ? '+' : '-'} cf`; }
    s.push(`const xf = ${expr};`);
    s.push(size === 4 ? 'const xq = xf >>> 0;' : `const xq = xf & ${mask};`);
    if (keep & C_) { E.f('cf'); s.push(`cf = xf ${add ? `> ${mask}` : '< 0'} ? 1 : 0;`); }
    if (keep & O_) {
      E.f('of');
      s.push(add ? `of = ((xa ^ xq) & (xb ^ xq) & ${sign}) ? 1 : 0;`
                 : `of = ((xa ^ xb) & (xa ^ xq) & ${sign}) ? 1 : 0;`);
    }
    if (keep & A_) { E.f('af'); s.push('af = ((xa ^ xb ^ xq) & 0x10) ? 1 : 0;'); }
  }
  if (keep & Z_) { E.f('zf'); s.push('zf = xq === 0 ? 1 : 0;'); }
  if (keep & S_) { E.f('sf'); s.push(`sf = (xq & ${sign}) ? 1 : 0;`); }
  if (keep & P_) { E.f('pf'); s.push('pf = P[xq & 0xff];'); }
  if (dst !== null) s.push(dst('xq'));
  if (fuse !== null) s.push(fuse(size));
  return s;
}

/**
 * The fused terminal branch after a sub or a cmp, over the masked operands the producer
 * already holds. The unsigned conditions compare xa and xb directly because both are
 * already zero-extended; the signed ones sign-extend first, which is the identity
 * sf !== of tests. o/no/p/np are not fused — they would need the flag anyway.
 */
export function fusePred(cc, size) {
  const sign = SIGN[size];
  const sx = (v) => size === 4 ? `(${v} | 0)` : size === 2 ? `((${v} << 16) >> 16)` : `((${v} << 24) >> 24)`;
  switch (cc) {
    case 0x2: return 'xa < xb';
    case 0x3: return 'xa >= xb';
    case 0x4: return 'xa === xb';
    case 0x5: return 'xa !== xb';
    case 0x6: return 'xa <= xb';
    case 0x7: return 'xa > xb';
    case 0x8: return `(xq & ${sign}) !== 0`;
    case 0x9: return `(xq & ${sign}) === 0`;
    case 0xc: return `${sx('xa')} < ${sx('xb')}`;
    case 0xd: return `${sx('xa')} >= ${sx('xb')}`;
    case 0xe: return `${sx('xa')} <= ${sx('xb')}`;
    case 0xf: return `${sx('xa')} > ${sx('xb')}`;
    default: return null;
  }
}

// cond(), cpu.js:650-670, as expressions over the flag locals. The locals hold the same
// 0/1 numbers the fields hold, so `sf !== of` compares identically.
const COND = ['of', '!of', 'cf', '!cf', 'zf', '!zf', '(cf || zf)', '!(cf || zf)',
              'sf', '!sf', 'pf', '!pf', '(sf !== of)', '(sf === of)',
              '(zf || sf !== of)', '(!zf && sf === of)'];

/** push, cpu.js:683-687: esp moves first in the interpreter, but the store has to come
 *  first here so a fault leaves the instruction entirely un-executed and replayable. */
function pushSrc(E, size, valExpr, k) {
  E.u(4);
  return ['{', `const xe = (r4 - ${size}) >>> 0;`, smcSrc(E, 'xe', size, k),
    barrierSrc(E, 'xe', size), memWr(size, 'xe', valExpr), `r4 = xe | 0;`, '}'].join('\n  ');
}

/** pop, cpu.js:688-693. Reads need no barrier. */
function popSrc(E, size, dst) {
  E.u(4);
  return ['{', `const xe = r4 >>> 0;`, `const xv = ${memRd(size, 'xe')};`,
    `r4 = (xe + ${size}) | 0;`, dst('xv'), '}'].join('\n  ');
}

/**
 * One instruction, or null when no template covers it and it must become a callout.
 *
 * `keep` is the flag bits this instruction has to compute; `fuse` is non-null only on the
 * producer of a fused terminal branch. A rep prefix is refused outright because pick()
 * refuses it too (cpu.js:253) — those records carry no handler and reach execute(), which
 * is where their semantics live. A segment override needs no care: it is recorded and
 * never applied, since every selector has base 0 in this flat model.
 */
function tmpl(o, k, n, E, keep, fuse) {
  if (o.rep !== 0) return null;
  const id = o.id, S = o.opsize, mem = o.mod !== 3;

  // --- ALU r/m,r · r,r/m · AL/eAX,imm (00..3b) ---------------------------------
  if (id < 0x40 && (id & 7) < 6) {
    const aluOp = id >> 3, form = id & 7;
    const size = (form === 0 || form === 2 || form === 4) ? 1 : S;
    const store = aluOp !== 7;
    if (form === 4 || form === 5) {
      const b = size === 1 ? o.imm : (o.imm >>> 0) & mask4(size);
      return join(aluSrc(E, aluOp, size, regRd(E, 0, size), hexu(b), keep,
        store ? (q) => regWr(E, 0, size, q) : null, fuse));
    }
    if (form === 0 || form === 1) {                              // r/m, r
      const b = regRd(E, o.reg, size);
      if (!mem) return join(aluSrc(E, aluOp, size, regRd(E, o.rm, size), b, keep,
        store ? (q) => regWr(E, o.rm, size, q) : null, fuse));
      const pre = [`const xe = ${eaSrc(E, o)};`];
      if (store) pre.push(smcSrc(E, 'xe', size, k));
      return join([...pre, ...aluSrc(E, aluOp, size, memRd(size, 'xe'), b, keep,
        store ? (q) => `${barrierSrc(E, 'xe', size)}\n  ${memWr(size, 'xe', q)}` : null, fuse)]);
    }
    // form 2/3: r, r/m — the destination is the register, so no store can ever happen
    const a = regRd(E, o.reg, size);
    const b = mem ? memRd(size, 'xe') : regRd(E, o.rm, size);
    const pre = mem ? [`const xe = ${eaSrc(E, o)};`] : [];
    return join([...pre, ...aluSrc(E, aluOp, size, a, b, keep,
      store ? (q) => regWr(E, o.reg, size, q) : null, fuse)]);
  }

  // --- group 1: ALU r/m, imm (80/81/83) ----------------------------------------
  if (id === 0x80 || id === 0x81 || id === 0x83) {
    const size = id === 0x80 ? 1 : S;
    const aluOp = o.reg, store = aluOp !== 7;
    // 0x83 sign-extends its byte and then masks to the operand size, which is what
    // execute() gets from `fetchS8() >>> 0` running into alu()'s own mask (cpu.js:1027).
    const b = hexu(id === 0x80 ? o.imm : (o.simm >>> 0) & mask4(size));
    if (!mem) return join(aluSrc(E, aluOp, size, regRd(E, o.rm, size), b, keep,
      store ? (q) => regWr(E, o.rm, size, q) : null, fuse));
    const pre = [`const xe = ${eaSrc(E, o)};`];
    if (store) pre.push(smcSrc(E, 'xe', size, k));
    return join([...pre, ...aluSrc(E, aluOp, size, memRd(size, 'xe'), b, keep,
      store ? (q) => `${barrierSrc(E, 'xe', size)}\n  ${memWr(size, 'xe', q)}` : null, fuse)]);
  }

  // --- test (84/85 r/m,r · a8/a9 eAX,imm · f6/f7 /0,/1 r/m,imm) ----------------
  if (id === 0x84 || id === 0x85) {
    const size = id === 0x84 ? 1 : S;
    const b = regRd(E, o.reg, size);
    const a = mem ? memRd(size, 'xe') : regRd(E, o.rm, size);
    const pre = mem ? [`const xe = ${eaSrc(E, o)};`] : [];
    return join([...pre, ...aluSrc(E, 4, size, a, b, keep, null, fuse)]);
  }
  if (id === 0xa8 || id === 0xa9) {
    const size = id === 0xa8 ? 1 : S;
    return join(aluSrc(E, 4, size, regRd(E, 0, size), hexu(o.imm >>> 0 & mask4(size)), keep, null, fuse));
  }

  // --- inc/dec r32 (40..4f) — the one pair that leaves CF alone ----------------
  if (id >= 0x40 && id <= 0x4f) {
    const i = id & 7;
    return join(aluSrc(E, id <= 0x47 ? 0 : 5, S, regRd(E, i, S), '1', keep & ~C_,
      (q) => regWr(E, i, S, q), fuse));
  }

  // --- push/pop r32 (50..5f) ---------------------------------------------------
  if (id >= 0x50 && id <= 0x57) return pushSrc(E, S, regRd(E, id & 7, S), k);
  if (id >= 0x58 && id <= 0x5f) return popSrc(E, S, (v) => regWr(E, id & 7, S, v));

  // --- jcc rel8/rel32, jmp, call, ret — all terminators ------------------------
  if ((id >= 0x70 && id <= 0x7f) || (id >= 0x180 && id <= 0x18f && S === 4)) {
    if (k !== n - 1) return null;                    // F_END: decodeOne can only put it last
    for (const fl of FLAG_ORDER) if (CONDUSE[id & 15] & FLAG_BIT[fl]) E.f(fl);
    return `if (${COND[id & 15]}) eipv = ${hexu(o.target)};`;
  }
  if ((id === 0xe9 || id === 0xeb) && S === 4) {
    if (k !== n - 1) return null;
    return `eipv = ${hexu(o.target)};`;
  }
  if (id === 0xe8 && S === 4) {
    if (k !== n - 1) return null;
    return `${pushSrc(E, 4, hexu(o.fall), k)}\n  eipv = ${hexu(o.target)};`;
  }
  if (id === 0xc3 && S === 4) {
    if (k !== n - 1) return null;
    return popSrc(E, 4, (v) => `eipv = ${v} >>> 0;`);
  }

  // --- mov ---------------------------------------------------------------------
  if (id === 0x88 || id === 0x89) {                  // mov r/m, r
    const size = id === 0x88 ? 1 : S;
    const v = regRd(E, o.reg, size);
    if (!mem) return regWr(E, o.rm, size, v);
    return ['{', `const xe = ${eaSrc(E, o)};`, smcSrc(E, 'xe', size, k),
      barrierSrc(E, 'xe', size), memWr(size, 'xe', v), '}'].join('\n  ');
  }
  if (id === 0x8a || id === 0x8b) {                  // mov r, r/m
    const size = id === 0x8a ? 1 : S;
    if (!mem) return regWr(E, o.reg, size, regRd(E, o.rm, size));
    return regWr(E, o.reg, size, memRd(size, eaSrc(E, o)));
  }
  if (id >= 0xa0 && id <= 0xa3) {                    // mov AL/eAX, moffs and back
    const size = (id & 1) === 0 ? 1 : S;
    const a = hexu(o.imm);
    if (id <= 0xa1) return regWr(E, 0, size, memRd(size, a));
    return ['{', `const xe = ${a};`, smcSrc(E, 'xe', size, k),
      barrierSrc(E, 'xe', size), memWr(size, 'xe', regRd(E, 0, size)), '}'].join('\n  ');
  }
  if (id >= 0xb0 && id <= 0xb7) return regWr(E, id & 7, 1, hexu(o.imm & 0xff));
  if (id >= 0xb8 && id <= 0xbf) return regWr(E, id & 7, S, hexu(o.imm & mask4(S)));
  if (id === 0xc6 || id === 0xc7) {                  // mov r/m, imm
    const size = id === 0xc6 ? 1 : S;
    const v = hexu(o.imm & mask4(size));
    if (!mem) return regWr(E, o.rm, size, v);
    return ['{', `const xe = ${eaSrc(E, o)};`, smcSrc(E, 'xe', size, k),
      barrierSrc(E, 'xe', size), memWr(size, 'xe', v), '}'].join('\n  ');
  }

  // --- lea, nop, xchg eAX,r, cdq -----------------------------------------------
  if (id === 0x8d) {                                 // lea on a register form faults
    if (!mem) return null;
    return regWr(E, o.reg, S, eaSrc(E, o));
  }
  if (id === 0x90) return ';';
  if (id >= 0x91 && id <= 0x97) {                    // xchg eAX, r
    const i = id & 7;
    return ['{', `const xv = ${regRd(E, 0, S)};`, regWr(E, 0, S, regRd(E, i, S)),
      regWr(E, i, S, 'xv'), '}'].join('\n  ');
  }
  if (id === 0x99) {
    E.u(0);
    return S === 4 ? regWr(E, 2, 4, '(r0 >> 31)') : regWr(E, 2, 2, '((r0 & 0x8000) ? 0xffff : 0)');
  }

  // --- inc/dec r/m and push r/m (fe · ff) --------------------------------------
  if ((id === 0xfe || id === 0xff) && o.reg <= 1) {
    const size = id === 0xfe ? 1 : S;
    const aluOp = o.reg === 0 ? 0 : 5;
    if (!mem) return join(aluSrc(E, aluOp, size, regRd(E, o.rm, size), '1', keep & ~C_,
      (q) => regWr(E, o.rm, size, q), fuse));
    return join([`const xe = ${eaSrc(E, o)};`, smcSrc(E, 'xe', size, k),
      ...aluSrc(E, aluOp, size, memRd(size, 'xe'), '1', keep & ~C_,
        (q) => `${barrierSrc(E, 'xe', size)}\n  ${memWr(size, 'xe', q)}`, fuse)]);
  }

  // --- group 3 not/neg (f6/f7 /2,/3) -------------------------------------------
  //
  // /0 and /1 are test r/m,imm and stay callouts: I_G3 advances past the immediate but
  // never records it (cpu.js:868), so the only place its bits exist is memory, and
  // execute() is what reads them.
  if (id === 0xf6 || id === 0xf7) {
    const size = id === 0xf6 ? 1 : S;
    if (o.reg === 2) {                               // not — writes no flags at all
      if (!mem) return regWr(E, o.rm, size, `(~${regRd(E, o.rm, size)})`);
      return ['{', `const xe = ${eaSrc(E, o)};`, smcSrc(E, 'xe', size, k),
        `const xv = ~${memRd(size, 'xe')};`, barrierSrc(E, 'xe', size),
        memWr(size, 'xe', 'xv'), '}'].join('\n  ');
    }
    if (o.reg === 3) {                               // neg: doSub(0, a), then CF from a != 0
      // cpu.js:1358-1362 overwrites the borrow doSub just computed, so the subtraction is
      // asked for every bit but CF and the override is the only thing that writes it.
      const cf = (keep & C_) ? (E.f('cf'), 'cf = xb !== 0 ? 1 : 0;') : '';
      if (!mem) {
        return join([...aluSrc(E, 5, size, '0', regRd(E, o.rm, size), keep & ~C_,
          (q) => regWr(E, o.rm, size, q), null), cf].filter(Boolean));
      }
      return join([`const xe = ${eaSrc(E, o)};`, smcSrc(E, 'xe', size, k),
        ...aluSrc(E, 5, size, '0', memRd(size, 'xe'), keep & ~C_,
          (q) => `${barrierSrc(E, 'xe', size)}\n  ${memWr(size, 'xe', q)}`, null), cf].filter(Boolean));
    }
    return null;                                     // mul/imul/div/idiv: callout
  }

  // --- movzx / movsx -----------------------------------------------------------
  if (id === 0x1b6 || id === 0x1b7 || id === 0x1be || id === 0x1bf) {
    const src = (id === 0x1b6 || id === 0x1be) ? 1 : 2;
    const v = mem ? memRd(src, eaSrc(E, o)) : regRd(E, o.rm, src);
    if (id === 0x1b6 || id === 0x1b7) return regWr(E, o.reg, S, v);
    return regWr(E, o.reg, S, src === 1 ? `((${v}) << 24 >> 24)` : `((${v}) << 16 >> 16)`);
  }

  return null;
}

const mask4 = (size) => size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
const join = (a) => `{\n  ${a.join('\n  ')}\n  }`;

/**
 * WHAT AN x87 CALLOUT CAN DO TO INTEGER STATE, decided statically from (op, mod, reg, raw).
 * lib/fpu.js is 390 lines and reaches the CPU in exactly four ways — cpu.mem, cpu.codeWrite,
 * cpu.unimplemented and cpu.modrm — plus three writes:
 *
 *   flagWriter   fpu.js:327 and :381, the fcomi/fucomi family (db and df, register form,
 *                raw 0xe8-0xf7): cpu.zf = c3, cpu.pf = c2, cpu.cf = c0, cpu.of = 0,
 *                cpu.sf = 0. AF is not touched. No other line in the file assigns a flag.
 *   eaxWriter    fpu.js:378, fnstsw ax (df /mod 3 raw 0xe0) -> cpu.set16(0, sw). The only
 *                GPR write in the file.
 *   stores       the memory forms that reach cpu.mem.set*: d9 /2,/3,/7 · db /1,/2,/3,/7 ·
 *                dd /2,/3,/7 · df /2,/3,/7. d8/da/dc/de are load-and-arith only, no
 *                register form stores, and every /reg not listed either loads or throws
 *                before it has written anything.
 *
 * Everything else — the dc/db/de/d9/d8/dd/da arithmetic bulk, 24%+ of the generation-phase
 * stream — is therefore invisible to integer state: flag locals and register locals cross
 * the call untouched, and no codeDirty test is emitted because no store can have happened.
 * This resolution is static on purpose. A dynamic check would put the cost back on the 24%
 * to serve the 0.4%.
 */
function x87Flags(o) {
  return o.mod === 3 && (o.op === 0xdb || o.op === 0xdf) && o.raw >= 0xe8 && o.raw <= 0xf7;
}
function x87Eax(o) { return o.mod === 3 && o.op === 0xdf && o.raw === 0xe0; }
function x87Stores(o) {
  if (o.mod === 3) return false;
  const r = o.reg;
  switch (o.op) {
    case 0xd9: return r === 2 || r === 3 || r === 7;
    case 0xdb: return r === 1 || r === 2 || r === 3 || r === 7;
    case 0xdd: return r === 2 || r === 3 || r === 7;
    case 0xdf: return r === 2 || r === 3 || r === 7;
    default: return false;
  }
}

/** The flags a callout writes to c BEFORE calling, and therefore the ones c — not the local
 *  — owns for as long as the call is on the stack. The catch reads this back through `i`. */
function calloutTouch(o, du, isLast) {
  if (isLast) return ALL6;
  if (o.id >= 0xd8 && o.id <= 0xdf) return x87Flags(o) ? (C_ | P_ | Z_ | S_ | O_) : 0;
  return du.use | du.def | du.weak;
}

/**
 * The three callout flavors. The two that go through the interpreter commit count and
 * insStart BEFORE the call, so a trampoline reached through farCall records exactly the
 * {addr, count, eip} cpu.js:1263 records and golden.mjs's chained trampoline digest is
 * unchanged; and so an error thrown inside already carries the right context, which is why
 * the catch rethrows it untouched instead of replaying it.
 *
 * WHAT CROSSES THE CALL IS WHAT duFor SAYS CROSSES IT. A callout writes to c only the
 * flags it can read or write, and reads back only the ones it can write. popad is the case
 * that makes this worth doing: 0x61 touches no flag at all, and astral's hot block is
 * popad + three templates, so flushing and reloading six flags around it was 12 memory
 * accesses against 4 instructions — the whole reason that demo was slower compiled than
 * interpreted. Registers have no such table and are flushed and reloaded whole, because
 * execute() reaches all eight.
 *
 * x87 IS THE THIRD FLAVOR AND PAYS NONE OF THAT. It does not go through a handler, does not
 * flush registers, and — unlike stage 3, which committed insStart, count and eip on every
 * one of the 99 M x87 callouts in a 6e8 run — commits nothing. The FPU reads no integer
 * state at all, and all ten of its unimplemented() throws precede any mutation of its own
 * state, so the ONE consumer of a committed count/insStart is context() on an error, and
 * the catch rebuilds those from `i` at zero cost to the path that does not throw.
 *
 * The ModRM the FPU is handed is baked, not filled: X[k] is an object created at emit time
 * with the same {mod, reg, rm, raw, addr} literal shape as c._m (cpu.js:360), so the call
 * site stays monomorphic, and mod/reg/rm/raw are already its constants. A memory form
 * writes one field, `addr`; a register form writes none. It is deliberately NOT frozen —
 * freezing transitions the map and would make fpu.execute's `m` polymorphic against c._m,
 * which the interpreter still passes on every step() of the same instruction.
 *
 * A TERMINAL callout — retf, far call, an indirect transfer, loop — needs no reload and no
 * codeDirty test: nothing runs after it, so the flush that preceded it plus execute()'s own
 * writes leave c complete and the block's exit is a bare `return n`.
 */
function calloutSrc(o, k, E, du, isLast, mods) {
  const at = hexu(o.at), fall = hexu(o.fall), cnt = `base + ${k + 1}`;
  const touch = calloutTouch(o, du, isLast);
  const back = du.def | du.weak;                   // may have been changed by the call

  if (o.id >= 0xd8 && o.id <= 0xdf) {
    mods[k] = { mod: o.mod, reg: o.reg, rm: o.rm, raw: o.raw, addr: null };
    // isMem inside fpu.execute is `m.addr !== null` (fpu.js:148), so a register form is
    // spelt by leaving the baked null in place and a memory form by storing ea().
    const fill = o.mod === 3 ? '' : `X[${k}].addr = ${eaSrc(E, o)};\n  `;
    if (x87Eax(o)) E.u(0);                         // fnstsw ax writes R[0] under the local
    // Only a form that can store needs the test: an FPU store goes through the inherited
    // codeWrite (fpu.js:209 etc.), so SMC through x87 is already visible in codeDirty, and
    // a form that cannot store cannot have raised it.
    const dirty = (isLast || !x87Stores(o)) ? ''
      : `\n  if (c.codeDirty !== 0) { @@FLUSH@@ c.count = ${cnt}; c.eip = ${fall}; return ${k + 1}; }`;
    // Coverage, emitted only under IXA_JIT_STATS. A clean differential run that never
    // reached the two special cases would prove nothing about them, and jizz never puts
    // fnstsw ax inside a compiled block at all — 0 occurrences over 1.2e9 instructions —
    // so which arms actually fired has to be counted, not assumed.
    const stat = !STATS ? ''
      : ` c.jitX87${x87Flags(o) ? 'Flag' : x87Eax(o) ? 'Eax' : x87Stores(o) ? 'Store' : 'Plain'}++;`;
    return `{${stat} @@XF:${touch}@@${x87Eax(o) ? ' R[0] = r0;' : ''}\n  ${fill}`
      + `c.fpu.execute(${o.op}, X[${k}]);`
      + (isLast ? '' : ` @@LF:${back}@@${x87Eax(o) ? ' r0 = R[0] | 0;' : ''}`) + `${dirty} }`;
  }

  const dirty = isLast ? ''
    : `\n  if (c.codeDirty !== 0) { @@FLUSH@@${o.end ? '' : ` c.eip = ${fall};`} return ${k + 1}; }`;
  const head = `@@XR@@ @@XF:${touch}@@ c.insStart = ${at}; c.count = ${cnt};`;
  const tail = isLast ? '' : ` @@LR@@ @@LF:${back}@@`;
  if (o.h !== null) {
    return `{ ${head} c.eip = ${fall};\n`
      + `  O[${k}].h(c, O[${k}]);${tail}${dirty} }`;
  }
  return `{ ${head} c.opsize = ${o.opsize}; c.repPrefix = ${o.rep}; `
    + `c.segOverride = ${o.seg === null ? 'null' : o.seg}; c.eip = ${hexu(o.mid)}; c._d = O[${k}];\n`
    + `  c.execute(${o.op}); c._d = null;${tail}${dirty} }`;
}

/**
 * The whole block as source. Never null: an instruction with no template becomes a callout.
 *
 * Shape of a callout-free block, which is the one the render phase compiles to:
 *
 *   const base = c.count; const CB = c.codeBits;
 *   let r3 = R[3] | 0, ...;  let cf = c.cf | 0, ...;  let eipv = <fall of last op>;
 *   try {
 *     <op 0>  ... <op n-1>
 *     R[3] = r3; ... c.cf = cf; ...
 *     c.insStart = <at of last>; c.eip = eipv; c.count = base + n; return n;
 *   } catch (e) { c.jitFaults++; return c.jitReplay(B, base); }
 *
 * Nothing is written back until the exit, which is exactly what makes jitReplay() correct:
 * the CPU still holds the state the block was entered with.
 *
 * A block with callouts additionally tracks `i` — assigned before every instruction, not
 * only before the ones that can fault, because a stale `i` would replay the wrong
 * instruction and corrupt state silently. It is the only value the catch needs: which
 * instruction faulted, which flavor of exit that instruction wants and which flags it had
 * published are all constants of k, resolved through `i` in chains that never run on the
 * hot path.
 */
function blockSrc(b) {
  const ops = b.ops, n = ops.length;
  const mods = new Array(n).fill(null);            // baked ModRM per x87 callout, else null

  // Probe first: whether an instruction has a template decides whether the block can use
  // liveness at all, and that has to be known before the backward pass runs.
  const probe = newEmit(b);
  const callAt = new Array(n);
  let hasCall = false;
  for (let k = 0; k < n; k++) {
    callAt[k] = tmpl(ops[k], k, n, probe, ALL6, null) === null;
    if (callAt[k]) hasCall = true;
  }

  const du = new Array(n);
  for (let k = 0; k < n; k++) du[k] = duFor(ops[k]);
  const eager = hasCall || EAGER;
  const keep = new Int32Array(n);
  if (eager) for (let k = 0; k < n; k++) keep[k] = du[k].def | du[k].weak;
  else keep.set(liveness(du, n));

  // Terminal fusion: the block ends in jcc and the instruction before it strongly defines
  // every bit that condition consumes. Only sub and cmp producers fuse — their operands
  // are the comparison — and only the twelve conditions fusePred models.
  const last = ops[n - 1];
  const isJcc = (last.id >= 0x70 && last.id <= 0x7f)
    || (last.id >= 0x180 && last.id <= 0x18f && last.opsize === 4);
  let fuseAt = -1, fuseCc = 0;
  if (isJcc && n >= 2 && !EAGER) {
    const p = ops[n - 2], cc = last.id & 15, need = CONDUSE[cc];
    const isSub = (p.id < 0x40 && (p.id & 7) < 6 && ((p.id >> 3) === 5 || (p.id >> 3) === 7))
      || ((p.id === 0x80 || p.id === 0x81 || p.id === 0x83) && (p.reg === 5 || p.reg === 7));
    if (isSub && (du[n - 2].def & need) === need && fusePred(cc, 1) !== null
        && tmpl(p, n - 2, n, probe, ALL6, null) !== null) { fuseAt = n - 2; fuseCc = cc; }
  }

  const E = newEmit(b);
  const body = [];
  for (let k = 0; k < n; k++) {
    if (k === n - 1 && fuseAt >= 0) continue;        // folded into its producer
    const fuse = k === fuseAt
      ? (size) => `if (${fusePred(fuseCc, size)}) eipv = ${hexu(last.target)};`
      : null;
    let s = tmpl(ops[k], k, n, E, keep[k], fuse);
    if (s === null) s = calloutSrc(ops[k], k, E, du[k], k === n - 1 && ops[k].end, mods);
    body.push(eager ? `  i = ${k};\n  ${s}` : `  ${s}`);
  }

  const rl = [...E.regs].sort((x, y) => x - y);
  const fl = FLAG_ORDER.filter((x) => E.flags.has(x));
  const flushR = rl.map((i) => `R[${i}] = r${i};`).join(' ');
  const flushF = fl.map((x) => `c.${x} = ${x};`).join(' ');
  const reloadR = rl.map((i) => `r${i} = R[${i}] | 0;`).join(' ');
  const reloadF = fl.map((x) => `${x} = c.${x} | 0;`).join(' ');

  const anyX87 = mods.some((m) => m !== null);
  const decl = [];
  if (rl.length) decl.push(`let ${rl.map((i) => `r${i} = R[${i}] | 0`).join(', ')};`);
  if (fl.length) decl.push(`let ${fl.map((x) => `${x} = c.${x} | 0`).join(', ')};`);
  if (E.stores) decl.push('const CB = c.codeBits;');
  if (hasCall) decl.push('const O = B.ops;');
  if (eager) decl.push('let i = 0;');

  // A terminal callout has already published everything: it flushed before the call and
  // execute() wrote c directly, so writing the locals back over that would undo it — and
  // for retf there may be no eip to write at all, because it halted.
  const lastIsCall = callAt[n - 1] && last.end;
  const exit = lastIsCall
    ? `  return ${n};\n`
    : `  @@FLUSH@@ c.insStart = ${hexu(last.at)}; c.eip = eipv; c.count = base + ${n}; return ${n};\n`;

  // WHOSE COPY OF A FLAG IS AUTHORITATIVE WHEN A CALLOUT THROWS. Only the callout that is
  // actually on the stack matters, and only the flags IT flushed: a later callout that
  // touches no flag leaves the locals owning everything, even flags an earlier callout in
  // the same block published. Stage 3 approximated this with the block-wide union of
  // callout defs, which is wrong exactly when a template redefines a flag between two
  // callouts — so the mask is per-instruction now, resolved through `i` in the catch where
  // it costs nothing.
  const touchAt = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    if (callAt[k]) touchAt[k] = calloutTouch(ops[k], du[k], k === n - 1 && ops[k].end);
  }

  // WHICH FLAVOR OF EXIT A THROW NEEDS, decided at emit time rather than carried in a live
  // variable. Stage 3 kept `cm` set across every call so the catch could tell "the callout
  // threw" from "an emitted access faulted"; that is a value live across a call, i.e. a
  // stack slot written and read on 33% of the generation-phase stream. It is redundant:
  // nothing an instruction emits around its call — an EA over locals, a store into a typed
  // array, a store into a field that already exists — can throw, so a throw while `i === k`
  // came from inside k's call exactly when k is a callout. 0 = template, 1 = x87 (nothing
  // committed, the catch rebuilds it), 2 = interpreter callout (already committed).
  const kindAt = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    if (callAt[k]) kindAt[k] = (ops[k].id >= 0xd8 && ops[k].id <= 0xdf) ? 1 : 2;
  }
  // An x87 callout committed nothing, so the catch is where insStart, count and eip are
  // brought up to what execBlock would have left them at (cpu.js:741-746: insStart = o.at,
  // count = base + k + 1, eip = o.fall, all set before the handler runs).
  const x87Ctx = anyX87
    ? ` @@XR@@ c.count = base + i + 1; c.insStart = ${chain(n, (k) => hexu(ops[k].at))};`
      + ` c.eip = ${chain(n, (k) => hexu(ops[k].fall))};`
    : ' @@XR@@';

  let src = `'use strict';\n`
    + `const base = c.count;\n`
    + decl.join('\n') + (decl.length ? '\n' : '')
    + (lastIsCall ? '' : `let eipv = ${hexu(last.fall)};\n`)
    + `try {\n`
    + body.join('\n') + '\n' + exit
    + `} catch (e) {\n`
    + (eager
      ? `  const cm = ${chain(n, (k) => kindAt[k])};\n`
        + `  if (cm !== 0) { const tf = ${chain(n, (k) => touchAt[k])};\n`
        + `    ${fl.map((x) => `if (!(tf & ${FLAG_BIT[x]})) c.${x} = ${x};`).join(' ')}\n`
        + `    if (cm === 1) {${x87Ctx} } c._d = null; c.jitRecontext(e); throw e; }\n`
        + `  @@FLUSH@@ c._d = null; c.jitFaults++;\n`
        + `  c.count = base + i; c.eip = ${chain(n, (k) => hexu(ops[k].at))};\n`
        + `  c.step();\n  return i + 1;\n`
      : `  c.jitFaults++;\n  return c.jitReplay(B, base);\n`)
    + `}\n`;

  // Patch the placeholders now that the register and flag sets are final. An own-SMC store
  // in a callout-free block replays the block through the oracle; in an eager block the
  // locals are exact, so the offending instruction is simply handed to step() — which also
  // guarantees forward progress where returning k would not, k being 0 for a block whose
  // first instruction patches itself.
  const subsetF = (mask, tpl) => fl.filter((x) => mask & FLAG_BIT[x]).map(tpl).join(' ');
  src = src.replace(/@@SMC(\d+)@@/g, (_, d) => {
    const k = +d;
    if (!eager) return `c.jitSmc++; return c.jitReplay(B, base);`;
    return `c.jitSmc++; ${flushR} ${flushF} c._d = null; c.count = base + ${k}; `
      + `c.eip = ${hexu(ops[k].at)}; c.step(); return ${k + 1};`;
  });
  return {
    src: src
      .replace(/@@XF:(\d+)@@/g, (_, m) => subsetF(+m, (x) => `c.${x} = ${x};`))
      .replace(/@@LF:(\d+)@@/g, (_, m) => subsetF(+m, (x) => `${x} = c.${x} | 0;`))
      .replace(/@@XR@@/g, flushR)
      .replace(/@@LR@@/g, reloadR)
      .replace(/@@FLUSH@@/g, `${flushR} ${flushF}`),
    mods: anyX87 ? mods : null,
  };
}

/** A per-instruction constant selected by `i`, without an array literal: a `const A = [...]`
 *  at function scope would allocate on every call, and these only run in a catch. */
function chain(n, f) {
  let s = '0';
  for (let k = n - 1; k >= 0; k--) s = `i === ${k} ? ${f(k)} : ${s}`;
  return s;
}

// ------------------------------------------------------------------------ engine

export class JitCPU extends CPU {
  constructor(machine) {
    super(machine);

    // Keyed on block start, NOT held on the block record: a record is thrown away on
    // every page-generation bump and there are 1.24 M of those per 200 M instructions
    // against ~500 distinct starts, so caching on the record would mean recompiling
    // essentially always. ~500 live entries make a Map's cost irrelevant next to the one
    // lookup per block entry it serves.
    this.jitTab = new Map();
    this.jitSlot = new Array(JIT_SLOTS).fill(null);
    this.jitEmits = 0;

    // Every counter is seeded here as a Smi and only ever incremented by 1, so no field on
    // this object can migrate representation underneath a compiled function that stores to
    // it (cpu.js:347-352 measured 33 M -> 14 M ips for getting that wrong once).
    this.jitReverify = 0;      // generations stale, bytes identical — the whole point
    this.jitVersionHits = 0;   // genuine SMC that came back to a form already compiled
    this.jitPoisons = 0;       // addresses abandoned to the interpreter for churning
    this.jitSrcHits = 0;       // emits V8's source cache had already parsed
    this.jitSmc = 0;           // stores that landed in the running block's own bytes
    this.jitWin = [];          // emits per 1e8 instructions — the stage gate is a window
    this.jitSrcSeen = STATS ? new Set() : null;

    // Scratch instrumentation: how much of the stream actually ran as compiled JS, and how
    // much of that ran as a template rather than a callout. Accumulated in run()'s locals
    // and folded in once per call, so no field is touched on the hot path.
    this.jitBlocks = 0;
    this.jitIns = 0;
    this.jitTmplIns = 0;
    this.jitCallIns = 0;
    this.jitCallOps = STATS ? new Map() : null;
    // x87 callouts by static class, so the differential run can be asserted to have
    // actually exercised the two arms that touch integer state.
    this.jitX87Flag = 0;       // fcomi/fucomi — db/df mod 3 raw 0xe8-0xf7 (fpu.js:327, :381)
    this.jitX87Eax = 0;        // fnstsw ax    — df mod 3 raw 0xe0     (fpu.js:378)
    this.jitX87Store = 0;      // the memory forms that can write memory
    this.jitX87Plain = 0;      // everything else: no integer state, no store, no barrier
    // How often the emitted catch handed control back to the oracle. Written only from the
    // catch, so it costs nothing on the hot path — and it has to be observable rather than
    // assumed, because the handoff is self-correcting: a genuine bug in emitted code that
    // throws would be replayed correctly and leave every checker green while quietly
    // costing all the speed. A non-zero value on a clean run means an access is faulting.
    this.jitFaults = 0;

    if (STATS) this.jitStatsAtExit();
  }

  reset(loaded) {
    super.reset(loaded);
    // Same reasoning as blockTab.fill(null) at cpu.js:373: reset() is the one place where
    // the bytes under an address change wholesale, and pageGen is NOT rewound, so a stale
    // entry could match on generation alone.
    this.jitTab.clear();
    this.jitSlot.fill(null);
    this.jitEmits = 0;
  }

  /**
   * Hand a block back to the oracle from its first instruction. Legal only from a
   * callout-free compiled block, where nothing has been written back yet, so the register
   * file, the flags and eip still hold what the block was entered with and re-running it
   * reproduces the interpreter exactly — including the Fault, with a real context().
   *
   * codeDirty is cleared first: emitted stores never test it, so it may already be set by
   * a write into some other block's bytes, and execBlock would stop after one instruction.
   */
  /**
   * Re-derive an error's decode context after the block's locals have been written back.
   * Only ever reached from the catch of a block that was inside a callout, which is the
   * one place where c.regs can have been stale when Unimplemented/Fault captured it —
   * x87 callouts deliberately do not flush registers first, since they never read them.
   * insStart and count were committed before the call, so context() is right the moment
   * the register file is.
   */
  jitRecontext(e) {
    if (e instanceof Unimplemented || e instanceof Fault) Object.assign(e, this.context());
  }

  jitReplay(b, base) {
    this.codeDirty = 0;
    this.count = base;
    this.eip = b.start;
    return this.execBlock(b);
  }

  /**
   * The compiled function for a block, or null to stay on the interpreter tier. This is
   * the one lookup per block entry, so only the first two arms are inline.
   *
   * Matching generations are proof on their own: compile() marks every 16-byte chunk of
   * the block in codeBits (cpu.js:795), so any write touching those bytes bumps the page
   * generation, and equal generations mean the bytes cannot have changed. Comparing
   * against b.g0/b.g1 rather than pageGen[] is the same predicate for two fewer loads —
   * block() only returned b after checking b.g0 === pageGen[b.p0] itself (cpu.js:773).
   */
  jitFor(b) {
    // Direct-mapped in front of the Map, tag-compared exactly as cpu.js:771 tags blockTab.
    // The Map stays the authority — a compiled function must survive an eviction, that is
    // the whole of stage 2 — but hashing a Smi on every block entry is 19 M hashes per 1e8
    // instructions, and only ~500 addresses ever execute, so the probe practically never
    // misses once the demo is warm.
    const slot = (b.start ^ (b.start >>> 15)) & JIT_SLOT_MASK;
    let e = this.jitSlot[slot];
    if (e === null || e.start !== b.start) {
      e = this.jitLookup(b);
      this.jitSlot[slot] = e;
    }
    if (e.poisoned) return null;
    if (e.fn !== null) {
      if (e.g0 === b.g0 && e.g1 === b.g1 && e.p0 === b.p0 && e.p1 === b.p1) return e;
      return this.jitRevalidate(b, e);
    }
    if (++e.hits < JIT_HITS) return null;
    return this.jitEmit(b, e, -1);
  }

  jitLookup(b) {
    let e = this.jitTab.get(b.start);
    if (e === undefined) {
      // Seeded once, here, and never reshaped: fn is null or a Function, snap null or a
      // Uint8Array, versions null or a Map, every number a Smi. Nothing in the entry can
      // migrate a field representation on a later write.
      e = {
        start: b.start, hits: 0, fn: null, mods: null, snap: null, byteLen: 0, hash: 0,
        p0: 0, p1: 0, g0: 0, g1: 0, tmplIns: 0, callIns: 0, callIds: null,
        versions: null, versionCount: 0, poisoned: false,
      };
      this.jitTab.set(b.start, e);
    }
    return e;
  }

  /**
   * A generation moved under a compiled block. Decide what that actually meant.
   *
   * Spans average 14-30 bytes and BLOCK_MAX_BYTES caps them at 1024, so the memcmp is
   * 37 ns against the 20.4 us it replaces. Length is part of the comparison: a block that
   * now decodes to a different extent is a different block, and since decodeOne is a pure
   * function of the bytes, equal length plus equal bytes means the records b carries are
   * the records the function was emitted from.
   */
  jitRevalidate(b, e) {
    const u8 = this.u8, start = b.start;
    const len = b.ops[b.len - 1].fall - start;
    if (len === e.byteLen && bytesEq(u8, start, e.snap)) {
      e.p0 = b.p0; e.p1 = b.p1; e.g0 = b.g0; e.g1 = b.g1;
      this.jitReverify++;
      return e;
    }

    // Genuine self-modification. Park the version being left before looking for the one
    // arriving, so the map always holds every form this address has been compiled in and
    // its size is the version count.
    let vs = e.versions;
    if (vs === null) vs = e.versions = new Map();
    vs.set(e.hash, { fn: e.fn, mods: e.mods, snap: e.snap, tmplIns: e.tmplIns, callIns: e.callIns, callIds: e.callIds });

    const h = fnv1a(u8, start, len);
    const v = vs.get(h);
    if (v !== undefined && v.snap.length === len && bytesEq(u8, start, v.snap)) {
      e.fn = v.fn; e.mods = v.mods; e.snap = v.snap; e.byteLen = len; e.hash = h;
      e.tmplIns = v.tmplIns; e.callIns = v.callIns; e.callIds = v.callIds;
      e.p0 = b.p0; e.p1 = b.p1; e.g0 = b.g0; e.g1 = b.g1;
      this.jitVersionHits++;
      return e;
    }
    if (vs.size >= JIT_VERSIONS) { this.jitPoisons++; return this.jitPoison(e); }
    return this.jitEmit(b, e, h);
  }

  /** Emit, snapshot and adopt. `hash` is -1 when the caller has not computed one. */
  jitEmit(b, e, hash) {
    if (this.jitEmits >= EMIT_MAX) return this.jitPoison(e);
    const { src, mods } = blockSrc(b);

    const u8 = this.u8, start = b.start;
    const len = b.ops[b.len - 1].fall - start;
    if (STATS) this.jitStatSrc(src);
    e.fn = new Function('c', 'R', 'M', 'P', 'B', 'X', src);
    e.mods = mods;
    e.snap = u8.slice(start, start + len);
    e.byteLen = len;
    e.hash = hash < 0 ? fnv1a(u8, start, len) : hash;
    e.p0 = b.p0; e.p1 = b.p1; e.g0 = b.g0; e.g1 = b.g1;
    this.jitCensus(b, e);
    if (e.versions !== null) {
      e.versions.set(e.hash, { fn: e.fn, mods: e.mods, snap: e.snap, tmplIns: e.tmplIns, callIns: e.callIns, callIds: e.callIds });
      e.versionCount = e.versions.size;
    }
    this.jitEmits++;
    if (STATS) { const w = (this.count / WINDOW) | 0; this.jitWin[w] = (this.jitWin[w] ?? 0) + 1; }
    return e;
  }

  /** How many of this block's instructions are templates and how many are callouts. The
   *  probe re-runs tmpl() against a throwaway emitter; it is compile-time only. */
  jitCensus(b, e) {
    const ops = b.ops, n = ops.length, probe = newEmit(b);
    let t = 0, ids = null;
    for (let k = 0; k < n; k++) {
      if (tmpl(ops[k], k, n, probe, ALL6, null) !== null) t++;
      else { if (ids === null) ids = []; ids.push(ops[k].id); }
    }
    e.tmplIns = t; e.callIns = n - t; e.callIds = ids;
  }

  /** Abandon this address to the interpreter, permanently. Everything is dropped rather
   *  than left dangling: jitFor() checks poisoned first, so a retained fn is unreachable
   *  by construction — but a later tier that forgets that would find a stale one. */
  jitPoison(e) {
    e.poisoned = true; e.fn = null; e.mods = null; e.snap = null; e.versions = null; e.callIds = null;
    return null;
  }

  jitStatSrc(src) {
    if (this.jitSrcSeen.has(src)) this.jitSrcHits++;
    else this.jitSrcSeen.add(src);
  }

  jitStatsAtExit() {
    const p = globalThis.process;
    if (!p?.on) return;
    p.on('exit', () => {
      if (this.count === 0) return;
      let live = 0, versioned = 0;
      for (const e of this.jitTab.values()) { if (e.fn !== null) live++; if (e.versions !== null) versioned++; }
      const win = [];
      const lastW = (this.count / WINDOW) | 0;
      for (let w = 0; w <= lastW; w++) win.push(`${w}00M:${this.jitWin[w] ?? 0}`);
      const top = [...this.jitCallOps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)
        .map(([id, v]) => `${id > 0xff ? '0f' + (id & 0xff).toString(16) : id.toString(16)}:${v}`);
      p.stderr.write(
        `jit: count=${this.count} blocks=${this.jitBlocks} ins=${this.jitIns} `
        + `(${(100 * this.jitIns / this.count).toFixed(3)}% in compiled blocks)\n`
        + `jit: template=${this.jitTmplIns} callout=${this.jitCallIns} `
        + `(${(100 * this.jitTmplIns / this.count).toFixed(2)}% of the stream ran as a template)\n`
        + `jit: emits=${this.jitEmits} srcHits=${this.jitSrcHits} reverify=${this.jitReverify} `
        + `versionHits=${this.jitVersionHits} poisons=${this.jitPoisons} `
        + `ownSmc=${this.jitSmc} faults=${this.jitFaults}\n`
        + `jit: entries=${this.jitTab.size} live=${live} versioned=${versioned}\n`
        + `jit: x87 flagWriter=${this.jitX87Flag} eaxWriter=${this.jitX87Eax} `
        + `store=${this.jitX87Store} plain=${this.jitX87Plain}\n`
        + `jit: emits/100M ${win.join(' ')}\n`
        + `jit: callouts by opcode ${top.join(' ')}\n`);
    });
  }

  /**
   * cpu.js:713-724 with the compiled tier spliced in, and its exactness contract kept to
   * the letter: a block is only ever entered whole and only when it fits the remaining
   * budget, so the last instructions of a budget are always single-stepped. A compiled
   * function returns how many instructions it actually ran — b.len, or fewer if it stopped
   * on its own bytes or handed a fault back to the oracle — so `remaining` stays exact and
   * golden.mjs's 19 fixed checkpoints and diff.mjs's replay-to-a-count both hold.
   */
  run(budget = 1e7) {
    let remaining = budget;
    // Accumulated in locals and folded in once per call: incrementing the fields per block
    // would put two stores on the dispatch path, and jitIns crosses 2^31 on a long run,
    // which is exactly the field-representation migration cpu.js:347-352 paid 2.3x for.
    // The finally is what makes them exact — run() exits by throwing whenever an
    // instruction faults, and a counter that silently drops its last slice is worse than
    // no counter, because it reads as "nothing compiled".
    let jb = 0, ji = 0, jt = 0, jc = 0;
    try {
      while (remaining > 0 && !this.halted) {
        const b = this.block(this.eip);
        if (b !== null && b.len <= remaining) {
          const e = this.jitFor(b);
          if (e !== null) {
            const k = e.fn(this, this.regs, this.mem, PARITY, b, e.mods);
            jb++; ji += k; remaining -= k;
            // MEASURED, and by far the largest single effect in this stage: reading
            // e.tmplIns and e.callIns AFTER the call cost 46% of the generation phase
            // (58.2 -> 87.1 M ips) and 11% of the render phase. They are loads the callee
            // could have invalidated, so `e` and `b` stay live across every compiled block
            // and are re-read on return — for a coverage statistic. It is only paid when
            // asked for; the correctness-relevant counter, jitIns, is a local.
            if (STATS) {
              if (k === b.len) { jt += e.tmplIns; jc += e.callIns; } else jt += k;
              if (k === b.len && e.callIds !== null) {
                for (const id of e.callIds) this.jitCallOps.set(id, (this.jitCallOps.get(id) ?? 0) + 1);
              }
            }
          } else {
            remaining -= this.execBlock(b);
          }
        } else {
          this.step();
          remaining--;
        }
      }
    } finally {
      this.jitBlocks += jb; this.jitIns += ji; this.jitTmplIns += jt; this.jitCallIns += jc;
    }
    return this.count;
  }
}
