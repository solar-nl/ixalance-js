// Live procedural-texture maps recovered from the two single-part TBL intros.
//
// Jizz's original DOS `/pandora` switch wrote sixteen 256x256 TGA files while the
// precalculation ran. The iXalance builds keep the same texture slots but have no DOS
// command line or filesystem. Stash uses a later revision of the same generator. These
// profiles describe the relocated slot tables and the in-memory pixel layout used by each
// result; callers decide how and where to write the images.

export const PANDORA_BYTES = 256 * 256 * 3;
const PANDORA_PLANE_BYTES = 256 * 256;

const PROFILES = [
  {
    production: 'Jizz',
    sha256: '5c55d364740911715e6ee50fafd1f4a2a88479ed853364b857b0711cb4a0685e',
    tableOffset: 0x18b6,
    capture: 'final',
    textures: [
      { slot: 1, name: 'MAP1', layout: 'planar' },
      // The live map is toroidally addressed from (64,64); the DOS dump starts at (0,0).
      { slot: 16, name: 'MAP1A', layout: 'planar', sourceX: 64, sourceY: 64 },
      { slot: 2, name: 'MAP2', layout: 'planar' },
      { slot: 3, name: 'MAP3', layout: 'planar' },
      { slot: 4, name: 'MAP4', layout: 'packed' },
      { slot: 5, name: 'MAP5', layout: 'planar' },
      // These three hidden dumps exist in planar scratch buffers only briefly. The live
      // slots are subsequently converted for the effects, so dumping them at TBL1 gives
      // separated channels or swizzled rows. The exporter lands on the recovered
      // deterministic instruction counts before those scratch buffers are reused.
      {
        slot: 6,
        name: 'WEIRDTXT',
        layout: 'planar',
        dumpPartmemOffset: 0x4ab000,
        captureAt: 1_484_000_000,
      },
      { slot: 7, name: 'MAP7', layout: 'planar' },
      { slot: 8, name: 'MAP8', layout: 'planar' },
      { slot: 9, name: 'MAP9', layout: 'planar' },
      // Slot 10 is reused later. The first completed version is the hidden dump's image.
      { slot: 10, name: 'TESTSHIT', layout: 'planar', captureAt: 1_956_000_000 },
      {
        slot: 11,
        name: 'LOGO2',
        layout: 'planar',
        dumpPartmemOffset: 0x4ab000,
        captureAt: 2_084_500_000,
      },
      {
        slot: 12,
        name: 'LOGO1',
        layout: 'planar',
        dumpPartmemOffset: 0x41b000,
        captureAt: 2_083_000_000,
      },
      { slot: 13, name: 'MAP10', layout: 'packed' },
      { slot: 14, name: 'MAP14', layout: 'packed' },
      // MAP15's unswizzled RGB copy survives outside the public slot table.
      {
        slot: 15,
        name: 'MAP15',
        layout: 'planar',
        partmemOffset: 0x3eb000,
        capture: 'final',
      },
    ],
  },
  {
    production: 'Stash',
    sha256: '87b326631d4ef9f4b4ba2c93c46dd73854666b6213d1c5074cb23f9f92bd9e21',
    tableOffset: 0x55721,
    capture: 'final',
    textures: [
      { slot: 0, name: 'SLOT00', layout: 'planar' },
      { slot: 1, name: 'NEWMAP1', layout: 'packed' },
      { slot: 3, name: 'NEWMAP3', layout: 'packed' },
      { slot: 4, name: 'NEWMAP4', layout: 'packed' },
      { slot: 5, name: 'NEWMAP5', layout: 'packed' },
      { slot: 7, name: 'STASH_07', layout: 'packed' },
      { slot: 9, name: 'STASH_09A', layout: 'packed' },
      { slot: 10, name: 'STASH_09B', layout: 'packed' },
      { slot: 11, name: 'STASH_11', layout: 'packed' },
      { slot: 12, name: 'STASH_12', layout: 'packed' },
      // These two texture programs use Stash's monochrome (0x21) result form. The
      // generated mask is in the third work plane; the first two planes remain scratch.
      {
        slot: 13,
        name: 'STASH_13',
        layout: 'mono',
        monoPlane: 2,
        captureAt: 2_348_000_000,
      },
      {
        slot: 14,
        name: 'STASH_14',
        layout: 'mono',
        monoPlane: 2,
        captureAt: 2_486_000_000,
      },
      // Slot 15 is the finished 320x200 image used by the intro, followed by 6 KiB of
      // allocation slack. Reading it as the usual 256x256 map interleaves every five
      // screen rows and produces the characteristic horizontal bands.
      { slot: 15, name: 'SLOT15', layout: 'packed', width: 320, height: 200 },
    ],
  },
];

/**
 * Look up the profile for a production.
 *
 * `sha256` is optional: the tables below are offsets into one exact build, so a caller
 * that can hash the container should, and gets told when it is looking at a different
 * one. The browser cannot always — SubtleCrypto needs a secure context, which a page
 * served over plain HTTP from anything but localhost does not have — so passing null
 * selects by name alone and leaves the caller to say the profile is unverified.
 */
export function pandoraProfile(demoname, sha256 = null) {
  const name = demoname.trim();
  const profile = PROFILES.find((p) => p.production === name);
  if (!profile) throw new Error(`${name} has no recovered Pandora texture profile`);
  if (sha256 !== null && profile.sha256 !== sha256) {
    throw new Error(
      `${name} Pandora profile targets IXA ${profile.sha256.slice(0, 12)}, `
      + `not ${sha256.slice(0, 12)}`,
    );
  }
  return profile;
}

export function pandoraPointer(machine, imageBase, profile, slot, allowEmpty = false) {
  const table = imageBase + profile.tableOffset;
  if (table < 0 || table + (slot + 1) * 4 > machine.brk) {
    throw new Error(`${profile.production} texture table is outside live memory`);
  }
  const pointer = machine.mem.getUint32(table + slot * 4, true);
  if (allowEmpty && pointer === 0) return 0;
  if (pointer === 0 || pointer + PANDORA_BYTES > machine.brk) {
    throw new Error(
      `${profile.production} texture slot ${slot} has invalid pointer `
      + `0x${pointer.toString(16)}`,
    );
  }
  return pointer;
}

function pandoraDimensions(layout, width, height, monoPlane) {
  if (layout !== 'packed' && layout !== 'planar' && layout !== 'mono') {
    throw new Error(`unknown Pandora texture layout ${layout}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0 || width * height > PANDORA_PLANE_BYTES) {
    throw new Error(`invalid Pandora texture dimensions ${width}x${height}`);
  }
  if (layout === 'mono'
      && (!Number.isInteger(monoPlane) || monoPlane < 0 || monoPlane > 2)) {
    throw new Error(`invalid Pandora monochrome plane ${monoPlane}`);
  }
}

function wrapped(value, size) {
  return ((value % size) + size) % size;
}

/** Convert one recovered slot to the BGR byte order stored in an uncompressed TGA. */
export function pandoraBgr(
  raw, layout, sourceX = 0, sourceY = 0, width = 256, height = 256, monoPlane = 0,
) {
  if (raw.length !== PANDORA_BYTES) {
    throw new Error(`Pandora texture has ${raw.length} bytes, expected ${PANDORA_BYTES}`);
  }
  pandoraDimensions(layout, width, height, monoPlane);

  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width);
    const source = wrapped(y + sourceY, height) * width + wrapped(x + sourceX, width);
    const mono = layout === 'mono' ? raw[monoPlane * PANDORA_PLANE_BYTES + source] : 0;
    const r = layout === 'packed' ? raw[source * 3]
      : layout === 'planar' ? raw[source] : mono;
    const g = layout === 'packed' ? raw[source * 3 + 1]
      : layout === 'planar' ? raw[PANDORA_PLANE_BYTES + source] : mono;
    const b = layout === 'packed' ? raw[source * 3 + 2]
      : layout === 'planar' ? raw[PANDORA_PLANE_BYTES * 2 + source] : mono;
    pixels[i * 3] = b;
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = r;
  }
  return pixels;
}

/**
 * The same unswizzle straight into canvas RGBA, for callers that are displaying a slot
 * rather than writing a TGA. Kept separate from pandoraBgr so the file-format path keeps
 * its byte order and its regression digests; `out` is reused across polls so a live view
 * does not allocate a quarter-megabyte per texture per frame.
 */
export function pandoraRgba(
  raw, layout, sourceX = 0, sourceY = 0, out = null,
  width = 256, height = 256, monoPlane = 0,
) {
  if (raw.length !== PANDORA_BYTES) {
    throw new Error(`Pandora texture has ${raw.length} bytes, expected ${PANDORA_BYTES}`);
  }
  pandoraDimensions(layout, width, height, monoPlane);

  const pixelBytes = width * height * 4;
  const pixels = out ?? new Uint8ClampedArray(pixelBytes);
  if (pixels.length !== pixelBytes) {
    throw new Error(`Pandora RGBA target has ${pixels.length} bytes, expected ${pixelBytes}`);
  }
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width);
    const source = wrapped(y + sourceY, height) * width + wrapped(x + sourceX, width);
    const mono = layout === 'mono' ? raw[monoPlane * PANDORA_PLANE_BYTES + source] : 0;
    pixels[i * 4] = layout === 'packed' ? raw[source * 3]
      : layout === 'planar' ? raw[source] : mono;
    pixels[i * 4 + 1] = layout === 'packed' ? raw[source * 3 + 1]
      : layout === 'planar' ? raw[PANDORA_PLANE_BYTES + source] : mono;
    pixels[i * 4 + 2] = layout === 'packed' ? raw[source * 3 + 2]
      : layout === 'planar' ? raw[PANDORA_PLANE_BYTES * 2 + source] : mono;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}
