# FT2 compatibility audit

This audit compares `lib/xm.js` with the replay behavior in
`source/ft2-clone-master/src/ft2_replayer.c` and its audio mixer. The target is behavioral
compatibility with ft2-clone, including the original FastTracker II quirks that ft2-clone
deliberately preserves.

The JavaScript mixer may retain Float32 output and linear sample interpolation, but tracker
state, tick ordering, effect memory, voice position, envelopes and loop boundaries must
follow ft2-clone. A difference is only intentional when it concerns output representation
rather than replay state, and every retained difference must be recorded here.

## Reference map

The comparison is against these ft2-clone paths:

| Area | ft2-clone reference | JavaScript implementation |
|---|---|---|
| row/tick dispatch and effects | `src/ft2_replayer.c` | `lib/xm.js` |
| period tables and wave tables | `src/ft2_tables.c` | `lib/xm.js` constants |
| XM parsing and sanitation | `src/modloaders/ft2_load_xm.c`, `src/ft2_module_loader.c` | `XmPlayer.parse()` |
| sample sanitation | `src/ft2_sample_ed.c` | instrument/sample parsing |
| voice update and tick scheduling | `src/ft2_audio.c` | `render()`, `skip()`, `mix()` |
| silent cursor and loop phase | `src/mixer/ft2_silence_mix.c` | `mix()` |

## Corrected divergences

The envelope audit preceding this pass found and corrected:

- volume and panning envelope loops wrapping one tracker tick late;
- held volume-envelope release advancing one tick early;
- floating-point envelope slopes replacing FT2's signed 8.8 interpolation.

The follow-up note-off audit found and this pass corrected:

- the bundled Stash modules use only plain note value 97; their 78 executed note-offs per
  song pass enter key-off and fade/release correctly;
- `K00` was missing from the initial tick-zero path, although nonzero `Kxx` worked;
- a note-off carrying an instrument number did not perform FT2's `resetVolumes`;
- a zero-volume JavaScript voice stopped advancing, while ft2-clone calls
  `silenceMixRoutine()` and advances its sample cursor;
- enabled panning-envelope release followed the logical behavior rather than
  ft2-clone's preserved inverted-condition quirk.

The comprehensive pass additionally corrected:

- note/instrument/sample-pointer ordering, old volume/pan state and empty-instrument
  placeholder behavior;
- `K00`, delayed note and note-off dispatch, `E90`, `E9x` and `Rxy` retrigger semantics;
- the volume-column/`Rxy` mutation quirk and volume-column tone-portamento precedence;
- signed 16-bit fine, normal and extra-fine pitch-slide overflow;
- packed tremor state and FT2's ramp-tremolo position bug;
- shared `Bxx`/`Dxx`/`E6x` pattern-control flags and their channel-order priority;
- `EEx` pattern-delay ordering, including navigation during delayed row cycles;
- FT2's fractional audio-tick carry instead of rounding every fractional tick upward;
- exact linear and Amiga period tables, the eight-octave arpeggio/glissando search bug,
  and FT2's quantized 16.16-to-32.32 voice delta;
- real envelope cursor/value/delta state, `Lxx`, long sustain counters, loop timing and
  the panning-envelope release quirk;
- autovibrato sweep, wrapping and terminal-period behavior;
- FT2 square-root panning and robust forward/ping-pong loop phase;
- stereo XM sample downmixing, ModPlug ADPCM decoding, sample/instrument sanitation,
  empty patterns, padded odd channel counts and FT2 playback limits.

## Conformance checklist

- [x] Note/instrument selection, retrigger and sample-offset state
- [x] Note value 97, `K00`, nonzero `Kxx`, delayed note-off and note cut
- [x] Tick-zero and nonzero effect dispatch
- [x] Effect memory, fine and extra-fine slides
- [x] Volume-column dispatch and memory
- [x] Pattern loop, delay, break, jump and restart behavior
- [x] Volume/panning envelopes, fadeout and instrument autovibrato
- [x] Linear and Amiga periods, glissando and arpeggio
- [x] Sample decoding, forward/ping-pong loops and silent cursor advancement
- [x] Global volume and channel final-volume/panning calculations
- [x] Differential fixtures for corrected state divergences
- [x] Full-song validation for Jizz, both Stash modules and Astral Blur

`node run.mjs verify` contains the permanent state fixtures. The full-song pass reached a
clean loop with finite state and no unsupported effects for all four soundtracks:

| Module | First loop at 48 kHz |
|---|---:|
| Jizz | 166.1 s |
| Stash XM 1 | 203.3 s |
| Stash XM 2 | 84.2 s |
| Astral Blur | 326.4 s |

## Intentional representation differences

- The browser mixer emits stereo `Float32` rather than FT2's configurable integer/float
  device formats.
- The JavaScript mixer uses linear interpolation rather than ft2-clone's selectable
  no/linear/cubic/sinc modes. This does not permit differences in
  sample position, loop direction, voice lifetime, tracker state or per-tick gain/panning.
- The browser keeps a fixed conservative output normalization (`0.22`) instead of exposing
  ft2-clone's configurable amplification and master-volume controls.
- ft2-clone's optional click-suppression volume ramps and fade-out helper voices are output
  smoothing, not XM replay state, and are not duplicated.
- This loader intentionally accepts XM 1.04, the format used by every bundled/generated
  soundtrack. ft2-clone also supports the older instrument-first XM 1.02/1.03 file layout;
  those versions are rejected explicitly instead of being misparsed.

MIDI input, tracker editing state, scopes and muted editor channels are outside the browser
player. The XM instrument mute flag is honored because it is stored in the module.
