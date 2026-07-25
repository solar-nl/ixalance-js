// The interpreter runs in a worker so the page stays responsive. A 64K intro spends
// billions of instructions generating its graphics before it draws anything, which on
// the main thread would simply look like a hung tab.

import { readIxa, unpackBlock, parseScript, classify } from './lib/ixa.js';
import { Machine, partmemFor } from './lib/machine.js';
import { CPU, Unimplemented, Fault } from './lib/cpu.js';

// Instructions per slice. The worker yields between slices so that pause and stop
// messages are seen promptly; ~4M is around a tenth of a second.
const SLICE = 4_000_000;

let machine, cpu;
let running = false, stopped = false;

const post = (type, data = {}) => self.postMessage({ type, ...data });
const log = (text, cls) => post('log', { text, cls });
const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));

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
  cpu.reset(loaded);
  log('running — the intro generates all its graphics first, so expect a decrunch bar '
      + 'for a while before anything else happens', 'warn');
}

async function loop() {
  let lastReport = 0, lastCount = 0, lastMs = Date.now();
  while (!stopped && !cpu.halted) {
    if (!running) { await yieldToLoop(); lastMs = Date.now(); lastCount = cpu.count; continue; }

    try {
      cpu.run(SLICE);
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

    const now = Date.now();
    if (now - lastReport > 400) {
      const rate = (cpu.count - lastCount) / ((now - lastMs) / 1000);
      post('stat', {
        count: cpu.count, frames: machine.frames,
        calls: cpu.trampolineHits.length, rate,
      });
      lastReport = now; lastCount = cpu.count; lastMs = now;
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
