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
import { RunSessionManager } from './lib/run-session.js';

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
