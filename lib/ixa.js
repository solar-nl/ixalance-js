// IXALANCE .IXA container reader — LZSS + RLE codecs and the script bytecode.
// Transcribed from d32load.c, lzss.c and unrle.c in iXalance-1.0.5.
// Runs unchanged in the browser and in Node; see ../../unixa.py for the reference
// Python implementation and ../../README.md for the format.

const HEADER_SIZE = 48;

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Parse header + directory. Returns {demoname, type, entries:[{pos,size,fullsize}]}. */
export function readIxa(bytes) {
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== 'IXALANCE') throw new Error(`not an IXA container (magic "${magic}")`);

  let demoname = '';
  for (let i = 8; i < 40 && bytes[i]; i++) demoname += String.fromCharCode(bytes[i]);

  const dirstart = u32(bytes, 40);
  const type = u32(bytes, 44);
  const count = u32(bytes, dirstart);

  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = dirstart + 4 + i * 12;
    entries.push({ pos: u32(bytes, o), size: u32(bytes, o + 4), fullsize: u32(bytes, o + 8) });
  }
  return { demoname, type, dirstart, entries, headerSize: HEADER_SIZE };
}

const INDEX_BITS = 10;              // 1024-byte window
const LENGTH_BITS = 4;
const BREAK_EVEN = ((1 + INDEX_BITS + LENGTH_BITS) / 9) | 0;   // == 1
const END_OF_STREAM = 0;

/**
 * Port of Expand() in lzss.c. Bits are consumed MSB-first from a rack refilled with
 * 32-bit little-endian words: a set flag bit is an 8-bit literal, a clear flag bit is
 * a (position, length) pair, and position 0 ends the stream.
 */
export function lzssExpand(src) {
  const nwords = src.length >>> 2;
  let wi = 0, rack = 0, count = 0;

  const window = new Uint8Array(1024);
  let wptr = 1;

  let out = new Uint8Array(1 << 16);
  let len = 0;
  const push = (byte) => {
    if (len === out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[len++] = byte;
  };

  const nextWord = () => {
    if (wi >= nwords) throw new Error('LZSS stream ran off the end without END_OF_STREAM');
    return u32(src, (wi++) * 4);
  };

  // Reads `n` bits, matching the InputBits macro: the rack's low bits are always zero
  // after shifting, so the partial read ORs cleanly with the next word's high bits.
  const bits = (n) => {
    let value;
    if (count < n) {
      const second = n - count;
      value = rack >>> (32 - n);
      rack = nextWord();
      value |= rack >>> (32 - second);
      rack = (rack << second) >>> 0;
      count = 32 - second;
    } else {
      value = rack >>> (32 - n);
      count -= n;
      rack = (rack << n) >>> 0;
    }
    return value >>> 0;
  };

  for (;;) {
    if (count === 0) { rack = nextWord(); count = 31; } else { count--; }
    const flag = rack >>> 31;
    rack = (rack << 1) >>> 0;

    if (flag) {
      const c = bits(8) & 0xff;
      push(c);
      window[wptr] = c;
      wptr = (wptr + 1) & 1023;
      continue;
    }

    const pos = bits(INDEX_BITS) & 1023;
    if (pos === END_OF_STREAM) break;

    // The C loop is `for (i = 0; i <= match_length; i++)`, so length+2 bytes total.
    const length = (bits(LENGTH_BITS) & 0xf) + BREAK_EVEN;
    let srcPtr = pos;
    for (let i = 0; i <= length; i++) {
      const byte = window[srcPtr];
      srcPtr = (srcPtr + 1) & 1023;
      window[wptr] = byte;
      wptr = (wptr + 1) & 1023;
      push(byte);
    }
  }

  return out.subarray(0, len);
}

/**
 * Port of decode_rle() in unrle.c. A leading u32 bounds the stream; a control byte
 * above 127 is a run of (byte - 127), otherwise it introduces (byte + 1) literals.
 */
export function rleDecode(src) {
  const declared = u32(src, 0);
  let pos = 4;

  // Worst case is 128x expansion, but the caller knows fullsize; grow instead.
  let out = new Uint8Array(1 << 16);
  let len = 0;
  const room = (n) => {
    if (len + n <= out.length) return;
    let cap = out.length;
    while (cap < len + n) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, len));
    out = bigger;
  };

  for (;;) {
    if (pos >= src.length) break;
    const ch = src[pos++];
    if (pos > declared) break;          // bound check after the read, as in the C
    if (ch > 127) {
      const run = ch - 127;
      const value = src[pos++];
      room(run);
      out.fill(value, len, len + run);
      len += run;
    } else {
      const run = ch + 1;
      room(run);
      out.set(src.subarray(pos, pos + run), len);
      len += run;
      pos += run;
    }
  }

  return { data: out.subarray(0, len), declared };
}

/** LZSS- then RLE-decode one directory entry. Throws if either length check fails. */
export function unpackBlock(bytes, entry) {
  const staged = lzssExpand(bytes.subarray(entry.pos, entry.pos + entry.size));
  const { data, declared } = rleDecode(staged);
  if (staged.length !== declared) {
    throw new Error(`LZSS output ${staged.length} != declared ${declared}`);
  }
  if (data.length !== entry.fullsize) {
    throw new Error(`RLE output ${data.length} != fullsize ${entry.fullsize}`);
  }
  return data;
}

// Script opcodes, from the interpreter loop at the bottom of d32load.c.
export const OPS = {
  1: { name: 'exe', size: 2 },
  2: { name: 'pop', size: 1 },
  3: { name: 'music', size: 2 },
  4: { name: 'picture', size: 2 },
  5: { name: 'waitmusic', size: 3 },
};

/** Disassemble the entry-0 bytecode into [{name, args}]. */
export function parseScript(script) {
  const ops = [];
  let i = 0;
  while (i < script.length) {
    const op = OPS[script[i]];
    if (!op) { ops.push({ name: `?${script[i]}`, args: [] }); i++; continue; }
    ops.push({ name: op.name, args: [...script.subarray(i + 1, i + op.size)] });
    i += op.size;
  }
  return ops;
}

/** Map block index -> kind, from how the script references it. */
export function classify(ops, count) {
  const kinds = new Array(count).fill('unused');
  kinds[0] = 'script';
  for (const { name, args } of ops) {
    if (args.length && (name === 'exe' || name === 'music' || name === 'picture')) {
      kinds[args[0]] = name;
    }
  }
  return kinds;
}
