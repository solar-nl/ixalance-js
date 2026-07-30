#!/usr/bin/env node
// Accelerated whole-production smoke test. A 10 Hz virtual display preserves
// Square's tick-based animation while reaching every music-gated part in about
// a minute on a contemporary machine.

import { readFileSync } from 'node:fs';
import { readIxa } from '../../../../lib/ixa.js';
import { Machine, partmemFor } from '../../../../lib/machine.js';
import { Sequencer } from '../../../../lib/sequencer.js';
import { JitCPU } from '../../../../lib/jit.js';

const bytes = new Uint8Array(readFileSync(new URL('square.ixa', import.meta.url)));
const { demoname } = readIxa(bytes);
const machine = new Machine({
  clock: 'virtual',
  fps: 10,
  partmem: partmemFor(demoname),
  onDebug(message) {
    if (message.startsWith('fardoint') || message.startsWith('XM:')) {
      process.stdout.write(`${message}\n`);
    }
  },
});
const seq = new Sequencer({
  bytes,
  machine,
  budget: 30_000_000_000,
  makeCpu() {
    const cpu = new JitCPU(machine);
    cpu.retainTrampolineHits = false;
    return cpu;
  },
});

const started = Date.now();
await seq.run();
const result = {
  done: seq.done,
  error: seq.error,
  instructions: seq.executed,
  frames: machine.frames,
  music: [machine.musicPos, machine.musicRow],
  seconds: (Date.now() - started) / 1000,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!seq.done || seq.error) process.exitCode = 1;
