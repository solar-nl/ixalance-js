// The interpreter runs in a worker so the page stays responsive. A 64K intro spends
// billions of instructions generating its graphics before it draws anything, which on
// the main thread would simply look like a hung tab.

import { readIxa, parseScript } from './lib/ixa.js';
import { Machine, partmemFor } from './lib/machine.js';
import { Sequencer } from './lib/sequencer.js';
import { CPU, Unimplemented, Fault } from './lib/cpu.js';
import { JitCPU } from './lib/jit.js';

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

let machine, seq;
let running = false, stopped = false;
let slice = 1_000_000;
let frameOutstanding = false;
let recycledFrame = null;

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

async function boot({ url, clock, fps, engine }) {
  log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const { demoname, entries } = readIxa(bytes);
  const script = bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size);
  const ops = parseScript(script);
  log(`${demoname.trim()}: ${entries.length} blocks`);
  log(`script: ${ops.map((o) => o.name + (o.args.length ? `(${o.args})` : '')).join(' ')}`);

  // farmalloc(0) is not an allocation, it is the demo's yield-to-host idiom, and a
  // music-gated part makes tens of millions of them: Astral's block 1 alone polls it
  // ~11,000 times a second. One line each would append DOM nodes faster than the page can
  // retire them, so say it once and let the host-call counter carry the rest. Every other
  // host message — real allocations, TBL requests, the module handover — still comes out.
  let yields = 0;

  machine = new Machine({
    partmem: partmemFor(demoname),
    clock, fps,
    onDebug: (m) => {
      if (m.startsWith('farmalloc(0)')) {
        if (yields++ === 0) log('  host: farmalloc(0) — the part is polling the music '
                                + 'position; not logging the rest');
        return;
      }
      log(`  host: ${m}`);
    },
    // Both music paths end up here: a 64K intro generates its module in memory and hands
    // it over via fardoint 'TBL1', and the script's `music` opcode copies a stored block
    // in and starts it the same way. Either way this is the page's only source of audio.
    onMusic: (xm) => {
      const copy = xm.slice();
      self.postMessage({ type: 'music', xm: copy.buffer }, [copy.buffer]);
    },
    onFrame: (fb, w, h) => {
      // The main thread can present at most one frame per animation frame. Do not convert
      // and enqueue frames behind one it has not drawn yet; the emulated draw still
      // completed and its clock/frame counter still advances. Once drawn, the RGBA buffer
      // is transferred back and reused, avoiding a fresh allocation on every demo frame.
      if (frameOutstanding) return;
      const bytes = w * h * 4;
      const out = recycledFrame?.byteLength === bytes
        ? recycledFrame
        : new Uint8ClampedArray(bytes);
      recycledFrame = null;
      const words = new Uint32Array(out.buffer);
      for (let i = 0, n = w * h; i < n; i++) {
        const v = fb[i * 2] | (fb[i * 2 + 1] << 8);
        words[i] = 0xff000000 | ((v & 31) << 19) | (((v >> 5) & 63) << 10) | (((v >> 11) & 31) << 3);
      }
      frameOutstanding = true;
      self.postMessage({ type: 'frame', pixels: out, width: w, height: h }, [out.buffer]);
    },
  });

  // The JIT is the production engine. An explicit `cpu` keeps the interpreter available as
  // the oracle for comparisons, including callers older than this page.
  const selectedEngine = engine ?? globalThis.process?.env?.IXA_ENGINE ?? 'jit';
  const wantJit = selectedEngine !== 'cpu';

  // The script owns the demo, not one block: `pop` is what runs a part, so Astral Blur's
  // eleven parts come off the stack in reverse push order with pictures and a module
  // interleaved. A 64K intro's `exe(1) pop` collapses to what this used to do inline.
  seq = new Sequencer({
    bytes, machine,
    // A fresh interpreter per part, none of them keeping a trampoline log: nothing here
    // inspects individual host calls, only how many there were, and a part that polls
    // farmalloc() to yield would grow the list by tens of millions of records a minute.
    makeCpu: () => {
      const c = wantJit ? new JitCPU(machine) : new CPU(machine);
      c.retainTrampolineHits = false;
      return c;
    },
    onOp: (o) => log(`script[${o.index}] ${o.name}(${o.args.join(',')})`),
    // An exe pop only reports back once the part has far-returned, which for Astral is
    // minutes of frames later — so this phase is "finished", and the loop announces the
    // part that a pop *started* from what step() hands back.
    onPart: (p) => log(p.kind === 'exe' && p.phase === 'pop'
      ? `  exe ${p.block} returned to host`
      : `  ${p.phase} ${p.kind} ${p.block}`),
  });
  log('running — the parts are loaded first and run in reverse, and a 64K intro generates '
      + 'all its graphics before it draws, so expect a decrunch bar for a while before '
      + 'anything else happens', 'warn');
}

async function loop() {
  let lastReport = 0, lastCount = 0, lastMs = Date.now();
  let livePart = null;                 // the block a `pop` is currently running, if any
  // Where the demo's timeline and the wall clock were last agreed to line up. Only the
  // virtual clock needs this: under 'wall' the demo reads real time itself and paces on
  // its own, so throttling it here would only make it miss its own deadlines.
  const paced = machine.clock === 'virtual';
  let paceReal = performance.now(), paceVirtual = machine.virtualMs;

  while (!stopped && !seq.done) {
    if (!running) {
      await yieldToLoop();
      lastMs = Date.now(); lastCount = seq.executed;
      paceReal = performance.now(); paceVirtual = machine.virtualMs;   // paused time is not owed
      continue;
    }

    const sliceStart = performance.now();
    try {
      // One bounded unit: a slice of the running part, one WaitMusic iteration, or one
      // script opcode. It never blocks, so pacing and message delivery stay this loop's.
      const r = seq.step(slice);
      // Which part a `pop` dispatched, said at the moment it starts rather than when it
      // ends: otherwise the log stops at `pop()` for however long the part runs.
      if (r.state === 'part' && r.block !== livePart) log(`  pop exe ${(livePart = r.block)}`);
      else if (r.state !== 'part') livePart = null;
    } catch (e) {
      if (e instanceof Unimplemented || e instanceof Fault) {
        log(`${e.name}: ${e.message}`, 'err');
        // e.count is the failing part's own count, which restarts at every pop; the
        // sequencer's total is the number that means anything across a script.
        log(`  at eip 0x${e.eip.toString(16)} after ${seq.executed.toLocaleString()} instructions`, 'err');
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
      // Everything reported here has to be cumulative over the whole script: each part
      // gets its own CPU and cpu.reset() zeroes its count, so counting the live CPU alone
      // would step backwards at every part boundary and show a negative rate.
      const rate = (seq.executed - lastCount) / ((now - lastMs) / 1000);
      post('stat', {
        count: seq.executed, frames: machine.frames,
        calls: seq.trampolines + (seq.cpu?.trampolineCount ?? 0), rate,
      });
      lastReport = now; lastCount = seq.executed; lastMs = now;
    }

    // The virtual clock advances a fixed step per presented frame, plus whatever the
    // sequencer adds for a drawless slice or a WaitMusic iteration, so the demo runs at
    // whatever rate the interpreter manages — too slow before, and too fast once it is
    // quick enough. Hold it to real time by sleeping off whatever it is ahead.
    // Sleeping cannot perturb the instruction stream, since no clock the demo can read
    // moves while the worker is idle.
    if (paced) {
      const ahead = (machine.virtualMs - paceVirtual) - (performance.now() - paceReal);
      if (ahead > PACE_SLACK_MS) await sleep(ahead);
      else if (ahead < -PACE_MAX_LAG_MS) { paceReal = performance.now(); paceVirtual = machine.virtualMs; }
    }
    await yieldToLoop();
  }
  // Only the script running out ends the demo. A part far-returning to the host halts its
  // own CPU, which used to be the end of everything and is now just the end of a part —
  // for Astral that happens eleven times before there is anything to say here.
  if (seq.done) {
    log(seq.error ? `stopped: ${seq.error}` : 'script complete');
    post('stopped', { reason: seq.error ?? 'script complete' });
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
    // BreakPart (d32load.c:247-255): the demo is abandoned mid-part, so tell the sequencer
    // to drop it and free its part memory rather than leaving a live CPU behind. The page
    // normally terminates the worker straight after, which this does not depend on.
    if (machine) machine.escaped = true;
  } else if (msg.cmd === 'position') {
    // Where the audio player actually is. Once this arrives the machine stops
    // approximating the position from the module's tempo.
    machine?.setMusicPosition(msg.pos, msg.row);
  } else if (msg.cmd === 'frame-consumed') {
    // putImageData() has synchronously copied the pixels, so ownership can return here and
    // the same storage can be filled for the next deliverable frame.
    recycledFrame = new Uint8ClampedArray(msg.buffer);
    frameOutstanding = false;
  }
};
