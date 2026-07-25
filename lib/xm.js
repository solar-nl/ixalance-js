// FastTracker II (.XM) replayer.
//
// Scoped to what TBL's modules actually use, which was measured rather than guessed:
// linear frequency, 8- and 16-bit samples with none/forward/ping-pong loops, no
// instrument envelopes at all, a volume column limited to set-volume and set-panning,
// and the effect set 1 2 3 4 8 9 A B C D F P with E1 E2 E6 E8 E9 EA EB EC ED EE.
//
// Anything outside that is ignored rather than approximated, and `unsupported` lists
// what was skipped so a caller can report it instead of silently playing it wrong.
//
// The replayer is deliberately free of Web Audio: it fills Float32 buffers, so it runs
// in an AudioWorklet, a worker, or Node for testing.

const AMIGA_WARN = 'Amiga frequency table (this player only implements linear)';

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

    const headerSize = u32(b, 0x3c);
    this.songLength = u16(b, 0x40);
    this.restart = u16(b, 0x42);
    this.channels = u16(b, 0x44);
    const numPatterns = u16(b, 0x46);
    const numInstruments = u16(b, 0x48);
    this.flags = u16(b, 0x4a);
    this.defaultSpeed = u16(b, 0x4c) || 6;
    this.defaultBpm = u16(b, 0x4e) || 125;
    if (!(this.flags & 1)) this.unsupported.add(AMIGA_WARN);

    this.order = Array.from(b.subarray(0x50, 0x50 + this.songLength));

    // --- patterns ---
    let at = 60 + headerSize;
    this.patterns = [];
    for (let p = 0; p < numPatterns; p++) {
      const hlen = u32(b, at);
      const rows = u16(b, at + 5) || 64;
      const packed = u16(b, at + 7);
      const data = b.subarray(at + hlen, at + hlen + packed);
      this.patterns.push(this.unpackPattern(data, rows));
      at += hlen + packed;
    }

    // --- instruments ---
    this.instruments = [];
    for (let i = 0; i < numInstruments; i++) {
      const ihdr = u32(b, at);
      const numSamples = u16(b, at + 27);
      const inst = { samples: [], keymap: new Uint8Array(96), volEnv: null, fadeout: 0 };

      if (numSamples > 0) {
        const shdrSize = u32(b, at + 29);
        inst.keymap.set(b.subarray(at + 33, at + 33 + 96));
        // The envelope switches are at +233 and +234. They were read at +0x10d and +0x10e,
        // which is past the end of the header and always zero, so every module looked
        // envelope-free and the check that was meant to report that never fired. Jizz's
        // cymbals are ping-pong loops held open forever by design: the envelope falling to
        // zero is the only thing that ever stops them.
        const volType = b[at + 233];
        if (b[at + 234] & 1) this.unsupported.add('panning envelope');
        if (volType & 1) {
          const num = Math.max(1, Math.min(12, b[at + 225]));
          const points = new Uint16Array(num * 2);
          for (let k = 0; k < num; k++) {
            points[k * 2] = u16(b, at + 129 + k * 4);        // frame, in ticks
            points[k * 2 + 1] = u16(b, at + 131 + k * 4);    // volume, 0..64
          }
          inst.volEnv = {
            points, num,
            sustain: (volType & 2) ? Math.min(num - 1, b[at + 227]) : -1,
            loopStart: (volType & 4) ? Math.min(num - 1, b[at + 228]) : -1,
            loopEnd: (volType & 4) ? Math.min(num - 1, b[at + 229]) : -1,
          };
        }
        inst.fadeout = u16(b, at + 239);

        let sat = at + ihdr;
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
          });
          sat += shdrSize;
        }
        for (const h of headers) {
          const sixteen = (h.type & 16) !== 0;
          const frames = sixteen ? h.length >> 1 : h.length;
          const pcm = new Float32Array(frames);
          // Sample data is stored as deltas.
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

          const loopType = h.type & 3;
          const loopStart = sixteen ? h.loopStart >> 1 : h.loopStart;
          const loopLength = sixteen ? h.loopLength >> 1 : h.loopLength;
          inst.samples.push({
            pcm,
            frames,
            loopType: loopLength > 0 ? loopType : 0,
            loopStart,
            loopEnd: loopStart + loopLength,
            volume: h.volume,
            finetune: h.finetune,
            panning: h.panning,
            relativeNote: h.relativeNote,
          });
        }
        at = sat;
      } else {
        at += ihdr;
      }
      this.instruments.push(inst);
    }

    this.totalRows = this.order.reduce(
      (sum, p) => sum + (this.patterns[p]?.rows ?? 64), 0);
  }

  /** Decode FT2's packed pattern representation into a flat cell array. */
  unpackPattern(data, rows) {
    const cells = new Uint8Array(rows * this.channels * 5);
    let j = 0, out = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < this.channels; c++, out += 5) {
        if (j >= data.length) continue;
        const n = data[j++];
        if (n & 0x80) {
          if (n & 1) cells[out] = data[j++];
          if (n & 2) cells[out + 1] = data[j++];
          if (n & 4) cells[out + 2] = data[j++];
          if (n & 8) cells[out + 3] = data[j++];
          if (n & 16) cells[out + 4] = data[j++];
        } else {
          cells[out] = n;
          cells[out + 1] = data[j++];
          cells[out + 2] = data[j++];
          cells[out + 3] = data[j++];
          cells[out + 4] = data[j++];
        }
      }
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
    this.patternDelay = 0;
    this.loopRow = 0;
    this.loopCount = 0;
    this.jumpTo = -1;
    this.breakRow = -1;
    this.repeatRow = false;
    this.pendingLoop = false;
    this.ended = false;
    this.loops = 0;

    this.samplesPerTick = this.sampleRate * 2.5 / this.bpm;
    this.tickRemainder = 0;

    this.ch = [];
    for (let i = 0; i < this.channels; i++) {
      this.ch.push({
        instrument: 0, sample: null,
        note: 0, period: 0, frequency: 0,
        pos: 0, dir: 1, playing: false,
        volume: 0, panning: 128,
        portaTarget: 0, portaSpeed: 0,
        vibPos: 0, vibSpeed: 0, vibDepth: 0, vibDelta: 0,
        volSlide: 0, panSlide: 0, fineSlide: 0,
        retrig: 0, retrigCount: 0,
        noteCut: -1, noteDelay: -1, delayed: null,
        effect: 0, param: 0,
        // Envelope state. envVal is the 0..64 the envelope currently asks for and fadeVol
        // the 0..65536 that key-off bleeds away; both scale c.volume rather than replacing
        // it, so the volume column and Axy keep meaning what they did.
        volEnv: null, envPos: 0, envVal: 64, envDone: false,
        fadeout: 0, fadeVol: 65536, keyOff: false,
      });
    }
  }

  /**
   * The 0..64 a volume envelope asks for at tick `pos`, linearly interpolated between its
   * points and flat outside them. FT2 stores points as (frame, value) with frames strictly
   * ascending, so a plain scan is enough at twelve points.
   */
  envelopeAt(env, pos) {
    const p = env.points;
    if (pos <= p[0]) return p[1];
    for (let k = 1; k < env.num; k++) {
      const frame = p[k * 2];
      if (pos <= frame) {
        const prevFrame = p[(k - 1) * 2], prevVal = p[(k - 1) * 2 + 1];
        const span = frame - prevFrame;
        if (span <= 0) return p[k * 2 + 1];
        return prevVal + (p[k * 2 + 1] - prevVal) * ((pos - prevFrame) / span);
      }
    }
    return p[(env.num - 1) * 2 + 1];
  }

  periodOf(note, sample) {
    return 7680 - (note + sample.relativeNote - 1) * 64 - sample.finetune / 2;
  }

  frequencyOf(period) {
    return 8363 * Math.pow(2, (4608 - clampPeriod(period)) / 768);
  }

  /** Recompute a channel's frequency from its (clamped) period plus vibrato. */
  updateFrequency(c) {
    c.period = clampPeriod(c.period);
    c.frequency = this.frequencyOf(c.period + c.vibDelta);
  }

  triggerNote(c, note, instrumentIndex) {
    if (instrumentIndex > 0) {
      c.instrument = instrumentIndex;
      const inst = this.instruments[instrumentIndex - 1];
      if (inst && inst.samples.length) {
        const which = note >= 1 && note <= 96 ? inst.keymap[note - 1] : 0;
        c.sample = inst.samples[which] ?? inst.samples[0];
        c.volume = c.sample.volume;
        c.panning = c.sample.panning;
      }
      c.volEnv = inst?.volEnv ?? null;
      c.fadeout = inst?.fadeout ?? 0;
    }
    if (note >= 1 && note <= 96 && c.sample) {
      c.note = note;
      c.period = this.periodOf(note, c.sample);
      c.frequency = this.frequencyOf(c.period);
      c.pos = 0;
      c.dir = 1;
      c.playing = true;
      c.vibPos = 0;
      // A new note restarts the envelope and cancels any fade still running.
      c.envPos = 0;
      c.envDone = false;
      c.keyOff = false;
      c.fadeVol = 65536;
      c.envVal = c.volEnv ? this.envelopeAt(c.volEnv, 0) : 64;
    }
  }

  /** Process one row: read cells, apply row-time effects. */
  startRow() {
    const pat = this.patterns[this.order[this.position]];
    if (!pat) { this.row = 0; this.advancePosition(); return; }
    const base = this.row * this.channels * 5;

    for (let i = 0; i < this.channels; i++) {
      const c = this.ch[i];
      const o = base + i * 5;
      const note = pat.cells[o], instr = pat.cells[o + 1];
      const vol = pat.cells[o + 2], fx = pat.cells[o + 3], param = pat.cells[o + 4];

      c.effect = fx; c.param = param;
      c.noteCut = -1; c.noteDelay = -1; c.delayed = null;
      c.volSlide = 0; c.panSlide = 0; c.retrig = 0;
      c.vibDelta = 0;

      // ED: hold the note back until a later tick in this row.
      if (fx === 0xe && (param >> 4) === 0xd && (param & 15) > 0) {
        c.noteDelay = param & 15;
        c.delayed = { note, instr };
      } else if (note === 97) {
        // Key off. With an envelope the note keeps sounding and is taken down by the
        // release part of it plus the fadeout; without one there is nothing to release it
        // gradually, so it stops dead exactly as it always did.
        c.keyOff = true;
        if (!c.volEnv) c.playing = false;
      } else if (fx === 3 || fx === 5 || (vol >> 4) === 0xf) {
        // Tone portamento: retarget without restarting the sample.
        if (instr > 0) {
          c.instrument = instr;
          const inst = this.instruments[instr - 1];
          if (inst && inst.samples.length) c.volume = c.sample?.volume ?? inst.samples[0].volume;
        }
        if (note >= 1 && note <= 96 && c.sample) c.portaTarget = this.periodOf(note, c.sample);
      } else {
        this.triggerNote(c, note, instr);
      }

      // Volume column: only set-volume and set-panning appear in these modules.
      if (vol >= 0x10 && vol <= 0x50) c.volume = vol - 0x10;
      else if (vol >= 0xc0 && vol <= 0xcf) c.panning = (vol - 0xc0) * 17;
      else if (vol >= 0x60) this.unsupported.add(`volume column 0x${(vol >> 4).toString(16)}0`);

      this.rowEffect(c, fx, param);
    }
  }

  rowEffect(c, fx, param) {
    const hi = param >> 4, lo = param & 15;
    switch (fx) {
      case 0x1: c.portaSpeed = param * 4; break;             // porta up
      case 0x2: c.portaSpeed = param * 4; break;             // porta down
      case 0x3: if (param) c.portaSpeed = param * 4; break;  // tone porta
      case 0x4:                                              // vibrato
        if (hi) c.vibSpeed = hi;
        if (lo) c.vibDepth = lo;
        break;
      case 0x5: break;                                       // tone porta + vol slide
      case 0x6: break;                                       // vibrato + vol slide
      case 0x8: c.panning = param; break;                    // set panning
      case 0x9:                                              // sample offset
        c.pos = param * 256;
        if (c.sample && c.pos >= c.sample.frames) c.playing = false;
        break;
      case 0xa: c.volSlide = hi ? hi : -lo; break;           // volume slide
      case 0xb: this.jumpTo = param; break;                  // position jump
      case 0xc: c.volume = Math.min(64, param); break;       // set volume
      case 0xd: this.breakRow = hi * 10 + lo; break;         // pattern break
      case 0xf:                                              // set speed / tempo
        if (param < 0x20) { if (param) this.speed = param; }
        else { this.bpm = param; this.samplesPerTick = this.sampleRate * 2.5 / this.bpm; }
        break;
      case 0x10: this.globalVolume = Math.min(64, param); break;  // G
      case 0x19: c.panSlide = hi ? hi : -lo; break;          // P pan slide
      case 0xe:
        switch (hi) {
          case 0x1: c.period -= lo * 4; this.updateFrequency(c); break;   // E1 fine porta up
          case 0x2: c.period += lo * 4; this.updateFrequency(c); break;   // E2 fine porta down
          case 0x6:                                          // E6 pattern loop
            if (lo === 0) this.loopRow = this.row;
            else if (this.loopCount === 0) { this.loopCount = lo; this.pendingLoop = true; }
            else if (--this.loopCount > 0) this.pendingLoop = true;
            break;
          case 0x8: c.panning = lo * 17; break;              // E8 set panning
          case 0x9: c.retrig = lo; c.retrigCount = 0; break; // E9 retrig
          case 0xa: c.volume = Math.min(64, c.volume + lo); break;   // EA fine vol up
          case 0xb: c.volume = Math.max(0, c.volume - lo); break;    // EB fine vol down
          case 0xc: c.noteCut = lo; break;                   // EC note cut
          case 0xd: break;                                   // ED handled in startRow
          case 0xe: this.patternDelay = lo; break;           // EE pattern delay
          default: this.unsupported.add(`E${hi.toString(16).toUpperCase()}`);
        }
        break;
      case 0x0: break;                                       // arpeggio, per tick
      default:
        if (fx || param) {
          const name = fx < 16 ? fx.toString(16).toUpperCase()
                               : String.fromCharCode(55 + fx);
          this.unsupported.add(name);
        }
    }
  }

  /** Per-tick effect processing, for every tick including tick 0 where applicable. */
  tickEffects() {
    for (const c of this.ch) {
      const hi = c.param >> 4, lo = c.param & 15;

      if (c.noteDelay >= 0 && this.tick === c.noteDelay) {
        this.triggerNote(c, c.delayed.note, c.delayed.instr);
        c.noteDelay = -1;
      }
      if (c.noteCut >= 0 && this.tick === c.noteCut) c.volume = 0;

      // Arpeggio cycles base / +hi / +lo semitones on successive ticks, including tick 0.
      if (c.effect === 0 && c.param) {
        const steps = [0, hi, lo][this.tick % 3];
        c.frequency = this.frequencyOf(c.period - steps * 64);
        continue;
      }

      if (this.tick > 0) {
        switch (c.effect) {
          case 0x1: c.period -= c.portaSpeed; break;
          case 0x2: c.period += c.portaSpeed; break;
          case 0x3: this.tonePorta(c); break;
          case 0x4: this.vibrato(c); break;
          case 0x5: this.tonePorta(c); c.volume = clamp(c.volume + (hi ? hi : -lo)); break;
          case 0x6: this.vibrato(c); c.volume = clamp(c.volume + (hi ? hi : -lo)); break;
          case 0xa: c.volume = clamp(c.volume + c.volSlide); break;
          case 0x19: c.panning = Math.max(0, Math.min(255, c.panning + c.panSlide * 4)); break;
        }
        if (c.retrig > 0 && ++c.retrigCount >= c.retrig) {
          c.retrigCount = 0; c.pos = 0; c.dir = 1; c.playing = c.sample != null;
        }
      }

      // Envelope and fadeout advance one step per tick, tick 0 included. Read the value
      // before stepping, so the first tick of a note gets the envelope's first point.
      if (c.volEnv) {
        const env = c.volEnv, p = env.points;
        c.envVal = this.envelopeAt(env, c.envPos);
        // A sustain point holds the envelope until key off; a loop wraps regardless.
        const held = env.sustain >= 0 && !c.keyOff && c.envPos >= p[env.sustain * 2];
        if (!held && !c.envDone) {
          c.envPos++;
          if (env.loopEnd >= 0 && c.envPos > p[env.loopEnd * 2]) c.envPos = p[env.loopStart * 2];
          else if (c.envPos > p[(env.num - 1) * 2]) { c.envPos = p[(env.num - 1) * 2]; c.envDone = true; }
        }
        // A ping-pong loop never runs out of sample, so silence at the end of the envelope
        // is the only thing that retires the channel.
        if (c.envDone && c.envVal <= 0) c.playing = false;
      }
      // fadeout 0 means the instrument does not fade: the envelope alone releases it.
      if (c.keyOff && c.fadeout > 0 && c.fadeVol > 0) {
        c.fadeVol -= c.fadeout;
        if (c.fadeVol <= 0) { c.fadeVol = 0; c.playing = false; }
      }

      this.updateFrequency(c);
    }
  }

  tonePorta(c) {
    if (!c.portaTarget) return;
    if (c.period < c.portaTarget) c.period = Math.min(c.portaTarget, c.period + c.portaSpeed);
    else if (c.period > c.portaTarget) c.period = Math.max(c.portaTarget, c.period - c.portaSpeed);
  }

  vibrato(c) {
    c.vibPos = (c.vibPos + c.vibSpeed) & 63;
    c.vibDelta = Math.sin(c.vibPos * Math.PI / 32) * c.vibDepth * 4;
  }

  advancePosition() {
    this.position++;
    if (this.position >= this.songLength) {
      this.position = this.restart < this.songLength ? this.restart : 0;
      this.loops++;                       // MIDAS played these looping, so do the same
    }
  }

  nextRow() {
    // EEx repeats the current row x times. The row must NOT be re-read while it
    // repeats, or the EE effect sets the counter again and the song never advances.
    if (this.patternDelay > 0) { this.patternDelay--; this.repeatRow = true; return; }
    this.repeatRow = false;

    if (this.pendingLoop) { this.pendingLoop = false; this.row = this.loopRow; return; }
    if (this.jumpTo >= 0) {
      this.position = this.jumpTo < this.songLength ? this.jumpTo : 0;
      this.row = this.breakRow >= 0 ? this.breakRow : 0;
      this.jumpTo = -1; this.breakRow = -1;
      return;
    }
    if (this.breakRow >= 0) {
      this.row = this.breakRow; this.breakRow = -1;
      this.advancePosition();
      return;
    }
    this.row++;
    const pat = this.patterns[this.order[this.position]];
    if (this.row >= (pat?.rows ?? 64)) { this.row = 0; this.advancePosition(); }
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
        this.tickRemainder = this.samplesPerTick;
      }
      const n = Math.min(frames - done, Math.ceil(this.tickRemainder));
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

  mix(left, right, offset, count) {
    left.fill(0, offset, offset + count);
    right.fill(0, offset, offset + count);
    const gv = this.globalVolume / 64;

    for (const c of this.ch) {
      // The envelope and the fade scale the channel volume rather than replacing it, so a
      // note under an Axy slide still obeys both.
      const shape = (c.volEnv ? c.envVal / 64 : 1) * (c.fadeVol / 65536);
      if (!c.playing || !c.sample || c.volume <= 0 || shape <= 0) continue;
      const s = c.sample;
      // A zero-length sample, or a loop that points outside it, would otherwise index
      // past the end of the PCM array and feed NaN into the mix for the rest of the run.
      if (s.frames <= 0) { c.playing = false; continue; }
      const step = c.frequency / this.sampleRate;
      if (!Number.isFinite(step) || !Number.isFinite(c.pos)) { c.playing = false; continue; }
      const vol = (Math.min(64, c.volume) / 64) * shape * gv * 0.22;   // headroom for 14-16 channels
      const pan = c.panning / 255;
      const lg = vol * (1 - pan), rg = vol * pan;
      let pos = c.pos, dir = c.dir;

      for (let i = 0; i < count; i++) {
        if (pos < 0) { pos = 0; dir = 1; }
        // Math.floor, not `| 0`: a runaway position past 2^31 would wrap and turn the
        // interpolation fraction into a huge multiplier instead of staying in [0, 1).
        let idx = Math.floor(pos);

        if (s.loopType === 0) {
          if (idx >= s.frames) { c.playing = false; break; }
        } else if (s.loopType === 1) {
          if (pos >= s.loopEnd) { pos = s.loopStart + (pos - s.loopEnd); idx = pos | 0; }
        } else {
          if (dir > 0 && pos >= s.loopEnd) { pos = s.loopEnd - (pos - s.loopEnd) - 1; dir = -1; idx = pos | 0; }
          else if (dir < 0 && pos < s.loopStart) { pos = s.loopStart + (s.loopStart - pos); dir = 1; idx = pos | 0; }
        }
        if (idx >= s.frames) idx = s.frames - 1;
        else if (idx < 0) idx = 0;

        // Linear interpolation between neighbouring samples. The second index is
        // clamped rather than trusted: a malformed loop can point outside the sample.
        const frac = pos - idx;
        const a = s.pcm[idx];
        let bIdx = idx + 1 < s.frames ? idx + 1 : (s.loopType ? s.loopStart : idx);
        if (bIdx >= s.frames || bIdx < 0) bIdx = idx;
        const v = a + (s.pcm[bIdx] - a) * frac;

        left[offset + i] += v * lg;
        right[offset + i] += v * rg;
        pos += step * dir;
      }
      c.pos = pos; c.dir = dir;
    }
  }
}

function clamp(v) { return v < 0 ? 0 : v > 64 ? 64 : v; }

// Linear-frequency periods run 0..7680 (ten octaves of 64 units per semitone).
// Unbounded portamento would otherwise drive this negative and the pitch to infinity.
function clampPeriod(p) {
  if (!Number.isFinite(p)) return 4608;
  return p < 1 ? 1 : p > 7680 ? 7680 : p;
}
