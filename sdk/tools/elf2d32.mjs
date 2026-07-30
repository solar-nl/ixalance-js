#!/usr/bin/env node
// ELF32 -> DOS/32A "Adam" linear executable, the payload format lib/d32.js loads.
//
// Input is an i686-elf executable linked with --emit-relocs: the retained R_386_32
// entries are exactly the address fixups the D32 stream needs (R_386_PC32 is
// image-relative and needs none). The image dwords at fixup sites hold absolute
// link-time addresses, and relocate() ADDS the runtime base — so each site is
// rebased here to image-relative by subtracting the link base.
//
// Self-verifying: the emitted file is re-parsed with lib/d32.js and relocated at a
// test base, and every fixup site is checked against the ELF's own values.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseD32, relocate } from '../../lib/d32.js';

function die(msg) { console.error(`elf2d32: ${msg}`); process.exit(1); }

const [elfPath, outPath] = process.argv.slice(2);
if (!outPath) die('usage: elf2d32.mjs <in.elf> <out.exe>');

const elf = new Uint8Array(readFileSync(elfPath));
const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
const u16 = (o) => dv.getUint16(o, true);
const u32 = (o) => dv.getUint32(o, true);

// ---------------------------------------------------------------- ELF32 parsing
if (u32(0) !== 0x464c457f) die('not an ELF file');
if (elf[4] !== 1 || elf[5] !== 1) die('not a 32-bit little-endian ELF');
if (u16(16) !== 2) die('not an executable (link with ld, not -r)');
if (u16(18) !== 3) die('not an i386 ELF');

const entryVA = u32(24);
const shoff = u32(32);
const shentsize = u16(46);
const shnum = u16(48);
const shstrndx = u16(50);

const SHT_PROGBITS = 1, SHT_NOBITS = 8, SHT_REL = 9;
const SHF_ALLOC = 2;

const sections = [];
for (let i = 0; i < shnum; i++) {
  const o = shoff + i * shentsize;
  sections.push({
    name: u32(o), type: u32(o + 4), flags: u32(o + 8), addr: u32(o + 12),
    offset: u32(o + 16), size: u32(o + 20), link: u32(o + 24), info: u32(o + 28),
    entsize: u32(o + 36),
  });
}
const shstr = sections[shstrndx];
const nameOf = (s) => {
  let n = '', at = shstr.offset + s.name;
  while (elf[at]) n += String.fromCharCode(elf[at++]);
  return n;
};

// ------------------------------------------------------------- flat image layout
const alloc = sections.filter((s) => (s.flags & SHF_ALLOC) && s.size > 0);
if (!alloc.length) die('no allocatable sections');
const linkBase = Math.min(...alloc.map((s) => s.addr));
const fileEnd = Math.max(...alloc.filter((s) => s.type !== SHT_NOBITS).map((s) => s.addr + s.size));
const memEnd = Math.max(...alloc.map((s) => s.addr + s.size));

const image = new Uint8Array(fileEnd - linkBase);
for (const s of alloc) {
  if (s.type === SHT_NOBITS) continue;
  image.set(elf.subarray(s.offset, s.offset + s.size), s.addr - linkBase);
}
const imageDv = new DataView(image.buffer);

// ------------------------------------------------------ fixups from .rel sections
const R_386_32 = 1, R_386_PC32 = 2;
const sites = [];
for (const s of sections) {
  if (s.type !== SHT_REL) continue;
  const target = sections[s.info];
  if (!target || !(target.flags & SHF_ALLOC)) continue;    // .rel.debug_* etc.
  for (let o = s.offset; o < s.offset + s.size; o += 8) {
    const rOffset = u32(o);
    const type = u32(o + 4) & 0xff;
    if (type === R_386_PC32) continue;                     // relative: no fixup needed
    if (type !== R_386_32) die(`unsupported relocation type ${type} in ${nameOf(s)} (compile with -fno-pic)`);
    sites.push(rOffset - linkBase);
  }
}
sites.sort((a, b) => a - b);
for (let i = 1; i < sites.length; i++) {
  if (sites[i] === sites[i - 1]) die(`duplicate fixup at image offset 0x${sites[i].toString(16)}`);
}

// Rebase each site to image-relative; relocate() adds the runtime base back.
const original = sites.map((off) => imageDv.getUint32(off, true));
sites.forEach((off, i) => imageDv.setUint32(off, (original[i] - linkBase) >>> 0, true));

// ------------------------------------------------------------- fixup stream encode
// relocate() reads delta bytes rotated left by 4, so store them rotated right by 4.
// All groups but the last carry the 0x80 continuation flag (checked after the rol).
const ror4 = (x) => ((x >>> 4) | (x << 4)) & 0xff;
const stream = [];
let prev = 0;
for (const off of sites) {
  const delta = off - prev;
  prev = off;
  if (delta <= 0) die(`non-positive fixup delta ${delta}`);
  const groups = [];
  let d = delta >>> 0;
  do { groups.unshift(d & 0x7f); d = Math.floor(d / 128); } while (d);
  groups.forEach((g, i) => stream.push(ror4(i < groups.length - 1 ? g | 0x80 : g)));
  // An address fixup consumes nothing after its delta; the byte relocate() peeks at as
  // the segment tag is the NEXT delta's first byte, which the flag/positivity rules
  // above guarantee is never raw zero.
}
const fixups = Uint8Array.from(stream);

// ------------------------------------------------------------------ Adam container
const STUB = 0x40, EXESTART = 0x40;
const startip = entryVA - linkBase;
const memrequired = memEnd - linkBase;

const out = new Uint8Array(STUB + EXESTART + image.length + fixups.length);
const odv = new DataView(out.buffer);
out[0] = 0x4d; out[1] = 0x5a;                    // "MZ"
odv.setUint16(2, STUB, true);                    // lastpage
odv.setUint16(4, 1, true);                       // pages: stub = lastpage + (pages-1)*512
out.set([0x41, 0x64, 0x61, 0x6d], STUB);         // "Adam"
odv.setUint16(STUB + 0x04, 0x0100, true);        // DOS32 version (cosmetic)
odv.setUint16(STUB + 0x06, 0x0100, true);        // DLINK version (cosmetic)
odv.setUint32(STUB + 0x08, image.length + fixups.length, true);
odv.setUint32(STUB + 0x0c, EXESTART + image.length, true);
odv.setUint32(STUB + 0x10, EXESTART, true);
odv.setUint32(STUB + 0x14, startip, true);
odv.setUint32(STUB + 0x18, memrequired, true);
odv.setUint32(STUB + 0x1c, 0, true);             // initial SP: PopExe overrides it
odv.setUint32(STUB + 0x20, image.length, true);
out.set(image, STUB + EXESTART);
out.set(fixups, STUB + EXESTART + image.length);

// ------------------------------------------------------------------- verification
const d32 = parseD32(out);
if (d32.exesize !== image.length || d32.startip !== startip
    || d32.memrequired !== memrequired || d32.fixupsize !== fixups.length) {
  die('re-parse mismatch: emitted header does not round-trip through lib/d32.js');
}
const TEST_BASE = 0x00234000;
const scratch = new Uint8Array(TEST_BASE + memrequired + 16);
scratch.set(d32.image, TEST_BASE);
const counts = relocate(new DataView(scratch.buffer), TEST_BASE, d32.fixups, 0x24);
if (counts.address !== sites.length || counts.segment !== 0) {
  die(`fixup stream desync: relocate saw ${counts.address}+${counts.segment}, expected ${sites.length}+0`);
}
const sdv = new DataView(scratch.buffer);
sites.forEach((off, i) => {
  const got = sdv.getUint32(TEST_BASE + off, true);
  const want = (original[i] - linkBase + TEST_BASE) >>> 0;
  if (got !== want) die(`fixup at 0x${off.toString(16)}: relocated to 0x${got.toString(16)}, expected 0x${want.toString(16)}`);
});

writeFileSync(outPath, out);
console.log(
  `elf2d32: ${outPath}: image ${image.length} bytes (base 0x${linkBase.toString(16)}, `
  + `entry ip 0x${startip.toString(16)}), bss to ${memrequired} bytes, `
  + `${sites.length} fixups in ${fixups.length} bytes — verified against lib/d32.js`);
