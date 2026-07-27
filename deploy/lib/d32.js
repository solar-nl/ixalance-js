// DOS/32A linear-executable loader: header parse plus the relocation pass.
// Header field offsets are from the RunExe() comment in d32load.c; the fixup stream
// format is transcribed from the hand-written `reloc` routine in code.asm.

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/**
 * Parse an unpacked IXA exe block.
 *
 * The MZ stub length comes from the standard DOS header (lastpage + (pages-1)*512),
 * and the DOS/32A header sits immediately after it:
 *
 *   0x00  "Adam"            magic
 *   0x04  u16 DOS32 version
 *   0x06  u16 DLINK version
 *   0x08  u32 image + fixups size
 *   0x0c  u32 header + image size
 *   0x10  u32 image offset, relative to the end of the stub
 *   0x14  u32 entry IP
 *   0x18  u32 memory required
 *   0x1c  u32 initial SP   (junk in practice — PopExe() overrides it)
 *   0x20  u32 image size
 */
export function parseD32(bytes) {
  const stub = u16(bytes, 2) + (u16(bytes, 4) - 1) * 512;
  const magic = String.fromCharCode(...bytes.subarray(stub, stub + 4));
  if (magic !== 'Adam') throw new Error(`not a DOS/32A image (magic "${magic}" at ${stub})`);

  const imageAndFixups = u32(bytes, stub + 0x08);
  const exestart = u32(bytes, stub + 0x10);
  const startip = u32(bytes, stub + 0x14);
  const memrequired = u32(bytes, stub + 0x18);
  const exesize = u32(bytes, stub + 0x20);
  const fixupsize = imageAndFixups - exesize;

  const imageOff = stub + exestart;
  return {
    stub,
    dos32Version: u16(bytes, 4 + stub),
    startip,
    memrequired,
    exesize,
    fixupsize,
    image: bytes.subarray(imageOff, imageOff + exesize),
    fixups: bytes.subarray(imageOff + exesize, imageOff + exesize + fixupsize),
  };
}

/**
 * Apply fixups in place. Port of `reloc` in code.asm.
 *
 * Each fixup is a variable-length delta added to a running target pointer. The delta
 * is built 7 bits at a time from bytes that have been rotated left by 4; the high bit
 * of the rotated byte means "another group follows". After each delta, a zero byte
 * selects a segment fixup (add the data selector to a word) and anything else selects
 * an address fixup (add the image base to a dword) without consuming a byte.
 *
 * @param mem   DataView over the flat address space
 * @param base  linear address the image was loaded at
 * @param fixups the fixup stream
 * @param dsSelector value of DS, added by segment fixups
 */
export function relocate(mem, base, fixups, dsSelector) {
  let esi = 0;
  let edi = base >>> 0;
  let edx = fixups.length - 1;
  let address = 0, segment = 0;

  while (edx >= 0) {
    let delta = 0;
    let al;
    do {
      delta = (delta << 7) >>> 0;
      al = fixups[esi++];
      edx--;
      al = ((al << 4) | (al >>> 4)) & 0xff;      // rol al, 4
      delta = (delta + (al & 127)) >>> 0;
    } while (al & 128);

    edi = (edi + delta) >>> 0;

    if (edx >= 0 && fixups[esi] === 0) {
      mem.setUint16(edi, (mem.getUint16(edi, true) + dsSelector) & 0xffff, true);
      esi++;
      edx--;
      segment++;
    } else {
      mem.setUint32(edi, (mem.getUint32(edi, true) + base) >>> 0, true);
      address++;
    }
  }

  return { address, segment };
}
