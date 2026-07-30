// FastTracker II (.XM) replayer.
// SPDX-FileCopyrightText: 2016-2026 Olav Sørensen
// SPDX-FileCopyrightText: 2026 Jasper Schelling
// SPDX-License-Identifier: BSD-3-Clause
//
// Replay behavior is ported from ft2-clone's BSD-licensed replayer, which in turn
// reproduces the original FT2 routines and their documented quirks. The audio mixer is
// intentionally native JavaScript (linear interpolation and Float32 output), but tracker
// timing, effect memory, envelopes and instrument modulation follow FT2.
//
// The replayer is deliberately free of Web Audio: it fills Float32 buffers, so it runs
// in an AudioWorklet, a worker, or Node for testing.

const VIBRATO_TABLE = new Uint8Array([
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
]);
const ARPEGGIO_TABLE = new Uint8Array([
  0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0,
  // FT2's 16-byte table is followed by these bytes in the original executable.
  0x00, 0x18, 0x31, 0x4a, 0x61, 0x78, 0x8d, 0xa1,
  0xb4, 0xc5, 0xd4, 0xe0, 0xeb, 0xf4, 0xfa, 0xfd,
]);
const AUTO_VIB_SINE = Int8Array.from(
  { length: 256 }, (_, i) => Math.round(64 * Math.sin(-i * Math.PI * 2 / 256)));
const FT2_LOG_TABLE = Uint32Array.from(
  { length: 768 }, (_, i) => Math.round(16777216 * Math.pow(2, i / 768)));
const FT2_FREQUENCY_MUL = Math.round(256 * 65536 / 44000 * 8363);
const FT2_FREQUENCY_DIV = Math.round(65536 * 1712 / 44000 * 8363);
const FT2_SQRT_PANNING = Float32Array.from(
  { length: 257 }, (_, i) => Math.round(65536 * Math.sqrt(i / 256)) / 65536);
const EMPTY_SAMPLE = Object.freeze({
  pcm: new Float32Array(0),
  frames: 0,
  loopType: 0,
  loopStart: 0,
  loopLength: 0,
  loopEnd: 0,
  volume: 0,
  finetune: 0,
  panning: 128,
  relativeNote: 0,
});

// Bit-exact ft2-clone/FastTracker II Amiga period table. It is stored as little-endian
// base64 to keep the standalone AudioWorklet source compact; the linear table is exactly
// `(1936-index)*4` and does not need storage.
const AMIGA_PERIOD_LUT = decodeU16Base64(
  'YHHwcIBwIHDAb1Bv4G6AbiBuwG1gbfBsgGwgbMBrYGsAa6BqQGrgaYBpIGnAaGBoAGigZ0Bn4GaAZiBmwGVgZQBloGRAZOBjgGMw'
  + 'Y+BigGIgYsBhYGEQYcBgYGAAYKBfQF/wXqBeUF4AXqBdQF3wXKBcUFwAXKBbQFvwWqBaUFoAWrBZYFkAWaBYUFgAWLBXYFcQV8BW'
  + 'cFYgVtBVgFUgVcBUkFRgVBBUwFNwUyBT0FKAUjBS4FGgUWBREFHAUGBQAFDAT4BPQE8AT8BOgE4wTuBNoE1gTRBNwEyATEBM4EuA'
  + 'S1BLIEvgSqBKUEoASsBJgElASQBJwEiASDBI4EeQR0BHEEfgRqBGYEYgRuBFoEVgRSBF4ESgRGBEIETgQ5BDQEMQQ+BCsEKAQkBC'
  + 'AELAQYBBQEEAQcBAgEBQQCBA0D+AP1A/ID/wPsA+gD5APgA+wD2QPWA9ID3gPLA8gDxAPAA80DugO3A7QDsAO8A6kDpgOiA64Dmw'
  + 'OYA5UDkgOeg4sDh4OEA4EDjgN6g3cDdANxA34DawNng2QDYQNuA1sDWANVA1IDXwNMA0kDRgNDA0ADTQM6AzcDNAMxAz4DKwMoAy'
  + 'UDIgMvAxwDGYMXAxQDEQMeAwsDCIMGAwMDAAMNAvoC94L1AvKC8AL9AuoC54LlAuKC4ALtAtoC14LVAtKC0ALdgssCyALFAsKCwA'
  + 'LNgrsCuIK2ArOCsQK+gqwCqQKmAqSCowKggq4Cm4KZApaClAKRgp8CjQKLAoiChgKDAoACjgJ8AnoCeAJ2AnQCcYJ/Am0CawJogm'
  + 'YCZAJiAm8CXAJaglkCVwJVAlKCUAJeAkwCSgJIAkYCRAJBgk8CPII6AjiCNwI1AjMCMQI/Ai0CKwIpAicCJQIjAiECLwIcghoCGI'
  + 'IXAhWCFAISAhACHgIMAgoCCAIGAgQCAoIBAg6B/AH6gfkB94H2AfQB8gHwAf4B7IHrAekB5wHlgeQB4gHgAe6B3QHbgdoB2AHWAd'
  + 'SB0wHRAd8BzYHMAcqByQHHQcWBw8HCAcCBzwG9QbuBugG4gbcBtYGzwbIBsIG/Aa2BrAGqgakBp4GmAaSBowGhgaABroGdAZuBmg'
  + 'GYgZcBlYGUAZKBkQGfgY4BjMGLgYoBiIGHAYWBhEGDAYGBgAGOgX0Be8F6gXlBeAF2gXUBc8FygXFBcAF+gW0Ba8FqgWlBaAFmwW'
  + 'WBZAFigWFBYAFuwV2BXEFbAVnBWIFXQVYBVIFTAVJBUYFQQV8BTcFMgUtBSgFIwUeBRoFFgURBQwFBgUABTwE+AT0BPAE7AToBOM'
  + 'E3gTaBNYE0QTMBMgExAT+BLgEtQSyBK4EqgSlBKAEnASYBJQEkASMBIgEgwS+BHkEdARxBG4EagRmBGIEXgRaBFYEUgROBEoERgR'
  + 'CBH4EOQQ0BDEELgQrBCgEJAQgBBwEGAQUBBAEDAQIBAUEAgQ9A/gD9QPyA+8D7APoA+QD4APcA9kD1gPSA84DywPIA8QDwAP9A7o'
  + 'DtwO0A7ADrAOpA6YDogOeA5sDmAOVA5IDjoOLA4eDhAOBA74DeoN3A3QDcQNuA2sDZ4NkA2EDXgNbA1gDVQNSA08DTANJA0YDQwN'
  + 'AA30DOgM3AzQDMQMuAysDKAMlAyIDHwMcAxmDFwMUAxEDDgMLAwiDBgMDAwADPQL6AveC9QLygvAC7QLqAueC5QLiguAC3QLaAte'
  + 'C1QLSgtACzYLLAsgCxQLCgsAC/YK7AriCtgKzgrECroKsAqkCpgKkgqMCoIKeApuCmQKWgpQCkYKPAo0CiwKIgoYCgwKAAr4CfAJ'
  + '6AngCdgJ0AnGCbwJtAmsCaIJmAmQCYgJfAlwCWoJZAlcCVQJSglACTgJMAkoCSAJGAkQCQYJ/AjyCOgI4gjcCNQIzAjECLwItAis'
  + 'CKQInAiUCIwIhAh8CHIIaAhiCFwIVghQCEgIQAg4CDAIKAggCBgIEAgKCAQI+gfwB+oH5AfeB9gH0AfIB8AHuAeyB6wHpAecB5YH'
  + 'kAeIB4AHegd0B24HaAdgB1gHUgdMB0QHPAc2BzAHKgckBx0HFgcPBwgHAgf8BvUG7gboBuIG3AbWBs8GyAbCBrwGtgawBqoGpAae'
  + 'BpgGkgaMBoYGgAZ6BnQGbgZoBmIGXAZWBlAGSgZEBj4GOAYzBi4GKAYiBhwGFgYRBgwGBgYABvoF9AXvBeoF5QXgBdoF1AXPBcoF'
  + 'xQXABboFtAWvBaoFpQWgBZsFlgWQBYoFhQWABXsFdgVxBWwFZwViBV0FWAVSBUwFSQVGBUEFPAU3BTIFLQUoBSMFHgUaBRYFEQUM'
  + 'BQYFAAX8BPgE9ATwBOwE6ATjBN4E2gTWBNEEzATIBMQEvgS4BLUEsgSuBKoEpQSgBJwEmASUBJAEjASIBIMEfgR5BHQEcQRuBGoE'
  + 'ZgRiBF4EWgRWBFIETgRKBEYEQgQ+BDkENAQxBC4EKwQoBCQEIAQcBBgEFAQQBAwECAQFBAIE/QP4A/UD8gPvA+wD6APkA+AD3APZ'
  + 'A9YD0gPOA8sDyAPEA8ADvQO6A7cDtAOwA6wDqQOmA6IDngObA5gDlQOSA44DiwOHA4QDgQN+A3oDdwN0A3EDbgNrA2cDZANhA14D'
  + 'WwNYA1UDUgNPA0wDSQNGA0MDQAM9AzoDNwM0AzEDLgMrAygDJQMiAx8DHAMZAxcDFAMRAw4DCwMIAwYDAwMAA/0C+gL3AvUC8gLw'
  + 'Au0C6gLnAuUC4gLgAt0C2gLXAtUC0gLQAs0CywLIAsUCwgLAAr0CuwK4ArYCswKxAq4CrAKpAqYCpAKjAqACngKbApkClgKUApEC'
  + 'jwKNAosCiAKGAoMCgAJ+AnwCegJ4AnYCdAJxAm8CbQJrAmgCZgJkAmICXwJcAloCWQJXAlUCUgJQAk4CTAJKAkgCRgJEAkECPwI8'
  + 'AjoCOAI3AjUCMwIxAi8CLQIrAikCJwIlAiMCIQIfAhwCGgIYAhcCFQIUAhICEAIOAgwCCgIIAgYCBAICAgEC/gH8AfoB+QH3AfYB'
  + '9AHyAfAB7gHsAesB6QHnAeUB5AHiAeAB3gHdAdsB2gHYAdYB1AHTAdEBzwHNAcwBygHJAccBxQHDAcIBwAG/Ab0BuwG5AbgBtgG1'
  + 'AbMBsgGwAa8BrQGsAaoBqQGnAaYBpAGjAaEBoAGeAZ0BmwGaAZgBlwGVAZQBkgGRAY8BjgGMAYsBiQGIAYYBhQGEAYMBgQGAAX4B'
  + 'fQF7AXoBeQF4AXYBdQFzAXIBcQFwAW4BbQFrAWoBaQFoAWYBZQFjAWIBYQFgAV4BXQFcAVsBWQFYAVcBVgFUAVMBUgFRAVABTwFN'
  + 'AUwBSwFKAUgBRwFGAUUBRAFDAUEBQAE/AT4BPQE8ATsBOgE4ATcBNgE1ATQBMwEyATEBLwEuAS0BLAErASoBKQEoAScBJgElASQB'
  + 'IwEiASABHwEeAR0BHAEbARoBGQEYARcBFgEVARQBEwESAREBEAEPAQ4BDQEMAQsBCgEKAQkBCAEHAQYBBQEEAQMBAgEBAQAB/wD+'
  + 'AP0A/AD7APsA+gD5APgA9wD2APUA9ADzAPIA8gDxAPAA7wDuAO0A7QDsAOsA6gDpAOgA5wDmAOYA5QDkAOMA4wDiAOEA4ADfAN4A'
  + '3gDdANwA2wDbANoA2QDYANcA1gDWANUA1ADTANMA0gDRANAA0ADPAM4AzQDNAMwAywDKAMoAyQDIAMcAxwDGAMYAxQDEAMMAwwDC'
  + 'AMEAwADAAL8AvgC9AL0AvAC8ALsAugC5ALkAuAC4ALcAtgC1ALUAtAC0ALMAswCyALEAsACwAK8ArwCuAK0ArACsAKsAqwCqAKkA'
  + 'qQCpAKgApwCmAKYApQClAKQApACjAKMAogChAKAAoACfAJ8AngCeAJ0AnQCcAJwAmwCbAJoAmQCYAJgAlwCXAJYAlgCVAJUAlACU'
  + 'AJMAkwCSAJIAkQCRAJAAkACPAI4AjgCOAI0AjQCMAIwAiwCLAIoAigCJAIkAiACIAIcAhgCGAIYAhQCFAIQAhACDAIMAggCCAIEA'
  + 'gQCAAIAAfwB/AH4AfgB9AH0AfAB8AHsAewB7AHsAegB6AHkAeQB4AHgAdwB3AHYAdgB1AHUAdQB1AHQAdABzAHMAcgByAHEAcQBw'
  + 'AHAAcABwAG8AbwBuAG4AbQBtAGwAbABsAGwAawBrAGoAagBpAGkAaQBpAGgAaABnAGcAZgBmAGYAZgBlAGUAZABkAGMAYwBjAGMA'
  + 'YgBiAGEAYQBhAGEAYABgAF8AXwBfAF8AXgBeAF0AXQBdAF0AXABcAFsAWwBbAFsAWgBaAFkAWQBZAFkAWABYAFcAVwBXAFcAVgBW'
  + 'AFUAVQBVAFUAVABUAFQAVABTAFMAUgBSAFIAUgBRAFEAUQBRAFAAUABPAE8ATwBPAE4ATgBOAE4ATQBNAE0ATQBMAEwASwBLAEsA'
  + 'SwBLAEsASgBKAEkASQBJAEkASABIAEgASABHAEcARwBHAEYARgBGAEYARQBFAEUARQBEAEQARABEAEMAQwBDAEMAQgBCAEIAQgBB'
  + 'AEEAQQBBAEAAQABAAEAAPwA/AD8APwA/AD8APgA+AD4APgA9AD0APQA9ADwAPAA8ADwAPAA8ADsAOwA7ADsAOgA6ADoAOgA5ADkA'
  + 'OQA5ADkAOQA4ADgAOAA4ADcANwA3ADcANwA3ADYANgA2ADYANQA1ADUANQA1ADUANAA0ADQANAA0ADQAMwAzADMAMwAyADIAMgAy'
  + 'ADIAMgAxADEAMQAxADEAMQAwADAAMAAwADAAMAAvAC8ALwAvAC8ALwAuAC4ALgAuAC4ALgAtAC0ALQAtAC0ALQAsACwALAAsACwA'
  + 'LAArACsAKwArACsAKwAqACoAKgAqACoAKgAqACoAKQApACkAKQApACkAKAAoACgAKAAoACgAJwAnACcAJwAnACcAJwAnACYAJgAm'
  + 'ACYAJgAmACYAJgAlACUAJQAlACUAJQAkACQAJAAkACQAJAAkACQAIwAjACMAIwAjACMAIwAjACIAIgAiACIAIgAiACIAIgAhACEA'
  + 'IQAhACEAIQAhACEAIAAgACAAIAAgACAAIAAgACAAIAAfAB8AHwAfAB8AHwAfAB8AHgAeAB4AHgAeAB4AHgAeAB4AHgAdAB0AHQAd'
  + 'AB0AHQAdAB0AHQAdABYAEAAIAAAAEAAgABgAEAAIAAAAEAAgABgAEAAIAAAAAAA=');

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

export class XmPlayer {
  constructor(bytes, sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.unsupported = new Set();
    this.parse(bytes);
    this.reset();
  }

  // --------------------------------------------------------------------- parsing

  parse(b) {
    if (String.fromCharCode(...b.subarray(0, 17)) !== 'Extended Module: ') {
      throw new Error('not an XM module');
    }
    this.title = String.fromCharCode(...b.subarray(17, 37)).replace(/\0.*$/, '').trim();
    this.tracker = String.fromCharCode(...b.subarray(38, 58)).replace(/\0.*$/, '').trim();

    const version = u16(b, 0x3a);
    if (version < 0x0102 || version > 0x0104) {
      throw new Error(`unsupported XM version 0x${version.toString(16)}`);
    }
    if (version !== 0x0104) {
      throw new Error('XM 1.02/1.03 instrument-first layout is not supported');
    }
    const headerSize = u32(b, 0x3c);
    this.songLength = Math.min(255, u16(b, 0x40) || 1);
    this.restart = u16(b, 0x42);
    const fileChannels = u16(b, 0x44);
    if (fileChannels === 0) throw new Error('XM has no channels');
    this.channels = Math.max(2, Math.min(32, fileChannels + (fileChannels & 1)));
    const numPatterns = u16(b, 0x46);
    const numInstruments = u16(b, 0x48);
    if (numPatterns > 256 || numInstruments > 256) {
      throw new Error('XM exceeds FT2 pattern/instrument limits');
    }
    this.flags = u16(b, 0x4a);
    this.defaultSpeed = Math.max(1, Math.min(31, u16(b, 0x4c)));
    this.defaultBpm = Math.max(32, Math.min(255, u16(b, 0x4e)));
    this.linearPeriods = (this.flags & 1) !== 0;

    const allOrders = Array.from(b.subarray(0x50, 0x150));
    for (let i = 255; i >= 0 && allOrders[i] === 0xff; i--) {
      if (this.songLength > i) this.songLength = i;
    }
    if (this.songLength < 1) this.songLength = 1;
    this.order = allOrders.slice(0, this.songLength);
    if (this.restart >= this.songLength) this.restart = 0;

    // --- patterns ---
    let at = 60 + headerSize;
    this.patterns = [];
    for (let p = 0; p < numPatterns; p++) {
      const hlen = u32(b, at);
      const rows = Math.min(256, u16(b, at + 5) || 64);
      const packed = u16(b, at + 7);
      const data = b.subarray(at + hlen, at + hlen + packed);
      this.patterns.push(this.unpackPattern(data, rows, fileChannels));
      at += hlen + packed;
    }

    // --- instruments ---
    this.instruments = [];
    for (let i = 0; i < numInstruments; i++) {
      const ihdr = u32(b, at);
      const instrumentSize = ihdr === 0 ? 263 : ihdr;
      const instrumentReadSize = ihdr === 0 ? 263 : Math.min(263, ihdr);
      const ib = (offset) => offset < instrumentReadSize ? (b[at + offset] ?? 0) : 0;
      const iu16 = (offset) =>
        offset + 1 < instrumentReadSize ? u16(b, at + offset) : 0;
      const numSamples = iu16(27);
      if ((numSamples & 0x8000) || numSamples > 32 || (ihdr & 0x80000000)) {
        throw new Error('corrupt XM instrument header');
      }
      const inst = {
        samples: [], keymap: new Uint8Array(96),
        volEnv: null, panEnv: null, fadeout: 0,
        volEnvFlags: 0, panEnvFlags: 0,
        autoVibType: 0, autoVibSweep: 0, autoVibDepth: 0, autoVibRate: 0,
        mute: false,
      };

      if (numSamples > 0) {
        const shdrSize = 40;
        for (let k = 0; k < 96; k++) inst.keymap[k] = ib(33 + k);
        for (let k = 0; k < inst.keymap.length; k++) {
          if (inst.keymap[k] >= 16) inst.keymap[k] = 15;
        }
        const readEnvelope = (
          pointsAt, lengthAt, sustainAt, loopStartAt, loopEndAt, flagsAt, maxValue,
        ) => {
          const flags = ib(flagsAt);
          const num = Math.min(12, ib(lengthAt));
          if (!(flags & 1) || num === 0) return null;
          const points = new Uint16Array(12 * 2);
          for (let k = 0; k < 12; k++) {
            points[k * 2] = Math.min(32767, iu16(pointsAt + k * 4));
            points[k * 2 + 1] = Math.min(
              maxValue,
              iu16(pointsAt + k * 4 + 2),
            );
          }
          return {
            points, num,
            sustain: (flags & 2) ? Math.min(11, ib(sustainAt)) : -1,
            loopStart: (flags & 4) ? Math.min(11, ib(loopStartAt)) : -1,
            loopEnd: (flags & 4) ? Math.min(11, ib(loopEndAt)) : -1,
          };
        };
        inst.volEnvFlags = ib(233);
        inst.panEnvFlags = ib(234);
        inst.volEnv = readEnvelope(129, 225, 227, 228, 229, 233, 64);
        inst.panEnv = readEnvelope(177, 226, 230, 231, 232, 234, 63);
        inst.autoVibType = ib(235) > 3 ? 0 : ib(235);
        inst.autoVibSweep = ib(236);
        inst.autoVibDepth = Math.min(15, ib(237));
        inst.autoVibRate = Math.min(63, ib(238));
        inst.fadeout = iu16(239);
        inst.mute = ib(247) === 1;

        let sat = at + instrumentSize;
        const headers = [];
        for (let s = 0; s < numSamples; s++) {
          headers.push({
            length: u32(b, sat),
            loopStart: u32(b, sat + 4),
            loopLength: u32(b, sat + 8),
            volume: b[sat + 12],
            finetune: (b[sat + 13] << 24) >> 24,
            type: b[sat + 14],
            panning: b[sat + 15],
            relativeNote: (b[sat + 16] << 24) >> 24,
            reserved: b[sat + 17],
          });
          sat += shdrSize;
        }
        for (let sampleIndex = 0; sampleIndex < headers.length; sampleIndex++) {
          const h = headers[sampleIndex];
          const sixteen = (h.type & 16) !== 0;
          const stereo = (h.type & 32) !== 0;
          const adpcm = h.reserved === 0xad && !sixteen && !stereo;
          const storedSamples = sixteen ? h.length >> 1 : h.length;
          const frames = stereo ? storedSamples >> 1 : storedSamples;
          const pcm = new Float32Array(frames);
          if (adpcm) {
            const delta = new Int8Array(16);
            for (let k = 0; k < 16; k++) delta[k] = b[sat + k];
            let old = 0, out = 0;
            for (let k = 0; out < frames; k++) {
              const packed = b[sat + 16 + k] ?? 0;
              old = (old + delta[packed & 15]) << 24 >> 24;
              pcm[out++] = old / 128;
              if (out < frames) {
                old = (old + delta[packed >> 4]) << 24 >> 24;
                pcm[out++] = old / 128;
              }
            }
            sat += 16 + Math.ceil(frames / 2);
          } else if (stereo) {
            const bytesPerSample = sixteen ? 2 : 1;
            const rightAt = sat + frames * bytesPerSample;
            let leftOld = 0, rightOld = 0;
            for (let k = 0; k < frames; k++) {
              if (sixteen) {
                leftOld = (leftOld + ((u16(b, sat + k * 2) << 16) >> 16)) << 16 >> 16;
                rightOld =
                  (rightOld + ((u16(b, rightAt + k * 2) << 16) >> 16)) << 16 >> 16;
                pcm[k] = ((leftOld + rightOld) >> 1) / 32768;
              } else {
                leftOld = (leftOld + ((b[sat + k] << 24) >> 24)) << 24 >> 24;
                rightOld =
                  (rightOld + ((b[rightAt + k] << 24) >> 24)) << 24 >> 24;
                pcm[k] = ((leftOld + rightOld) >> 1) / 128;
              }
            }
            sat += h.length;
          } else {
            // Normal XM sample data is delta encoded.
            let old = 0;
            if (sixteen) {
              for (let k = 0; k < frames; k++) {
                old = (old + ((u16(b, sat + k * 2) << 16) >> 16)) & 0xffff;
                pcm[k] = ((old << 16) >> 16) / 32768;
              }
            } else {
              for (let k = 0; k < frames; k++) {
                old = (old + ((b[sat + k] << 24) >> 24)) & 0xff;
                pcm[k] = ((old << 24) >> 24) / 128;
              }
            }
            sat += h.length;
          }

          let loopType = h.type & 3;
          if (loopType === 3) loopType = 2; // both bits means ping-pong in FT2
          let loopStart = sixteen ? h.loopStart >> 1 : h.loopStart;
          let loopLength = sixteen ? h.loopLength >> 1 : h.loopLength;
          if (stereo) {
            loopStart >>= 1;
            loopLength >>= 1;
          }
          const validLoop = loopStart >= 0 && loopLength > 0
            && loopStart + loopLength <= frames;
          if (!validLoop) loopType = 0;
          if (sampleIndex < 16) {
            inst.samples.push({
              pcm,
              frames,
              loopType,
              loopStart: validLoop ? loopStart : 0,
              loopLength: validLoop ? loopLength : 0,
              loopEnd: validLoop ? loopStart + loopLength : 0,
              volume: Math.min(64, h.volume),
              finetune: h.finetune,
              panning: h.panning,
              relativeNote: Math.max(-48, Math.min(71, h.relativeNote)),
            });
          }
        }
        at = sat;
      } else {
        at += instrumentSize;
      }
      if (i < 128) this.instruments.push(inst);
    }

    this.totalRows = this.order.reduce(
      (sum, p) => sum + (this.patterns[p]?.rows ?? 64), 0);
  }

  /** Decode FT2's packed pattern representation into a flat cell array. */
  unpackPattern(data, rows, sourceChannels = this.channels) {
    const cells = new Uint8Array(rows * this.channels * 5);
    let j = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < sourceChannels; c++) {
        if (j >= data.length) continue;
        const cell = [0, 0, 0, 0, 0];
        const n = data[j++];
        if (n & 0x80) {
          if (n & 1) cell[0] = data[j++] ?? 0;
          if (n & 2) cell[1] = data[j++] ?? 0;
          if (n & 4) cell[2] = data[j++] ?? 0;
          if (n & 8) cell[3] = data[j++] ?? 0;
          if (n & 16) cell[4] = data[j++] ?? 0;
        } else {
          cell[0] = n;
          for (let k = 1; k < 5; k++) cell[k] = data[j++] ?? 0;
        }
        if (cell[0] > 97) cell[0] = 0;
        if (cell[1] > 128) cell[1] = 0;
        if (cell[3] > 35) cell[3] = cell[4] = 0;
        if (c < this.channels) {
          const out = (r * this.channels + c) * 5;
          cells.set(cell, out);
        }
      }
    }
    if (!cells.some((value) => value !== 0)) {
      return { rows: 64, cells: new Uint8Array(64 * this.channels * 5) };
    }
    return { rows, cells };
  }

  // ------------------------------------------------------------------- playback

  reset() {
    this.speed = this.defaultSpeed;       // ticks per row
    this.bpm = this.defaultBpm;
    this.globalVolume = 64;

    this.position = 0;                    // index into the order table
    this.row = 0;
    this.tick = 0;
    this.patternDelaySet = 0;
    this.patternDelayRemaining = 0;
    this.positionJump = false;
    this.positionJumpTarget = -1;
    this.patternBreakPosition = 0;
    this.patternBreak = false;
    this.repeatRow = false;
    this.ended = false;
    this.loops = 0;

    this.setTickDuration(this.bpm);
    this.tickSampleCarry = 0;
    this.tickRemainder = 0;

    this.ch = [];
    for (let i = 0; i < this.channels; i++) {
      this.ch.push({
        instrument: 0, inst: null, sample: null,
        mute: false,
        note: 0, relativeNote: 0, finetune: 0,
        period: 0, outPeriod: 0, frequency: 0,
        pos: 0, dir: 1, playing: false,
        volume: 0, outVolume: 0, panning: 128, finalPan: 128,
        oldVolume: 0, oldPanning: 128,
        portaTarget: 0, portaSpeed: 0, portaDirection: 0,
        pitchUp: 0, pitchDown: 0, finePitchUp: 0, finePitchDown: 0,
        extraFineUp: 0, extraFineDown: 0, glissando: false,
        vibPos: 0, vibSpeed: 0, vibDepth: 0, vibWave: 0,
        tremPos: 0, tremSpeed: 0, tremDepth: 0, tremWave: 0,
        volSlide: 0, panSlide: 0, globalVolSlide: 0,
        fineVolUp: 0, fineVolDown: 0,
        sampleOffset: 0,
        retrigSpeed: 0, retrigVolume: 0, retrigCount: 0,
        tremorParam: 0, tremorPos: 0,
        noteCut: -1, noteDelay: -1, delayed: null,
        effect: 0, param: 0, volColumn: 0,
        patternLoopRow: 0, patternLoopCount: 0,
        volEnv: null, volEnvTick: 0xffff, volEnvPos: 0,
        volEnvValue: 0, volEnvDelta: 0, envVal: 64,
        panEnv: null, panEnvTick: 0xffff, panEnvPos: 0,
        panEnvValue: 0, panEnvDelta: 0, panEnvVal: 32,
        fadeout: 0, fadeVol: 32768, keyOff: false,
        autoVibPos: 0, autoVibAmp: 0, autoVibSweep: 0,
      });
    }
  }

  /**
   * The 0..64 an envelope asks for at tick `pos`.
   *
   * FT2 interpolates in signed 8.8 fixed point: it truncates the slope once and accumulates
   * that value on every tick, then snaps to the exact value at the next point. Computing
   * the same accumulated value directly avoids carrying FT2's separate value/delta fields
   * while retaining its rounding.
   */
  envelopeAt(env, pos) {
    const p = env.points;
    if (pos <= p[0]) return p[1];
    for (let k = 1; k < env.num; k++) {
      const frame = p[k * 2];
      if (pos === frame) return p[k * 2 + 1];
      if (pos < frame) {
        const prevFrame = p[(k - 1) * 2], prevVal = p[(k - 1) * 2 + 1];
        const span = frame - prevFrame;
        if (span <= 0) return p[k * 2 + 1];
        const delta8 = Math.trunc(((p[k * 2 + 1] - prevVal) * 256) / span);
        return clamp((prevVal * 256 + delta8 * (pos - prevFrame)) / 256);
      }
    }
    return p[(env.num - 1) * 2 + 1];
  }

  periodAt(index) {
    if (index < 0 || index >= 1936) return 0;
    return this.linearPeriods ? (1936 - index) * 4 : AMIGA_PERIOD_LUT[index];
  }

  periodOf(note, sample, finetune = sample.finetune) {
    const relativeNote = note + sample.relativeNote;
    if (relativeNote < 1 || relativeNote >= 120) return null;
    const fine = ((finetune >> 3) + 16);
    const index = (relativeNote - 1) * 16 + fine;
    return this.periodAt(index);
  }

  frequencyOf(period) {
    period = Math.trunc(period) & 0xffff;
    if (period === 0) return 0;

    let ft2Delta;
    if (this.linearPeriods) {
      const inverse = (9216 - period) & 0xffff;
      const quotient = Math.floor(inverse / 768);
      const remainder = inverse % 768;
      const shift = (14 - quotient) & 31;
      ft2Delta = Math.floor(
        FT2_LOG_TABLE[remainder] * FT2_FREQUENCY_MUL / 16777216,
      ) >>> 0;
      ft2Delta >>>= shift;
    } else {
      ft2Delta = Math.floor(FT2_FREQUENCY_DIV / period);
    }

    // ft2-clone scales the original 16.16 delta at 44kHz to a 32.32 mixer delta.
    // Round at the same boundary, then expose it as a frequency for this float mixer.
    const deltaMul = 65536 * 44000 / this.sampleRate;
    const voiceDelta = Math.round(ft2Delta * deltaMul);
    return voiceDelta * this.sampleRate / 4294967296;
  }

  /**
   * Original FT2 derives tick duration from an integer sample count at its 44 kHz SB16
   * reference rate, then ft2-clone scales that duration to the output rate.
   */
  samplesPerTickAt(bpm) {
    const referenceRate = 44000;
    const referenceSamples = Math.trunc((referenceRate * 2.5) / bpm);
    return this.sampleRate * referenceSamples / referenceRate;
  }

  setTickDuration(bpm) {
    this.samplesPerTick = this.samplesPerTickAt(bpm);
    this.samplesPerTickInt = Math.floor(this.samplesPerTick);
    this.samplesPerTickFrac = this.samplesPerTick - this.samplesPerTickInt;
  }

  nextTickLength() {
    let length = this.samplesPerTickInt;
    this.tickSampleCarry += this.samplesPerTickFrac;
    if (this.tickSampleCarry >= 1) {
      this.tickSampleCarry -= 1;
      length++;
    }
    return length;
  }

  /** Recompute a channel's frequency after tracker and instrument modulation. */
  updateFrequency(c) {
    c.period = Math.trunc(c.period) & 0xffff;
    c.outPeriod = Math.trunc(c.outPeriod) & 0xffff;
    let finalPeriod = c.outPeriod;
    const inst = c.inst;
    if (inst && inst.autoVibDepth > 0) {
      let amp;
      if (c.autoVibSweep > 0) {
        amp = c.autoVibSweep;
        if (!c.keyOff) {
          amp += c.autoVibAmp;
          const maximum = inst.autoVibDepth << 8;
          if ((amp >> 8) > inst.autoVibDepth) {
            amp = maximum;
            c.autoVibSweep = 0;
          }
          c.autoVibAmp = amp;
        }
      } else {
        amp = c.autoVibAmp;
      }
      c.autoVibPos = (c.autoVibPos + inst.autoVibRate) & 255;
      let wave;
      if (inst.autoVibType === 1) wave = c.autoVibPos > 127 ? 64 : -64;
      else if (inst.autoVibType === 2) wave = (((c.autoVibPos >> 1) + 64) & 127) - 64;
      else if (inst.autoVibType === 3) wave = ((-(c.autoVibPos >> 1) + 64) & 127) - 64;
      else wave = AUTO_VIB_SINE[c.autoVibPos];
      finalPeriod = (finalPeriod + ((wave * amp) >> 14)) & 0xffff;
      if (finalPeriod >= 32000) finalPeriod = 0;
    }
    c.frequency = finalPeriod === 0 ? 0 : this.frequencyOf(finalPeriod);
  }

  resetInstrument(c) {
    if (!(c.vibWave & 4)) c.vibPos = 0;
    if (!(c.tremWave & 4)) c.tremPos = 0;
    c.retrigCount = 0;
    c.tremorPos = 0;
    c.keyOff = false;
    c.volEnv = c.inst?.volEnv ?? null;
    c.panEnv = c.inst?.panEnv ?? null;
    c.volEnvTick = c.panEnvTick = 0xffff;
    c.volEnvPos = c.panEnvPos = 0;
    c.volEnvValue = c.volEnvDelta = 0;
    c.panEnvValue = c.panEnvDelta = 0;
    c.envVal = c.volEnv ? this.envelopeAt(c.volEnv, 0) : 64;
    c.panEnvVal = c.panEnv ? this.envelopeAt(c.panEnv, 0) : 32;
    c.fadeout = c.inst?.fadeout ?? 0;
    c.fadeVol = 32768;
    c.autoVibPos = 0;
    c.autoVibAmp = 0;
    const depth = c.inst?.autoVibDepth ?? 0;
    const sweep = c.inst?.autoVibSweep ?? 0;
    c.autoVibSweep = depth > 0 && sweep > 0
      ? Math.trunc((depth << 8) / sweep)
      : 0;
    if (depth > 0 && sweep === 0) c.autoVibAmp = depth << 8;
  }

  /** Restore the current sample's base volume and panning, as FT2 resetVolumes() does. */
  resetVolumes(c) {
    c.volume = c.outVolume = c.oldVolume;
    c.panning = c.finalPan = c.oldPanning;
  }

  selectSample(c, note, sampleIndex = null) {
    const inst = c.inst;
    if (note < 1 || note > 96) return null;
    if (!inst || !inst.samples.length) return EMPTY_SAMPLE;
    // Instrument inspectors need to audition a particular physical sample while retaining
    // all other XI behavior. Normal song playback always leaves this override null and
    // follows the instrument's 96-note keymap.
    if (sampleIndex !== null) return inst.samples[sampleIndex] ?? EMPTY_SAMPLE;
    const which = inst.keymap[note - 1] & 15;
    return inst.samples[which] ?? inst.samples[0] ?? EMPTY_SAMPLE;
  }

  triggerNote(c, note, instrumentIndex = 0, fx = 0, param = 0, sampleIndex = null) {
    const changedInstrument = instrumentIndex > 0
      && instrumentIndex <= Math.min(128, this.instruments.length);
    if (changedInstrument) c.instrument = instrumentIndex;
    if (note === 0) {
      note = c.note;
      if (note === 0) return false;
    }
    c.note = note;
    const playbackNote = note > 96 ? 96 : note;
    c.inst = this.instruments[c.instrument - 1] ?? null;
    c.mute = c.inst?.mute ?? false;
    if (playbackNote >= 1) {
      const selected = this.selectSample(c, playbackNote, sampleIndex);
      if (selected) {
        c.sample = selected;
        c.relativeNote = selected.relativeNote;
      }
    }
    if (playbackNote >= 1 && c.sample) {
      const relativeNote = playbackNote + c.sample.relativeNote;
      if (relativeNote < 1 || relativeNote >= 120) return false;
      c.oldVolume = Math.min(64, c.sample.volume);
      c.oldPanning = c.sample.panning;
      if (fx === 0xe && (param >> 4) === 5) {
        c.finetune = ((param & 15) << 4) - 128;
      } else {
        c.finetune = c.sample.finetune;
      }
      const period = this.periodOf(playbackNote, c.sample, c.finetune);
      if (period == null) return false;
      c.period = c.outPeriod = period;

      if (fx === 9) {
        if (param) c.sampleOffset = param;
        c.pos = c.sampleOffset << 8;
      } else {
        c.pos = 0;
      }
      c.dir = 1;
      const sampleEnd = c.sample.loopType ? c.sample.loopEnd : c.sample.frames;
      c.playing = c.sample.frames > 0 && c.pos < sampleEnd;
    }
    this.updateFrequency(c);
    return true;
  }

  /**
   * Put a dedicated player into XI-style instrument audition mode.
   *
   * The song patterns are replaced by silence so they cannot introduce other voices, but
   * tick timing remains active: sample loops, volume/panning envelopes, auto-vibrato and
   * fadeout consequently take exactly the same path as ordinary module playback.
   * `sampleIndex` is an inspector-only physical-sample override; omit it to use the XI
   * keymap normally.
   */
  startInstrumentAudition(instrumentIndex, note, sampleIndex = null) {
    this.reset();
    this.patterns = [{
      rows: 64,
      cells: new Uint8Array(64 * this.channels * 5),
    }];
    this.order = [0];
    this.songLength = 1;
    this.restart = 0;

    const c = this.ch[0];
    if (!this.triggerNote(c, note, instrumentIndex, 0, 0, sampleIndex)) return null;
    this.resetVolumes(c);
    this.resetInstrument(c);
    return c;
  }

  keyOffChannel(c) {
    c.keyOff = true;
    if (c.volEnv) {
      this.rewindReleasedEnvelope(c, c.volEnv, 'volEnv');
    } else {
      c.volume = c.outVolume = 0;
    }
    // Do not rewind an enabled panning envelope. Original FT2 accidentally tests for
    // "not enabled" here, and ft2-clone deliberately retains that compatibility bug.
  }

  /**
   * FT2 keeps an envelope point cursor as well as its tick. While a sustain or final point
   * is held, that cursor remains on the current point; key-off rewinds the tick to one
   * before it so the release tick emits the held value once before advancing. Between
   * points the cursor already targets the next point and no rewind occurs.
   */
  rewindReleasedEnvelope(c, env, prefix) {
    const tickName = `${prefix}Tick`;
    const posName = `${prefix}Pos`;
    const point = Math.min(env.num - 1, c[posName] ?? 0);
    const pointTick = env.points[point * 2];
    if ((c[tickName] & 0xffff) >= pointTick) {
      c[tickName] = (pointTick - 1) & 0xffff;
    }
  }

  /** Process one row: read cells, apply row-time effects. */
  startRow() {
    const pat = this.patterns[this.order[this.position]];
    const base = this.row * this.channels * 5;

    for (let i = 0; i < this.channels; i++) {
      const c = this.ch[i];
      const o = base + i * 5;
      const note = pat?.cells[o] ?? 0, instr = pat?.cells[o + 1] ?? 0;
      const vol = pat?.cells[o + 2] ?? 0, fx = pat?.cells[o + 3] ?? 0;
      const param = pat?.cells[o + 4] ?? 0;

      const oldEffect = c.effect, oldParam = c.param;
      c.effect = fx; c.param = param; c.volColumn = vol;
      c.noteCut = -1; c.noteDelay = -1; c.delayed = null;
      if ((oldEffect === 0 && oldParam)
          || ((oldEffect === 4 || oldEffect === 6) && fx !== 4 && fx !== 6)) {
        c.outPeriod = c.period;
      }
      const validInstrument = instr > 0
        && instr <= Math.min(128, this.instruments.length);
      if (validInstrument) c.instrument = instr;

      // FT2 returns before every other tick-zero action for ED1..EDF.
      if (fx === 0xe && (param >> 4) === 0xd && (param & 15) > 0) {
        c.noteDelay = param & 15;
        c.delayed = { note, instr, vol };
      } else if (!(fx === 0xe && param === 0x90)
          && (fx === 3 || fx === 5 || (vol >> 4) === 0xf)) {
        // Tone portamento: retarget without restarting the sample.
        if ((vol >> 4) === 0xf) {
          if (vol & 15) c.portaSpeed = (vol & 15) << 6;
        } else if (fx === 3 && param) {
          c.portaSpeed = param * 4;
        }
        if (note === 97) {
          this.keyOffChannel(c);
        } else if (note > 0) {
          const target = this.periodOf(
            note,
            { relativeNote: c.relativeNote, finetune: c.finetune },
            c.finetune,
          );
          if (target != null) {
            c.portaTarget = target;
            if (target === c.period) c.portaDirection = 0;
            else c.portaDirection = target > c.period ? 1 : 2;
          }
        }
        if (validInstrument) {
          this.resetVolumes(c);
          if (note !== 97) this.resetInstrument(c);
        }
      } else if (fx === 0x14 && param === 0) {
        // K00 is dispatched on the initial tick before empty-note/instrument handling.
        // Nonzero Kxx remains in the nonzero-tick effect table.
        this.keyOffChannel(c);
        if (validInstrument) this.resetVolumes(c);
      } else if (fx === 0xe && param === 0x90) {
        // E90 retriggers immediately, even when the note field is empty.
        if (note === 97) {
          this.keyOffChannel(c);
          if (validInstrument) this.resetVolumes(c);
        } else {
          this.triggerNote(c, note || c.note, instr, fx, param);
          if (validInstrument) {
            this.resetVolumes(c);
            this.resetInstrument(c);
          }
        }
      } else if (note === 97) {
        this.keyOffChannel(c);
        if (validInstrument) this.resetVolumes(c);
      } else if (note > 0) {
        this.triggerNote(c, note, instr, fx, param);
        if (validInstrument) {
          this.resetVolumes(c);
          this.resetInstrument(c);
        }
      } else if (validInstrument) {
        this.resetVolumes(c);
        this.resetInstrument(c);
      } else {
        // Empty cell: keep the existing voice and instrument state.
      }

      if (c.noteDelay < 0) {
        const volColumnData = this.volumeColumnTickZero(c);
        this.rowEffect(c, fx, param, volColumnData);
      }
    }
  }

  volumeColumnTickZero(c) {
    const vol = c.volColumn, hi = vol >> 4, lo = vol & 15;
    let result = vol;
    if (vol >= 0x10 && vol <= 0x50) result = c.volume = c.outVolume = vol - 0x10;
    else if (hi === 8) result = c.volume = c.outVolume = clamp(c.volume - lo);
    else if (hi === 9) result = c.volume = c.outVolume = clamp(c.volume + lo);
    else if (hi === 0xa) {
      result = lo * 4;
      if (result) c.vibSpeed = result;
    } else if (hi === 0xc) result = c.panning = c.finalPan = lo << 4;
    return result;
  }

  volumeColumnTick(c) {
    const hi = c.volColumn >> 4, lo = c.volColumn & 15;
    if (hi === 6) c.volume = c.outVolume = clamp(c.volume - lo);
    else if (hi === 7) c.volume = c.outVolume = clamp(c.volume + lo);
    else if (hi === 0xb) {
      if (lo) c.vibDepth = lo;
      this.vibrato(c, 0);
    } else if (hi === 0xd) {
      // FT2 bug: D0 in the volume column snaps fully left.
      c.panning = c.finalPan = lo === 0 ? 0 : Math.max(0, c.panning - lo);
    }
    else if (hi === 0xe) c.panning = c.finalPan = Math.min(255, c.panning + lo);
    else if (hi === 0xf) this.tonePorta(c);
  }

  rowEffect(c, fx, param, volColumnData = c.volColumn) {
    const hi = param >> 4, lo = param & 15;
    switch (fx) {
      case 0x3: break;                                      // prepared while reading note
      case 0x8: c.panning = param; break;                    // set panning
      case 0xb:                                              // position jump
        this.positionJumpTarget = param < this.songLength ? param : 0;
        this.patternBreakPosition = 0;
        this.positionJump = true;
        break;
      case 0xc: c.volume = c.outVolume = Math.min(64, param); break;
      case 0xd: {                                           // pattern break
        const row = hi * 10 + lo;
        this.patternBreakPosition = row <= 63 ? row : 0;
        this.positionJump = true;
        break;
      }
      case 0xf:                                              // set speed / tempo
        if (param < 0x20) this.speed = param || 256;
        else { this.bpm = param; this.setTickDuration(this.bpm); }
        break;
      case 0x10: this.globalVolume = Math.min(64, param); break;  // G
      case 0x15:                                             // L set envelope position
        if (c.volEnv) this.setEnvelopePosition(c, c.volEnv, 'volEnv', param);
        // FT2 has a test against the volume sustain flag here instead of pan-enabled.
        if ((c.inst?.volEnvFlags & 2) && c.panEnv) {
          this.setEnvelopePosition(c, c.panEnv, 'panEnv', param);
        }
        break;
      case 0x1b:                                             // R multi retrigger
        if (lo) c.retrigSpeed = lo;
        if (hi) c.retrigVolume = hi;
        if (volColumnData === 0) this.multiRetrigger(c);
        break;
      case 0x21:                                             // X extra-fine pitch slide
        if (hi === 1) {
          const amount = lo || c.extraFineUp;
          if (lo) c.extraFineUp = lo;
          c.period = c.outPeriod = ft2SlideUp(c.period, amount);
        } else if (hi === 2) {
          const amount = lo || c.extraFineDown;
          if (lo) c.extraFineDown = lo;
          c.period = c.outPeriod = ft2SlideDown(c.period, amount);
        }
        break;
      case 0xe:
        switch (hi) {
          case 0x1: {
            const amount = lo || c.finePitchUp;
            if (lo) c.finePitchUp = lo;
            c.period = c.outPeriod = ft2SlideUp(c.period, amount * 4);
            break;
          }
          case 0x2: {
            const amount = lo || c.finePitchDown;
            if (lo) c.finePitchDown = lo;
            c.period = c.outPeriod = ft2SlideDown(c.period, amount * 4);
            break;
          }
          case 0x3: c.glissando = lo !== 0; break;
          case 0x4: c.vibWave = lo; break;
          case 0x5: break;                                  // applied while triggering
          case 0x6:                                          // E6 pattern loop
            if (lo === 0) c.patternLoopRow = this.row;
            else if (c.patternLoopCount === 0) {
              c.patternLoopCount = lo;
              this.patternBreakPosition = c.patternLoopRow;
              this.patternBreak = true;
            } else if (--c.patternLoopCount > 0) {
              this.patternBreakPosition = c.patternLoopRow;
              this.patternBreak = true;
            }
            break;
          case 0x7: c.tremWave = lo; break;
          case 0x8: break;                                   // E8 is a dummy in FT2
          case 0x9: break;                                   // E90 handled while reading note
          case 0xa: {
            const amount = lo || c.fineVolUp;
            if (lo) c.fineVolUp = lo;
            c.volume = c.outVolume = clamp(c.volume + (amount || 0));
            break;
          }
          case 0xb: {
            const amount = lo || c.fineVolDown;
            if (lo) c.fineVolDown = lo;
            c.volume = c.outVolume = clamp(c.volume - (amount || 0));
            break;
          }
          case 0xc:
            c.noteCut = lo;
            if (lo === 0) c.volume = c.outVolume = 0;
            break;
          case 0xd: break;                                   // ED handled in startRow
          case 0xe:                                          // EE pattern delay
            if (this.patternDelayRemaining === 0) this.patternDelaySet = lo + 1;
            break;
          default: break;                                    // E0/EF are FT2 dummies
        }
        break;
      // These effects either run on non-zero ticks or are defined FT2 dummies.
      case 0x0: case 0x1: case 0x2: case 0x4: case 0x5: case 0x6:
      case 0x7: case 0x9: case 0xa: case 0x11: case 0x14: case 0x19:
      case 0x1d:
        break;
      default:
        if (fx > 35) this.unsupported.add(`effect ${fx}`);
    }
  }

  slideVolume(c, param) {
    if (!param) param = c.volSlide;
    else c.volSlide = param;
    if (!(param & 0xf0)) c.volume = clamp(c.volume - (param & 15));
    else c.volume = clamp(c.volume + (param >> 4));
    c.outVolume = c.volume;
  }

  slideGlobalVolume(c, param) {
    if (!param) param = c.globalVolSlide;
    else c.globalVolSlide = param;
    if (!(param & 0xf0)) this.globalVolume = clamp(this.globalVolume - (param & 15));
    else this.globalVolume = clamp(this.globalVolume + (param >> 4));
  }

  slidePanning(c, param) {
    if (!param) param = c.panSlide;
    else c.panSlide = param;
    if (!(param & 0xf0)) c.panning = Math.max(0, c.panning - (param & 15));
    else c.panning = Math.min(255, c.panning + (param >> 4));
    c.finalPan = c.panning;
  }

  retrigger(c, resetEnvelope = true) {
    this.triggerNote(c, c.note);
    if (resetEnvelope) this.resetInstrument(c);
  }

  multiRetrigger(c) {
    const count = (c.retrigCount + 1) & 255;
    if (count < c.retrigSpeed) {
      c.retrigCount = count;
      return;
    }
    c.retrigCount = 0;

    let v = c.volume;
    switch (c.retrigVolume) {
      case 1: v--; break; case 2: v -= 2; break; case 3: v -= 4; break;
      case 4: v -= 8; break; case 5: v -= 16; break;
      case 6: v = (v >> 1) + (v >> 3) + (v >> 4); break;
      case 7: v >>= 1; break; case 8: break;
      case 9: v++; break; case 10: v += 2; break; case 11: v += 4; break;
      case 12: v += 8; break; case 13: v += 16; break;
      case 14: v += v >> 1; break; case 15: v += v; break;
    }
    c.volume = c.outVolume = clamp(v);

    if (c.volColumn >= 0x10 && c.volColumn <= 0x50) {
      c.volume = c.outVolume = c.volColumn - 0x10;
    } else if (c.volColumn >= 0xc0 && c.volColumn <= 0xcf) {
      c.panning = c.finalPan = (c.volColumn & 15) << 4;
    }

    // Rxy retriggers only the sample. Unlike E9x, it does not reset envelopes, fadeout,
    // vibrato positions or key-off state.
    this.retrigger(c, false);
  }

  triggerDelayed(c) {
    if (!c.delayed) return;
    if (c.delayed.note === 97) this.keyOffChannel(c);
    else this.triggerNote(c, c.delayed.note || c.note, c.delayed.instr);
    if (c.delayed.instr > 0) this.resetVolumes(c);
    // FT2 calls triggerInstrument() even after a delayed note-off.
    this.resetInstrument(c);
    c.volColumn = c.delayed.vol;
    if (c.volColumn >= 0x10 && c.volColumn <= 0x50) {
      c.volume = c.outVolume = c.volColumn - 0x10;
    } else if (c.volColumn >= 0xc0 && c.volColumn <= 0xcf) {
      c.panning = c.finalPan = (c.volColumn & 15) << 4;
    }
  }

  /** Per-tick effect processing and final FT2 envelope/instrument modulation. */
  tickEffects() {
    for (const c of this.ch) {
      const hi = c.param >> 4, lo = c.param & 15;

      // During EEx pattern-delay repeats FT2 runs the non-zero effect table on the
      // repeated cycle's tick zero as well; only pattern data/tick-zero effects are held.
      if (this.tick > 0 || this.repeatRow) {
        this.volumeColumnTick(c);
        switch (c.effect) {
          case 0x0:
            if (c.param) {
              const phase = ARPEGGIO_TABLE[(this.speed - this.tick) & 31];
              const semitones = phase === 1 ? hi : phase === 2 ? lo : 0;
              c.outPeriod = this.period2NotePeriod(c.period, semitones, c);
            }
            break;
          case 0x1: {
            const amount = c.param || c.pitchUp;
            if (c.param) c.pitchUp = c.param;
            c.period = c.outPeriod = ft2SlideUp(c.period, amount * 4);
            break;
          }
          case 0x2: {
            const amount = c.param || c.pitchDown;
            if (c.param) c.pitchDown = c.param;
            c.period = c.outPeriod = ft2SlideDown(c.period, amount * 4);
            break;
          }
          case 0x3: this.tonePorta(c); break;
          case 0x4: this.vibrato(c, c.param); break;
          case 0x5: this.tonePorta(c); this.slideVolume(c, c.param); break;
          case 0x6: this.vibrato(c, 0); this.slideVolume(c, c.param); break;
          case 0x7: this.tremolo(c, c.param); break;
          case 0xa: this.slideVolume(c, c.param); break;
          case 0x11: this.slideGlobalVolume(c, c.param); break;       // H
          case 0x14: if (this.tick === (c.param & 31)) this.keyOffChannel(c); break;
          case 0x19: this.slidePanning(c, c.param); break;            // P
          case 0x1b: this.multiRetrigger(c); break;                   // R
          case 0x1d: this.tremor(c, c.param); break;                  // T
          case 0xe:
            if (hi === 9 && lo > 0 && this.tick % lo === 0) this.retrigger(c, true);
            else if (hi === 0xc && this.tick === lo) c.volume = c.outVolume = 0;
            else if (hi === 0xd && this.tick === lo) this.triggerDelayed(c);
            break;
        }
      }

      this.updateChannel(c);
    }
  }

  period2NotePeriod(period, noteOffset, c) {
    const fine = (c.finetune >> 3) + 16;
    let high = 8 * 12 * 16;
    let low = 0;

    for (let i = 0; i < 8; i++) {
      const candidate = (((low + high) >> 1) & ~15) + fine;
      const lookup = Math.max(0, candidate - 8);
      if (period >= this.periodAt(lookup)) high = (candidate - fine) & ~15;
      else low = (candidate - fine) & ~15;
    }

    let index = low + fine + (noteOffset << 4);
    if (index >= (8 * 12 * 16 + 15) - 1) index = (8 * 12 * 16 + 16) - 1;
    return this.periodAt(index);
  }

  tonePorta(c) {
    if (c.portaDirection === 0) return;
    if (c.portaDirection > 1) {
      c.period = (c.period - c.portaSpeed) & 0xffff;
      if (ft2Signed16(c.period) <= ft2Signed16(c.portaTarget)) {
        c.portaDirection = 1;
        c.period = c.portaTarget;
      }
    } else {
      c.period = (c.period + c.portaSpeed) & 0xffff;
      if (c.period >= c.portaTarget) {
        c.portaDirection = 1;
        c.period = c.portaTarget;
      }
    }
    c.outPeriod = c.glissando ? this.period2NotePeriod(c.period, 0, c) : c.period;
  }

  vibrato(c, param) {
    if (param) {
      if (param & 15) c.vibDepth = param & 15;
      if (param & 0xf0) c.vibSpeed = (param & 0xf0) >> 2;
    }
    const index = (c.vibPos >> 2) & 31;
    let wave;
    if ((c.vibWave & 3) === 0) wave = VIBRATO_TABLE[index];
    else if ((c.vibWave & 3) === 1) {
      wave = index << 3;
      if (c.vibPos & 0x80) wave = (~wave) & 255;
    } else wave = 255;
    const delta = (wave * c.vibDepth) >> 5;
    c.outPeriod = c.period + ((c.vibPos & 0x80) ? -delta : delta);
    c.vibPos = (c.vibPos + c.vibSpeed) & 255;
  }

  tremolo(c, param) {
    if (param) {
      if (param & 15) c.tremDepth = param & 15;
      if (param & 0xf0) c.tremSpeed = (param & 0xf0) >> 2;
    }
    const index = (c.tremPos >> 2) & 31;
    let wave;
    if ((c.tremWave & 3) === 0) wave = VIBRATO_TABLE[index];
    else if ((c.tremWave & 3) === 1) {
      wave = index << 3;
      // Original FT2 accidentally tests vibrato position for ramp tremolo.
      if (c.vibPos & 0x80) wave = (~wave) & 255;
    } else wave = 255;
    const delta = (wave * c.tremDepth) >> 6;
    c.outVolume = clamp(c.volume + ((c.tremPos & 0x80) ? -delta : delta));
    c.tremPos = (c.tremPos + c.tremSpeed) & 255;
  }

  tremor(c, param) {
    if (param) c.tremorParam = param;
    let sign = c.tremorPos & 0x80;
    let count = (c.tremorPos & 0x7f) - 1;
    if (count < 0) {
      if (sign) {
        sign = 0;
        count = c.tremorParam & 15;
      } else {
        sign = 0x80;
        count = c.tremorParam >> 4;
      }
    }
    c.tremorPos = sign | count;
    c.outVolume = sign ? c.volume : 0;
  }

  setEnvelopePosition(c, env, prefix, param) {
    const tickName = `${prefix}Tick`;
    const posName = `${prefix}Pos`;
    const valueName = `${prefix}Value`;
    const deltaName = `${prefix}Delta`;
    c[tickName] = (param - 1) & 0xffff;

    let point = 0;
    let update = true;
    let tick = param;
    let value = c[valueName] ?? 0;
    let delta = c[deltaName] ?? 0;
    if (env.num > 1) {
      point++;
      for (let i = 0; i < env.num - 1; i++) {
        if (tick < env.points[point * 2]) {
          point--;
          tick -= env.points[point * 2];
          if (tick === 0) {
            update = false;
            break;
          }

          const x0 = env.points[point * 2];
          const x1 = env.points[(point + 1) * 2];
          const span = x1 - x0;
          if (span <= 0) {
            update = true;
            break;
          }

          const y0 = env.points[point * 2 + 1];
          const y1 = env.points[(point + 1) * 2 + 1];
          delta = Math.trunc((ft2Signed8(y1 - y0) << 8) / span);
          value = ft2Signed16((y0 << 8) + delta * (tick - 1));
          point++;
          update = false;
          break;
        }
        point++;
      }
      if (update) point--;
    }

    if (update) {
      delta = 0;
      value = ft2Signed16(env.points[Math.max(0, point) * 2 + 1] << 8);
    }
    if (point >= env.num) point = Math.max(0, env.num - 1);
    c[posName] = point;
    c[valueName] = value;
    c[deltaName] = delta;
  }

  advanceEnvelope(c, env, tickName, defaultValue) {
    if (!env) return defaultValue;
    const prefix = tickName.slice(0, -4);
    const posName = `${prefix}Pos`;
    const valueName = `${prefix}Value`;
    const deltaName = `${prefix}Delta`;
    const p = env.points;
    let pos = Math.min(env.num - 1, c[posName] ?? 0);
    let value = c[valueName] ?? 0;
    let delta = c[deltaName] ?? 0;
    let tick = ((c[tickName] ?? 0xffff) + 1) & 0xffff;
    let output = 0;
    let didInterpolate = false;

    if (tick === p[pos * 2]) {
      value = ft2Signed16(ft2Signed8(p[pos * 2 + 1]) << 8);
      let next = pos + 1;
      if (env.loopEnd >= 0) {
        next--;
        if (next === env.loopEnd) {
          const shouldLoop =
            env.sustain < 0 || next !== env.sustain || c.keyOff;
          if (shouldLoop) {
            next = env.loopStart;
            tick = p[next * 2];
            value = ft2Signed16(ft2Signed8(p[next * 2 + 1]) << 8);
          }
        }
        next++;
      }

      if (next < env.num) {
        let interpolate = true;
        if (env.sustain >= 0 && !c.keyOff && next - 1 === env.sustain) {
          next--;
          delta = 0;
          interpolate = false;
        }
        if (interpolate) {
          pos = next;
          const x0 = p[(pos - 1) * 2];
          const x1 = p[pos * 2];
          const span = x1 - x0;
          if (span > 0) {
            const y0 = p[(pos - 1) * 2 + 1];
            const y1 = p[pos * 2 + 1];
            delta = Math.trunc((ft2Signed8(y1 - y0) << 8) / span);
            output = value;
            didInterpolate = true;
          } else {
            delta = 0;
          }
        }
      } else {
        delta = 0;
      }
    }

    if (!didInterpolate) {
      value = ft2Signed16(value + delta);
      output = value;
      const high = (output >> 8) & 255;
      if (high > 64) {
        output = high <= 160 ? 64 << 8 : 0;
        delta = 0;
      }
    }

    c[tickName] = tick;
    c[posName] = pos;
    c[valueName] = value;
    c[deltaName] = delta;
    return (output & 0xffff) / 256;
  }

  updateChannel(c) {
    if (c.keyOff && c.fadeVol > 0) c.fadeVol = Math.max(0, c.fadeVol - c.fadeout);
    if (!c.mute) c.envVal = this.advanceEnvelope(c, c.volEnv, 'volEnvTick', 64);
    c.panEnvVal = this.advanceEnvelope(c, c.panEnv, 'panEnvTick', 32);

    if (c.panEnv) {
      const panMul = 128 - Math.abs(c.panning - 128);
      const env8 = Math.round(c.panEnvVal * 256) - (32 * 256);
      const panAdd = (env8 * (panMul << 3)) >> 16;
      c.finalPan = (c.panning + ((panAdd << 24) >> 24)) & 255;
    } else {
      c.finalPan = c.panning;
    }
    this.updateFrequency(c);
  }

  advancePosition() {
    this.position++;
    if (this.position >= this.songLength) {
      this.position = this.restart < this.songLength ? this.restart : 0;
      this.loops++;                       // MIDAS played these looping, so do the same
    }
  }

  nextRow() {
    this.row++;

    if (this.patternDelaySet > 0) {
      this.patternDelayRemaining = this.patternDelaySet;
      this.patternDelaySet = 0;
    }
    if (this.patternDelayRemaining > 0) {
      this.patternDelayRemaining--;
      if (this.patternDelayRemaining > 0) this.row--;
    }
    this.repeatRow = this.patternDelayRemaining > 0;

    if (this.patternBreak) {
      this.patternBreak = false;
      this.row = this.patternBreakPosition;
    }

    const pat = this.patterns[this.order[this.position]];
    if (this.row >= (pat?.rows ?? 64) || this.positionJump) {
      this.row = this.patternBreakPosition;
      this.patternBreakPosition = 0;
      this.positionJump = false;

      if (this.positionJumpTarget >= 0) {
        const target = this.positionJumpTarget;
        if (target <= this.position) this.loops++;
        this.position = target;
        this.positionJumpTarget = -1;
      } else {
        this.advancePosition();
      }

      // Preserve FT2's pattern-loop interaction, but retain ft2-clone's safety fix:
      // a loop row outside the newly selected pattern is reset to row zero.
      const next = this.patterns[this.order[this.position]];
      if (this.row >= (next?.rows ?? 64)) this.row = 0;
    }
  }

  /** Advance one tick of playback state. */
  advanceTick() {
    if (this.tick === 0 && !this.repeatRow) this.startRow();
    this.tickEffects();
    this.tick++;
    if (this.tick >= this.speed) {
      this.tick = 0;
      this.nextRow();
    }
  }

  // ---------------------------------------------------------------------- mixing

  /**
   * Render `frames` stereo frames into left/right. Ticks are advanced as the buffer is
   * filled, so playback position tracks the audio the listener is actually hearing.
   */
  render(left, right, frames) {
    let done = 0;
    while (done < frames) {
      if (this.tickRemainder <= 0) {
        this.advanceTick();
        this.tickRemainder = this.nextTickLength();
      }
      const n = Math.min(frames - done, this.tickRemainder);
      this.mix(left, right, done, n);
      this.tickRemainder -= n;
      done += n;
    }
    // Final safety clamp. Sixteen channels summing at full volume can exceed unity even
    // with headroom, and a hard clip is preferable to whatever the audio device does.
    for (let i = 0; i < frames; i++) {
      const l = left[i], r = right[i];
      left[i] = l > 1 ? 1 : l < -1 ? -1 : l;
      right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
  }

  /**
   * Advance tracker timing without mixing samples.
   *
   * The browser mixes on a separate audio thread, so a CPU benchmark should not charge
   * audio synthesis to the emulated part. Order, row, tick, tempo and effect state still
   * advance exactly as render() advances them. Sample cursors deliberately do not: callers
   * use this for timeline position, not to resume audible playback after a seek.
   */
  skip(frames) {
    let done = 0;
    while (done < frames) {
      if (this.tickRemainder <= 0) {
        this.advanceTick();
        this.tickRemainder = this.nextTickLength();
      }
      const n = Math.min(frames - done, this.tickRemainder);
      this.tickRemainder -= n;
      done += n;
    }
  }

  mix(left, right, offset, count) {
    left.fill(0, offset, offset + count);
    right.fill(0, offset, offset + count);
    const gv = this.globalVolume / 64;

    for (const c of this.ch) {
      // The envelope and the fade scale the channel volume rather than replacing it, so a
      // note under an Axy slide still obeys both.
      const shape = (c.volEnv ? c.envVal / 64 : 1) * (c.fadeVol / 32768);
      if (!c.playing || !c.sample) continue;
      const s = c.sample;
      // A zero-length sample, or a loop that points outside it, would otherwise index
      // past the end of the PCM array and feed NaN into the mix for the rest of the run.
      if (s.frames <= 0) { c.playing = false; continue; }
      const step = c.frequency / this.sampleRate;
      if (!Number.isFinite(step) || !Number.isFinite(c.pos)) { c.playing = false; continue; }
      // FT2 advances a zero-volume voice through a dedicated silence mixer. Continue
      // walking the cursor so a later volume or instrument-only command resumes at the
      // correct sample position instead of the position where silence began.
      const audible = !c.mute && c.outVolume > 0 && shape > 0;
      const vol = audible
        ? (Math.min(64, c.outVolume) / 64) * shape * gv * 0.22
        : 0; // headroom for 14-16 channels
      const pan = c.finalPan & 255;
      const lg = vol * FT2_SQRT_PANNING[256 - pan];
      const rg = vol * FT2_SQRT_PANNING[pan];
      let pos = c.pos, dir = c.dir;

      for (let i = 0; i < count; i++) {
        if (s.loopType === 0) {
          if (pos >= s.frames) { c.playing = false; break; }
        } else if (s.loopType === 1) {
          if (pos >= s.loopEnd) {
            pos = s.loopLength >= 2
              ? s.loopStart + ((pos - s.loopEnd) % s.loopLength)
              : s.loopStart;
          }
        } else if (pos >= s.loopEnd) {
          if (s.loopLength >= 2) {
            const overflow = pos - s.loopEnd;
            const cycles = Math.floor(overflow / s.loopLength);
            pos = s.loopStart + (overflow % s.loopLength);
            // The first boundary reverses direction; every complete overflow cycle
            // reverses it again. This is ft2-clone's silenceMixRoutine phase model.
            if ((cycles & 1) === 0) dir = -dir;
          } else {
            pos = s.loopStart;
          }
        }

        let samplePos = pos;
        if (s.loopType === 2 && dir < 0) {
          samplePos = s.loopStart + s.loopEnd - 1 - pos;
          if (samplePos < s.loopStart) samplePos = s.loopStart;
        }
        // Math.floor, not `| 0`: a runaway position past 2^31 would wrap and turn the
        // interpolation fraction into a huge multiplier instead of staying in [0, 1).
        let idx = Math.floor(samplePos);
        if (idx >= s.frames) idx = s.frames - 1;
        else if (idx < 0) idx = 0;

        if (audible) {
          // Linear interpolation between neighbouring samples. The second index is
          // clamped rather than trusted: a malformed loop can point outside the sample.
          const frac = samplePos - idx;
          const a = s.pcm[idx];
          let bIdx = idx + 1;
          if (s.loopType && bIdx >= s.loopEnd) {
            bIdx = s.loopType === 1 ? s.loopStart : s.loopEnd - 1;
          } else if (bIdx >= s.frames) {
            bIdx = idx;
          }
          if (bIdx >= s.frames || bIdx < 0) bIdx = idx;
          const v = a + (s.pcm[bIdx] - a) * frac;

          left[offset + i] += v * lg;
          right[offset + i] += v * rg;
        }
        // FT2 keeps a monotonically increasing loop phase and uses a reversed sample
        // base while a ping-pong voice is travelling backwards.
        pos += step;
      }
      // FT2's mixers normalize the voice immediately after the final output sample in a
      // block. Do the same even when the next render call has not started yet.
      if (c.playing && s.loopType === 0 && pos >= s.frames) {
        c.playing = false;
      } else if (c.playing && s.loopType === 1 && pos >= s.loopEnd) {
        pos = s.loopLength >= 2
          ? s.loopStart + ((pos - s.loopEnd) % s.loopLength)
          : s.loopStart;
      } else if (c.playing && s.loopType === 2 && pos >= s.loopEnd) {
        if (s.loopLength >= 2) {
          const overflow = pos - s.loopEnd;
          const cycles = Math.floor(overflow / s.loopLength);
          pos = s.loopStart + (overflow % s.loopLength);
          if ((cycles & 1) === 0) dir = -dir;
        } else {
          pos = s.loopStart;
        }
      }
      c.pos = pos; c.dir = dir;
    }
  }
}

function clamp(v) { return v < 0 ? 0 : v > 64 ? 64 : v; }

function decodeU16Base64(text) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const values = new Uint8Array(128);
  for (let i = 0; i < alphabet.length; i++) values[alphabet.charCodeAt(i)] = i;

  const result = new Uint16Array(Math.floor(text.length * 3 / 8));
  let accumulator = 0, bits = 0, byteIndex = 0, lowByte = 0, out = 0;
  for (let i = 0; i < text.length && text.charCodeAt(i) !== 61; i++) {
    accumulator = (accumulator << 6) | values[text.charCodeAt(i)];
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    const byte = (accumulator >> bits) & 255;
    if ((byteIndex++ & 1) === 0) lowByte = byte;
    else result[out++] = lowByte | (byte << 8);
  }
  return result.subarray(0, out);
}

function ft2Signed16(v) {
  return (v << 16) >> 16;
}

function ft2Signed8(v) {
  return (v << 24) >> 24;
}

// FT2 performs period slides in uint16 storage, then applies signed int16
// comparisons. Preserve that overflow behavior instead of using a normal clamp.
function ft2SlideUp(period, amount) {
  let next = (Math.trunc(period) - amount) & 0xffff;
  if (ft2Signed16(next) < 1) next = 1;
  return next;
}

function ft2SlideDown(period, amount) {
  let next = (Math.trunc(period) + amount) & 0xffff;
  if (ft2Signed16(next) >= 32000) next = 31999;
  return next;
}
