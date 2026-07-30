#!/usr/bin/env node
/* Exercise the SDK with the incomplete gfxmodeinfo shape used by a surviving
 * native driver: RGB masks, pitch and resolution are valid, tcbitmode is 0. */

import { readFileSync } from 'node:fs';
import { JitCPU } from '../../../lib/jit.js';
import { readIxa } from '../../../lib/ixa.js';
import { GFX, Machine } from '../../../lib/machine.js';
import { Sequencer } from '../../../lib/sequencer.js';

class MissingBitmodeMachine extends Machine {
  setVideoResolution(width, height) {
    super.setVideoResolution(width, height);
    this.mem.setUint8(this.gfx + GFX.tcbitmode, 0);
  }
}

const bytes = new Uint8Array(readFileSync(new URL('legacy-video.ixa', import.meta.url)));
const { demoname } = readIxa(bytes);
const machine = new MissingBitmodeMachine({ clock: 'virtual' });
const seq = new Sequencer({
  bytes,
  machine,
  budget: 100_000_000,
  makeCpu() {
    const cpu = new JitCPU(machine);
    cpu.retainTrampolineHits = false;
    return cpu;
  },
});

await seq.run();
if (!seq.done || seq.error) {
  throw new Error(`legacy video guest did not complete: ${seq.error ?? 'instruction budget'}`);
}
if (machine.frames !== 1) {
  throw new Error(`legacy video guest presented ${machine.frames} frames, expected 1`);
}

/* ixa_present centres the 2x1 canvas in the 320x200 host mode. */
const first = machine.fb + (99 * 320 + 159) * 2;
const red = machine.mem.getUint16(first, true);
const green = machine.mem.getUint16(first + 2, true);
if (red !== 0xf800 || green !== 0x07e0) {
  throw new Error(
    `missing-tcbitmode inference produced 0x${red.toString(16)},0x${green.toString(16)} `
    + 'instead of RGB565 red/green',
  );
}

process.stdout.write(
  `legacy gfxmode: tcbitmode=0 inferred as RGB565; ${machine.frames} frame verified\n`,
);
