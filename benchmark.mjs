// Deterministic, order-based performance benchmarks for the generated-music 64K intros.
//
// A compressed post-decrunch checkpoint is captured immediately after the demo hands its
// generated XM to TBL1. Exact order-start checkpoints branch from it on demand. Restores
// include architectural state, tracker time and used memory, but no decode or JIT cache.
// The real XM replayer then advances without mixing audio and supplies the order/row clock
// the demo reads through TBL3. A separate phase benchmark times fresh startup through TBL1.

import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { gzipSync, gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { readIxa, unpackBlock, parseScript } from './lib/ixa.js';
import { Machine, partmemFor } from './lib/machine.js';
import { CPU } from './lib/cpu.js';
import { JitCPU } from './lib/jit.js';
import { XmPlayer } from './lib/xm.js';

const FORMAT = 1;
const ORDER_FORMAT = 1;
const ROW_FORMAT = 1;
const SAMPLE_RATE = 48_000;
const MUSIC_READY = Symbol('music-ready');
const NEXT_MUSIC_READY = Symbol('next-music-ready');
const ORDER_READY = Symbol('order-ready');
const FLAGS = ['cf', 'pf', 'af', 'zf', 'sf', 'of', 'df'];
const MACHINE_SCALARS = [
  'brk', 'partmemUsed', 'width', 'height', 'frames', 'escaped', 'startTime',
  'fps', 'virtualMs', 'timerRate', 'lastTick', 'herzcount',
  'externalMusic', 'musicPos', 'musicRow',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;
const integer = (n) => Math.round(n).toLocaleString('en-US');
const rate = (instructions, ms) => ms > 0 ? instructions / ms / 1000 : 0;

function parseOptions(args) {
  const opts = {
    engine: 'both',
    from: 0,
    to: Infinity,
    repeat: 1,
    slice: 2_000_000,
    budget: 20_000_000_000,
    rebuild: false,
    prepareOnly: false,
    prepareOrder: null,
    checkpoint: null,
    csv: null,
    music: 1,
    rowStep: null,
    phase: null,
    orders: null,
    fromSet: false,
    toSet: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      return args[++i];
    };
    if (arg === '--engine') opts.engine = value();
    else if (arg === '--from') { opts.from = Number(value()); opts.fromSet = true; }
    else if (arg === '--to') { opts.to = Number(value()); opts.toSet = true; }
    else if (arg === '--repeat') opts.repeat = Number(value());
    else if (arg === '--slice') opts.slice = Number(value());
    else if (arg === '--budget') opts.budget = Number(value());
    else if (arg === '--checkpoint') opts.checkpoint = value();
    else if (arg === '--csv') opts.csv = value();
    else if (arg === '--music') opts.music = Number(value());
    else if (arg === '--row-step') opts.rowStep = Number(value());
    else if (arg === '--phase') opts.phase = value().toLowerCase();
    else if (arg === '--orders') opts.orders = parseOrderSpec(value());
    else if (arg === '--prepare-order') opts.prepareOrder = Number(value());
    else if (arg === '--rebuild') opts.rebuild = true;
    else if (arg === '--prepare') opts.prepareOnly = true;
    else throw new Error(`unknown benchmark option ${arg}`);
  }
  if (!['cpu', 'jit', 'both'].includes(opts.engine)) {
    throw new Error(`--engine must be cpu, jit or both (got ${opts.engine})`);
  }
  if (opts.phase !== null && opts.phase !== 'decrunch') {
    throw new Error(`--phase must be decrunch (got ${opts.phase})`);
  }
  for (const [name, value] of [
    ['from', opts.from], ['to', opts.to], ['repeat', opts.repeat],
    ['slice', opts.slice], ['budget', opts.budget], ['music', opts.music],
    ['row-step', opts.rowStep],
  ]) {
    if (value !== null
        && !(Number.isFinite(value) || (name === 'to' && value === Infinity))) {
      throw new Error(`--${name} must be a number`);
    }
  }
  if (opts.from < 0 || opts.to <= opts.from) throw new Error('order range must satisfy 0 <= from < to');
  if (opts.repeat < 1 || opts.slice < 1 || opts.budget < 1) {
    throw new Error('--repeat, --slice and --budget must be positive');
  }
  opts.from = Math.floor(opts.from);
  opts.to = Math.floor(opts.to);
  opts.repeat = Math.floor(opts.repeat);
  opts.music = Math.floor(opts.music);
  if (opts.rowStep !== null) opts.rowStep = Math.floor(opts.rowStep);
  if (opts.music < 1) throw new Error('--music must be a positive one-based index');
  if (opts.rowStep !== null && opts.rowStep < 1) {
    throw new Error('--row-step must be a positive row count');
  }
  if (opts.prepareOrder !== null) {
    if (!Number.isFinite(opts.prepareOrder) || opts.prepareOrder < 0) {
      throw new Error('--prepare-order must be a non-negative order number');
    }
    opts.prepareOrder = Math.floor(opts.prepareOrder);
  }
  if (opts.orders !== null && (opts.fromSet || opts.toSet)) {
    throw new Error('--orders cannot be combined with --from or --to');
  }
  if (opts.prepareOrder !== null && (opts.orders !== null || opts.fromSet || opts.toSet)) {
    throw new Error('--prepare-order cannot be combined with --orders, --from or --to');
  }
  if (opts.phase !== null && (opts.orders !== null || opts.fromSet || opts.toSet
      || opts.prepareOnly || opts.prepareOrder !== null || opts.rebuild
      || opts.checkpoint !== null || opts.csv !== null || opts.music !== 1
      || opts.rowStep !== null)) {
    throw new Error('--phase cannot be combined with order selection or checkpoint preparation');
  }
  return opts;
}

function parseOrderSpec(spec) {
  const orders = new Set();
  for (const item of spec.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(item);
    if (!match) throw new Error(`invalid --orders item ${JSON.stringify(item)}`);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (to < from) throw new Error(`descending --orders range ${item}`);
    for (let order = from; order <= to; order++) orders.add(order);
  }
  if (orders.size === 0) throw new Error('--orders needs at least one order');
  return [...orders].sort((a, b) => a - b);
}

function checkpointPath(ixaPath, hash, requested) {
  if (requested) return resolve(requested);
  const stem = basename(ixaPath, extname(ixaPath)).toLowerCase();
  return resolve('out', 'bench', `${stem}-${hash.slice(0, 12)}.music-start.cp.gz`);
}

function musicCheckpointPath(firstMusicFile, musicIndex) {
  if (musicIndex === 0) return firstMusicFile;
  const suffix = `.music-${String(musicIndex + 1).padStart(3, '0')}-start.cp.gz`;
  return firstMusicFile.endsWith('.music-start.cp.gz')
    ? firstMusicFile.slice(0, -'.music-start.cp.gz'.length) + suffix
    : firstMusicFile + suffix;
}

function orderCheckpointPath(musicStartFile, order) {
  const suffix = `.order-${String(order).padStart(3, '0')}.cp.gz`;
  if (musicStartFile.endsWith('.music-start.cp.gz')) {
    return musicStartFile.slice(0, -'.music-start.cp.gz'.length) + suffix;
  }
  const later = /^(.*\.music-\d+)-start\.cp\.gz$/.exec(musicStartFile);
  return later ? later[1] + suffix : musicStartFile + suffix;
}

function rowCheckpointPath(musicStartFile, order, row) {
  const orderFile = orderCheckpointPath(musicStartFile, order);
  const suffix = `.row-${String(row).padStart(3, '0')}.cp.gz`;
  return orderFile.endsWith('.cp.gz')
    ? orderFile.slice(0, -'.cp.gz'.length) + suffix
    : orderFile + suffix;
}

function captureCpu(cpu) {
  const f = cpu.fpu;
  return {
    regs: Array.from(cpu.regs),
    seg: { ...cpu.seg },
    eip: cpu.eip,
    flags: Object.fromEntries(FLAGS.map((name) => [name, cpu[name]])),
    fpu: {
      st: Array.from(f.st),
      empty: Array.from(f.empty),
      top: f.top,
      cw: f.cw,
      sw: f.sw,
      c0: f.c0,
      c1: f.c1,
      c2: f.c2,
      c3: f.c3,
    },
    insStart: cpu.insStart,
    opsize: cpu.opsize,
    addrsize: cpu.addrsize,
    segOverride: cpu.segOverride,
    repPrefix: cpu.repPrefix,
    count: cpu.count,
    trampolineCount: cpu.trampolineCount,
  };
}

function captureMachine(machine) {
  const ptr = machine.xm?.bytes?.byteOffset;
  const len = machine.xm?.bytes?.byteLength;
  if (!Number.isInteger(ptr) || !Number.isInteger(len)) {
    throw new Error('cannot checkpoint without a live generated XM');
  }
  return {
    size: machine.size,
    partmemSize: machine.partmemSize,
    scalars: Object.fromEntries(MACHINE_SCALARS.map((name) => [name, machine[name]])),
    xmPtr: ptr,
    xmLength: len,
  };
}

function stoppingEngine(Engine, shouldStop, sentinel) {
  return class extends Engine {
    farCall(off, sel) {
      const result = super.farCall(off, sel);
      // farCall has applied the trampoline's register effects before the sentinel escapes,
      // so a captured state is after the completed host-call instruction.
      if (shouldStop(this)) throw sentinel;
      return result;
    }
  };
}

function executablePart(bytes) {
  const { demoname, entries } = readIxa(bytes);
  const script = bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size);
  const ops = parseScript(script);
  const exeOps = ops.filter((op) => op.name === 'exe');
  if (exeOps.length !== 1) {
    throw new Error(`${demoname.trim()} has ${exeOps.length} executable parts; `
      + 'music-start checkpoints currently target single-part intros');
  }
  return {
    demoname,
    image: unpackBlock(bytes, entries[exeOps[0].args[0]]),
  };
}

function runToMusic(bytes, Engine, engineName, budget, retainState = false) {
  const { demoname, image } = executablePart(bytes);
  const machine = new Machine({
    partmem: partmemFor(demoname),
    clock: 'virtual',
    onDebug: () => {},
  });
  const loaded = machine.loadExe(image);
  let hadMusic = false;
  const CaptureEngine = stoppingEngine(
    Engine,
    (cpu) => {
      const ready = !hadMusic && cpu.machine.xm !== null;
      hadMusic = cpu.machine.xm !== null;
      return ready;
    },
    MUSIC_READY,
  );
  const cpu = new CaptureEngine(machine);
  cpu.retainTrampolineHits = false;
  cpu.reset(loaded);

  const started = performance.now();
  try {
    cpu.run(budget);
  } catch (error) {
    if (error !== MUSIC_READY) throw error;
  }
  const elapsed = performance.now() - started;
  const budgetHit = !machine.xm && cpu.count >= budget;
  if (!machine.xm && !budgetHit) throw new Error('the part did not hand a generated XM to TBL1');
  const player = machine.xm ? new XmPlayer(machine.xm.bytes.slice(), SAMPLE_RATE) : null;
  return {
    engine: engineName,
    cpu: retainState ? cpu : null,
    machine: retainState ? machine : null,
    player: retainState ? player : null,
    instructions: cpu.count,
    milliseconds: elapsed,
    frames: machine.frames,
    hostCalls: cpu.trampolineCount,
    budgetHit,
    fingerprint: player ? fingerprint(cpu, machine, player) : null,
  };
}

function checkpointFromMusicRun(ixaPath, hash, demoname, run) {
  if (!run.machine.xm) throw new Error('cannot checkpoint before TBL1');
  return {
    format: FORMAT,
    kind: 'music-start',
    input: {
      path: resolve(ixaPath),
      sha256: hash,
      demoname,
    },
    startup: {
      engine: run.engine,
      instructions: run.instructions,
      milliseconds: run.milliseconds,
      frames: run.frames,
      hostCalls: run.hostCalls,
    },
    machine: captureMachine(run.machine),
    cpu: captureCpu(run.cpu),
    memory: run.machine.u8.slice(0, run.machine.brk),
    timeline: {
      samples: 0,
      position: 0,
      row: 0,
      tick: 0,
      loops: 0,
      occurrence: 0,
      visits: [[0, 0]],
    },
  };
}

function prepareCheckpoint(ixaPath, bytes, hash, file, budget) {
  const { demoname } = executablePart(bytes);
  process.stdout.write(
    `Preparing ${demoname.trim()} post-decrunch checkpoint at generated-XM handoff (TBL1)...\n`);
  process.stdout.write('  jit 1/1...\n');
  const run = runToMusic(bytes, JitCPU, 'jit', budget, true);
  if (run.budgetHit) {
    throw new Error(`TBL1 was not reached within the ${integer(budget)} instruction budget`);
  }

  const checkpoint = checkpointFromMusicRun(ixaPath, hash, demoname, run);

  mkdirSync(dirname(file), { recursive: true });
  const packed = gzipSync(serialize(checkpoint), { level: 1 });
  writeFileSync(file, packed);
  process.stdout.write(
    `  startup ${integer(run.instructions)} instructions in ${(run.milliseconds / 1000).toFixed(3)} s `
    + `(${rate(run.instructions, run.milliseconds).toFixed(1)} M/s), ${run.frames} frames\n`
    + `  wrote ${file} (${mib(packed.length)} compressed, ${mib(checkpoint.memory.length)} memory)\n`);
  return checkpoint;
}

function loadCheckpoint(file, hash) {
  const checkpoint = deserialize(gunzipSync(readFileSync(file)));
  if (checkpoint.format !== FORMAT) {
    throw new Error(`checkpoint format ${checkpoint.format}; expected ${FORMAT} (use --rebuild)`);
  }
  if (checkpoint.kind !== undefined && checkpoint.kind !== 'music-start') {
    throw new Error(`checkpoint ${file} is ${checkpoint.kind}, not a post-decrunch checkpoint`);
  }
  if (checkpoint.input.sha256 !== hash) {
    throw new Error('checkpoint input hash does not match the IXA file (use --rebuild)');
  }
  return checkpoint;
}

function loadLaterMusicCheckpoint(file, hash, originState, expectedIndex) {
  const checkpoint = deserialize(gunzipSync(readFileSync(file)));
  if (checkpoint.format !== FORMAT || checkpoint.kind !== 'music-start') {
    throw new Error(`unsupported later-music checkpoint format in ${file}`);
  }
  if (checkpoint.input.sha256 !== hash) {
    throw new Error(`music checkpoint input hash does not match in ${file}`);
  }
  if (checkpoint.originState !== originState) {
    throw new Error(`music checkpoint was built from a different first-music state: ${file}`);
  }
  if (checkpoint.musicIndex !== expectedIndex) {
    throw new Error(
      `music checkpoint ${file} is segment ${checkpoint.musicIndex + 1}, `
      + `not ${expectedIndex + 1}`);
  }
  return checkpoint;
}

function saveLaterMusicCheckpoint(base, firstFile, originState, musicIndex,
    machine, cpu, player, preparation) {
  const file = musicCheckpointPath(firstFile, musicIndex);
  const checkpoint = {
    format: FORMAT,
    kind: 'music-start',
    musicIndex,
    originState,
    input: base.input,
    preparation,
    machine: captureMachine(machine),
    cpu: captureCpu(cpu),
    memory: machine.u8.slice(0, machine.brk),
    timeline: {
      samples: 0,
      position: 0,
      row: 0,
      tick: 0,
      loops: 0,
      occurrence: 0,
      visits: [[0, 0]],
    },
    music: {
      title: player.title,
      orders: player.songLength,
      rows: player.totalRows,
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  const packed = gzipSync(serialize(checkpoint), { level: 1 });
  writeFileSync(file, packed);
  process.stdout.write(
    `  cached XM ${musicIndex + 1} ${JSON.stringify(player.title || '(untitled)')} start: `
    + `${file} (${mib(packed.length)}, ${integer(cpu.count)} instructions from XM `
    + `${preparation.fromMusic + 1})\n`);
  return checkpoint;
}

function prepareNextMusicCheckpoint(base, firstFile, originState, currentMusic,
    previousIndex, seed, opts) {
  let machine = null;
  let player = null;
  let cpu = null;
  let pendingMusic = false;
  let pendingOrder = null;
  let advancedSamples = 0;
  let currentOrder = seed.timeline?.position ?? 0;
  const initialSamples = seed.timeline?.samples ?? 0;
  const visits = new Map(
    seed.timeline?.visits ?? [[currentOrder, seed.timeline?.occurrence ?? 0]]);
  const currentFile = musicCheckpointPath(firstFile, previousIndex);
  const currentOrigin = checkpointStateHash(currentMusic);

  const hooks = {
    onFrame: () => {
      const target = Math.max(0, Math.floor(
        (machine.virtualMs - seed.machine.scalars.virtualMs) * SAMPLE_RATE / 1000));
      if (target > advancedSamples) {
        player.skip(target - advancedSamples);
        advancedSamples = target;
      }
      machine.setMusicPosition(player.position, player.row);
      if (player.position !== currentOrder) {
        const occurrence = (visits.get(player.position) ?? -1) + 1;
        visits.set(player.position, occurrence);
        pendingOrder = { order: player.position, occurrence };
      }
    },
    onMusic: () => { pendingMusic = true; },
  };

  machine = restoreMachine(seed, hooks);
  player = restorePlayer(seed);
  machine.setMusicPosition(player.position, player.row);
  const BoundaryEngine = stoppingEngine(
    JitCPU, () => pendingMusic || pendingOrder !== null, NEXT_MUSIC_READY);
  cpu = restoreCpu(BoundaryEngine, machine, seed.cpu);
  const started = performance.now();

  process.stdout.write(
    `Preparing XM ${previousIndex + 2} start with JIT from XM ${previousIndex + 1}...\n`);
  while (!cpu.halted && cpu.count < opts.budget) {
    try {
      cpu.run(Math.min(opts.slice, opts.budget - cpu.count));
    } catch (error) {
      if (error !== NEXT_MUSIC_READY) throw error;
      if (pendingMusic) {
        const nextPlayer = new XmPlayer(machine.xm.bytes.slice(), SAMPLE_RATE);
        machine.setMusicPosition(0, 0);
        return saveLaterMusicCheckpoint(
          base,
          firstFile,
          originState,
          previousIndex + 1,
          machine,
          cpu,
          nextPlayer,
          {
            engine: 'jit',
            fromMusic: previousIndex,
            instructions: cpu.count,
            milliseconds: performance.now() - started,
            previousSamples: initialSamples + advancedSamples,
            previousPosition: player.position,
            previousRow: player.row,
          },
        );
      }

      const { order, occurrence } = pendingOrder;
      if (occurrence === 0) {
        saveOrderCheckpoint(
          currentMusic,
          currentFile,
          currentOrigin,
          machine,
          cpu,
          player,
          initialSamples + advancedSamples,
          occurrence,
          visits,
          {
            engine: 'jit',
            fromOrder: seed.timeline?.position ?? 0,
            instructions: cpu.count,
            milliseconds: performance.now() - started,
          },
        );
      }
      currentOrder = order;
      pendingOrder = null;
    }
  }
  if (cpu.halted) {
    throw new Error(
      `demo halted before XM ${previousIndex + 2}: ${cpu.haltReason}`);
  }
  throw new Error(
    `XM ${previousIndex + 2} was not reached within the `
    + `${integer(opts.budget)} instruction budget`);
}

function ensureMusicCheckpoint(base, firstFile, hash, targetIndex, opts) {
  if (targetIndex === 0) return base;
  const originState = checkpointStateHash(base);
  let checkpoint = base;
  let currentIndex = 0;

  if (!opts.rebuild) {
    for (let index = targetIndex; index >= 1; index--) {
      const file = musicCheckpointPath(firstFile, index);
      if (!existsSync(file)) continue;
      try {
        checkpoint = loadLaterMusicCheckpoint(file, hash, originState, index);
        currentIndex = index;
        process.stdout.write(
          `Loaded XM ${index + 1} checkpoint ${file} (${mib(statSync(file).size)})\n`);
        break;
      } catch (error) {
        process.stdout.write(`Ignoring stale music checkpoint: ${error.message}\n`);
      }
    }
  }

  while (currentIndex < targetIndex) {
    // Reuse the latest valid order boundary inside the current soundtrack. Stash's first
    // XM alone executes more than 20B instructions before it switches modules, so replaying
    // from order 0 merely to discover the next TBL1 would throw away the checkpoint system's
    // largest benefit.
    let seed = checkpoint;
    if (!opts.rebuild) {
      const currentFile = musicCheckpointPath(firstFile, currentIndex);
      const currentOrigin = checkpointStateHash(checkpoint);
      const currentPlayer = restorePlayer(checkpoint);
      for (let order = currentPlayer.songLength - 1; order >= 1; order--) {
        const file = orderCheckpointPath(currentFile, order);
        if (!existsSync(file)) continue;
        try {
          seed = loadOrderCheckpoint(file, hash, currentOrigin, order);
          process.stdout.write(
            `Loaded XM ${currentIndex + 1} order ${order} as the next-music seed `
            + `(${mib(statSync(file).size)})\n`);
          break;
        } catch (error) {
          process.stdout.write(`Ignoring stale next-music seed: ${error.message}\n`);
        }
      }
    }
    checkpoint = prepareNextMusicCheckpoint(
      base, firstFile, originState, checkpoint, currentIndex, seed, opts);
    currentIndex++;
  }
  return checkpoint;
}

function checkpointStateHash(checkpoint) {
  return sha256(serialize({
    machine: checkpoint.machine,
    cpu: checkpoint.cpu,
    memory: checkpoint.memory,
  }));
}

function loadOrderCheckpoint(file, hash, originState, expectedOrder) {
  const checkpoint = deserialize(gunzipSync(readFileSync(file)));
  if (checkpoint.format !== ORDER_FORMAT || checkpoint.kind !== 'xm-order-start') {
    throw new Error(`unsupported order checkpoint format in ${file}`);
  }
  if (checkpoint.input.sha256 !== hash) {
    throw new Error(`order checkpoint input hash does not match in ${file}`);
  }
  if (checkpoint.originState !== originState) {
    throw new Error(`order checkpoint was built from a different post-decrunch state: ${file}`);
  }
  if (checkpoint.timeline.position !== expectedOrder || checkpoint.timeline.occurrence !== 0) {
    throw new Error(`order checkpoint ${file} is not the first visit to order ${expectedOrder}`);
  }
  return checkpoint;
}

function loadRowCheckpoint(file, hash, originState, expectedOrder, expectedRow) {
  const checkpoint = deserialize(gunzipSync(readFileSync(file)));
  if (checkpoint.format !== ROW_FORMAT || checkpoint.kind !== 'xm-row-start') {
    throw new Error(`unsupported row checkpoint format in ${file}`);
  }
  if (checkpoint.input.sha256 !== hash) {
    throw new Error(`row checkpoint input hash does not match in ${file}`);
  }
  if (checkpoint.originState !== originState) {
    throw new Error(`row checkpoint was built from a different music-start state: ${file}`);
  }
  if (checkpoint.timeline.position !== expectedOrder
      || checkpoint.timeline.row !== expectedRow
      || checkpoint.timeline.occurrence !== 0) {
    throw new Error(
      `row checkpoint ${file} is not the first visit to ${expectedOrder}:${expectedRow}`);
  }
  return checkpoint;
}

function restoreMachine(checkpoint, hooks) {
  const state = checkpoint.machine;
  const machine = new Machine({
    size: state.size,
    partmem: state.partmemSize,
    clock: 'virtual',
    fps: state.scalars.fps,
    onFrame: hooks.onFrame,
    onDebug: () => {},
  });
  machine.u8.set(checkpoint.memory);
  // Install onMusic only after restoring the XM that owns this checkpoint. Otherwise the
  // restore itself looks like a new TBL1 and multi-XM intros immediately capture a false
  // boundary before executing one instruction.
  machine.startXm(state.xmPtr, state.xmLength);
  for (const name of MACHINE_SCALARS) machine[name] = state.scalars[name];
  machine.onMusic = hooks.onMusic ?? null;
  return machine;
}

function restorePlayer(checkpoint) {
  const xm = checkpoint.memory.subarray(
    checkpoint.machine.xmPtr,
    checkpoint.machine.xmPtr + checkpoint.machine.xmLength);
  const player = new XmPlayer(xm, SAMPLE_RATE);
  const timeline = checkpoint.timeline;
  if (timeline?.samples > 0) player.skip(timeline.samples);
  if (timeline && (player.position !== timeline.position || player.row !== timeline.row
      || player.tick !== timeline.tick || player.loops !== timeline.loops)) {
    throw new Error(
      `XM timeline restore mismatch: wanted ${timeline.position}:${timeline.row}`
      + ` tick ${timeline.tick}, got ${player.position}:${player.row} tick ${player.tick}`);
  }
  return player;
}

function restoreCpu(Engine, machine, state) {
  const cpu = new Engine(machine);
  cpu.regs.set(state.regs);
  Object.assign(cpu.seg, state.seg);
  cpu.eip = state.eip >>> 0;
  for (const name of FLAGS) cpu[name] = state.flags[name];
  cpu.fpu.st.set(state.fpu.st);
  cpu.fpu.empty.set(state.fpu.empty);
  for (const name of ['top', 'cw', 'sw', 'c0', 'c1', 'c2', 'c3']) {
    cpu.fpu[name] = state.fpu[name];
  }
  cpu.insStart = state.insStart;
  cpu.opsize = state.opsize;
  cpu.addrsize = state.addrsize;
  cpu.segOverride = state.segOverride;
  cpu.repPrefix = state.repPrefix;
  // Counts and diagnostic caches are benchmark-local. Constructor-created decode/JIT
  // tables stay empty, which makes every restored run a genuinely cold engine start.
  cpu.count = 0;
  cpu.trampolineCount = 0;
  cpu.retainTrampolineHits = false;
  return cpu;
}

function fingerprint(cpu, machine, player) {
  const hash = createHash('sha256');
  hash.update(machine.u8.subarray(0, machine.brk));
  hash.update(new Uint8Array(cpu.regs.buffer, cpu.regs.byteOffset, cpu.regs.byteLength));
  hash.update(new Uint8Array(cpu.fpu.st.buffer, cpu.fpu.st.byteOffset, cpu.fpu.st.byteLength));
  hash.update(cpu.fpu.empty);
  hash.update(JSON.stringify({
    count: cpu.count,
    trampolineCount: cpu.trampolineCount,
    eip: cpu.eip,
    seg: cpu.seg,
    flags: Object.fromEntries(FLAGS.map((name) => [name, cpu[name]])),
    fpu: Object.fromEntries(
      ['top', 'cw', 'sw', 'c0', 'c1', 'c2', 'c3'].map((name) => [name, cpu.fpu[name]])),
    halted: cpu.halted,
    haltReason: cpu.haltReason,
    machine: Object.fromEntries(MACHINE_SCALARS.map((name) => [name, machine[name]])),
    tracker: {
      position: player.position,
      row: player.row,
      tick: player.tick,
      loops: player.loops,
    },
  }));
  return hash.digest('hex');
}

function saveOrderCheckpoint(base, baseFile, originState, machine, cpu, player,
    samples, occurrence, visits, preparation) {
  const order = player.position;
  const file = orderCheckpointPath(baseFile, order);
  const checkpoint = {
    format: ORDER_FORMAT,
    kind: 'xm-order-start',
    input: base.input,
    originState,
    preparation,
    machine: captureMachine(machine),
    cpu: captureCpu(cpu),
    memory: machine.u8.slice(0, machine.brk),
    timeline: {
      samples,
      position: player.position,
      row: player.row,
      tick: player.tick,
      loops: player.loops,
      occurrence,
      visits: [...visits],
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  const packed = gzipSync(serialize(checkpoint), { level: 1 });
  writeFileSync(file, packed);
  process.stdout.write(
    `  cached order ${order} start at ${player.position}:${player.row} tick ${player.tick}: `
    + `${file} (${mib(packed.length)})\n`);
  return checkpoint;
}

function saveRowCheckpoint(base, baseFile, originState, machine, cpu, player,
    samples, occurrence, visits, preparation) {
  const order = player.position;
  const row = player.row;
  const file = rowCheckpointPath(baseFile, order, row);
  const checkpoint = {
    format: ROW_FORMAT,
    kind: 'xm-row-start',
    input: base.input,
    originState,
    preparation,
    machine: captureMachine(machine),
    cpu: captureCpu(cpu),
    memory: machine.u8.slice(0, machine.brk),
    timeline: {
      samples,
      position: order,
      row,
      tick: player.tick,
      loops: player.loops,
      occurrence,
      visits: [...visits],
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  const packed = gzipSync(serialize(checkpoint), { level: 1 });
  writeFileSync(file, packed);
  process.stdout.write(
    `  cached ${order}:${row} tick ${player.tick}: ${file} (${mib(packed.length)})\n`);
  return checkpoint;
}

function ensureOrderCheckpoint(base, baseFile, hash, originState, targetOrder, opts) {
  if (targetOrder === 0) return base;

  let checkpoint = base;
  let checkpointOrder = 0;
  if (!opts.rebuild) {
    for (let order = targetOrder; order >= 1; order--) {
      const file = orderCheckpointPath(baseFile, order);
      if (!existsSync(file)) continue;
      try {
        checkpoint = loadOrderCheckpoint(file, hash, originState, order);
        checkpointOrder = order;
        process.stdout.write(
          `Loaded order ${order} checkpoint ${file} (${mib(statSync(file).size)})\n`);
        break;
      } catch (error) {
        process.stdout.write(`Ignoring stale order checkpoint: ${error.message}\n`);
      }
    }
  }
  if (checkpointOrder === targetOrder) return checkpoint;

  process.stdout.write(
    `Preparing order checkpoints ${checkpointOrder + 1}..${targetOrder} with JIT `
    + `from cached order ${checkpointOrder}...\n`);

  let player = null;
  let cpu = null;
  let machine = null;
  let pending = null;
  let musicChanged = false;
  let advancedSamples = 0;
  const initialSamples = checkpoint.timeline?.samples ?? 0;
  const initialLoops = checkpoint.timeline?.loops ?? 0;
  let currentOrder = checkpointOrder;
  const visits = new Map(
    checkpoint.timeline?.visits
      ?? [[currentOrder, checkpoint.timeline?.occurrence ?? 0]]);

  const hooks = {
    onFrame: () => {
      const target = Math.max(0, Math.floor(
        (machine.virtualMs - checkpoint.machine.scalars.virtualMs) * SAMPLE_RATE / 1000));
      if (target > advancedSamples) {
        player.skip(target - advancedSamples);
        advancedSamples = target;
      }
      machine.setMusicPosition(player.position, player.row);
      if (player.loops > initialLoops) {
        throw new Error(`XM looped before reaching order ${targetOrder}`);
      }
      if (player.position !== currentOrder) {
        const occurrence = (visits.get(player.position) ?? -1) + 1;
        visits.set(player.position, occurrence);
        pending = { order: player.position, occurrence };
      }
    },
    onMusic: () => { musicChanged = true; },
  };

  machine = restoreMachine(checkpoint, hooks);
  player = restorePlayer(checkpoint);
  machine.setMusicPosition(player.position, player.row);
  const BoundaryEngine = stoppingEngine(
    JitCPU, () => musicChanged || pending !== null, ORDER_READY);
  cpu = restoreCpu(BoundaryEngine, machine, checkpoint.cpu);
  const started = performance.now();

  while (!cpu.halted && cpu.count < opts.budget) {
    try {
      cpu.run(Math.min(opts.slice, opts.budget - cpu.count));
    } catch (error) {
      if (error !== ORDER_READY) throw error;
      if (musicChanged) {
        throw new Error(
          `XM changed before reaching order ${targetOrder}; select the next soundtrack`);
      }
      if (!pending) throw new Error('order-boundary sentinel without a pending boundary');
      const nextOrder = pending.order;
      const occurrence = pending.occurrence;
      const saved = occurrence === 0
        ? saveOrderCheckpoint(
          base,
          baseFile,
          originState,
          machine,
          cpu,
          player,
          initialSamples + advancedSamples,
          occurrence,
          visits,
          {
            engine: 'jit',
            fromOrder: checkpointOrder,
            instructions: cpu.count,
            milliseconds: performance.now() - started,
          },
        )
        : null;
      currentOrder = nextOrder;
      pending = null;
      if (nextOrder === targetOrder && occurrence === 0) return saved;
    }
  }

  if (cpu.halted) {
    throw new Error(`demo halted at order ${player.position}: ${cpu.haltReason}`);
  }
  throw new Error(
    `order ${targetOrder} was not reached within the ${integer(opts.budget)} instruction budget`);
}

function ensureRowCheckpoint(base, baseFile, hash, originState, orderCheckpoint,
    targetOrder, targetRow, opts) {
  if (targetRow === 0) return orderCheckpoint;

  let checkpoint = orderCheckpoint;
  let checkpointRow = 0;
  if (!opts.rebuild) {
    for (let row = targetRow; row >= 1; row--) {
      const file = rowCheckpointPath(baseFile, targetOrder, row);
      if (!existsSync(file)) continue;
      try {
        checkpoint = loadRowCheckpoint(file, hash, originState, targetOrder, row);
        checkpointRow = row;
        process.stdout.write(
          `Loaded ${targetOrder}:${row} checkpoint ${file} (${mib(statSync(file).size)})\n`);
        break;
      } catch (error) {
        process.stdout.write(`Ignoring stale row checkpoint: ${error.message}\n`);
      }
    }
  }
  if (checkpointRow === targetRow) return checkpoint;

  process.stdout.write(
    `Preparing row checkpoint ${targetOrder}:${targetRow} with JIT from `
    + `${targetOrder}:${checkpointRow}...\n`);

  let machine = null;
  let player = null;
  let cpu = null;
  let advancedSamples = 0;
  let boundary = false;
  let musicChanged = false;
  const initialSamples = checkpoint.timeline?.samples ?? 0;
  const initialLoops = checkpoint.timeline?.loops ?? 0;
  const occurrence = checkpoint.timeline?.occurrence ?? 0;
  const visits = new Map(
    checkpoint.timeline?.visits ?? [[targetOrder, occurrence]]);

  const hooks = {
    onFrame: () => {
      const target = Math.max(0, Math.floor(
        (machine.virtualMs - checkpoint.machine.scalars.virtualMs) * SAMPLE_RATE / 1000));
      if (target > advancedSamples) {
        player.skip(target - advancedSamples);
        advancedSamples = target;
      }
      machine.setMusicPosition(player.position, player.row);
      if (player.loops > initialLoops
          || player.position !== targetOrder
          || player.row >= targetRow) {
        boundary = true;
      }
    },
    onMusic: () => { musicChanged = true; },
  };

  machine = restoreMachine(checkpoint, hooks);
  player = restorePlayer(checkpoint);
  machine.setMusicPosition(player.position, player.row);
  const BoundaryEngine = stoppingEngine(
    JitCPU, () => musicChanged || boundary, ORDER_READY);
  cpu = restoreCpu(BoundaryEngine, machine, checkpoint.cpu);
  const started = performance.now();

  while (!cpu.halted && cpu.count < opts.budget) {
    try {
      cpu.run(Math.min(opts.slice, opts.budget - cpu.count));
    } catch (error) {
      if (error !== ORDER_READY) throw error;
      if (musicChanged || player.loops > initialLoops
          || player.position !== targetOrder) {
        return null;
      }
      if (player.row !== targetRow) {
        throw new Error(
          `tracker skipped requested row ${targetOrder}:${targetRow}; `
          + `first observed ${player.position}:${player.row}`);
      }
      return saveRowCheckpoint(
        base,
        baseFile,
        originState,
        machine,
        cpu,
        player,
        initialSamples + advancedSamples,
        occurrence,
        visits,
        {
          engine: 'jit',
          fromOrder: targetOrder,
          fromRow: checkpointRow,
          instructions: cpu.count,
          milliseconds: performance.now() - started,
        },
      );
    }
  }

  if (cpu.halted) return null;
  throw new Error(
    `row ${targetOrder}:${targetRow} was not reached within the `
    + `${integer(opts.budget)} instruction budget`);
}

function runOrders(checkpoint, Engine, engineName, opts) {
  let cpu = null;
  let player = null;
  let advancedSamples = 0;
  let currentOrder = 0;
  let occurrence = 0;
  const initialOccurrence = checkpoint.timeline?.occurrence ?? 0;
  const visits = new Map(checkpoint.timeline?.visits ?? []);
  let startCount = 0;
  let startFrames = 0;
  let startMs = 0;
  let clockMilliseconds = 0;
  let startClockMilliseconds = 0;
  let stop = false;
  let musicChanged = false;
  const rows = [];

  const finish = (now, nextOrder, looped) => {
    if (currentOrder >= opts.from && currentOrder < opts.to) {
      rows.push({
        order: currentOrder,
        occurrence,
        pattern: player.order[currentOrder] ?? -1,
        instructions: cpu.count - startCount,
        frames: machine.frames - startFrames,
        // XM timing runs on the audio thread in the browser. skip() lives here only to
        // provide its clock, so do not charge that bookkeeping to either CPU engine.
        milliseconds: (now - startMs) - (clockMilliseconds - startClockMilliseconds),
      });
    }
    if (looped || nextOrder >= opts.to) {
      stop = true;
      return;
    }
    currentOrder = nextOrder;
    occurrence = (visits.get(nextOrder) ?? -1) + 1;
    visits.set(nextOrder, occurrence);
    startCount = cpu.count;
    startFrames = machine.frames;
    startMs = now;
    startClockMilliseconds = clockMilliseconds;
  };

  const hooks = {
    onFrame: () => {
      // cpu.run() only returns at the end of its current slice. Once an order boundary has
      // ended the requested range, later frames in that same slice are deliberately ignored.
      if (stop) return;
      const clockStarted = performance.now();
      const target = Math.max(0, Math.floor(
        (machine.virtualMs - checkpoint.machine.scalars.virtualMs) * SAMPLE_RATE / 1000));
      if (target > advancedSamples) {
        player.skip(target - advancedSamples);
        advancedSamples = target;
      }
      machine.setMusicPosition(player.position, player.row);
      clockMilliseconds += performance.now() - clockStarted;
      if (player.loops > 0 || player.position !== currentOrder) {
        finish(performance.now(), player.position, player.loops > 0);
      }
    },
    onMusic: () => { musicChanged = true; },
  };
  const machine = restoreMachine(checkpoint, hooks);
  player = restorePlayer(checkpoint);
  currentOrder = player.position;
  occurrence = initialOccurrence;
  visits.set(currentOrder, occurrence);
  machine.setMusicPosition(player.position, player.row);
  const BoundaryEngine = stoppingEngine(
    Engine, () => musicChanged, NEXT_MUSIC_READY);
  cpu = restoreCpu(BoundaryEngine, machine, checkpoint.cpu);
  startCount = cpu.count;
  startFrames = machine.frames;
  startMs = performance.now();
  startClockMilliseconds = clockMilliseconds;

  while (!stop && !cpu.halted && cpu.count < opts.budget) {
    try {
      cpu.run(Math.min(opts.slice, opts.budget - cpu.count));
    } catch (error) {
      if (error !== NEXT_MUSIC_READY) throw error;
      finish(performance.now(), currentOrder, true);
    }
  }
  if (!stop) finish(performance.now(), player.position, player.loops > 0);
  return {
    engine: engineName,
    rows,
    halted: cpu.halted,
    haltReason: cpu.haltReason,
    budgetHit: cpu.count >= opts.budget,
    musicChanged,
    finalOrder: player.position,
    finalRow: player.row,
    totalInstructions: cpu.count,
    fingerprint: fingerprint(cpu, machine, player),
  };
}

function runSelectedOrders(checkpoints, Engine, engineName, opts) {
  const outcomes = [];
  const rows = [];
  for (const order of opts.orders) {
    const result = runOrders(
      checkpoints.get(order),
      Engine,
      engineName,
      { ...opts, from: order, to: order + 1 },
    );
    outcomes.push({ order, result });
    rows.push(...result.rows);
  }
  const stopped = outcomes.find(({ result }) => result.budgetHit || result.halted)
    ?? outcomes[outcomes.length - 1];
  return {
    engine: engineName,
    rows,
    halted: outcomes.some(({ result }) => result.halted),
    haltReason: stopped.result.haltReason,
    budgetHit: outcomes.some(({ result }) => result.budgetHit),
    musicChanged: outcomes.some(({ result }) => result.musicChanged),
    finalOrder: stopped.result.finalOrder,
    finalRow: stopped.result.finalRow,
    totalInstructions: outcomes.reduce(
      (sum, { result }) => sum + result.totalInstructions, 0),
    budgetOrders: outcomes.filter(({ result }) => result.budgetHit)
      .map(({ order }) => order),
    haltedOrders: outcomes.filter(({ result }) => result.halted)
      .map(({ order }) => order),
    fingerprint: sha256(JSON.stringify(
      outcomes.map(({ order: selected, result }) => [selected, result.fingerprint]))),
  };
}

function averageDecrunchRuns(runs) {
  const first = runs[0];
  for (const run of runs) {
    if (run.instructions !== first.instructions || run.frames !== first.frames
        || run.hostCalls !== first.hostCalls || run.budgetHit !== first.budgetHit
        || run.fingerprint !== first.fingerprint) {
      throw new Error(`non-deterministic ${first.engine} decrunch result`);
    }
  }
  return {
    ...first,
    cpu: null,
    machine: null,
    player: null,
    milliseconds: runs.reduce((sum, run) => sum + run.milliseconds, 0) / runs.length,
  };
}

function benchmarkDecrunch(bytes, opts) {
  process.stdout.write(
    `Benchmarking decrunch/startup through generated-XM handoff (TBL1), `
    + `${opts.repeat} run(s), fresh machine and cold engine caches\n`);
  const engines = opts.engine === 'both'
    ? [['cpu', CPU], ['jit', JitCPU]]
    : [[opts.engine, opts.engine === 'cpu' ? CPU : JitCPU]];
  const results = [];
  for (const [name, Engine] of engines) {
    const runs = [];
    for (let i = 0; i < opts.repeat; i++) {
      process.stdout.write(`  ${name} ${i + 1}/${opts.repeat}...\n`);
      runs.push(runToMusic(bytes, Engine, name, opts.budget));
    }
    results.push(averageDecrunchRuns(runs));
  }

  if (results.length === 2) {
    const cpu = results.find((result) => result.engine === 'cpu');
    const jit = results.find((result) => result.engine === 'jit');
    if (!cpu.budgetHit && cpu.fingerprint !== jit.fingerprint) {
      throw new Error('CPU/JIT architectural fingerprints differ after decrunch');
    }
    if (cpu.instructions !== jit.instructions || cpu.frames !== jit.frames) {
      throw new Error('CPU/JIT decrunch boundaries differ');
    }
    process.stdout.write('\n'
      + ' phase       frames    instructions      CPU ms   CPU M/s      JIT ms   JIT M/s  speedup\n'
      + ` decrunch    ${String(cpu.frames).padStart(6)}  `
      + `${integer(cpu.instructions).padStart(14)}  `
      + `${cpu.milliseconds.toFixed(1).padStart(10)}  `
      + `${rate(cpu.instructions, cpu.milliseconds).toFixed(1).padStart(8)}  `
      + `${jit.milliseconds.toFixed(1).padStart(10)}  `
      + `${rate(jit.instructions, jit.milliseconds).toFixed(1).padStart(8)}  `
      + `${(cpu.milliseconds / jit.milliseconds).toFixed(2).padStart(7)}x\n`);
  } else {
    const result = results[0];
    process.stdout.write('\n'
      + ' phase       frames    instructions          ms     M/s\n'
      + ` decrunch    ${String(result.frames).padStart(6)}  `
      + `${integer(result.instructions).padStart(14)}  `
      + `${result.milliseconds.toFixed(1).padStart(10)}  `
      + `${rate(result.instructions, result.milliseconds).toFixed(1).padStart(6)}\n`);
  }
  for (const result of results) {
    if (result.budgetHit) {
      process.stdout.write(
        `warning: ${result.engine} did not reach TBL1 within the `
        + `${integer(opts.budget)} instruction budget\n`);
    }
  }
  return 0;
}

function averageRuns(runs) {
  const first = runs[0];
  for (const run of runs) {
    if (run.fingerprint !== first.fingerprint) {
      throw new Error(`non-deterministic ${first.engine} architectural fingerprint`);
    }
  }
  const rows = first.rows.map((row, index) => {
    const peers = runs.map((run) => run.rows[index]);
    for (const peer of peers) {
      if (!peer || peer.order !== row.order || peer.occurrence !== row.occurrence
          || peer.instructions !== row.instructions || peer.frames !== row.frames) {
        throw new Error(`non-deterministic ${first.engine} result at order ${row.order}`);
      }
    }
    return {
      ...row,
      milliseconds: peers.reduce((sum, peer) => sum + peer.milliseconds, 0) / peers.length,
    };
  });
  return { ...first, rows };
}

const orderLabel = (row) => `${String(row.order).padStart(3)}`
  + (row.occurrence ? `#${row.occurrence}` : '  ');

function printSingle(result, player) {
  process.stdout.write(`\n${result.engine.toUpperCase()}\n`
    + ' order  pat  frames    instructions      ms     M/s\n');
  for (const row of result.rows) {
    process.stdout.write(
      ` ${orderLabel(row)}  ${String(row.pattern).padStart(3)}  `
      + `${String(row.frames).padStart(6)}  ${integer(row.instructions).padStart(14)}  `
      + `${row.milliseconds.toFixed(1).padStart(7)}  `
      + `${rate(row.instructions, row.milliseconds).toFixed(1).padStart(6)}\n`);
  }
  const instructions = result.rows.reduce((sum, row) => sum + row.instructions, 0);
  const ms = result.rows.reduce((sum, row) => sum + row.milliseconds, 0);
  process.stdout.write(
    ` total            ${integer(instructions).padStart(14)}  ${ms.toFixed(1).padStart(7)}  `
    + `${rate(instructions, ms).toFixed(1).padStart(6)}\n`
    + ` tracker: ${player.songLength} orders, ${player.totalRows} nominal rows\n`);
}

function printComparison(cpu, jit, player) {
  if (cpu.fingerprint !== jit.fingerprint) {
    throw new Error('CPU/JIT architectural fingerprints differ after the benchmark range');
  }
  if (cpu.rows.length !== jit.rows.length) {
    throw new Error(`CPU produced ${cpu.rows.length} order windows, JIT produced ${jit.rows.length}`);
  }
  process.stdout.write('\n'
    + ' order  pat  frames    instructions   CPU M/s   JIT M/s  speedup\n');
  for (let i = 0; i < cpu.rows.length; i++) {
    const a = cpu.rows[i];
    const b = jit.rows[i];
    if (a.order !== b.order || a.occurrence !== b.occurrence
        || a.pattern !== b.pattern || a.instructions !== b.instructions || a.frames !== b.frames) {
      throw new Error(`CPU/JIT order window differs at result ${i}`);
    }
    const ar = rate(a.instructions, a.milliseconds);
    const br = rate(b.instructions, b.milliseconds);
    process.stdout.write(
      ` ${orderLabel(a)}  ${String(a.pattern).padStart(3)}  `
      + `${String(a.frames).padStart(6)}  ${integer(a.instructions).padStart(14)}  `
      + `${ar.toFixed(1).padStart(8)}  ${br.toFixed(1).padStart(8)}  `
      + `${(br / ar).toFixed(2).padStart(7)}x\n`);
  }
  const ins = cpu.rows.reduce((sum, row) => sum + row.instructions, 0);
  const cpuMs = cpu.rows.reduce((sum, row) => sum + row.milliseconds, 0);
  const jitMs = jit.rows.reduce((sum, row) => sum + row.milliseconds, 0);
  process.stdout.write(
    ` total            ${integer(ins).padStart(14)}  `
    + `${rate(ins, cpuMs).toFixed(1).padStart(8)}  ${rate(ins, jitMs).toFixed(1).padStart(8)}  `
    + `${(cpuMs / jitMs).toFixed(2).padStart(7)}x\n`
    + ` tracker: ${player.songLength} orders, ${player.totalRows} nominal rows\n`);
}

function writeOrderCsv(results, requested, music, player) {
  const file = resolve(requested);
  const cpu = results.find((result) => result.engine === 'cpu') ?? null;
  const jit = results.find((result) => result.engine === 'jit') ?? null;
  const primary = jit ?? cpu;
  const key = (row) => `${row.order}:${row.occurrence}`;
  const cpuRows = new Map((cpu?.rows ?? []).map((row) => [key(row), row]));
  const jitRows = new Map((jit?.rows ?? []).map((row) => [key(row), row]));
  const measured = primary.rows.map((row) => {
    const c = cpuRows.get(key(row)) ?? null;
    const j = jitRows.get(key(row)) ?? null;
    const cpuRate = c === null ? null : rate(c.instructions, c.milliseconds);
    const jitRate = j === null ? null : rate(j.instructions, j.milliseconds);
    return { row, c, j, cpuRate, jitRate, primaryRate: jitRate ?? cpuRate };
  });
  const fastest = Math.max(...measured.map((x) => x.primaryRate));
  const ranks = new Map(
    [...measured].sort((a, b) => b.primaryRate - a.primaryRate)
      .map((x, i) => [key(x.row), i + 1]),
  );
  const number = (value, digits) => value === null ? '' : value.toFixed(digits);
  const text = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const lines = [
    'music,music_title,order,occurrence,pattern,frames,instructions,'
      + 'cpu_ms,cpu_mips,jit_ms,jit_mips,'
      + 'jit_speedup,rank,deficit_from_fastest_mips,pct_of_fastest',
  ];
  for (const x of measured) {
    const { row, c, j, cpuRate, jitRate, primaryRate } = x;
    lines.push([
      music, text(player.title), row.order, row.occurrence, row.pattern, row.frames,
      row.instructions,
      number(c?.milliseconds ?? null, 3), number(cpuRate, 3),
      number(j?.milliseconds ?? null, 3), number(jitRate, 3),
      number(cpuRate !== null && jitRate !== null ? jitRate / cpuRate : null, 4),
      ranks.get(key(row)), number(fastest - primaryRate, 3),
      number(100 * primaryRate / fastest, 2),
    ].join(','));
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  process.stdout.write(`Wrote order performance CSV ${file}\n`);
}

export function benchmarkIxa(ixaPath, args = []) {
  if (!ixaPath) throw new Error('bench needs an .ixa path');
  const opts = parseOptions(args);
  const bytes = new Uint8Array(readFileSync(ixaPath));
  if (opts.phase === 'decrunch') return benchmarkDecrunch(bytes, opts);

  const hash = sha256(bytes);
  const firstFile = checkpointPath(ixaPath, hash, opts.checkpoint);

  let firstCheckpoint;
  if (opts.rebuild || !existsSync(firstFile)) {
    firstCheckpoint = prepareCheckpoint(ixaPath, bytes, hash, firstFile, opts.budget);
  } else {
    firstCheckpoint = loadCheckpoint(firstFile, hash);
    process.stdout.write(
      `Loaded ${firstCheckpoint.input.demoname.trim()} post-decrunch checkpoint `
      + `${firstFile} (${mib(statSync(firstFile).size)})\n`);
  }

  const musicIndex = opts.music - 1;
  const checkpoint = ensureMusicCheckpoint(
    firstCheckpoint, firstFile, hash, musicIndex, opts);
  const file = musicCheckpointPath(firstFile, musicIndex);
  if (opts.prepareOnly && opts.prepareOrder === null) return 0;
  const player = restorePlayer(checkpoint);
  process.stdout.write(
    `Selected XM ${opts.music}: ${JSON.stringify(player.title || '(untitled)')}, `
    + `${player.songLength} orders, ${player.totalRows} nominal rows\n`);
  const originState = checkpointStateHash(checkpoint);
  if (opts.prepareOrder !== null) {
    if (opts.prepareOrder >= player.songLength) {
      throw new Error(
        `requested order ${opts.prepareOrder}, but the module has ${player.songLength} orders`);
    }
    ensureOrderCheckpoint(
      checkpoint, file, hash, originState, opts.prepareOrder, opts);
    return 0;
  }

  if (opts.orders !== null) {
    const invalid = opts.orders.find((order) => order >= player.songLength);
    if (invalid !== undefined) {
      throw new Error(`requested order ${invalid}, but the module has ${player.songLength} orders`);
    }
  }
  opts.to = Math.min(opts.to, player.songLength);
  if (opts.orders === null && opts.from >= opts.to) {
    throw new Error(`requested order ${opts.from}, but the module has ${player.songLength} orders`);
  }

  const checkpoints = new Map();
  if (opts.orders !== null) {
    for (const order of opts.orders) {
      checkpoints.set(
        order,
        ensureOrderCheckpoint(checkpoint, file, hash, originState, order, opts),
      );
    }
    process.stdout.write(
      `Benchmarking isolated orders ${opts.orders.join(',')}, ${opts.repeat} run(s), `
      + `exact order-start snapshots, cold engine caches, exact XM clock without audio mixing\n`);
  } else {
    checkpoints.set(
      opts.from,
      ensureOrderCheckpoint(checkpoint, file, hash, originState, opts.from, opts),
    );
    process.stdout.write(
      `Benchmarking orders ${opts.from}..${opts.to - 1}, ${opts.repeat} run(s), `
      + `exact order-${opts.from} start snapshot, cold engine caches, `
      + `exact XM clock without audio mixing\n`);
  }

  const engines = opts.engine === 'both'
    ? [['cpu', CPU], ['jit', JitCPU]]
    : [[opts.engine, opts.engine === 'cpu' ? CPU : JitCPU]];
  const results = [];
  for (const [name, Engine] of engines) {
    const runs = [];
    for (let i = 0; i < opts.repeat; i++) {
      process.stdout.write(`  ${name} ${i + 1}/${opts.repeat}...\n`);
      runs.push(opts.orders === null
        ? runOrders(checkpoints.get(opts.from), Engine, name, opts)
        : runSelectedOrders(checkpoints, Engine, name, opts));
    }
    results.push(averageRuns(runs));
  }

  if (results.length === 2) {
    const cpu = results.find((result) => result.engine === 'cpu');
    const jit = results.find((result) => result.engine === 'jit');
    printComparison(cpu, jit, player);
  } else {
    printSingle(results[0], player);
  }
  if (opts.csv !== null) writeOrderCsv(results, opts.csv, opts.music, player);
  for (const result of results) {
    if (result.budgetHit) {
      if (opts.orders !== null) {
        process.stdout.write(
          `warning: ${result.engine} hit the per-order ${integer(opts.budget)} instruction `
          + `budget for selected order(s) ${result.budgetOrders.join(',')}\n`);
      } else {
        process.stdout.write(
          `warning: ${result.engine} hit the ${integer(opts.budget)} instruction budget at `
          + `${result.finalOrder}:${result.finalRow}\n`);
      }
    } else if (result.halted) {
      const where = opts.orders !== null
        ? `selected order(s) ${result.haltedOrders.join(',')}`
        : `${result.finalOrder}:${result.finalRow}`;
      process.stdout.write(
        `note: ${result.engine} halted at ${where}: ${result.haltReason}\n`);
    }
  }
  return 0;
}
