// Headless harness. Runs the same lib/ modules the browser page uses, so the container,
// codecs, CPU and replayer can all be exercised and regression-checked without a browser.
//
//   node run.mjs verify                        check codecs against data/reference.json
//   node run.mjs run <file.ixa> [block] [budget] [framedir]
//       with no block the script drives: every part, in the order the demo asks for.
//       Name a block to load and run that one alone, for probing a part in isolation.
//   node run.mjs dumpxm <file.ixa> <out.xm>    capture the module a part generates
//   node run.mjs renderxm <file.xm> <out.wav> [seconds]
//   node run.mjs pandora <file.ixa> <outdir>    export generated textures as TGA
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
import { CPU, REG, Unimplemented, Fault } from './lib/cpu.js';
import { JitCPU } from './lib/jit.js';
import { XmPlayer } from './lib/xm.js';
import { RunSessionManager } from './lib/run-session.js';
import {
  PANDORA_BYTES, pandoraBgr, pandoraPointer, pandoraProfile,
} from './lib/pandora.js';
import { TextureWatcher, noteHz, summariseSamples } from './lib/debug-capture.js';
import { AccessProvenance } from './lib/provenance.js';

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

  // startdemo gives each executable the address of herzcount, and the original parts
  // consume elapsed ticks by writing zero through that pointer. Verify UpdateMusic adds
  // only the new tick delta to the value currently in shared memory rather than restoring
  // a private cumulative total.
  const timer = new Machine({ clock: 'virtual' });
  const observed = [];
  for (const ms of [20, 40, 60]) {
    timer.virtualMs = ms;
    timer.updateMusic();
    observed.push(timer.herzcount);
    timer.mem.setInt32(timer.pHerzcount, 0, true);
  }
  const timerOk = observed.length === 3
    && observed[0] === 1 && observed[1] === 1 && observed[2] === 2
    && timer.herzcount === 0;
  if (timerOk) ok++; else fail++;
  process.stdout.write(
    `shared 70 Hz timer: ${timerOk ? 'match' : `MISMATCH (${observed.join(', ')})`}\n`);

  // A second TBL1 replaces the playing module while the browser's AudioWorklet reports
  // positions asynchronously. Stash does this in one executable. XM 1's final external
  // position must be cleared synchronously, or XM 2 starts with the visuals reading the
  // previous soundtrack's order until the first new worklet report arrives.
  const handoffBytes = new Uint8Array(readFileSync(`${HERE}data/astral.ixa`));
  const handoffIxa = readIxa(handoffBytes);
  const handoffXm = unpackBlock(handoffBytes, handoffIxa.entries[6]);
  const handoff = new Machine({ clock: 'virtual' });
  const handoffAt = handoff.alloc(handoffXm.length);
  handoff.u8.set(handoffXm, handoffAt);
  handoff.startXm(handoffAt, handoffXm.length);
  handoff.setMusicPosition(10, 63, 1);
  handoff.mem.setUint8(handoff.pMustime, 10);
  handoff.mem.setUint8(handoff.pMustime + 1, 63);
  handoff.startXm(handoffAt, handoffXm.length);
  const staleAccepted = handoff.setMusicPosition(10, 63, 1);
  const handoffOk = handoff.externalMusic
    && handoff.musicGeneration === 2 && !staleAccepted
    && handoff.musicPos === 0 && handoff.musicRow === 0
    && handoff.mem.getUint8(handoff.pMustime) === 0
    && handoff.mem.getUint8(handoff.pMustime + 1) === 0;
  if (handoffOk) ok++; else fail++;
  process.stdout.write(
    `multi-XM position handoff: ${handoffOk ? 'match' : 'MISMATCH'}`
    + ` (${handoff.musicPos}:${handoff.musicRow})\n`);

  // The real MIDAS player and XmPlayer loop at the XM restart order. The
  // sound-off fallback clock must wrap too: some executable parts wait for
  // curpos to fall back to the song opening before they far-return.
  handoff.externalMusic = false;
  const rowsPerSecond = (handoff.xm.bpm * 2 / 5) / handoff.xm.speed;
  handoff.virtualMs = (handoff.xm.totalRows + 2.25) * 1000 / rowsPerSecond;
  handoff.updateMusic();
  const loopClockOk = handoff.musicPos === handoff.xm.restart && handoff.musicRow === 2;
  if (loopClockOk) ok++; else fail++;
  process.stdout.write(
    `sound-off XM restart loop: ${loopClockOk ? 'match' : 'MISMATCH'}`
    + ` (${handoff.musicPos}:${handoff.musicRow}, restart ${handoff.xm.restart})\n`);

  // A second Start click can arrive while the previous worker is playing, downloading,
  // or still awaiting Safari's AudioWorklet setup. Ownership must move synchronously so
  // late frames, download progress and audio callbacks from run 1 cannot affect run 2.
  const sessionEvents = [];
  const deactivated = [];
  const sessions = new RunSessionManager({
    onDeactivate: (run) => deactivated.push(run.name),
  });
  const firstRun = sessions.begin({ name: 'first' });
  firstRun.abort.signal.addEventListener('abort', () => sessionEvents.push('abort'));
  const firstWorker = {
    postMessage: (message) => sessionEvents.push(`worker:${message.cmd}`),
    terminate: () => sessionEvents.push('terminate'),
  };
  const firstAudio = { close: () => sessionEvents.push('audio:close') };
  firstRun.worker = firstWorker;
  firstRun.audio = firstAudio;
  const secondRun = sessions.begin({ name: 'second' });
  const staleStopIgnored = !sessions.stop(firstRun) && sessions.isActive(secondRun);
  const currentStopped = sessions.stop(secondRun);
  const sessionSwitchOk = firstRun.closed
    && firstRun.abort.signal.aborted
    && firstRun.worker === null && firstRun.audio === null
    && sessionEvents.join(',') === 'abort,worker:stop,terminate,audio:close'
    && deactivated.join(',') === 'first,second'
    && staleStopIgnored && currentStopped && sessions.current === null;
  if (sessionSwitchOk) ok++; else fail++;
  process.stdout.write(
    `browser production handoff: ${sessionSwitchOk ? 'match' : 'MISMATCH'}`
    + ` (${sessionEvents.join(', ')})\n`);

  // A hot generated rasterizer changes displacement/immediate bytes without changing its
  // instruction shape. Drive one block through enough variants to promote the JIT's live
  // tier, then prove its in-place operand refresh remains architecturally identical to the
  // interpreter. This is the small permanent form of Astral block 2's generated rasterizer
  // workload; the visually later tunnel freeze is the separate block-3 probe below.
  const smcProbe = (Engine) => {
    const m = new Machine({ clock: 'virtual' });
    const at = m.alloc(4096);
    // mov eax, 0x12345678 ; jmp back to mov
    m.u8.set([0xb8, 0x78, 0x56, 0x34, 0x12, 0xe9, 0xf6, 0xff, 0xff, 0xff], at);
    const cpu = new Engine(m);
    cpu.eip = at;
    cpu.retainTrampolineHits = false;
    const values = [];
    for (let value = 1; value <= 20; value++) {
      cpu.wr32(at + 1, value);
      cpu.run(64);
      values.push(cpu.regs[0] >>> 0);
    }
    return {
      count: cpu.count,
      eip: cpu.eip,
      eax: cpu.regs[0] >>> 0,
      values: values.join(','),
      dynamic: cpu.jitDynamic ?? 0,
      refreshes: cpu.jitDynamicHits ?? 0,
    };
  };
  const smcCpu = smcProbe(CPU);
  const smcJit = smcProbe(JitCPU);
  const smcOk = smcCpu.count === smcJit.count
    && smcCpu.eip === smcJit.eip
    && smcCpu.eax === smcJit.eax
    && smcCpu.values === smcJit.values
    && smcJit.dynamic > 0
    && smcJit.refreshes > 0;
  if (smcOk) ok++; else fail++;
  process.stdout.write(
    `live self-modifying operands: ${smcOk ? 'match' : 'MISMATCH'}`
    + ` (${smcJit.dynamic} promotion, ${smcJit.refreshes} refreshes)\n`);

  // Astral's tunnel is loader block 3 (the fourth visible effect, but the third EXE pop).
  // It assumes every display iteration sees a positive 70 Hz delta. A wall-clock worker
  // can execute several show calls inside one synchronous CPU slice, feed it a zero delta,
  // and send its update counter around an enormous loop. Browser audio reports mustime
  // independently, so exercise that exact entry position with the paced virtual animation
  // clock and prove a second slice still presents frames and reaches host callbacks.
  const astralBytes = new Uint8Array(readFileSync(`${HERE}data/astral.ixa`));
  const astral = readIxa(astralBytes);
  const tunnelProbe = (Engine) => {
    const machine = new Machine({
      partmem: partmemFor(astral.demoname),
      clock: 'virtual',
    });
    const loaded = machine.loadExe(
      unpackBlock(astralBytes, astral.entries[3]),
    );
    machine.setMusicPosition(12, 63);
    machine.mem.setUint8(machine.pMustime, 12);
    machine.mem.setUint8(machine.pMustime + 1, 63);
    const cpu = new Engine(machine);
    cpu.retainTrampolineHits = false;
    cpu.reset(loaded);
    cpu.run(32_000_000);
    const midFrames = machine.frames;
    const midCalls = cpu.trampolineCount;
    cpu.run(32_000_000);
    return {
      midFrames,
      midCalls,
      frames: machine.frames,
      calls: cpu.trampolineCount,
      eip: cpu.eip,
      regs: [...cpu.regs].join(','),
    };
  };
  const tunnelCpu = tunnelProbe(CPU);
  const tunnelJit = tunnelProbe(JitCPU);
  const tunnelOk = tunnelCpu.midFrames > 0
    && tunnelCpu.frames > tunnelCpu.midFrames
    && tunnelCpu.calls > tunnelCpu.midCalls
    && tunnelCpu.frames === tunnelJit.frames
    && tunnelCpu.calls === tunnelJit.calls
    && tunnelCpu.eip === tunnelJit.eip
    && tunnelCpu.regs === tunnelJit.regs;
  if (tunnelOk) ok++; else fail++;
  process.stdout.write(
    `Astral block-3 paced tunnel: ${tunnelOk ? 'match' : 'MISMATCH'}`
    + ` (${tunnelJit.midFrames}->${tunnelJit.frames} frames, `
    + `${tunnelJit.midCalls}->${tunnelJit.calls} host calls)\n`);

  // Astral carries a large, effect-heavy XM as block 6. It exercises volume and panning
  // envelopes, sample loops, E-effects and a backward Bxx song loop, making it a compact
  // permanent replay regression without regenerating Jizz/Stash's modules during every
  // verify run. Also pin the less visible FT2 rules that previously differed here.
  const astralXmBytes = unpackBlock(astralBytes, astral.entries[6]);
  const sampleSummary = summariseSamples(astralXmBytes);
  const patternPitchedSamples =
    sampleSummary.samples.filter((sample) => sample.pitchSource === 'pattern');
  const samplePitchOk = patternPitchedSamples.length > 0
    && patternPitchedSamples.some((sample) => sample.usualNote !== 49)
    && patternPitchedSamples.every((sample) =>
      sample.usualNoteUses > 0
      && sample.usualNoteUses <= sample.noteUses
      && sample.hz === noteHz(
        sample.usualNote,
        sample.relativeNote,
        sample.finetune,
        sampleSummary.linearPeriods,
      ));
  if (samplePitchOk) ok++; else fail++;
  process.stdout.write(
    `XM sample audition pitches: ${samplePitchOk ? 'match' : 'MISMATCH'}`
    + ` (${patternPitchedSamples.length}/${sampleSummary.samples.length} samples used, `
    + 'modal notes mapped through instrument keymaps)\n',
  );

  // The inspector must audition an XI instrument, not ask Web Audio to loop raw PCM.
  // Astral instrument 1 supplies a compact permanent fixture: its sample ping-pongs, its
  // volume envelope sustains, and note-off engages a nonzero instrument fadeout.
  const xiSample = patternPitchedSamples.find(
    (sample) => sample.instrument === 1 && sample.loopType === 2,
  );
  const xiAudition = new XmPlayer(astralXmBytes, 48_000);
  const xiVoice = xiSample
    ? xiAudition.startInstrumentAudition(
        xiSample.instrument,
        xiSample.usualNote,
        xiSample.sampleIndex,
      )
    : null;
  const xiInstrument = xiSample
    ? xiAudition.instruments[xiSample.instrument - 1]
    : null;
  const auditionLeft = new Float32Array(48_000);
  const auditionRight = new Float32Array(48_000);
  if (xiVoice) xiAudition.render(auditionLeft, auditionRight, auditionLeft.length);
  const fadeBeforeRelease = xiVoice?.fadeVol ?? 0;
  if (xiVoice) {
    xiAudition.keyOffChannel(xiVoice);
    const releaseFrames = Math.ceil(xiAudition.samplesPerTick * 2);
    xiAudition.render(
      new Float32Array(releaseFrames),
      new Float32Array(releaseFrames),
      releaseFrames,
    );
  }
  const xiAuditionOk = xiVoice !== null
    && xiVoice.sample === xiInstrument.samples[xiSample.sampleIndex]
    && xiVoice.sample.loopType === 2
    && xiVoice.volEnv === xiInstrument.volEnv
    && xiVoice.keyOff
    && xiVoice.fadeVol < fadeBeforeRelease
    && auditionLeft.some((value) => value !== 0)
    && auditionRight.some((value) => value !== 0);
  if (xiAuditionOk) ok++; else fail++;
  process.stdout.write(
    `XI sample inspector audition: ${xiAuditionOk ? 'match' : 'MISMATCH'}`
    + ' (physical sample, ping-pong loop, stereo mix, envelope, note-off/fadeout)\n',
  );
  const xm = new XmPlayer(astralXmBytes, 48_000);
  const xmChannel = xm.ch[0];
  xmChannel.panning = xmChannel.finalPan = 77;
  xm.rowEffect(xmChannel, 0xe, 0x8f); // E8x is a dummy in FT2, not set-panning
  const e8Ok = xmChannel.panning === 77;
  xmChannel.period = xmChannel.outPeriod = 1000;
  xm.rowEffect(xmChannel, 0xe, 0x13);
  xm.rowEffect(xmChannel, 0xe, 0x10); // zero recalls E1x's channel-local parameter
  const memoryOk = xmChannel.period === 976;
  const panEnvelopeOk = xm.instruments.some((instrument) => instrument.panEnv !== null);

  // Pin FT2's envelope counter order with the short gate from Stash XM 2 instrument 25.
  // FT2 wraps on the loop-end tick itself, making this a six-tick cycle; wrapping on the
  // following tick leaves one extra silent tick and makes the gate 16.7% too slow. Also
  // exercise FT2's sustain release rewind and signed 8.8 interpolation.
  const loopEnv = {
    points: Uint16Array.from([0, 64, 3, 64, 4, 0, 6, 0]),
    num: 4, sustain: -1, loopStart: 0, loopEnd: 3,
  };
  const loopChannel = { volEnvTick: -1, keyOff: false };
  const loopTicks = [], loopValues = [];
  for (let i = 0; i < 7; i++) {
    loopValues.push(xm.advanceEnvelope(loopChannel, loopEnv, 'volEnvTick', 64));
    loopTicks.push(loopChannel.volEnvTick);
  }

  const sustainEnv = {
    points: Uint16Array.from([0, 64, 4, 64, 8, 63, 14, 8, 24, 22, 32, 8]),
    num: 6, sustain: 2, loopStart: -1, loopEnd: -1,
  };
  const sustainChannel = {
    volEnv: sustainEnv, volEnvTick: -1,
    panEnv: null, panEnvTick: -1,
    keyOff: false, volume: 64, outVolume: 64,
  };
  for (let i = 0; i < 20; i++) {
    xm.advanceEnvelope(sustainChannel, sustainEnv, 'volEnvTick', 64);
  }
  xm.keyOffChannel(sustainChannel);
  const release0 = xm.advanceEnvelope(sustainChannel, sustainEnv, 'volEnvTick', 64);
  const release1 = xm.advanceEnvelope(sustainChannel, sustainEnv, 'volEnvTick', 64);
  const envelopeTimingOk = loopTicks.join(',') === '0,1,2,3,4,5,0'
    && loopValues.join(',') === '64,64,64,64,0,0,64'
    && release0 === 63 && release1 === 53.8359375;
  if (envelopeTimingOk) ok++; else fail++;
  process.stdout.write(
    `FT2 envelope timing: ${envelopeTimingOk ? 'match' : 'MISMATCH'}`
    + ` (loop ticks ${loopTicks.join(',')}, release ${release0}->${release1})\n`);

  // Focused state fixtures derived directly from ft2_replayer.c. These cover quirks that
  // the bundled music does not necessarily execute, and guard the ordering between note
  // parsing, tick-zero effects, pattern control and the silence mixer.
  const compatibility = new XmPlayer(astralXmBytes, 48_000);
  const putRow = (player, note, instrument, volume, effect, parameter) => {
    const cells = new Uint8Array(64 * player.channels * 5);
    cells.set([note, instrument, volume, effect, parameter], 0);
    player.patterns = [{ rows: 64, cells }];
    player.order = [0];
    player.songLength = 1;
    player.position = player.row = 0;
    player.repeatRow = false;
  };

  const k00 = compatibility.ch[0];
  k00.inst = null;
  k00.volEnv = null;
  k00.volume = k00.outVolume = 42;
  putRow(compatibility, 0, 0, 0, 0x14, 0);
  compatibility.startRow();
  const k00Ok = k00.keyOff && k00.volume === 0 && k00.outVolume === 0;

  const noteOffPlayer = new XmPlayer(astralXmBytes, 48_000);
  const instrumentIndex =
    noteOffPlayer.instruments.findIndex((instrument) => instrument.samples.length > 0) + 1;
  const noteOff = noteOffPlayer.ch[0];
  noteOffPlayer.triggerNote(noteOff, 48, instrumentIndex);
  noteOffPlayer.resetVolumes(noteOff);
  noteOffPlayer.resetInstrument(noteOff);
  noteOff.volume = noteOff.outVolume = 7;
  noteOff.panning = noteOff.finalPan = 99;
  putRow(noteOffPlayer, 97, instrumentIndex, 0, 0, 0);
  noteOffPlayer.startRow();
  const noteOffInstrumentOk = noteOff.keyOff
    && noteOff.volume === noteOff.oldVolume
    && noteOff.panning === noteOff.oldPanning;

  const silent = new XmPlayer(astralXmBytes, 48_000);
  const silentChannel = silent.ch[0];
  Object.assign(silentChannel, {
    sample: {
      pcm: Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      frames: 8, loopType: 1, loopStart: 2, loopLength: 3, loopEnd: 5,
    },
    playing: true, pos: 0, dir: 1, frequency: 48_000,
    volume: 0, outVolume: 0, fadeVol: 32768,
  });
  silent.mix(new Float32Array(10), new Float32Array(10), 0, 10);
  const silentForwardOk = silentChannel.pos === 4 && silentChannel.playing;
  Object.assign(silentChannel, {
    sample: {
      pcm: Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      frames: 8, loopType: 2, loopStart: 2, loopLength: 3, loopEnd: 5,
    },
    playing: true, pos: 2, dir: 1, frequency: 48_000,
  });
  silent.mix(new Float32Array(8), new Float32Array(8), 0, 8);
  const silentPingPongOk =
    silentChannel.pos === 4 && silentChannel.dir === 1 && silentChannel.playing;

  const timing = new XmPlayer(astralXmBytes, 48_000);
  timing.setTickDuration(123);
  timing.tickSampleCarry = 0;
  const tickLengths = Array.from({ length: 8 }, () => timing.nextTickLength());
  const fractionalTimingOk = tickLengths.join(',') === '975,975,975,976,975,975,975,976';

  const control = new XmPlayer(astralXmBytes, 48_000);
  control.patterns = Array.from(
    { length: 5 },
    () => ({ rows: 64, cells: new Uint8Array(64 * control.channels * 5) }),
  );
  control.order = [0, 1, 2, 3, 4];
  control.songLength = 5;
  control.position = 2;
  control.row = 10;
  control.rowEffect(control.ch[0], 0x0d, 0x12);
  control.rowEffect(control.ch[1], 0x0b, 0x03);
  control.nextRow();
  const breakThenJumpOk = control.position === 3 && control.row === 0;

  control.position = 2;
  control.row = 10;
  control.positionJump = control.patternBreak = false;
  control.positionJumpTarget = -1;
  control.patternBreakPosition = 0;
  control.rowEffect(control.ch[0], 0x0b, 0x03);
  control.rowEffect(control.ch[1], 0x0d, 0x12);
  control.nextRow();
  const jumpThenBreakOk = control.position === 3 && control.row === 12;

  control.position = 2;
  control.row = 10;
  control.positionJump = control.patternBreak = false;
  control.positionJumpTarget = -1;
  control.patternBreakPosition = 0;
  control.ch[1].patternLoopRow = 7;
  control.ch[1].patternLoopCount = 0;
  control.rowEffect(control.ch[0], 0x0b, 0x03);
  control.rowEffect(control.ch[1], 0x0e, 0x61);
  control.nextRow();
  const jumpLoopPriorityOk = control.position === 3 && control.row === 7;

  const exact = new XmPlayer(astralXmBytes, 48_000);
  exact.linearPeriods = true;
  exact.ch[0].finetune = 0;
  const exactPeriodsOk =
    exact.period2NotePeriod(4600, 3, exact.ch[0]) === 4416
    && exact.period2NotePeriod(4571, 0, exact.ch[0]) === 4544
    && exact.frequencyOf(4608) === 8362.79296875;
  exact.linearPeriods = false;
  const amigaTableOk = exact.periodAt(0) === 29024
    && exact.periodAt(1535) === 113
    && exact.periodAt(1920) === 16
    && exact.periodAt(1935) === 0;

  const slide = exact.ch[0];
  slide.period = slide.outPeriod = 2;
  exact.rowEffect(slide, 0x0e, 0x1f);
  const slideUpOk = slide.period === 1;
  slide.period = slide.outPeriod = 65530;
  exact.rowEffect(slide, 0x21, 0x24);
  const slideOverflowOk = slide.period === 65534;

  const sustainState = {
    volEnv: sustainEnv, volEnvTick: -1, volEnvPos: 0,
    volEnvValue: 0, volEnvDelta: 0,
    panEnv: null, panEnvTick: -1,
    keyOff: false, volume: 64, outVolume: 64,
  };
  for (let i = 0; i < 20; i++) {
    exact.advanceEnvelope(sustainState, sustainEnv, 'volEnvTick', 64);
  }
  const heldCounterOk = sustainState.volEnvTick === 19 && sustainState.volEnvPos === 2;
  exact.keyOffChannel(sustainState);
  const releasedCounterOk = sustainState.volEnvTick === 7;

  const panRelease = {
    volEnv: null, panEnv: sustainEnv,
    panEnvTick: 20, panEnvPos: 2,
    keyOff: false, volume: 64, outVolume: 64,
  };
  exact.keyOffChannel(panRelease);
  const panReleaseQuirkOk = panRelease.panEnvTick === 20;

  const ft2StateOk = k00Ok && noteOffInstrumentOk
    && silentForwardOk && silentPingPongOk && fractionalTimingOk
    && breakThenJumpOk && jumpThenBreakOk && jumpLoopPriorityOk
    && exactPeriodsOk && amigaTableOk && slideUpOk && slideOverflowOk
    && heldCounterOk && releasedCounterOk && panReleaseQuirkOk;
  if (ft2StateOk) ok++; else fail++;
  process.stdout.write(
    `FT2 differential state fixtures: ${ft2StateOk ? 'match' : 'MISMATCH'}`
    + ` (note-off ${k00Ok && noteOffInstrumentOk ? 'match' : 'wrong'}, `
    + `loops ${silentForwardOk && silentPingPongOk ? 'match' : 'wrong'}, `
    + `tick carry ${fractionalTimingOk ? 'match' : 'wrong'}, `
    + `control ${breakThenJumpOk && jumpThenBreakOk && jumpLoopPriorityOk ? 'match' : 'wrong'}, `
    + `periods ${exactPeriodsOk && amigaTableOk ? 'match' : 'wrong'}, `
    + `envelopes ${heldCounterOk && releasedCounterOk && panReleaseQuirkOk ? 'match' : 'wrong'})\n`);

  let previousPosition = xm.position;
  let songLooped = false;
  let finite = true;
  const maxFrames = 48_000 * 30 * 60;
  for (let frames = 0; frames < maxFrames && !songLooped; frames += 4800) {
    xm.skip(4800);
    if (xm.position < previousPosition || xm.loops > 0) songLooped = true;
    previousPosition = xm.position;
    for (const channel of xm.ch) {
      if (!Number.isFinite(channel.frequency)
          || !Number.isFinite(channel.envVal)
          || !Number.isFinite(channel.finalPan)) {
        finite = false;
        break;
      }
    }
  }
  const xmOk = e8Ok && memoryOk && panEnvelopeOk && songLooped && finite
    && xm.unsupported.size === 0;
  if (xmOk) ok++; else fail++;
  process.stdout.write(
    `FT2 XM replay semantics: ${xmOk ? 'match' : 'MISMATCH'}`
    + ` (E8 ${e8Ok ? 'dummy' : 'wrong'}, memory ${memoryOk ? 'match' : 'wrong'}, `
    + `pan envelope ${panEnvelopeOk ? 'active' : 'missing'}, `
    + `song loop ${songLooped ? 'reached' : 'missing'})\n`);

  // Pandora slots mix planar, packed and monochrome results; MAP1A additionally starts at
  // a wrapped texture origin, while Stash slot 15 is a 320x200 image in a 192 KiB slot.
  // Keep conversion independent of the multi-billion-instruction integration command so
  // ordinary verification catches channel, dimension and row-order regressions.
  const packedTexture = new Uint8Array(PANDORA_BYTES);
  packedTexture.set([1, 2, 3], 0);
  const shifted = (64 * 256 + 64) * 3;
  packedTexture.set([4, 5, 6], shifted);
  const planarTexture = new Uint8Array(PANDORA_BYTES);
  planarTexture[0] = 7;
  planarTexture[0x10000] = 8;
  planarTexture[0x20000] = 9;
  planarTexture[0x20000 + 1] = 10;
  const packedBgr = pandoraBgr(packedTexture, 'packed');
  const shiftedBgr = pandoraBgr(packedTexture, 'packed', 64, 64);
  const planarBgr = pandoraBgr(planarTexture, 'planar');
  const monoBgr = pandoraBgr(planarTexture, 'mono', 1, 0, 256, 256, 2);
  const screenBgr = pandoraBgr(packedTexture, 'packed', 0, 0, 320, 200);
  const jizzPandora = pandoraProfile(
    'Jizz',
    '5c55d364740911715e6ee50fafd1f4a2a88479ed853364b857b0711cb4a0685e',
  );
  const weirdtxt = jizzPandora.textures.find((texture) => texture.slot === 6);
  const logo2 = jizzPandora.textures.find((texture) => texture.slot === 11);
  const logo1 = jizzPandora.textures.find((texture) => texture.slot === 12);
  const map15 = jizzPandora.textures.find((texture) => texture.slot === 15);
  const stashPandora = pandoraProfile(
    'Stash',
    '87b326631d4ef9f4b4ba2c93c46dd73854666b6213d1c5074cb23f9f92bd9e21',
  );
  const stash13 = stashPandora.textures.find((texture) => texture.slot === 13);
  const stash15 = stashPandora.textures.find((texture) => texture.slot === 15);
  const pandoraOk = packedBgr[0] === 3 && packedBgr[1] === 2 && packedBgr[2] === 1
    && shiftedBgr[0] === 6 && shiftedBgr[1] === 5 && shiftedBgr[2] === 4
    && planarBgr[0] === 9 && planarBgr[1] === 8 && planarBgr[2] === 7
    && monoBgr[0] === 10 && monoBgr[1] === 10 && monoBgr[2] === 10
    && screenBgr.length === 320 * 200 * 3
    && jizzPandora.textures.length === 16
    && weirdtxt.dumpPartmemOffset === 0x4ab000
    && weirdtxt.captureAt === 1_484_000_000
    && logo2.dumpPartmemOffset === 0x4ab000
    && logo2.captureAt === 2_084_500_000
    && logo1.dumpPartmemOffset === 0x41b000
    && logo1.captureAt === 2_083_000_000
    && map15.partmemOffset === 0x3eb000
    && stashPandora.textures.length === 13
    && stash13.layout === 'mono' && stash13.monoPlane === 2
    && stash15.layout === 'packed' && stash15.width === 320 && stash15.height === 200;
  if (pandoraOk) ok++; else fail++;
  process.stdout.write(
    `Pandora texture profiles: ${pandoraOk ? 'match' : 'MISMATCH'} `
    + '(packed, planar, mono, wrapped origin, rectangular output, Jizz/Stash tables)\n',
  );

  // The browser initially previews ordinary live slots, but exact scratch-backed images
  // must appear only at their recovered instruction boundary and remain frozen. TBL1 then
  // replaces every other preview with the same final snapshot the CLI writes.
  const watcherMachine = new Machine({ clock: 'virtual' });
  const exactAt = watcherMachine.partmem;
  const finalAt = exactAt + PANDORA_BYTES;
  watcherMachine.u8.set([1, 2, 3], exactAt);
  watcherMachine.u8.set([4, 5, 6], finalAt);
  const watcher = new TextureWatcher({
    machine: watcherMachine,
    imageBase: 0,
    profile: {
      production: 'watcher probe',
      tableOffset: 0,
      textures: [
        {
          slot: 0, name: 'exact', layout: 'packed',
          dumpPartmemOffset: 0, captureAt: 100,
        },
        {
          slot: 1, name: 'final', layout: 'packed',
          partmemOffset: PANDORA_BYTES, width: 320, height: 200,
        },
      ],
    },
  });
  const nextCapture = watcher.nextCaptureAt(0);
  const liveShots = watcher.poll(0);
  const earlyShots = watcher.captureDue(99);
  const exactShots = watcher.captureDue(100);
  watcherMachine.u8.set([9, 9, 9], exactAt);
  const repeatedShots = watcher.captureDue(101);
  const finalShots = watcher.finalize(200);
  const settledShots = watcher.poll(201);
  const experimentalWatcher = new TextureWatcher({
    machine: watcherMachine,
    provenance: true,
  });
  const watcherOk = watcher.trace === null
    && experimentalWatcher.trace instanceof AccessProvenance
    && experimentalWatcher.frameRegion !== null
    && nextCapture === 100
    && liveShots.length === 1 && liveShots[0].name === 'final' && !liveShots[0].frozen
    && earlyShots.length === 0
    && exactShots.length === 1 && exactShots[0].name === 'exact' && exactShots[0].frozen
    && exactShots[0].pixels.slice(0, 4).join(',') === '1,2,3,255'
    && repeatedShots.length === 0
    && finalShots.length === 1 && finalShots[0].name === 'final' && finalShots[0].frozen
    && finalShots[0].width === 320 && finalShots[0].height === 200
    && finalShots[0].pixels.slice(0, 4).join(',') === '4,5,6,255'
    && settledShots.length === 0;
  if (watcherOk) ok++; else fail++;
  process.stdout.write(
    `Pandora browser snapshots: ${watcherOk ? 'match' : 'MISMATCH'}`
    + ' (default untraced, gated provenance, exact scratch, TBL1 final, rectangular slot)\n',
  );

  // Debug tracing substitutes only the guest-data DataView. Prove that compiled integer
  // templates, x87's direct DataView path and interpreter string operations all reach it.
  // The provenance probes are intentionally adversarial: fixed scalars must not become
  // "wave tables", far-apart allocations used by one EIP must not merge, and xyz/index
  // previews require observed access strides rather than lucky-looking bytes.
  const traceMachine = new Machine({ clock: 'virtual' });
  const codeAt = traceMachine.alloc(32);
  const sourceAt = traceMachine.alloc(16);
  const destAt = traceMachine.alloc(16);
  const stringSource = traceMachine.alloc(16);
  const stringDest = traceMachine.alloc(16);
  const fpuDest = traceMachine.alloc(16);
  const stackTop = traceMachine.alloc(4096) + 4096;
  traceMachine.mem.setUint32(sourceAt, 0x78563412, true);
  traceMachine.u8.set([9, 8, 7, 6], stringSource);
  traceMachine.u8[codeAt] = 0xa1;                    // mov eax,[source]
  traceMachine.mem.setUint32(codeAt + 1, sourceAt, true);
  traceMachine.u8[codeAt + 5] = 0xa3;                // mov [dest],eax
  traceMachine.mem.setUint32(codeAt + 6, destAt, true);
  traceMachine.u8[codeAt + 10] = 0xe9;               // jmp codeAt
  traceMachine.mem.setInt32(codeAt + 11, -15, true);

  const traceEvents = [];
  const provenance = new AccessProvenance({
    machine: traceMachine,
    onBoundary: (region, info) => traceEvents.push({ region, info }),
  });
  const jitRegion = provenance.registerRange({
    key: 'jit-destination',
    start: destAt,
    length: 16,
    kind: 'probe',
    labels: ['destination'],
    capture: true,
    width: 1,
    height: 1,
  });
  const traceCpu = new JitCPU(traceMachine);
  traceCpu.reset({
    entry: codeAt,
    regs: {
      eax: 0, ecx: 0, edx: 0, ebx: 0,
      esp: stackTop, ebp: 0, esi: 0, edi: 0,
      cs: 0, ds: 0, es: 0, ss: 0, fs: 0, gs: 0,
    },
  });
  provenance.attach(traceCpu, 0);
  traceCpu.run(256);
  provenance.force(jitRegion, traceCpu.count, 'probe');
  traceCpu.fpu.set(0, 1.25);
  traceCpu.fpu.execute(0xd9, { mod: 0, reg: 2, rm: 0, raw: 0, addr: fpuDest });
  traceCpu.set32(REG.esi, stringSource);
  traceCpu.set32(REG.edi, stringDest);
  traceCpu.set32(REG.ecx, 4);
  traceCpu.repPrefix = 0xf3;
  traceCpu.stringOp('movs', 1);

  const lutAt = traceMachine.alloc(4096);
  const sampledAt = traceMachine.alloc(4096);
  const lutDest = traceMachine.alloc(1024);
  for (let i = 0; i < 1024; i++) traceMachine.mem.setUint16(lutAt + i * 2, i, true);
  const sampledRegion = provenance.registerRange({
    key: 'sampled-texture',
    start: sampledAt,
    length: 32 * 32 * 3,
    kind: 'texture',
    labels: ['sampled texture'],
    capture: false,
    width: 32,
    height: 32,
    layout: 'packed',
  });
  let lutInfo = null, scalarInfo = null, clusterInfo = null;
  let blendInfo = null, scanlineInfo = null, waveInfo = null;
  let scalarRegion = null, clusterRegion = null;
  let blendRegion = null, scanlineRegion = null, waveRegion = null;
  const lutRegion = provenance.registerRange({
    key: 'lut-destination',
    start: lutDest,
    length: 1024,
    kind: 'texture',
    labels: ['LUT probe'],
    capture: true,
    width: 32,
    height: 32,
  });
  const oldBoundary = provenance.onBoundary;
  provenance.onBoundary = (region, info) => {
    if (region === lutRegion) lutInfo = info;
    if (region === scalarRegion) scalarInfo = info;
    if (region === clusterRegion) clusterInfo = info;
    if (region === blendRegion) blendInfo = info;
    if (region === scanlineRegion) scanlineInfo = info;
    if (region === waveRegion) waveInfo = info;
    oldBoundary?.(region, info);
  };
  for (let i = 0; i < 1024; i++) {
    provenance.read(lutAt + i * 2, 2, 'u16', i, codeAt, traceCpu.count + i);
    const sample = (i * 73) % 1024;
    provenance.read(
      sampledAt + sample * 3, 1, 'u8', sample & 255, codeAt + 1, traceCpu.count + i,
    );
    provenance.write(lutDest + i, 1, 'u8', i, codeAt + 5, traceCpu.count + i);
  }
  provenance.force(lutRegion, traceCpu.count + 1024, 'probe');

  const scalarAt = traceMachine.alloc(16);
  const scalarDest = traceMachine.alloc(256);
  scalarRegion = provenance.registerRange({
    key: 'scalar-destination',
    start: scalarDest,
    length: 256,
    kind: 'probe',
    capture: true,
    width: 16,
    height: 16,
  });
  for (let i = 0; i < 256; i++) {
    provenance.read(scalarAt, 4, 'u32', 7, codeAt + 12, traceCpu.count + i);
    provenance.write(scalarDest + i, 1, 'u8', i, codeAt + 16, traceCpu.count + i);
  }
  provenance.force(scalarRegion, traceCpu.count + 256, 'probe');

  const clusterA = traceMachine.alloc(16);
  traceMachine.alloc(8192);
  const clusterB = traceMachine.alloc(16);
  const clusterDest = traceMachine.alloc(64);
  clusterRegion = provenance.registerRange({
    key: 'cluster-destination',
    start: clusterDest,
    length: 64,
    kind: 'probe',
    capture: true,
    width: 8,
    height: 8,
  });
  for (let i = 0; i < 32; i++) {
    const source = (i & 1) === 0 ? clusterA + (i & 12) : clusterB + (i & 12);
    provenance.read(source, 4, 'u32', i, codeAt + 20, traceCpu.count + i);
    provenance.write(clusterDest + i, 1, 'u8', i, codeAt + 24, traceCpu.count + i);
  }
  provenance.force(clusterRegion, traceCpu.count + 32, 'probe');

  const blendAt = traceMachine.alloc(65536);
  const blendDest = traceMachine.alloc(1024);
  blendRegion = provenance.registerRange({
    key: 'blend-destination',
    start: blendDest,
    length: 1024,
    kind: 'probe',
    capture: true,
    width: 32,
    height: 32,
  });
  for (let i = 0; i < 1024; i++) {
    const lookup = (i * 40503) & 0xffff;
    provenance.read(blendAt + lookup, 1, 'u8', lookup & 255, codeAt + 28, traceCpu.count + i);
    provenance.write(blendDest + i, 1, 'u8', i, codeAt + 29, traceCpu.count + i);
  }
  provenance.force(blendRegion, traceCpu.count + 1024, 'probe');

  const scanlineAt = traceMachine.alloc(256);
  const scanlineDest = traceMachine.alloc(4096);
  scanlineRegion = provenance.registerRange({
    key: 'scanline-destination',
    start: scanlineDest,
    length: 4096,
    kind: 'probe',
    capture: true,
    width: 64,
    height: 64,
  });
  for (let y = 0; y < 64; y++) {
    provenance.read(
      scanlineAt + y * 2, 2, 'u16', y * 3, codeAt + 30, traceCpu.count + y,
    );
    provenance.write(
      scanlineDest + y * 64, 1, 'u8', y, codeAt + 31, traceCpu.count + y,
    );
  }
  provenance.force(scanlineRegion, traceCpu.count + 64, 'probe');

  const waveAt = traceMachine.alloc(256);
  const waveDest = traceMachine.alloc(1024);
  waveRegion = provenance.registerRange({
    key: 'wave-destination',
    start: waveDest,
    length: 1024,
    kind: 'probe',
    capture: true,
    width: 32,
    height: 32,
  });
  for (let i = 0; i < 1024; i++) {
    const lookup = i & 255;
    provenance.read(waveAt + lookup, 1, 'u8', lookup, codeAt + 26, traceCpu.count + i);
    provenance.write(waveDest + i, 1, 'u8', i, codeAt + 27, traceCpu.count + i);
  }
  provenance.force(waveRegion, traceCpu.count + 1024, 'probe');

  const meshAt = traceMachine.alloc(4096);
  for (let i = 0; i < 96; i++) {
    const a = meshAt + i * 12;
    traceMachine.mem.setFloat32(a, Math.sin(i * 0.2), true);
    traceMachine.mem.setFloat32(a + 4, Math.cos(i * 0.13), true);
    traceMachine.mem.setFloat32(a + 8, i * 0.05, true);
  }
  const indexAt = traceMachine.alloc(4096);
  for (let i = 0; i < 288; i++) traceMachine.mem.setUint16(indexAt + i * 2, i % 96, true);
  const meshDest = traceMachine.alloc(2048);
  const meshRegion = provenance.registerRange({
    key: 'mesh-framebuffer',
    start: meshDest,
    length: 2048,
    kind: 'framebuffer',
    labels: ['mesh framebuffer'],
    capture: true,
    width: 32,
    height: 32,
    layout: 'rgb565',
  });
  // Geometry profiling starts at the music handoff in real productions, keeping the
  // multi-billion-instruction precalc out of the bounded mesh access profiles.
  traceMachine.xm = {};
  let meshCount = traceCpu.count + 10_000;
  for (let i = 0; i < 96; i++) {
    const at = meshAt + i * 12;
    provenance.read(at, 4, 'f32', traceMachine.mem.getFloat32(at, true), codeAt + 1, meshCount++);
    provenance.read(
      at + 4, 4, 'f32', traceMachine.mem.getFloat32(at + 4, true), codeAt + 2, meshCount++,
    );
    provenance.read(
      at + 8, 4, 'f32', traceMachine.mem.getFloat32(at + 8, true), codeAt + 3, meshCount++,
    );
    provenance.write(meshDest + i * 2, 2, 'u16', i, codeAt + 5, meshCount++);
  }
  for (let i = 0; i < 288; i++) {
    provenance.read(
      indexAt + i * 2, 2, 'u16', i % 96, codeAt + 6, meshCount++,
    );
    provenance.write(meshDest + (i % 1024) * 2, 2, 'u16', i, codeAt + 7, meshCount++);
  }
  const meshScene = provenance.scene(meshRegion, 32, 32, meshCount);
  const mesh = meshScene?.meshes[0] ?? null;
  const indices = mesh?.index ?? null;
  provenance.detach();

  const traceOk = traceMachine.mem.getUint32(destAt, true) === 0x78563412
    && traceCpu.jitIns > 0
    && traceEvents.some((event) =>
      event.info.sources.some((source) =>
        source.start <= sourceAt && source.end >= sourceAt && source.eip === codeAt))
    && traceEvents.some((event) =>
      event.info.writers.some((writer) =>
        writer.eip === codeAt + 5 && writer.start === destAt && writer.end === destAt + 3))
    && traceMachine.mem.getFloat32(fpuDest, true) === 1.25
    && traceMachine.u8.subarray(stringDest, stringDest + 4).join(',') === '9,8,7,6'
    && lutInfo?.sources.some((source) =>
      source.type === 'possible deformation-coordinate input'
      && source.preview?.kind === 'observed value map')
    && lutInfo?.sources.some((source) =>
      source.source === [...sampledRegion.labels].join('/')
      && source.preview?.kind === 'verified source-coordinate map')
    && scalarInfo?.sources.every((source) => source.type === 'state / parameter block')
    && clusterInfo?.sources.filter((source) => source.eip === codeAt + 20).length === 2
    && blendInfo?.sources.some((source) =>
      source.type === 'possible 64K palette/blend lookup'
      && source.preview?.kind === 'observed value map')
    && scanlineInfo?.sources.some((source) =>
      source.type === 'possible per-scanline lookup'
      && source.preview?.kind === 'observed value map')
    && waveInfo?.sources.some((source) =>
      source.type === 'possible periodic/wave lookup'
      && source.preview?.kind === 'observed value map')
    && mesh !== null && mesh.vertices >= 90 && mesh.stride === 12
    && mesh.fieldOffsets.join(',') === '0,4,8'
    && indices !== null && indices.size === 2 && indices.triangles === 96;
  if (!traceOk) {
    process.stdout.write(`  trace diagnostics ${JSON.stringify({
      copied: traceMachine.mem.getUint32(destAt, true) === 0x78563412,
      jitIns: traceCpu.jitIns,
      sourceEvent: traceEvents.some((event) =>
        event.info.sources.some((source) => source.start <= sourceAt && source.end >= sourceAt)),
      fpu: traceMachine.mem.getFloat32(fpuDest, true),
      string: traceMachine.u8.subarray(stringDest, stringDest + 4).join(','),
      lutTypes: lutInfo?.sources.map((source) => source.type),
      scalarTypes: scalarInfo?.sources.map((source) => source.type),
      clusterRanges: clusterInfo?.sources.map((source) => source.range),
      blendTypes: blendInfo?.sources.map((source) => source.type),
      scanlineTypes: scanlineInfo?.sources.map((source) => source.type),
      waveTypes: waveInfo?.sources.map((source) => source.type),
      mesh: mesh && {
        vertices: mesh.vertices, stride: mesh.stride, fields: mesh.fieldOffsets,
      },
      indices,
    })}\n`);
  }
  if (traceOk) ok++; else fail++;
  process.stdout.write(
    `Memory provenance tracing: ${traceOk ? 'match' : 'MISMATCH'}`
    + ' (JIT/x87/string, clusters, coordinate/blend/scanline/wave maps, observed xyz/index)\n',
  );

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
  const exactFrame = Number(process.env.IXA_FRAME_AT ?? 0);
  if (frameDir) mkdirSync(frameDir, { recursive: true });
  const machine = new Machine({
    partmem: partmemFor(demoname),
    clock: process.env.IXA_CLOCK ?? 'virtual',   // deterministic for headless runs
    onDebug: (m) => process.stdout.write(`    host: ${m}\n`),
    onFrame: (fb, w, h) => {
      if (!frameDir || saved >= 24) return;
      // Absolute emulated frame capture for direct comparison with an external recording.
      // copyScreen() increments machine.frames before invoking this callback, so the name
      // and selector are one-based and independent of blank-frame filtering.
      if (exactFrame > 0) {
        if (machine.frames !== exactFrame) return;
        writeFileSync(
          `${frameDir}/frame${String(exactFrame).padStart(6, '0')}.png`,
          png(fb, w, h),
        );
        saved++;
        return;
      }
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
      shouldStop: () => exactFrame > 0 && saved > 0,
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
    if (exactFrame > 0) {
      while (!cpu.halted && cpu.count < budget && saved === 0) {
        cpu.run(Math.min(2_000_000, budget - cpu.count));
      }
    } else {
      cpu.run(budget);
    }
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

function pandoraTga(raw, texture) {
  const width = texture.width ?? 256;
  const height = texture.height ?? 256;
  const header = new Uint8Array(18);
  header[2] = 2;                  // uncompressed true-colour
  new DataView(header.buffer).setUint16(12, width, true);
  new DataView(header.buffer).setUint16(14, height, true);
  header[16] = 24;
  header[17] = 0x20;             // top-left origin, as in the original Jizz dump
  const out = new Uint8Array(header.length + width * height * 3);
  out.set(header);
  out.set(
    pandoraBgr(
      raw, texture.layout, texture.sourceX ?? 0, texture.sourceY ?? 0,
      width, height, texture.monoPlane ?? 0,
    ),
    header.length,
  );
  return out;
}

/**
 * Modern equivalent of Jizz's hidden `/pandora` switch.
 *
 * Both intros generate into a small table of 192 KiB pixel work slots. Some slots are
 * converted in place or reused before TBL1, so polling only at the music handoff loses
 * an earlier completed image. Sample the tables while precalculation runs and retain the
 * first version that remains unchanged across two 2M-instruction boundaries. This is an
 * observation only: it never changes demo memory or the instruction stream.
 */
function dumpPandora(ixaPath, outDir) {
  if (!ixaPath || !outDir) {
    process.stderr.write('usage: node run.mjs pandora <file.ixa> <outdir>\n');
    return 2;
  }

  const bytes = new Uint8Array(readFileSync(ixaPath));
  const digest = sha(bytes);
  const { demoname, entries } = readIxa(bytes);
  let profile;
  try {
    profile = pandoraProfile(demoname, digest);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  const script = bytes.subarray(entries[0].pos, entries[0].pos + entries[0].size);
  const exeOps = parseScript(script).filter((op) => op.name === 'exe');
  if (exeOps.length !== 1) {
    process.stderr.write(
      `${demoname.trim()} has ${exeOps.length} executable parts; Pandora needs one\n`,
    );
    return 1;
  }

  process.stdout.write(
    `${demoname.trim()}: running precalculation and observing `
    + `${profile.textures.length} texture slots\n`,
  );

  const stop = new Error('__pandora_music_ready');
  const machine = new Machine({
    partmem: partmemFor(demoname),
    clock: 'virtual',
    onDebug: () => {},
  });
  const loaded = machine.loadExe(unpackBlock(bytes, entries[exeOps[0].args[0]]));
  let hadMusic = false;
  class PandoraJitCPU extends JitCPU {
    farCall(off, sel) {
      const result = super.farCall(off, sel);
      const ready = !hadMusic && this.machine.xm !== null;
      hadMusic = this.machine.xm !== null;
      if (ready) throw stop;
      return result;
    }
  }
  const cpu = new PandoraJitCPU(machine);
  cpu.retainTrampolineHits = false;
  cpu.reset(loaded);

  const states = new Map(profile.textures.map((texture) => [
    texture.name,
    { hash: null, dirty: false, stable: 0, raw: null, capturedAt: 0 },
  ]));

  const sample = (final = false) => {
    for (const texture of profile.textures) {
      const state = states.get(texture.name);
      const capture = texture.captureAt === undefined
        ? texture.capture ?? profile.capture ?? 'first'
        : 'instruction';
      const partmemOffset = texture.dumpPartmemOffset ?? texture.partmemOffset;
      const pointer = partmemOffset === undefined
        ? pandoraPointer(machine, loaded.base, profile, texture.slot, true)
        : machine.partmem + partmemOffset;
      if (pointer === 0) continue;
      if (pointer < 0 || pointer + PANDORA_BYTES > machine.brk) {
        throw new Error(
          `${profile.production} texture ${texture.name} has invalid pointer `
          + `0x${pointer.toString(16)}`,
        );
      }
      const raw = machine.u8.subarray(pointer, pointer + PANDORA_BYTES);

      if (capture === 'instruction') {
        if (state.raw === null && cpu.count >= texture.captureAt) {
          state.raw = raw.slice();
          state.capturedAt = cpu.count;
        }
        continue;
      }

      const hash = sha(raw);

      if (state.hash === null) {
        state.hash = hash;
        if (final) {
          state.raw = raw.slice();
          state.capturedAt = cpu.count;
        }
        continue;
      }
      if (hash !== state.hash) {
        state.hash = hash;
        state.dirty = true;
        state.stable = 0;
      } else if (state.dirty && ++state.stable >= 2 && state.raw === null
          && capture !== 'final') {
        state.raw = raw.slice();
        state.capturedAt = cpu.count;
        state.dirty = false;
      }

      if (final && (state.raw === null || capture === 'final')) {
        state.raw = raw.slice();
        state.capturedAt = cpu.count;
      }
    }
  };

  // Establish the relocated-but-not-generated baseline, then watch the decrunch in small
  // deterministic slices. Jizz reaches TBL1 at ~2.37B instructions and Stash at ~2.58B.
  sample();
  const started = performance.now();
  try {
    while (!cpu.halted && cpu.count < 20_000_000_000) {
      // Most observations use coarse deterministic slices. A few Jizz source images
      // survive only in short scratch-buffer windows, so land exactly on their recovered
      // capture counts instead of stepping over them.
      let budget = 2_000_000;
      for (const texture of profile.textures) {
        const state = states.get(texture.name);
        if (state.raw !== null || texture.captureAt === undefined
            || texture.captureAt <= cpu.count) continue;
        budget = Math.min(budget, texture.captureAt - cpu.count);
      }
      cpu.run(budget);
      sample();
    }
  } catch (error) {
    if (error !== stop) throw error;
  }
  sample(true);

  if (!machine.xm) {
    process.stderr.write('the intro did not reach its generated-XM handoff\n');
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  const manifest = {
    format: 1,
    production: profile.production,
    input: { path: ixaPath, sha256: digest },
    phase: 'first generated-XM handoff',
    instructions: cpu.count,
    elapsedSeconds: (performance.now() - started) / 1000,
    textures: [],
  };

  for (const texture of profile.textures) {
    const state = states.get(texture.name);
    if (state.raw === null) {
      throw new Error(
        `${profile.production} texture slot ${texture.slot} was never populated`,
      );
    }
    const filename = `${texture.name}.TGA`;
    writeFileSync(`${outDir}/${filename}`, pandoraTga(state.raw, texture));
    manifest.textures.push({
      file: filename,
      slot: texture.slot,
      layout: texture.layout,
      capture: texture.captureAt === undefined
        ? texture.capture ?? profile.capture ?? 'first'
        : 'instruction',
      captureRequestedAtInstruction: texture.captureAt,
      sourceX: texture.sourceX ?? 0,
      sourceY: texture.sourceY ?? 0,
      monoPlane: texture.monoPlane,
      width: texture.width ?? 256,
      height: texture.height ?? 256,
      capturedAtInstruction: state.capturedAt,
    });
  }
  writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `  wrote ${profile.textures.length} 24-bit TGA files and manifest.json to `
    + `${outDir}\n  stopped at TBL1 after ${cpu.count.toLocaleString('en-US')} instructions `
    + `(${manifest.elapsedSeconds.toFixed(2)} s)\n`,
  );
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'verify') process.exit(verify());
else if (cmd === 'dumpxm') process.exit(dumpXm(rest[0], rest[1]));
else if (cmd === 'renderxm') process.exit(renderXm(rest[0], rest[1], Number(rest[2] ?? 30)));
else if (cmd === 'pandora') process.exit(dumpPandora(rest[0], rest[1]));
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
