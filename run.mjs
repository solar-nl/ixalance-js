// Headless harness. Runs the same lib/ modules the browser page uses, so the container,
// codecs, CPU and replayer can all be exercised and regression-checked without a browser.
//
//   node run.mjs verify                        check codecs against data/reference.json
//   node run.mjs run <file.ixa> [block] [budget] [framedir]
//       with no block the script drives: every part, in the order the demo asks for.
//       Name a block to load and run that one alone, for probing a part in isolation.
//   node run.mjs dumpxm <file.ixa> <out.xm>    capture the module a part generates
//   node run.mjs renderxm <file.xm> <out.wav> [seconds]
//   node run.mjs bench <file.ixa> [options]     benchmark generated-music intros by XM phase
//       --engine cpu|jit|both  --from ORDER  --to ORDER  --repeat N
//       --orders 1,4,7-9      run only those orders, each from an exact cached boundary
//       --music N              select a generated XM (one-based; Stash has two)
//       --row-step N           split selected orders into exact N-row windows
//       --rows 0,16,32         with --row-step, run only these row starts
//       --csv FILE             write ranked CPU/JIT performance data
//       --phase decrunch      time fresh startup through the generated-XM handoff
//       --prepare             only build the cached post-decrunch checkpoint
//       --prepare-order N     cache exact order starts through N, then exit
//       --rebuild             replace the post-decrunch checkpoint

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readIxa, unpackBlock, parseScript, classify } from './lib/ixa.js';
import { Machine, partmemFor } from './lib/machine.js';
import { Sequencer } from './lib/sequencer.js';
import { CPU, Unimplemented, Fault } from './lib/cpu.js';
import { JitCPU } from './lib/jit.js';
import { XmPlayer } from './lib/xm.js';

// The JIT is the production engine; keep the interpreter one environment variable away
// as the reference path for differential checks.
const Engine = globalThis.process?.env?.IXA_ENGINE === 'cpu' ? CPU : JitCPU;

const HERE = new URL('.', import.meta.url).pathname;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Unpack every block of every bundled module and compare against known-good digests.
 *
 * The digests in data/reference.json were produced by unixa.py in the demoscene-archeology
 * repository, whose own correctness rests on the container being self-verifying: blocks
 * are contiguous and end exactly at EOF, the LZSS output length matches the length the
 * RLE stage declares, and the RLE output length matches the directory's fullsize.
 */
function verify() {
  const ref = JSON.parse(readFileSync(`${HERE}data/reference.json`, 'utf8'));
  let ok = 0, fail = 0;

  for (const [name, prod] of Object.entries(ref)) {
    const bytes = new Uint8Array(readFileSync(`${HERE}data/${name}.ixa`));
    const ixaDigest = sha(bytes);
    const { demoname, entries } = readIxa(bytes);
    const ops = parseScript(bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size));
    const kinds = classify(ops, entries.length);

    const containerOk = ixaDigest === prod.ixa;
    if (!containerOk) fail++;
    process.stdout.write(
      `${name} (${demoname.trim()}): ${entries.length} blocks, `
      + `container ${containerOk ? 'authentic' : 'DIGEST MISMATCH'}\n`);

    for (const [index, want] of Object.entries(prod.blocks)) {
      const i = Number(index);
      const got = unpackBlock(bytes, entries[i]);
      const same = got.length === want.size && sha(got) === want.sha256;
      const kindOk = kinds[i] === want.kind;
      if (same && kindOk) ok++; else fail++;
      process.stdout.write(
        `  [${String(i).padStart(2)}] ${want.kind.padEnd(7)} ${String(got.length).padStart(8)}`
        + ` bytes  ${same ? 'match' : 'MISMATCH'}${kindOk ? '' : ` (kind ${kinds[i]}!)`}\n`);
    }
  }

  process.stdout.write(`\n${ok} checks passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

/** Render a module to a 16-bit stereo WAV, for checking the replayer without a browser. */
function renderXm(xmPath, wavPath, seconds = 30) {
  const SR = 48000;
  const player = new XmPlayer(new Uint8Array(readFileSync(xmPath)), SR);
  process.stdout.write(
    `${player.title || '(untitled)'} — ${player.channels} channels, `
    + `${player.songLength} orders, ${player.patterns.length} patterns, `
    + `speed ${player.defaultSpeed}, ${player.defaultBpm} BPM\n`);

  const n = SR * seconds;
  const L = new Float32Array(n), R = new Float32Array(n);
  const CHUNK = 4800;
  for (let off = 0; off < n; off += CHUNK) {
    const count = Math.min(CHUNK, n - off);
    player.render(L.subarray(off, off + count), R.subarray(off, off + count), count);
  }

  let peak = 0, sum = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(L[i]);
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) bad++;
    if (v > peak) peak = v;
    sum += L[i] * L[i];
  }
  process.stdout.write(
    `  peak ${peak.toFixed(3)}, rms ${Math.sqrt(sum / n).toFixed(4)}, `
    + `${bad} non-finite samples\n`
    + `  after ${seconds}s: order ${player.position}/${player.songLength}, `
    + `row ${player.row}, ${player.loops} loop(s)\n`
    + `  unsupported: ${[...player.unsupported].join(', ') || 'none'}\n`);

  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), i * 4);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 4, 28);
  hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  writeFileSync(wavPath, Buffer.concat([hdr, pcm]));
  process.stdout.write(`  wrote ${wavPath}\n`);
  return bad === 0 ? 0 : 1;
}

/** Minimal PNG writer, so frames can be eyeballed without extra dependencies. */
function png(rgb565, width, height) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                              // filter: none
    for (let x = 0; x < width; x++) {
      const v = rgb565[(y * width + x) * 2] | (rgb565[(y * width + x) * 2 + 1] << 8);
      raw[o++] = ((v >> 11) & 31) << 3;
      raw[o++] = ((v >> 5) & 63) << 2;
      raw[o++] = (v & 31) << 3;
    }
  }
  const chunk = (tag, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const data = Buffer.concat([Buffer.from(tag), body]);
    const crc = Buffer.alloc(4);
    // CRC-32, table-free
    let c = 0xffffffff;
    for (const b of data) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Report a Fault/Unimplemented the same way whichever path raised it. */
function reportFault(err) {
  process.stdout.write(`\n  ${err.name}: ${err.message}\n`);
  process.stdout.write(`    at eip 0x${err.eip.toString(16)} after ${err.count} instructions\n`);
  process.stdout.write(`    bytes: ${err.bytes}\n`);
  const r = err.regs;
  process.stdout.write(`    eax=${r.eax} ecx=${r.ecx} edx=${r.edx} ebx=${r.ebx}\n`);
  process.stdout.write(`    esp=${r.esp} ebp=${r.ebp} esi=${r.esi} edi=${r.edi}\n`);
  return 1;
}

async function run(ixaPath, blockArg, budget, frameDir) {
  const bytes = new Uint8Array(readFileSync(ixaPath));
  const { demoname, entries } = readIxa(bytes);
  const script = bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size);
  const ops = parseScript(script);
  const kinds = classify(ops, entries.length);

  // Naming a block means "probe this part": load it and run it, script and part stack
  // ignored, which is how a single part gets measured in isolation. Without one the script
  // drives, and for a 64K intro's `exe(1) pop` that reduces to the very same thing — one
  // block, one CPU — while for Astral Blur it is eleven parts in LIFO order with picture
  // blits and a module in between. An empty argument is "not named": `run f.ixa '' 4e8 dir`
  // is how a budget and a frame directory get past the block slot.
  const probe = blockArg !== undefined && blockArg !== '';
  const block = probe ? Number(blockArg) : null;
  process.stdout.write(probe
    ? `${demoname.trim()}: running block ${block} (${kinds[block]})\n`
    : `${demoname.trim()}: running the script, ${ops.length} opcodes over ${entries.length - 1} blocks\n`);

  let saved = 0, seen = 0;
  const every = Number(process.env.IXA_FRAME_EVERY ?? 1);
  if (frameDir) mkdirSync(frameDir, { recursive: true });
  const machine = new Machine({
    partmem: partmemFor(demoname),
    clock: process.env.IXA_CLOCK ?? 'virtual',   // deterministic for headless runs
    onDebug: (m) => process.stdout.write(`    host: ${m}\n`),
    onFrame: (fb, w, h) => {
      if (!frameDir || saved >= 24) return;
      // Skip frames that are entirely one colour — nothing has been drawn yet.
      let varied = false;
      for (let i = 2; i < fb.length; i += 2) if (fb[i] !== fb[0] || fb[i + 1] !== fb[1]) { varied = true; break; }
      if (!varied) return;
      if (seen++ < Number(process.env.IXA_FRAME_FROM ?? 0)) return;
      if ((seen - 1) % every !== 0) return;
      writeFileSync(`${frameDir}/frame${String(saved).padStart(3, '0')}.png`, png(fb, w, h));
      saved++;
    },
  });

  if (!probe) {
    const seq = new Sequencer({
      bytes, machine, budget,
      // A fresh interpreter per part, none of them keeping a trampoline log: Astral banks
      // ~140k {addr,count,eip} records per million instructions and a run that gets as far
      // as the third part is billions long, so retention is an out-of-memory kill, not a
      // diagnostic. cpu.trampolineCount still counts them.
      makeCpu: () => { const c = new Engine(machine); c.retainTrampolineHits = false; return c; },
      onOp: (o) => process.stdout.write(`  script[${o.index}] ${o.name}(${o.args.join(',')})\n`),
      onPart: (p) => process.stdout.write(`    ${p.phase} ${p.kind} ${p.block}\n`),
    });

    let err = null;
    try {
      await seq.run();
    } catch (e) {
      if (e instanceof Unimplemented || e instanceof Fault) err = e;
      else throw e;
    }

    // No completion assertion: Astral is 448 seconds of music and block 3 alone has eaten
    // 4.57 billion instructions in a probe, so "ran out of budget mid-script" is the normal
    // outcome and not a failure. What is worth printing is how far it got.
    process.stdout.write(
      `\n  executed ${seq.executed} instructions, ${machine.frames} frames presented, `
      + `${seq.trampolines + (seq.cpu?.trampolineCount ?? 0)} host calls, `
      + `script byte ${seq.pos}/${seq.script.length}${seq.done ? ' (complete)' : ''}`
      + `${seq.error ? ` (error: ${seq.error})` : ''}\n`);
    if (frameDir) process.stdout.write(`  wrote ${saved} non-blank frame(s) to ${frameDir}\n`);
    return err ? reportFault(err) : 0;
  }

  const image = unpackBlock(bytes, entries[block]);
  const loaded = machine.loadExe(image);
  process.stdout.write(
    `  image ${loaded.d32.exesize} bytes at 0x${loaded.base.toString(16)}, `
    + `entry 0x${loaded.entry.toString(16)} (ip 0x${loaded.d32.startip.toString(16)})\n`
    + `  fixups: ${loaded.relocs.address} address + ${loaded.relocs.segment} segment `
    + `= ${loaded.relocs.address + loaded.relocs.segment} in ${loaded.d32.fixupsize} bytes\n`
    + `  stack esp=0x${(loaded.regs.esp >>> 0).toString(16)}, gfxmodeinfo at 0x${machine.gfx.toString(16)}\n`);

  const cpu = new Engine(machine);
  // The hit list is per-instruction detail worth keeping for a short probe and fatal for a
  // long one — ~140k records per million instructions on Astral. The default budget is 1e7,
  // so ordinary probes are unaffected and only deliberately long ones give up the list.
  if (budget > 5e7) cpu.retainTrampolineHits = false;
  cpu.reset(loaded);

  let err = null;
  try {
    cpu.run(budget);
  } catch (e) {
    if (e instanceof Unimplemented || e instanceof Fault) err = e;
    else throw e;
  }

  process.stdout.write(`\n  executed ${cpu.count} instructions, ${machine.frames} frames presented\n`);
  if (frameDir) process.stdout.write(`  wrote ${saved} non-blank frame(s) to ${frameDir}\n`);
  if (cpu.trampolineHits.length) {
    const names = { 0: 'basic', 0x10: 'showp', 0x20: 'malloc', 0x30: 'doint' };
    process.stdout.write(`  reached ${cpu.trampolineHits.length} host callback(s):\n`);
    for (const h of cpu.trampolineHits.slice(0, 8)) {
      process.stdout.write(`    ${names[h.addr - 0xf0000000]} at instruction ${h.count}, from 0x${h.eip.toString(16)}\n`);
    }
  } else if (cpu.trampolineCount) {
    // An empty list with a non-zero count is retention turned off above, not silence.
    process.stdout.write(
      `  reached ${cpu.trampolineCount} host callback(s) (list not retained at this budget)\n`);
  } else {
    process.stdout.write('  no host callback reached yet\n');
  }

  if (cpu.halted) process.stdout.write(`  halted: ${cpu.haltReason}\n`);
  return err ? reportFault(err) : 0;
}

/**
 * Write out a production's music module.
 *
 * There are two cases. Astral Blur carries its module as a stored block and the script
 * names it with a `music` opcode, so it can simply be unpacked. The 64K intros generate
 * theirs at runtime and hand it over through fardoint's 'TBL1' request, which means
 * actually interpreting the part until it gets there — a couple of billion instructions.
 */
function dumpXm(ixaPath, outPath) {
  const bytes = new Uint8Array(readFileSync(ixaPath));
  const { demoname, entries } = readIxa(bytes);
  const ops = parseScript(bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size));

  const musicOp = ops.find((o) => o.name === 'music');
  if (musicOp) {
    const data = unpackBlock(bytes, entries[musicOp.args[0]]);
    writeFileSync(outPath, data);
    process.stdout.write(
      `  ${demoname.trim()} stores its module in block ${musicOp.args[0]}\n`
      + `  wrote ${data.length} bytes to ${outPath}\n`);
    return 0;
  }

  process.stdout.write(
    `  ${demoname.trim()} generates its module at runtime; interpreting until 'TBL1'\n`);
  const machine = new Machine({
    partmem: partmemFor(demoname),
    clock: 'virtual',
    onDebug: (m) => process.stdout.write(`  host: ${m}\n`),
    onMusic: (xm) => {
      writeFileSync(outPath, xm);
      process.stdout.write(`  wrote ${xm.length} bytes to ${outPath}\n`);
      throw new Error('__xm_captured');
    },
  });
  const loaded = machine.loadExe(unpackBlock(bytes, entries[ops.find((o) => o.name === 'exe').args[0]]));
  const cpu = new Engine(machine);
  cpu.reset(loaded);
  try {
    cpu.run(2e10);
  } catch (e) {
    if (e.message === '__xm_captured') return 0;
    process.stdout.write(`  stopped: ${e.message}\n`);
    return 1;
  }
  process.stdout.write('  the part never handed over an XM\n');
  return 1;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'verify') process.exit(verify());
else if (cmd === 'dumpxm') process.exit(dumpXm(rest[0], rest[1]));
else if (cmd === 'renderxm') process.exit(renderXm(rest[0], rest[1], Number(rest[2] ?? 30)));
else if (cmd === 'bench') {
  import('./benchmark.mjs')
    .then(({ benchmarkIxa }) => process.exit(benchmarkIxa(rest[0], rest.slice(1))))
    .catch((error) => {
      process.stderr.write(`bench: ${error?.stack ?? error}\n`);
      process.exit(1);
    });
}
// run() is async because the sequencer's run() is; the other commands stay synchronous.
else if (cmd === 'run') run(rest[0], rest[1], Number(rest[2] ?? 1e7), rest[3]).then(process.exit);
else {
  // The usage block at the top of this file is the help text.
  const src = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  process.stdout.write(src.slice(0, src.findIndex((l) => !l.startsWith('//'))).join('\n') + '\n');
  process.exit(2);
}
