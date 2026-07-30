// The interpreter runs in a worker so the page stays responsive. A 64K intro spends
// billions of instructions generating its graphics before it draws anything, which on
// the main thread would simply look like a hung tab.

import { readIxa, parseScript } from './lib/ixa.js';
// The query is deliberate: a long-lived demo tab could otherwise construct a new worker
// while retaining the pre-shared-herzcount machine module from its HTTP cache.
import {
  Machine, MACHINE_REVISION, partmemFor,
} from './lib/machine.js?v=pandora-deploy-v26';
import { Sequencer } from './lib/sequencer.js';
import { CPU, FPU_REVISION, Unimplemented, Fault } from './lib/cpu.js';
import { JitCPU, JIT_REVISION } from './lib/jit.js';
import { pandoraProfile } from './lib/pandora.js';
import { TextureWatcher, summariseSamples } from './lib/debug-capture.js';

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
// Debug view state. All of it stays null unless the page asked for it, so the observation
// path costs nothing at all when the panel is closed.
// debugEnabled gates the module summary, which any production with music can provide;
// debugProfile gates the texture watcher, which only the two intros with recovered slot
// tables can. Astral Blur has a stored module and no generated textures, so it gets one
// panel and not the other rather than nothing at all.
let debugEnabled = false, debugProvenance = false, debugProfile = null, textures = null;

const post = (type, data = {}) => self.postMessage({ type, ...data });
const log = (text, cls) => post('log', { text, cls });
const postTextureShots = (shots) => {
  for (const shot of shots ?? []) {
    const transfer = [shot.pixels.buffer];
    for (const source of shot.sources ?? []) {
      if (source.preview?.pixels) transfer.push(source.preview.pixels.buffer);
    }
    self.postMessage({ type: 'debug-texture', ...shot }, transfer);
  }
};
const postScene = (scene) => {
  if (scene === null) return;
  const transfer = [];
  for (const source of scene.sources ?? []) {
    if (source.preview?.pixels) transfer.push(source.preview.pixels.buffer);
  }
  for (const mesh of scene.meshes ?? []) {
    if (mesh.preview?.pixels) transfer.push(mesh.preview.pixels.buffer);
  }
  self.postMessage({ type: 'debug-scene', ...scene }, transfer);
};

// setTimeout(0) is clamped to 4 ms once it nests five deep, which at a 4 ms slice would
// halve throughput outright. A MessageChannel round trip is a real task — so messages
// queued against the worker are still delivered before it resumes — but is not clamped.
const hop = new MessageChannel();
let onHop = null;
hop.port1.onmessage = () => { const r = onHop; onHop = null; if (r) r(); };
const yieldToLoop = () => new Promise((r) => { onHop = r; hop.port2.postMessage(0); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch an IXA as a stream so the page can show useful progress for multi-megabyte demos.
 * Content-Length is optional (and can disappear behind compression/proxies), so retain
 * chunks and report an indeterminate byte count when the server cannot provide a total.
 */
async function fetchIxa(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);

  const header = Number(res.headers.get('content-length'));
  const total = Number.isFinite(header) && header > 0 ? header : 0;
  post('download', { received: 0, total });

  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    post('download', { received: bytes.length, total: total || bytes.length, complete: true });
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0, lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const now = performance.now();
    if (now - lastReport >= 50) {
      post('download', { received, total });
      lastReport = now;
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  post('download', { received, total: total || received, complete: true });
  return bytes;
}

/**
 * SHA-256 of the container, or null where the browser will not provide one.
 *
 * The Pandora tables are offsets into one exact build, so the digest is what proves the
 * profile belongs to the file being run. SubtleCrypto requires a secure context, which a
 * page served over plain HTTP from a LAN address does not have — there the profile is
 * still selected by name and the panel says it is unverified.
 */
async function containerDigest(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function boot({ url, clock, fps, engine, debug, provenance = false }) {
  log(`fetching ${url}`);
  const bytes = await fetchIxa(url);
  log(`downloaded ${(bytes.length / 1048576).toFixed(1)} MiB`);

  const { demoname, entries } = readIxa(bytes);
  const script = bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size);
  const ops = parseScript(script);
  log(`${demoname.trim()}: ${entries.length} blocks`);
  log(`script: ${ops.map((o) => o.name + (o.args.length ? `(${o.args})` : '')).join(' ')}`);

  // Only the two single-part 64K intros have recovered texture tables; Astral Blur loads
  // its graphics from the container and has nothing to watch being generated.
  if (debug) {
    debugEnabled = true;
    debugProvenance = provenance === true;
    try {
      const digest = await containerDigest(bytes);
      debugProfile = pandoraProfile(demoname, digest);
      post('debug-status', {
        available: true,
        production: debugProfile.production,
        slots: debugProfile.textures.length,
        verified: digest !== null,
        provenance: debugProvenance,
      });
      log(`Pandora: ${debugProfile.textures.length} recovered texture slots`
          + `${debugProvenance ? ' · experimental provenance enabled' : ''}`
          + `${digest === null ? ' (profile unverified — no SubtleCrypto)' : ''}`);
    } catch (e) {
      debugProfile = null;
      post('debug-status', {
        available: true,
        textures: false,
        provenance: debugProvenance,
        reason: String(e.message ?? e),
      });
      log(`Pandora: no recovered texture profile (${e.message ?? e})`
          + `${debugProvenance ? '; experimental framebuffer provenance remains enabled' : ''}`,
      'warn');
    }
  }

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
      const generation = machine.musicGeneration;
      // Pandora's CLI stops at this first TBL1 and takes every final-mode texture here.
      // Do the same before the part can reuse or offset those buffers during playback.
      if (textures !== null && generation === 1) {
        postTextureShots(textures.drain(seq?.executed ?? 0));
        postTextureShots(textures.captureDue(seq?.executed ?? 0));
        postTextureShots(textures.finalize(seq?.executed ?? 0));
      }
      // Describe the module before handing the bytes away: the summary is read from the
      // live view, and `copy.buffer` is detached by the transfer below.
      if (debugEnabled) {
        try {
          // Keep the compact waveform summaries, but audition from the module itself.
          // That lets the browser run the containing XI instrument through XmPlayer
          // instead of treating a looping physical sample as a raw Web Audio buffer.
          const { title, linearPeriods, samples } = summariseSamples(xm);
          const auditionXm = xm.slice();
          const transfer = [
            auditionXm.buffer,
            ...samples.map((sample) => sample.peaks.buffer),
          ];
          self.postMessage({
            type: 'debug-samples',
            generation, title, linearPeriods, samples,
            xm: auditionXm.buffer,
            bytes: xm.length,
            at: seq?.executed ?? 0,
          }, transfer);
        } catch (e) {
          log(`Pandora: could not summarise the generated module — ${e.message ?? e}`, 'warn');
        }
      }
      const copy = xm.slice();
      self.postMessage({ type: 'music', xm: copy.buffer, generation }, [copy.buffer]);
    },
    onFrame: (fb, w, h) => {
      // A real screen flip is the semantic boundary for the software renderer. Sampling
      // one in 25 keeps mesh inference out of the presentation hot path while still
      // following scene changes; memory dependencies continue accumulating every frame.
      if (debugProvenance && textures !== null && machine.frames % 25 === 0) {
        postScene(textures.scene(w, h, seq?.executed ?? 0));
      }
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
  log(`runtime: machine=${MACHINE_REVISION}, fpu=${FPU_REVISION}, jit=${JIT_REVISION}`);

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
  let lastReport = Date.now(), lastCount = 0, lastMs = lastReport;
  // Wall throughput includes the time deliberately slept to hold CopyScreen to the
  // requested display rate. Keep a second clock around the actual seq.step() calls so a
  // cheap scene that finishes early reports a high active rate and a low paced rate,
  // instead of looking like a JIT regression precisely because it has time to sleep.
  let activeCount = 0, activeMs = 0, lastFrames = machine.frames;
  let livePart = null;                 // the block a `pop` is currently running, if any
  // Where guest presentation and real time were last agreed to line up. With the virtual
  // clock, virtualMs is the whole demo timeline. With sound, the audio thread remains the
  // authority on music/time, but CopyScreen still has to behave like a display flip: the
  // original driver could not accept hundreds of flips per second. Letting it do so made
  // Astral reach the block-3 tunnel with ~9,600 total guest flips instead of a display-rate
  // count. Frame count is used only for wall-clock pacing; it never feeds back into mustime
  // or herzcount.
  const paceValue = () => machine.clock === 'virtual'
    ? machine.virtualMs
    : machine.frames * 1000 / machine.fps;
  let paceReal = performance.now(), paceGuest = paceValue();

  while (!stopped && !seq.done) {
    if (!running) {
      await yieldToLoop();
      lastMs = Date.now(); lastCount = seq.executed;
      activeCount = 0; activeMs = 0; lastFrames = machine.frames;
      paceReal = performance.now(); paceGuest = paceValue();          // paused time is not owed
      continue;
    }

    const beforeCount = seq.executed;
    const sliceStart = performance.now();
    let stepBudget = slice;
    const nextTextureCapture = textures?.nextCaptureAt(seq.executed);
    if (nextTextureCapture !== null && nextTextureCapture !== undefined) {
      stepBudget = Math.min(stepBudget, nextTextureCapture - seq.executed);
    }
    try {
      // One bounded unit: a slice of the running part, one WaitMusic iteration, or one
      // script opcode. It never blocks, so pacing and message delivery stay this loop's.
      const r = seq.step(stepBudget);
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
    activeCount += seq.executed - beforeCount;
    activeMs += took;
    if (took > 0.1) {
      const want = stepBudget * (SLICE_MS / took);
      slice = Math.max(SLICE_MIN, Math.min(SLICE_MAX, Math.round(slice * 0.75 + want * 0.25)));
    }

    // This is deliberately independent of the wall-clock debug poll. Exact scratch
    // images can survive for less than one adaptive CPU slice.
    if (textures !== null) {
      postTextureShots(textures.captureDue(seq.executed));
      postTextureShots(textures.drain(seq.executed));
    }

    const now = Date.now();
    if (now - lastReport > 400) {
      // Everything reported here has to be cumulative over the whole script: each part
      // gets its own CPU and cpu.reset() zeroes its count, so counting the live CPU alone
      // would step backwards at every part boundary and show a negative rate.
      const elapsed = (now - lastMs) / 1000;
      const wallRate = (seq.executed - lastCount) / elapsed;
      const rate = activeMs > 0 ? activeCount / (activeMs / 1000) : wallRate;
      post('stat', {
        count: seq.executed, frames: machine.frames,
        calls: seq.trampolines + (seq.cpu?.trampolineCount ?? 0),
        rate, wallRate, fps: (machine.frames - lastFrames) / elapsed,
        block: seq.part?.block ?? null,
        partCount: seq.cpu?.count ?? 0,
        eip: seq.cpu?.eip ?? 0,
        musicPos: machine.musicPos,
        musicRow: machine.musicRow,
      });
      lastReport = now; lastCount = seq.executed; lastMs = now;
      activeCount = 0; activeMs = 0; lastFrames = machine.frames;
    }

    // The texture tables are image-relative, so the watcher cannot exist until a `pop`
    // has relocated a part and started running it.
    if (debugEnabled && textures === null && seq.part?.loaded) {
      textures = new TextureWatcher({
        machine, profile: debugProfile, imageBase: seq.part.loaded.base,
        provenance: debugProvenance,
      });
    }
    if (debugProvenance && textures !== null && seq.cpu !== null) {
      textures.attachCpu(seq.cpu, seq.executed);
    }

    // Hold guest presentation to real time by sleeping off whatever it is ahead. Under
    // the virtual clock this paces the whole emulated timeline. Under the wall clock it
    // caps only screen flips; setup and drawless work still run flat out and music remains
    // driven by the audio thread. A slow engine is never asked to repay missed frames.
    const ahead = (paceValue() - paceGuest) - (performance.now() - paceReal);
    if (ahead > PACE_SLACK_MS) await sleep(ahead);
    else if (ahead < -PACE_MAX_LAG_MS) {
      paceReal = performance.now();
      paceGuest = paceValue();
    }
    await yieldToLoop();
  }
  textures?.detachCpu();
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
    // Where the audio player actually is. A report queued by XM 1 can arrive after XM 2's
    // synchronous TBL1 reset, so accept positions only from the currently active module.
    machine?.setMusicPosition(msg.pos, msg.row, msg.generation);
  } else if (msg.cmd === 'frame-consumed') {
    // putImageData() has synchronously copied the pixels, so ownership can return here and
    // the same storage can be filled for the next deliverable frame.
    recycledFrame = new Uint8ClampedArray(msg.buffer);
    frameOutstanding = false;
  }
};
