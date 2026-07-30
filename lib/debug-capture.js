// Observation helpers for the page's Pandora view: recovered texture snapshots and
// generated-module samples. Experimental write provenance/LUT/geometry analysis is an
// explicit opt-in; the default never wraps guest memory.
//
// Nothing here writes to demo memory or changes the instruction stream. Debug mode swaps
// the CPU's guest-data DataView for an observational wrapper, so it can make execution
// slower but cannot change the values the production reads or writes.
//
// The optional panels have different reach:
//
//   * TEXTURES default to the original /pandora semantics: hidden scratch results retain
//     exact recovered boundaries and all remaining slots freeze at the first generated-XM
//     handoff. With provenance enabled, guest writes also establish intermediate stages.
//   * SCENES exist only with provenance enabled.
//   * SAMPLES are not. A generated module only becomes locatable at the 'TBL1' handoff,
//     which for these intros is the end of precalculation. The synth builds each sample
//     in a scratch buffer first and `rep movsb`s it into the module, and those scratch
//     addresses are per-production and not recovered here. So the sample panel is a
//     snapshot of the finished module, not a progress view.

import { PANDORA_BYTES, pandoraPointer, pandoraRgba } from './pandora.js';
import { AccessProvenance } from './provenance.js';

const TRACE_HISTORY_LIMIT = 64;

function fullHash(u8, at, len, pointer) {
  let h = (0x811c9dc5 ^ pointer) >>> 0;
  for (let i = 0; i < len; i++) h = Math.imul(h ^ u8[at + i], 0x01000193);
  return h >>> 0;
}

function cloneSources(sources) {
  return sources.map((source) => ({
    ...source,
    preview: source.preview
      ? { ...source.preview, pixels: source.preview.pixels.slice() }
      : null,
  }));
}

/**
 * Cheap change detector over a texture slot.
 *
 * A full 192 KB compare per slot per poll would cost more than the view is worth, so
 * hash a strided sample instead: 97 is coprime with the 256-byte row pitch and with the
 * 0x10000 plane stride, so the probe walks across rows and planes rather than sitting in
 * one column of every row. The pointer goes into the hash too, because a slot being
 * repointed at a different buffer is a change even when the bytes look alike.
 */
function stridedHash(u8, at, len, pointer) {
  let h = (0x811c9dc5 ^ pointer) >>> 0;
  for (let i = 0; i < len; i += 97) {
    h = Math.imul(h ^ u8[at + i], 0x01000193);
  }
  return h >>> 0;
}

export class TextureWatcher {
  /**
   * @param {object} opts
   *   machine    a live Machine
   *   profile    an optional lib/pandora.js profile
   *   imageBase  linear address the part's image was relocated to
   *   provenance enable experimental write/LUT/geometry tracing (default false)
   *   maxPerPoll how many changed slots to convert per poll; the rest wait their turn
   */
  constructor({
    machine, profile = null, imageBase = 0, provenance = false, maxPerPoll = 4,
  }) {
    this.machine = machine;
    this.profile = profile;
    this.imageBase = imageBase;
    this.provenance = provenance;
    this.maxPerPoll = maxPerPoll;
    this.cursor = 0;
    this.states = new Map((profile?.textures ?? []).map((t) => [
      t.name,
      {
        hash: null, dirty: false, frozen: false,
        traceHash: null, traceCount: 0,
      },
    ]));

    this.pending = [];
    this.regionTextures = new Map();
    this.trace = provenance
      ? new AccessProvenance({
        machine,
        onBoundary: (region, info) => this.traceBoundary(region, info),
      })
      : null;

    // The provenance side is useful even without a Pandora texture profile: every
    // production writes the host framebuffer, so Astral Blur can expose its span,
    // transform and possible mesh buffers through the same inspector.
    this.frameRegion = this.trace === null
      ? null
      : this.trace.registerRange({
        key: 'framebuffer',
        start: machine.fb,
        length: 800 * 600 * 2,
        kind: 'framebuffer',
        labels: ['framebuffer'],
        capture: true,
        layout: 'rgb565',
        width: machine.width,
        height: machine.height,
      });

    if (profile !== null && this.trace !== null) {
      const maxSlot = Math.max(...profile.textures.map((t) => t.slot));
      this.trace.registerRange({
        key: 'pandora-pointer-table',
        start: imageBase + profile.tableOffset,
        length: (maxSlot + 1) * 4,
        kind: 'pointer table',
        labels: ['Pandora slots'],
        capture: false,
        onWrite: () => this.syncPointers(),
      });
      // Canonical scratch/final buffers are known before their public slot is populated.
      for (const texture of profile.textures) {
        if (texture.dumpPartmemOffset !== undefined || texture.partmemOffset !== undefined) {
          this.watchTexture(texture, this.pointerFor(texture, true));
        }
      }
      this.syncPointers();
    }
  }

  attachCpu(cpu, totalInstructions = 0) {
    this.trace?.attach(cpu, totalInstructions);
  }

  detachCpu() {
    this.trace?.detach();
  }

  watchTexture(texture, pointer) {
    if (this.trace === null) return null;
    if (pointer <= 0 || pointer + PANDORA_BYTES > this.machine.brk) return null;
    const region = this.trace.registerRange({
      key: `pandora:${pointer}:${PANDORA_BYTES}`,
      start: pointer,
      length: PANDORA_BYTES,
      kind: 'texture',
      labels: [texture.name],
      capture: true,
      width: texture.width ?? 256,
      height: texture.height ?? 256,
      layout: texture.layout,
      logicalLength: (texture.width ?? 256) * (texture.height ?? 256) * 3,
    });
    let defs = this.regionTextures.get(region);
    if (defs === undefined) {
      defs = new Map();
      this.regionTextures.set(region, defs);
    }
    defs.set(texture.name, texture);
    return region;
  }

  syncPointers() {
    if (this.profile === null) return;
    for (const texture of this.profile.textures) {
      // A recovered canonical offset is authoritative for the image we want to show;
      // following its later public alias would attribute unrelated scratch activity.
      const canonical = texture.dumpPartmemOffset !== undefined
        || texture.partmemOffset !== undefined;
      const pointer = this.pointerFor(texture, canonical);
      if (pointer > 0) this.watchTexture(texture, pointer);
    }
  }

  traceBoundary(region, info) {
    if (region.kind !== 'texture') return;
    const defs = this.regionTextures.get(region);
    if (defs === undefined) return;
    for (const texture of defs.values()) {
      const state = this.states.get(texture.name);
      if (!state || state.frozen || state.traceCount >= TRACE_HISTORY_LIMIT) continue;
      const hash = fullHash(this.machine.u8, region.start, PANDORA_BYTES, region.start);
      if (hash === state.traceHash) continue;
      state.traceHash = hash;
      state.traceCount++;
      this.pending.push(this.shot(texture, region.start, info.at, false, {
        reason: info.reason,
        writes: info.writes,
        totalWrites: info.totalWrites,
        coverage: info.coverage,
        sequence: state.traceCount,
        destination: info.destination,
        writers: info.writers,
        sources: cloneSources(info.sources),
      }));
    }
  }

  /** Where a slot's pixels live right now, or 0 while the generator has not set it up. */
  pointerFor(texture, canonical = false) {
    if (this.profile === null) return 0;
    try {
      if (canonical && texture.dumpPartmemOffset !== undefined) {
        return this.machine.partmem + texture.dumpPartmemOffset;
      }
      if (texture.partmemOffset !== undefined) return this.machine.partmem + texture.partmemOffset;
      return pandoraPointer(this.machine, this.imageBase, this.profile, texture.slot, true);
    } catch {
      // Before the table is populated the slot words are whatever the image was loaded
      // with, which can read as a wild pointer. Not an error: just nothing to show yet.
      return 0;
    }
  }

  /** The next exact scratch-buffer boundary the worker must not step over. */
  nextCaptureAt(instructionCount) {
    if (this.profile === null) return null;
    let next = null;
    for (const texture of this.profile.textures) {
      const state = this.states.get(texture.name);
      if (state.frozen || texture.captureAt === undefined
          || texture.captureAt <= instructionCount) continue;
      next = next === null ? texture.captureAt : Math.min(next, texture.captureAt);
    }
    return next;
  }

  shot(texture, pointer, instructionCount, frozen, trace = null) {
    const width = texture.width ?? 256;
    const height = texture.height ?? 256;
    const raw = this.machine.u8.subarray(pointer, pointer + PANDORA_BYTES);
    const pixels = pandoraRgba(
      raw, texture.layout, texture.sourceX ?? 0, texture.sourceY ?? 0,
      new Uint8ClampedArray(width * height * 4),
      width, height, texture.monoPlane ?? 0,
    );
    return {
      name: texture.name,
      slot: texture.slot,
      layout: texture.layout,
      width,
      height,
      pixels,
      at: instructionCount,
      frozen,
      reason: trace?.reason ?? (frozen ? 'snapshot' : 'live'),
      writes: trace?.writes ?? null,
      totalWrites: trace?.totalWrites ?? null,
      coverage: trace?.coverage ?? null,
      sequence: trace?.sequence ?? null,
      destination: trace?.destination ?? null,
      writers: trace?.writers ?? [],
      sources: trace?.sources ?? [],
    };
  }

  /**
   * Freeze scratch-backed images whose exact instruction boundary has been reached.
   *
   * The worker clamps its CPU slice to nextCaptureAt(), so `instructionCount` normally
   * equals captureAt rather than merely exceeding it.
   */
  captureDue(instructionCount) {
    if (this.profile === null) return [];
    const out = [];
    for (const texture of this.profile.textures) {
      const state = this.states.get(texture.name);
      if (state.frozen || texture.captureAt === undefined
          || instructionCount < texture.captureAt) continue;
      const pointer = this.pointerFor(texture, true);
      if (pointer <= 0 || pointer + PANDORA_BYTES > this.machine.brk) continue;
      state.frozen = true;
      state.dirty = false;
      out.push(this.shot(texture, pointer, instructionCount, true));
    }
    return out;
  }

  /** Freeze every remaining texture at the first generated-XM handoff (TBL1). */
  finalize(instructionCount) {
    if (this.profile === null) return [];
    const out = [];
    for (const texture of this.profile.textures) {
      const state = this.states.get(texture.name);
      if (state.frozen) continue;
      const pointer = this.pointerFor(texture, true);
      if (pointer <= 0 || pointer + PANDORA_BYTES > this.machine.brk) continue;
      state.frozen = true;
      state.dirty = false;
      out.push(this.shot(texture, pointer, instructionCount, true));
    }
    return out;
  }

  /**
   * Look at every slot, and convert at most `maxPerPoll` of the changed ones.
   *
   * Conversion is the expensive half, so scanning and converting are separated: all slots
   * are hashed every poll, and the round-robin cursor makes sure a slot that changes on
   * every poll cannot starve the others out of ever being shown.
   *
   * @returns {Array<{name, slot, layout, pixels, at}>} newest images, transferable
   */
  poll(instructionCount) {
    if (this.profile === null) return [];
    const u8 = this.machine.u8;
    const brk = this.machine.brk;
    const changed = [];

    for (const texture of this.profile.textures) {
      // Exact scratch captures appear only when captureDue() freezes them. Showing their
      // later public slots first is precisely the misleading view this path must avoid.
      if (texture.captureAt !== undefined) continue;
      const state = this.states.get(texture.name);
      if (state.frozen) continue;
      const pointer = this.pointerFor(texture);
      if (pointer <= 0 || pointer + PANDORA_BYTES > brk) continue;
      const hash = stridedHash(u8, pointer, PANDORA_BYTES, pointer);
      if (hash !== state.hash) {
        state.hash = hash;
        state.dirty = true;
      }
      if (state.dirty) changed.push({ texture, pointer });
    }
    if (changed.length === 0) return [];

    // Round-robin from wherever the last poll stopped.
    const out = [];
    for (let n = 0; n < changed.length && out.length < this.maxPerPoll; n++) {
      const { texture, pointer } = changed[(this.cursor + n) % changed.length];
      const state = this.states.get(texture.name);
      state.dirty = false;
      out.push(this.shot(texture, pointer, instructionCount, false));
    }
    this.cursor = (this.cursor + out.length) % Math.max(1, changed.length);
    return out;
  }

  /**
   * Deliver write-boundary snapshots and close quiet epochs. Unlike poll(), this never
   * scans texture memory merely to discover whether something happened: guest writes are
   * the trigger, and a full hash is paid only when a meaningful pass boundary is reached.
   */
  drain(instructionCount) {
    this.trace?.flush(instructionCount);
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** One provenance report at a real CopyScreen boundary. */
  scene(width, height, instructionCount) {
    return this.trace?.scene(this.frameRegion, width, height, instructionCount) ?? null;
  }
}

// ---------------------------------------------------------------- generated samples

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s8 = (v) => (v << 24) >> 24;
// Names are fixed-width and padded with either NULs or spaces depending on what wrote
// them; stop at the first NUL and drop anything unprintable, because the module title is
// followed immediately by the 0x1a terminator and the tracker string.
const fixedName = (b, o, width) => String.fromCharCode(...b.subarray(o, o + width))
  .replace(/\0.*$/, '')
  .replace(/[\x00-\x1f]/g, '')
  .trim();
const name22 = (b, o) => fixedName(b, o, 22);

/** Format an XM note number the way FT2 does: 1 is C-0 and 49 is C-4. */
export function xmNoteName(note) {
  if (note < 1 || note > 96) return '---';
  const names = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
  return `${names[(note - 1) % 12]}${Math.floor((note - 1) / 12)}`;
}

/**
 * Playback rate of a sample when an XM note is struck, in Hz.
 *
 * XM sample headers carry no rate: pitch comes from the pattern note, offset by the
 * sample's relative note and finetune. C-4 with relnote 0 and finetune 0 lands on period
 * 4608, which is the 8363 Hz ProTracker reference. This is the same arithmetic as
 * lib/xm.js's periodOf()/frequencyOf().
 */
export function noteHz(patternNote, relativeNote, finetune, linearPeriods = true) {
  const note = patternNote + relativeNote;
  if (note < 1 || note >= 120) return null;
  const index = (note - 1) * 16 + ((finetune >> 3) + 16);
  if (linearPeriods) {
    const period = (1936 - index) * 4;
    return 8363 * Math.pow(2, (4608 - period) / 768);
  }
  const period = Math.round((1712 * 4 * 16) / Math.pow(2, (368 + index) / (12 * 16)));
  return period > 0 ? 8363 * 1712 / period : null;
}

/** Backwards-compatible C-4 reference used for samples absent from the pattern data. */
export function referenceHz(relativeNote, finetune, linearPeriods = true) {
  return noteHz(49, relativeNote, finetune, linearPeriods);
}

/**
 * Decode just the note and instrument columns of one packed XM pattern.
 *
 * The sample inspector does not need volume/effect data, but it must still consume those
 * fields to remain aligned with the next packed cell.
 */
function unpackNoteInstruments(data, rows, channels) {
  const cells = new Uint8Array(rows * channels * 2);
  let at = 0;
  for (let row = 0; row < rows; row++) {
    for (let channel = 0; channel < channels; channel++) {
      if (at >= data.length) continue;
      const packed = data[at++];
      let note = 0, instrument = 0;
      if (packed & 0x80) {
        if (packed & 1) note = data[at++] ?? 0;
        if (packed & 2) instrument = data[at++] ?? 0;
        if (packed & 4) at++;
        if (packed & 8) at++;
        if (packed & 16) at++;
      } else {
        note = packed;
        instrument = data[at] ?? 0;
        at += 4;
      }
      const out = (row * channels + channel) * 2;
      cells[out] = note <= 97 ? note : 0;
      cells[out + 1] = instrument <= 128 ? instrument : 0;
    }
  }
  return cells;
}

/** Prefer the modal note; resolve equal modes towards the centre of actual use. */
function representativeNote(counts) {
  let total = 0, weighted = 0, maximum = 0;
  for (let note = 1; note <= 96; note++) {
    const count = counts[note];
    total += count;
    weighted += note * count;
    if (count > maximum) maximum = count;
  }
  if (total === 0) return { note: 49, uses: 0, total: 0 };

  const centre = weighted / total;
  let best = 1, distance = Infinity;
  for (let note = 1; note <= 96; note++) {
    if (counts[note] !== maximum) continue;
    const candidateDistance = Math.abs(note - centre);
    if (candidateDistance < distance) {
      best = note;
      distance = candidateDistance;
    }
  }
  return { note: best, uses: maximum, total };
}

/**
 * Walk a module and describe every sample that has data.
 *
 * This parses the container directly rather than going through lib/xm.js, which decodes
 * for playback: it drops sample and instrument names and does not retain bit depth per
 * sample. The lightweight pattern pass retains only note/instrument columns so the
 * inspector can audition each physical sample at the pitch most often used in the song.
 *
 * @returns {{title, linearPeriods, samples: Array}} peaks are 2 signed bytes per bucket
 */
export function summariseSamples(bytes, { buckets = 160, limit = 128, withPcm = false } = {}) {
  const b = bytes;
  if (String.fromCharCode(...b.subarray(0, 17)) !== 'Extended Module: ') {
    throw new Error('not an XM module');
  }
  const title = fixedName(b, 17, 20);            // 20 bytes, then the 0x1a terminator
  const linearPeriods = (u16(b, 74) & 1) !== 0;
  const songLength = Math.min(256, u16(b, 64) || 1);
  const channels = u16(b, 68);
  const numPatterns = u16(b, 70);
  const numInstruments = u16(b, 72);

  let at = 60 + u32(b, 60);
  const patterns = [];
  for (let p = 0; p < numPatterns; p++) {
    const headerSize = u32(b, at);
    const rows = Math.min(256, u16(b, at + 5) || 64);
    const packedSize = u16(b, at + 7);
    const packed = b.subarray(at + headerSize, at + headerSize + packedSize);
    patterns.push({ rows, cells: unpackNoteInstruments(packed, rows, channels) });
    at += headerSize + packedSize;
  }

  // Track the channel's current instrument across the written song order, mirroring the
  // useful subset of FT2 row semantics. Effects can alter/retrigger notes later, but the
  // modal written note is the stable and recognisable pitch wanted by an audition button.
  const instrumentNotes = Array.from(
    { length: numInstruments },
    () => new Uint32Array(97),
  );
  const currentInstrument = new Uint16Array(channels);
  for (let position = 0; position < songLength; position++) {
    const pattern = patterns[b[80 + position]];
    if (!pattern) continue;
    for (let row = 0; row < pattern.rows; row++) {
      for (let channel = 0; channel < channels; channel++) {
        const cell = (row * channels + channel) * 2;
        const note = pattern.cells[cell];
        const instrument = pattern.cells[cell + 1];
        if (instrument > 0 && instrument <= numInstruments) {
          currentInstrument[channel] = instrument;
        }
        const active = currentInstrument[channel];
        if (note >= 1 && note <= 96 && active > 0) {
          instrumentNotes[active - 1][note]++;
        }
      }
    }
  }

  const samples = [];
  for (let i = 0; i < numInstruments && samples.length < limit; i++) {
    const headerSize = u32(b, at);
    const numSamples = u16(b, at + 27);
    if (numSamples === 0) { at += headerSize; continue; }
    const instName = name22(b, at + 4);
    const shdr = u32(b, at + 29);
    const sampleNotes = Array.from({ length: numSamples }, () => new Uint32Array(97));
    for (let note = 1; note <= 96; note++) {
      const count = instrumentNotes[i][note];
      if (count === 0) continue;
      // FT2 clamps keymap entries 16..255 to sample 15. A missing selected sample falls
      // back to sample zero, matching XmPlayer.selectSample().
      const mapped = b[at + 32 + note] ?? 0;
      const selected = Math.min(15, mapped);
      const sampleIndex = selected < numSamples ? selected : 0;
      sampleNotes[sampleIndex][note] += count;
    }

    let sat = at + headerSize;
    const headers = [];
    for (let s = 0; s < numSamples; s++) {
      headers.push({
        length: u32(b, sat),
        loopStart: u32(b, sat + 4),
        loopLength: u32(b, sat + 8),
        volume: b[sat + 12],
        finetune: s8(b[sat + 13]),
        type: b[sat + 14],
        relativeNote: s8(b[sat + 16]),
        name: name22(b, sat + 18),
      });
      sat += shdr;
    }

    let hi_ = 0;
    for (; hi_ < headers.length; hi_++) {
      const h = headers[hi_];
      if (h.length === 0) continue;
      if (samples.length >= limit) break;
      const sixteen = (h.type & 16) !== 0;
      const frames = sixteen ? h.length >> 1 : h.length;
      const n = Math.min(buckets, Math.max(1, frames));
      const peaks = new Int8Array(n * 2);
      // Decoded PCM is only produced when a caller intends to play it back: for Stash's
      // first module that is 868 KB the summary would otherwise never need to hold.
      const pcm = withPcm ? (sixteen ? new Int16Array(frames) : new Int8Array(frames)) : null;

      // One delta pass, bucketed on the fly: a 59,000-frame sample never needs to exist
      // as decoded PCM just to draw 160 columns of envelope.
      let old = 0, bucket = 0, lo = 127, hi = -128, drawn = 0;
      const per = frames / n;
      for (let k = 0; k < frames; k++) {
        let v;
        if (sixteen) {
          old = (old + ((u16(b, sat + k * 2) << 16) >> 16)) & 0xffff;
          const full = (old << 16) >> 16;
          if (pcm) pcm[k] = full;
          v = full >> 8;                              // scale to the 8-bit envelope
        } else {
          old = (old + s8(b[sat + k])) & 0xff;
          v = s8(old);
          if (pcm) pcm[k] = v;
        }
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (k + 1 >= Math.round((bucket + 1) * per) && drawn < n) {
          peaks[drawn * 2] = lo; peaks[drawn * 2 + 1] = hi;
          drawn++; bucket++; lo = 127; hi = -128;
        }
      }
      while (drawn < n) { peaks[drawn * 2] = 0; peaks[drawn * 2 + 1] = 0; drawn++; }
      sat += h.length;
      const usual = representativeNote(sampleNotes[hi_]);
      const baseHz = referenceHz(h.relativeNote, h.finetune, linearPeriods);

      samples.push({
        instrument: i + 1,
        instrumentName: instName,
        sampleIndex: hi_,
        name: h.name,
        frames,
        bits: sixteen ? 16 : 8,
        volume: h.volume,
        finetune: h.finetune,
        relativeNote: h.relativeNote,
        loopType: h.loopLength > 0 ? (h.type & 3) : 0,
        // Loop points are byte offsets in the header; a player wants frames.
        loopStart: sixteen ? h.loopStart >> 1 : h.loopStart,
        loopEnd: (sixteen ? h.loopStart >> 1 : h.loopStart)
               + (sixteen ? h.loopLength >> 1 : h.loopLength),
        usualNote: usual.note,
        usualNoteName: xmNoteName(usual.note),
        usualNoteUses: usual.uses,
        noteUses: usual.total,
        pitchSource: usual.total > 0 ? 'pattern' : 'fallback',
        baseHz,
        hz: noteHz(usual.note, h.relativeNote, h.finetune, linearPeriods),
        peaks,
        pcm,
      });
    }
    // The limit can stop the loop mid-instrument. Step over the sample bodies that were
    // not described, or the next instrument header is read from the wrong offset and
    // everything after it is garbage.
    for (let k = hi_; k < headers.length; k++) sat += headers[k].length;
    at = sat;
  }

  return { title, linearPeriods, samples };
}
