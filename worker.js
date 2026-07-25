// The interpreter runs in a worker so the page stays responsive. A 64K intro spends
// billions of instructions generating its graphics before it draws anything, which on
// the main thread would simply look like a hung tab.

import { readIxa, unpackBlock, parseScript, classify } from './lib/ixa.js';
import { Machine, partmemFor } from './lib/machine.js';
import { CPU, Unimplemented, Fault } from './lib/cpu.js';

// How long a slice should take, not how many instructions it should be. A fixed count
// was ~90 ms once the interpreter got fast, which is both a visible pause before a stop
// message is seen and far coarser than the frame it has to land a pace on. The count is
// re-derived from the measured rate after every slice and clamped in case a slice lands
// inside something pathological.
const SLICE_MS = 4;
const SLICE_MIN = 64_000, SLICE_MAX = 64_000_000;

// Pacing tolerances, virtual clock only. Sleep only when far enough ahead that a sleep is
// worth its own overhead, and forget a deficit larger than this: the intro spends billions
// of instructions presenting nothing, and that debt must not cash out as a burst of
// unthrottled frames the moment it starts drawing.
const PACE_SLACK_MS = 2, PACE_MAX_LAG_MS = 250;

let machine, cpu;
let running = false, stopped = false;
let slice = 1_000_000;

const post = (type, data = {}) => self.postMessage({ type, ...data });
const log = (text, cls) => post('log', { text, cls });

// setTimeout(0) is clamped to 4 ms once it nests five deep, which at a 4 ms slice would
// halve throughput outright. A MessageChannel round trip is a real task — so messages
// queued against the worker are still delivered before it resumes — but is not clamped.
const hop = new MessageChannel();
let onHop = null;
hop.port1.onmessage = () => { const r = onHop; onHop = null; if (r) r(); };
const yieldToLoop = () => new Promise((r) => { onHop = r; hop.port2.postMessage(0); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot({ url, clock, fps }) {
  log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const { demoname, entries } = readIxa(bytes);
  const script = bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size);
  const ops = parseScript(script);
  const kinds = classify(ops, entries.length);
  log(`${demoname.trim()}: ${entries.length} blocks`);
  log(`script: ${ops.map((o) => o.name + (o.args.length ? `(${o.args})` : '')).join(' ')}`);

  machine = new Machine({
    partmem: partmemFor(demoname),
    clock, fps,
    onDebug: (m) => log(`  host: ${m}`),
    // The demo generates its module in memory and hands it over via fardoint 'TBL1'.
    onMusic: (xm) => {
      const copy = xm.slice();
      self.postMessage({ type: 'music', xm: copy.buffer }, [copy.buffer]);
    },
    onFrame: (fb, w, h) => {
      const out = new Uint8ClampedArray(w * h * 4);
      const words = new Uint32Array(out.buffer);
      for (let i = 0, n = w * h; i < n; i++) {
        const v = fb[i * 2] | (fb[i * 2 + 1] << 8);
        words[i] = 0xff000000 | ((v & 31) << 19) | (((v >> 5) & 63) << 10) | (((v >> 11) & 31) << 3);
      }
      self.postMessage({ type: 'frame', pixels: out, width: w, height: h }, [out.buffer]);
    },
  });

  const block = ops.find((o) => o.name === 'exe')?.args[0];
  if (block === undefined) throw new Error('script has no exe block to run');
  log(`unpacking block ${block} (${kinds[block]})`);
  const loaded = machine.loadExe(unpackBlock(bytes, entries[block]));
  log(`image ${loaded.d32.exesize} bytes at 0x${loaded.base.toString(16)}, `
      + `entry 0x${loaded.entry.toString(16)}`);
  log(`fixups: ${loaded.relocs.address} address + ${loaded.relocs.segment} segment`);

  cpu = new CPU(machine);
  // Nothing here inspects individual host calls, only how many there were, and a demo
  // that polls farmalloc() would grow the log by tens of millions of records a minute.
  cpu.retainTrampolineHits = false;
  cpu.reset(loaded);
  log('running — the intro generates all its graphics first, so expect a decrunch bar '
      + 'for a while before anything else happens', 'warn');
}

async function loop() {
  let lastReport = 0, lastCount = 0, lastMs = Date.now();
  // Where the demo's timeline and the wall clock were last agreed to line up. Only the
  // virtual clock needs this: under 'wall' the demo reads real time itself and paces on
  // its own, so throttling it here would only make it miss its own deadlines.
  const paced = machine.clock === 'virtual';
  let paceReal = performance.now(), paceVirtual = machine.virtualMs;

  while (!stopped && !cpu.halted) {
    if (!running) {
      await yieldToLoop();
      lastMs = Date.now(); lastCount = cpu.count;
      paceReal = performance.now(); paceVirtual = machine.virtualMs;   // paused time is not owed
      continue;
    }

    const sliceStart = performance.now();
    try {
      cpu.run(slice);
    } catch (e) {
      if (e instanceof Unimplemented || e instanceof Fault) {
        log(`${e.name}: ${e.message}`, 'err');
        log(`  at eip 0x${e.eip.toString(16)} after ${e.count.toLocaleString()} instructions`, 'err');
        log(`  bytes: ${e.bytes}`, 'err');
        post('stopped', { reason: e.message });
      } else {
        log(String(e && e.stack ? e.stack : e), 'err');
        post('stopped', { reason: String(e) });
      }
      return;
    }

    // Re-aim the next slice at SLICE_MS. Fixed instruction counts drift by an order of
    // magnitude between the intro's setup phase and its inner loops.
    const took = performance.now() - sliceStart;
    if (took > 0.1) {
      const want = slice * (SLICE_MS / took);
      slice = Math.max(SLICE_MIN, Math.min(SLICE_MAX, Math.round(slice * 0.75 + want * 0.25)));
    }

    const now = Date.now();
    if (now - lastReport > 400) {
      const rate = (cpu.count - lastCount) / ((now - lastMs) / 1000);
      post('stat', {
        count: cpu.count, frames: machine.frames,
        calls: cpu.trampolineCount, rate,
      });
      lastReport = now; lastCount = cpu.count; lastMs = now;
    }

    // The virtual clock advances a fixed step per presented frame and nothing else, so the
    // demo runs at whatever rate the interpreter manages — too slow before, and too fast
    // once it is quick enough. Hold it to real time by sleeping off whatever it is ahead.
    // Sleeping cannot perturb the instruction stream, since no clock the demo can read
    // moves while the worker is idle.
    if (paced) {
      const ahead = (machine.virtualMs - paceVirtual) - (performance.now() - paceReal);
      if (ahead > PACE_SLACK_MS) await sleep(ahead);
      else if (ahead < -PACE_MAX_LAG_MS) { paceReal = performance.now(); paceVirtual = machine.virtualMs; }
    }
    await yieldToLoop();
  }
  if (cpu.halted) {
    log(`halted: ${cpu.haltReason}`);
    post('stopped', { reason: cpu.haltReason });
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.cmd === 'start') {
    try {
      await boot(msg);
    } catch (e) {
      log(String(e.message ?? e), 'err');
      post('stopped', { reason: String(e.message ?? e) });
      return;
    }
    running = true; stopped = false;
    post('started');
    loop();
  } else if (msg.cmd === 'pause') {
    running = false;
  } else if (msg.cmd === 'resume') {
    running = true;
  } else if (msg.cmd === 'stop') {
    stopped = true;
  } else if (msg.cmd === 'position') {
    // Where the audio player actually is. Once this arrives the machine stops
    // approximating the position from the module's tempo.
    machine?.setMusicPosition(msg.pos, msg.row);
  }
};
