#!/usr/bin/env node
// .IXA container writer — the encoder side of lib/ixa.js.
//
//   node mkixa.mjs -o out.ixa --name "Phase0" --script "exe 1; pop" block1 [block2 ...]
//
// Entry 0 is always the generated script, stored raw (fullsize 0), matching every
// shipped container. Numbered blocks start at 1 and are RLE- then LZSS-encoded, the
// inverse of unpackBlock's LZSS-then-RLE decode order. The result is verified by
// round-tripping every block through lib/ixa.js itself before it is written.

import { readFileSync, writeFileSync } from 'node:fs';
import { readIxa, unpackBlock, parseScript } from '../../lib/ixa.js';

function die(msg) { console.error(`mkixa: ${msg}`); process.exit(1); }

// ----------------------------------------------------------------- RLE encoder
// Decoder: control > 127 is a run of (control - 127) copies of the next byte;
// control <= 127 introduces (control + 1) literals. The leading u32 is the total
// encoded length including itself. Runs pay off at length 3.
function rleCompress(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    let j = i;
    while (j < data.length && data[j] === data[i] && j - i < 128) j++;
    if (j - i >= 3) {
      out.push(127 + (j - i), data[i]);
      i = j;
      continue;
    }
    let k = i;
    while (k < data.length && k - i < 128) {
      if (k + 2 < data.length && data[k] === data[k + 1] && data[k] === data[k + 2]) break;
      k++;
    }
    out.push(k - i - 1);
    for (let b = i; b < k; b++) out.push(data[b]);
    i = k;
  }
  const stream = new Uint8Array(4 + out.length);
  new DataView(stream.buffer).setUint32(0, stream.length, true);
  stream.set(out, 4);
  return stream;
}

// ---------------------------------------------------------------- LZSS encoder
// Decoder: MSB-first bits from 32-bit LE words. Flag 1 -> 8-bit literal; flag 0 ->
// 10-bit window position (0 = end of stream) + 4-bit length, copying (length + 2)
// bytes byte-by-byte through a 1024-byte ring whose write pointer starts at 1.
// The encoder maintains the identical ring, so a match may legally read bytes it is
// itself writing (RLE-style overlap) — candidate scoring simulates that exactly.
class BitWriter {
  constructor() { this.words = []; this.acc = 0; this.n = 0; }
  put(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = ((this.acc << 1) | ((value >>> i) & 1)) >>> 0;
      if (++this.n === 32) { this.words.push(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  finish() {
    if (this.n) this.words.push((this.acc << (32 - this.n)) >>> 0);
    const out = new Uint8Array(this.words.length * 4);
    const dv = new DataView(out.buffer);
    this.words.forEach((w, i) => dv.setUint32(i * 4, w, true));
    return out;
  }
}

function lzssCompress(data) {
  const window = new Uint8Array(1024);
  let wptr = 1;
  const bw = new BitWriter();

  // Scratch overlay so scoring a candidate can model the decoder's in-flight writes
  // without touching the real ring. Generation-stamped to avoid clearing.
  const overlayGen = new Int32Array(1024);
  const overlayVal = new Uint8Array(1024);
  let gen = 0;

  let di = 0;
  while (di < data.length) {
    const maxLen = Math.min(17, data.length - di);
    let bestLen = 0, bestPos = 0;
    if (maxLen >= 2) {
      for (let pos = 1; pos < 1024; pos++) {
        gen++;
        let sp = pos, wp = wptr, len = 0;
        while (len < maxLen) {
          const b = overlayGen[sp] === gen ? overlayVal[sp] : window[sp];
          if (b !== data[di + len]) break;
          overlayGen[wp] = gen; overlayVal[wp] = b;
          sp = (sp + 1) & 1023; wp = (wp + 1) & 1023; len++;
        }
        if (len > bestLen) { bestLen = len; bestPos = pos; if (len === maxLen) break; }
      }
    }
    if (bestLen >= 2) {
      bw.put(0, 1); bw.put(bestPos, 10); bw.put(bestLen - 2, 4);
      for (let i = 0; i < bestLen; i++) {
        window[wptr] = data[di + i];
        wptr = (wptr + 1) & 1023;
      }
      di += bestLen;
    } else {
      bw.put(1, 1); bw.put(data[di], 8);
      window[wptr] = data[di];
      wptr = (wptr + 1) & 1023;
      di++;
    }
  }
  bw.put(0, 1); bw.put(0, 10);                 // END_OF_STREAM
  return bw.finish();
}

/* --fast: literal-only LZSS (valid stream, ~9/8 size) for quick build cycles. */
function lzssStore(data) {
  const bw = new BitWriter();
  for (let i = 0; i < data.length; i++) { bw.put(1, 1); bw.put(data[i], 8); }
  bw.put(0, 1); bw.put(0, 10);
  return bw.finish();
}

let FAST = false;
const packBlock = (data) => (FAST ? lzssStore : lzssCompress)(rleCompress(data));

// --------------------------------------------------------------- script assembly
const SCRIPT_OPS = {
  exe: { op: 1, args: 1 }, pop: { op: 2, args: 0 }, music: { op: 3, args: 1 },
  picture: { op: 4, args: 1 }, waitmusic: { op: 5, args: 2 },
};

function assembleScript(text) {
  const bytes = [];
  for (const stmt of text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const [name, ...args] = stmt.split(/\s+/);
    const spec = SCRIPT_OPS[name];
    if (!spec) die(`unknown script op "${name}"`);
    if (args.length !== spec.args) die(`${name} wants ${spec.args} argument(s), got ${args.length}`);
    bytes.push(spec.op, ...args.map((a) => {
      const v = Number(a);
      if (!Number.isInteger(v) || v < 0 || v > 255) die(`bad argument "${a}" in "${stmt}"`);
      return v;
    }));
  }
  return Uint8Array.from(bytes);
}

// ------------------------------------------------------------------------- main
const argv = process.argv.slice(2);
let outPath = null, name = 'Untitled', scriptText = null;
const blockPaths = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-o') outPath = argv[++i];
  else if (argv[i] === '--name') name = argv[++i];
  else if (argv[i] === '--script') scriptText = argv[++i];
  else if (argv[i] === '--fast') FAST = true;
  else blockPaths.push(argv[i]);
}
if (!outPath || !scriptText || !blockPaths.length) {
  die('usage: mkixa.mjs -o out.ixa --name NAME --script "exe 1; pop" block1 [block2 ...]');
}
if (name.length > 31) die('demoname must fit 31 bytes');

const script = assembleScript(scriptText);
const raw = blockPaths.map((p) => new Uint8Array(readFileSync(p)));
const packed = raw.map(packBlock);

const count = 1 + raw.length;
const HEADER = 48;
const dirSize = 4 + count * 12;
let pos = HEADER + dirSize;

const entries = [{ pos, size: script.length, fullsize: 0 }];   // script: stored raw
pos += script.length;
packed.forEach((p, i) => {
  entries.push({ pos, size: p.length, fullsize: raw[i].length });
  pos += p.length;
});

const out = new Uint8Array(pos);
const dv = new DataView(out.buffer);
out.set([...'IXALANCE'].map((c) => c.charCodeAt(0)), 0);
out.set([...name].map((c) => c.charCodeAt(0)), 8);
dv.setUint32(40, HEADER, true);                                // dirstart
dv.setUint32(44, 1, true);                                     // type
dv.setUint32(HEADER, count, true);
entries.forEach((e, i) => {
  const o = HEADER + 4 + i * 12;
  dv.setUint32(o, e.pos, true);
  dv.setUint32(o + 4, e.size, true);
  dv.setUint32(o + 8, e.fullsize, true);
});
out.set(script, entries[0].pos);
packed.forEach((p, i) => out.set(p, entries[i + 1].pos));

// ------------------------------------------------------------------ verification
const parsed = readIxa(out);
if (parsed.demoname !== name) die(`name round-trip failed ("${parsed.demoname}")`);
const gotScript = out.subarray(parsed.entries[0].pos, parsed.entries[0].pos + parsed.entries[0].size);
if (Buffer.compare(Buffer.from(gotScript), Buffer.from(script)) !== 0) die('script round-trip failed');
raw.forEach((want, i) => {
  const got = unpackBlock(out, parsed.entries[i + 1]);
  if (Buffer.compare(Buffer.from(got), Buffer.from(want)) !== 0) {
    die(`block ${i + 1} does not round-trip through lib/ixa.js unpackBlock`);
  }
});

writeFileSync(outPath, out);
const ops = parseScript(script).map((o) => `${o.name}(${o.args.join(',')})`).join(' ');
console.log(`mkixa: ${outPath}: "${name}", ${count} blocks, script [${ops}]`);
raw.forEach((r, i) => console.log(
  `  [${i + 1}] ${r.length} -> ${packed[i].length} bytes `
  + `(${(100 * packed[i].length / r.length).toFixed(1)}%) — verified`));
