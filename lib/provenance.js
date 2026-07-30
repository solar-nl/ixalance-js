// Dynamic provenance for the browser inspector.
//
// The tracer deliberately records relationships, not a byte-by-byte log. A generated
// texture or a software framebuffer can receive millions of writes; retaining all of
// them would turn a useful debugger into a second workload larger than the demo. Recent
// reads are attributed to watched writes, accesses are coalesced by instruction/range,
// and page-level ancestry lets the scene view walk back through span and transform
// buffers without knowing the production's private structs.

import { setMemoryTrace } from './memory-trace.js';

const PAGE_SHIFT = 12;
const PAGE_BYTES = 1 << PAGE_SHIFT;
const CHUNK_SHIFT = 2;
const RECENT = 128;
const RECENT_MASK = RECENT - 1;
const FULL_COVERAGE = 1;
const QUIET_INSTRUCTIONS = 750_000;
const MAX_SOURCE_CLUSTERS = 128;
const MAX_CLUSTERS_PER_SITE = 16;
const CLUSTER_GAP = 4096;
const MAX_ACCESS_SAMPLES = 2048;
const MAX_RELATIONS = 4096;
const ACCESS_MAP_SIDE = 64;
const MAX_GLOBAL_SITES = 256;
const MAX_PAGE_DEPS = 32;

const KIND = {
  u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, f64: 7,
};
const KIND_NAME = Object.keys(KIND);
const KIND_SIZE = [1, 1, 2, 2, 4, 4, 4, 8];

const hex = (v) => `0x${(v >>> 0).toString(16)}`;

function fnv1a(bytes, start, length) {
  let h = 0x811c9dc5;
  const end = Math.min(bytes.length, start + length);
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

function dominantKind(counts) {
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
  return best;
}

function freshAccess(eip, addr, owner = null) {
  return {
    eip, owner, count: 0, bytes: 0, min: addr, max: addr, maxSize: 1,
    last: -1, sequential: 0, constant: 0, kinds: new Uint32Array(KIND_NAME.length),
    unique: new Set(), uniqueOverflow: 0, deltas: new Map(), samples: [],
    relations: new Map(), lastAt: 0,
  };
}

function accessDelta(stat) {
  let delta = 0, count = 0;
  for (const [d, n] of stat.deltas) {
    if (d > 0 && n > count) { delta = d; count = n; }
  }
  return {
    delta,
    support: stat.count > 1 ? count / (stat.count - 1) : 0,
  };
}

function addAccess(stat, addr, size, kind, value, when) {
  stat.count++;
  stat.bytes += size;
  stat.min = Math.min(stat.min, addr);
  stat.max = Math.max(stat.max, addr + size - 1);
  stat.maxSize = Math.max(stat.maxSize, size);
  stat.kinds[kind]++;
  stat.lastAt = when;
  if (stat.unique.size < 4096) stat.unique.add(addr);
  else stat.uniqueOverflow = 1;
  if (stat.last >= 0) {
    const delta = addr - stat.last;
    if (delta === size) stat.sequential++;
    if (delta === 0) stat.constant++;
    if (delta !== 0 && Math.abs(delta) <= 65536) {
      if (stat.deltas.has(delta) || stat.deltas.size < 32) {
        stat.deltas.set(delta, (stat.deltas.get(delta) ?? 0) + 1);
      }
    }
  }
  stat.last = addr;
  if (stat.samples.length < MAX_ACCESS_SAMPLES) {
    stat.samples.push({ addr, value });
  } else {
    // Deterministic reservoir sampling: preserve the beginning of the stream and replace
    // a stable rotating suffix. This keeps loop shape without Math.random() affecting a
    // debug capture.
    const replace = stat.count % MAX_ACCESS_SAMPLES;
    if (replace >= MAX_ACCESS_SAMPLES / 2) stat.samples[replace] = { addr, value };
  }
}

function mergeAccess(into, from) {
  into.count += from.count;
  into.bytes += from.bytes;
  into.min = Math.min(into.min, from.min);
  into.max = Math.max(into.max, from.max);
  into.maxSize = Math.max(into.maxSize, from.maxSize);
  into.sequential += from.sequential;
  into.constant += from.constant;
  for (let i = 0; i < into.kinds.length; i++) into.kinds[i] += from.kinds[i];
  for (const addr of from.unique) {
    if (into.unique.size < 4096) into.unique.add(addr);
    else into.uniqueOverflow = 1;
  }
  into.uniqueOverflow |= from.uniqueOverflow;
  for (const [delta, count] of from.deltas) {
    if (into.deltas.has(delta) || into.deltas.size < 32) {
      into.deltas.set(delta, (into.deltas.get(delta) ?? 0) + count);
    }
  }
  for (const sample of from.samples) {
    if (into.samples.length >= MAX_ACCESS_SAMPLES) break;
    into.samples.push(sample);
  }
  for (const [cell, sample] of from.relations) {
    if (into.relations.size >= MAX_RELATIONS && !into.relations.has(cell)) continue;
    into.relations.set(cell, sample);
  }
  if (from.lastAt > into.lastAt) {
    into.lastAt = from.lastAt;
    into.last = from.last;
  }
}

function coalesceClusters(clusters, stat) {
  let removed = 0;
  for (let i = clusters.length - 1; i >= 0; i--) {
    const other = clusters[i];
    if (other === stat || other.owner !== stat.owner) continue;
    const gap = other.max < stat.min ? stat.min - other.max
      : stat.max < other.min ? other.min - stat.max : 0;
    if (gap > CLUSTER_GAP) continue;
    mergeAccess(stat, other);
    clusters.splice(i, 1);
    removed++;
  }
  return removed;
}

function line(pixels, width, height, x0, y0, x1, y1, colour) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 >= 0 && y0 >= 0 && x0 < width && y0 < height) {
      const p = (y0 * width + x0) * 4;
      pixels[p] = colour[0]; pixels[p + 1] = colour[1];
      pixels[p + 2] = colour[2]; pixels[p + 3] = 255;
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/**
 * A page/range level access tracer. `onBoundary` runs at a completed full-buffer pass,
 * a stable writer-region change, or a quiet point. It receives the old buffer before the
 * first store of a new writer group, which is the detail polling could never provide.
 */
export class AccessProvenance {
  constructor({ machine, onBoundary = null } = {}) {
    this.machine = machine;
    this.onBoundary = onBoundary;
    this.pageCount = Math.ceil(machine.size / PAGE_BYTES);
    this.pageRegions = new Array(this.pageCount).fill(null);
    this.regions = [];

    this.cpu = null;
    this.countBase = 0;
    this.readSeq = 0;
    this.readSeqAt = new Float64Array(RECENT);
    this.readAddr = new Uint32Array(RECENT);
    this.readSize = new Uint8Array(RECENT);
    this.readKind = new Uint8Array(RECENT);
    this.readEip = new Uint32Array(RECENT);
    this.readValue = new Float64Array(RECENT);

    // Geometry is accepted only when the access instructions themselves establish a
    // record layout. These bounded profiles retain float and possible index streams;
    // arbitrary bytes are never searched for values that merely happen to look like xyz.
    this.floatReads = new Map();
    this.integerReads = new Map();
    this.sceneStartAt = 0;
    this.geometryActive = false;
    this.geometryGeneration = machine.musicGeneration;

    // A compact, sampled dependency graph for buffers that are not known in advance.
    // The fixed arrays make the common write path allocation-free; maps are touched only
    // when the writer site changes or once per 256 writes to the same page.
    this.pageWriter = new Uint32Array(this.pageCount);
    this.pageWrites = new Uint32Array(this.pageCount);
    this.pageLastRead = new Float64Array(this.pageCount);
    this.pageDeps = new Map();
  }

  at(count) { return this.countBase + count; }

  attach(cpu, totalInstructions = 0) {
    if (this.cpu === cpu) return;
    if (this.cpu !== null) setMemoryTrace(this.cpu, null);
    this.cpu = cpu;
    this.countBase = totalInstructions - cpu.count;
    setMemoryTrace(cpu, this);
  }

  detach() {
    if (this.cpu !== null) setMemoryTrace(this.cpu, null);
    this.cpu = null;
  }

  registerRange({
    key, start, length, kind = 'buffer', labels = [], capture = true,
    onWrite = null, width = 0, height = 0, layout = null, logicalLength = length,
  }) {
    start >>>= 0;
    const old = this.regions.find((r) => r.key === key);
    if (old && old.start === start && old.length === length) {
      for (const label of labels) old.labels.add(label);
      return old;
    }

    const region = {
      id: this.regions.length, key, start, length, kind, capture, onWrite,
      width, height, layout, logicalLength: Math.min(length, logicalLength),
      labels: new Set(labels),
      chunks: new Uint8Array(Math.ceil(Math.min(length, logicalLength) / (1 << CHUNK_SHIFT))),
      touched: 0, dirty: false, epochWrites: 0, totalWrites: 0,
      lastWriteAt: 0, lastReadSeq: this.readSeq, writerGroup: -1,
      sources: new Map(), sourceClusters: 0, writers: new Map(),
      lastHash: null, snapshots: 0, frozen: false,
    };
    this.regions.push(region);

    const first = start >>> PAGE_SHIFT;
    const last = (start + length - 1) >>> PAGE_SHIFT;
    for (let page = first; page <= last && page < this.pageCount; page++) {
      let owners = this.pageRegions[page];
      if (owners === null) owners = this.pageRegions[page] = [];
      owners.push(region);
    }
    return region;
  }

  freeze(region) {
    if (region) region.frozen = true;
  }

  regionAt(at) {
    const owners = this.pageRegions[at >>> PAGE_SHIFT];
    if (owners === null) return null;
    for (const r of owners) {
      if (at >= r.start && at < r.start + r.length) return r;
    }
    return null;
  }

  read(at, size, kind, value, eip, count) {
    const seq = ++this.readSeq;
    const p = seq & RECENT_MASK;
    this.readSeqAt[p] = seq;
    this.readAddr[p] = at;
    this.readSize[p] = size;
    this.readKind[p] = KIND[kind] ?? 0;
    this.readEip[p] = eip;
    this.readValue[p] = value;
    const when = this.at(count);
    this.ensureGeometryEpoch(when);
    if (this.geometryActive && (kind === 'f32' || kind === 'f64')) {
      this.addProfile(this.floatReads, eip, at, size, KIND[kind], value, when);
    } else if (this.geometryActive
        && (kind === 'u16' || kind === 'i16' || kind === 'u32' || kind === 'i32')) {
      this.addProfile(this.integerReads, eip, at, size, KIND[kind], value, when);
    }
  }

  ensureGeometryEpoch(when) {
    if (this.machine.xm === null
        || (this.geometryActive && this.geometryGeneration === this.machine.musicGeneration)) return;
    this.geometryActive = true;
    this.geometryGeneration = this.machine.musicGeneration;
    this.sceneStartAt = when;
    this.floatReads.clear();
    this.integerReads.clear();
    this.pageDeps.clear();
    this.pageWriter.fill(0);
    this.pageWrites.fill(0);
    this.pageLastRead.fill(this.readSeq);
  }

  ownerAt(at) {
    return this.regionAt(at)?.id ?? -1;
  }

  /**
   * One load instruction can be reused for unrelated allocations. Keep up to four
   * independently expanding address islands rather than turning their extrema into one
   * fictitious mega-buffer.
   */
  accessCluster(map, eip, addr, owner = this.ownerAt(addr), create = true) {
    let clusters = map.get(eip);
    if (clusters === undefined) {
      if (!create || map.size >= MAX_GLOBAL_SITES) return null;
      clusters = [];
      map.set(eip, clusters);
    }
    let best = null, distance = Infinity;
    for (const cluster of clusters) {
      if (cluster.owner !== owner) continue;
      const d = addr < cluster.min ? cluster.min - addr
        : addr > cluster.max ? addr - cluster.max : 0;
      if (d < distance) { best = cluster; distance = d; }
    }
    // A registered region is already an exact allocation boundary. Keep one stream for
    // it even when a sampler jumps from one edge to the other; address islands are needed
    // only for otherwise anonymous memory.
    if (best !== null && owner >= 0) return best;
    if (best !== null && (distance <= CLUSTER_GAP
        || addr === best.last || addr === best.last + best.maxSize)) return best;
    if (!create || clusters.length >= MAX_CLUSTERS_PER_SITE) return null;
    const cluster = freshAccess(eip, addr, owner);
    clusters.push(cluster);
    return cluster;
  }

  addProfile(map, eip, addr, size, kind, value, when) {
    const stat = this.accessCluster(map, eip, addr);
    if (stat !== null) {
      addAccess(stat, addr, size, kind, value, when);
      coalesceClusters(map.get(eip), stat);
    }
  }

  forEachRegion(at, size, fn) {
    const first = at >>> PAGE_SHIFT;
    const last = (at + size - 1) >>> PAGE_SHIFT;
    if (first === last) {
      const owners = this.pageRegions[first];
      if (owners === null) return;
      for (const region of owners) {
        if (at < region.start + region.length && at + size > region.start) fn(region);
      }
      return;
    }
    const seen = new Set();
    for (let page = first; page <= last; page++) {
      const owners = this.pageRegions[page];
      if (owners === null) continue;
      for (const region of owners) {
        if (!seen.has(region)
            && at < region.start + region.length && at + size > region.start) {
          seen.add(region);
          fn(region);
        }
      }
    }
  }

  beforeWrite(at, size, _kind, _value, eip, count) {
    const when = this.at(count);
    this.forEachRegion(at, size, (region) => {
      if (!region.capture || region.frozen || !region.dirty) return;
      const group = eip >>> 10;
      // A different 1 KiB code neighbourhood after most of a pass is a useful operator
      // boundary. Snapshot before its first store, preserving the completed prior result.
      if (region.writerGroup >= 0 && group !== region.writerGroup
          && region.epochWrites >= 4096
          && region.touched / region.chunks.length >= 0.60) {
        this.boundary(region, when, 'writer');
      }
    });
  }

  write(at, size, kind, _value, eip, count) {
    const when = this.at(count);
    this.ensureGeometryEpoch(when);
    if (this.geometryActive) this.recordPageWrite(at, size, kind, eip, when);

    this.forEachRegion(at, size, (region) => {
      region.onWrite?.(at, size, eip, when);
      if (!region.capture || region.frozen) return;

      this.attributeReads(region, at, when);
      let writer = region.writers.get(eip);
      if (writer === undefined) {
        if (region.writers.size < 24) {
          writer = { eip, count: 0, min: 0xffffffff, max: 0, sizes: 0 };
          region.writers.set(eip, writer);
        }
      }
      if (writer !== undefined) {
        writer.count++;
        writer.min = Math.min(writer.min, at);
        writer.max = Math.max(writer.max, at + size - 1);
        writer.sizes |= size === 1 ? 1 : size === 2 ? 2 : size === 4 ? 4 : 8;
      }
      region.dirty = true;
      region.epochWrites++;
      region.totalWrites++;
      region.lastWriteAt = when;
      region.writerGroup = eip >>> 10;

      const logicalEnd = region.start + region.logicalLength;
      if (at < logicalEnd && at + size > region.start) {
        const lo = Math.max(0, at - region.start) >>> CHUNK_SHIFT;
        const hi = Math.min(region.logicalLength - 1, at + size - 1 - region.start)
          >>> CHUNK_SHIFT;
        for (let c = lo; c <= hi; c++) {
          const chunkAt = region.start + (c << CHUNK_SHIFT);
          const from = Math.max(0, at - chunkAt);
          const to = Math.min((1 << CHUNK_SHIFT) - 1, at + size - 1 - chunkAt);
          const writeMask = ((1 << (to - from + 1)) - 1) << from;
          const valid = Math.min(1 << CHUNK_SHIFT, region.logicalLength - (c << CHUNK_SHIFT));
          const fullMask = (1 << valid) - 1;
          const oldMask = region.chunks[c];
          const newMask = oldMask | writeMask;
          region.chunks[c] = newMask;
          if (oldMask !== fullMask && newMask === fullMask) region.touched++;
        }
      }
      if (region.chunks.length > 0
          && region.touched / region.chunks.length >= FULL_COVERAGE) {
        this.boundary(region, when, 'full-pass');
      }
    });
  }

  destinationCell(region, at) {
    const width = region.kind === 'framebuffer' ? this.machine.width : region.width;
    const height = region.kind === 'framebuffer' ? this.machine.height : region.height;
    if (width <= 0 || height <= 0) return -1;
    const offset = at - region.start;
    let pixel;
    if (region.layout === 'rgb565' || region.kind === 'framebuffer') {
      pixel = Math.floor(offset / 2);
    } else if (region.layout === 'packed') {
      pixel = Math.floor(offset / 3);
    } else if (region.layout === 'planar' || region.layout === 'mono') {
      pixel = offset % (width * height);
    } else {
      pixel = Math.floor(offset / Math.max(1, region.logicalLength
        / (width * height)));
    }
    if (pixel < 0 || pixel >= width * height) return -1;
    const x = pixel % width, y = Math.floor(pixel / width);
    const gx = Math.min(ACCESS_MAP_SIDE - 1, Math.floor(x * ACCESS_MAP_SIDE / width));
    const gy = Math.min(ACCESS_MAP_SIDE - 1, Math.floor(y * ACCESS_MAP_SIDE / height));
    return gy * ACCESS_MAP_SIDE + gx;
  }

  attributeReads(region, destinationAt, when) {
    const first = Math.max(region.lastReadSeq + 1, this.readSeq - RECENT + 1);
    const cell = this.destinationCell(region, destinationAt);
    for (let seq = first; seq <= this.readSeq; seq++) {
      const p = seq & RECENT_MASK;
      if (this.readSeqAt[p] !== seq) continue;
      const eip = this.readEip[p];
      let clusters = region.sources.get(eip);
      if (clusters === undefined) {
        clusters = [];
        region.sources.set(eip, clusters);
      }
      const addr = this.readAddr[p], size = this.readSize[p], k = this.readKind[p];
      const owner = this.ownerAt(addr);
      let stat = null, distance = Infinity;
      for (const candidate of clusters) {
        if (candidate.owner !== owner) continue;
        const d = addr < candidate.min ? candidate.min - addr
          : addr > candidate.max ? addr - candidate.max : 0;
        if (d < distance) { stat = candidate; distance = d; }
      }
      if (stat === null || (owner < 0 && distance > CLUSTER_GAP
          && addr !== stat.last && addr !== stat.last + stat.maxSize)) {
        if (clusters.length >= MAX_CLUSTERS_PER_SITE
            || region.sourceClusters >= MAX_SOURCE_CLUSTERS) continue;
        stat = freshAccess(eip, addr, owner);
        clusters.push(stat);
        region.sourceClusters++;
      }
      addAccess(stat, addr, size, k, this.readValue[p], when);
      region.sourceClusters -= coalesceClusters(clusters, stat);
      if (cell >= 0 && stat.relations.size < MAX_RELATIONS) {
        stat.relations.set(cell, { addr, value: this.readValue[p] });
      } else if (cell >= 0 && stat.relations.has(cell)) {
        stat.relations.set(cell, { addr, value: this.readValue[p] });
      }
    }
    region.lastReadSeq = this.readSeq;
  }

  recordPageWrite(at, size, _kind, eip, when) {
    const page = at >>> PAGE_SHIFT;
    if (page >= this.pageCount) return;
    const n = ++this.pageWrites[page];
    const changed = this.pageWriter[page] !== eip;
    this.pageWriter[page] = eip;
    if (!changed && (n & 255) !== 1) return;

    const first = Math.max(this.pageLastRead[page] + 1, this.readSeq - RECENT + 1);
    let deps = this.pageDeps.get(page);
    if (deps === undefined) {
      deps = new Map();
      this.pageDeps.set(page, deps);
    }
    for (let seq = first; seq <= this.readSeq; seq++) {
      const p = seq & RECENT_MASK;
      if (this.readSeqAt[p] !== seq) continue;
      const addr = this.readAddr[p], sourcePage = addr >>> PAGE_SHIFT;
      if (sourcePage === page || sourcePage >= this.pageCount) continue;
      let dep = deps.get(sourcePage);
      if (dep === undefined) {
        if (deps.size >= MAX_PAGE_DEPS) continue;
        dep = {
          page: sourcePage, count: 0, min: 0xffffffff, max: 0,
          kinds: new Uint32Array(KIND_NAME.length), lastAt: when,
        };
        deps.set(sourcePage, dep);
      }
      const k = this.readKind[p], bytes = this.readSize[p];
      dep.count++;
      dep.min = Math.min(dep.min, addr);
      dep.max = Math.max(dep.max, addr + bytes - 1);
      dep.kinds[k]++;
      dep.lastAt = when;
    }
    this.pageLastRead[page] = this.readSeq;
  }

  boundary(region, when, reason) {
    if (!region.dirty) return;
    const info = {
      at: when,
      reason,
      writes: region.epochWrites,
      totalWrites: region.totalWrites,
      coverage: region.touched / region.chunks.length,
      destination: {
        start: region.start,
        end: region.start + region.length - 1,
        range: `${hex(region.start)}–${hex(region.start + region.length - 1)}`,
      },
      writers: this.describeWriters(region),
      sources: this.describeSources(region, region.width, region.height),
    };
    this.onBoundary?.(region, info);
    region.chunks.fill(0);
    region.touched = 0;
    region.dirty = false;
    region.epochWrites = 0;
    region.sources.clear();
    region.sourceClusters = 0;
    region.writers.clear();
    region.lastReadSeq = this.readSeq;
    region.writerGroup = -1;
  }

  flush(totalInstructions) {
    for (const region of this.regions) {
      if (region.capture && !region.frozen && region.dirty
          && totalInstructions - region.lastWriteAt >= QUIET_INSTRUCTIONS) {
        this.boundary(region, region.lastWriteAt, 'quiet');
      }
    }
  }

  force(region, totalInstructions, reason = 'snapshot') {
    if (region?.dirty) this.boundary(region, totalInstructions, reason);
  }

  describeWriters(region) {
    return [...region.writers.values()]
      .sort((a, b) => b.count - a.count)
      .map((writer) => ({
        eip: writer.eip,
        eipHex: hex(writer.eip),
        start: writer.min,
        end: writer.max,
        range: `${hex(writer.min)}–${hex(writer.max)}`,
        writes: writer.count,
        share: writer.count / Math.max(1, region.epochWrites),
        sizes: writer.sizes,
      }));
  }

  knownSource(stat) {
    if (stat.owner < 0) return null;
    return this.regions.find((region) => region.id === stat.owner) ?? null;
  }

  relationShape(stat) {
    if (stat.relations.size === 0) {
      return { cells: 0, rows: 0, columns: 0, rowLike: false };
    }
    const rows = new Set(), columns = new Set();
    for (const cell of stat.relations.keys()) {
      rows.add(Math.floor(cell / ACCESS_MAP_SIDE));
      columns.add(cell % ACCESS_MAP_SIDE);
    }
    return {
      cells: stat.relations.size,
      rows: rows.size,
      columns: columns.size,
      rowLike: rows.size >= 12 && columns.size <= Math.max(4, rows.size / 4),
    };
  }

  classifySource(stat, region, peers = []) {
    const kindIndex = dominantKind(stat.kinds);
    const kind = KIND_NAME[kindIndex];
    const size = KIND_SIZE[kindIndex];
    const span = stat.max - stat.min + 1;
    const seq = stat.count > 1 ? stat.sequential / (stat.count - 1) : 0;
    const same = stat.count > 1 ? stat.constant / (stat.count - 1) : 0;
    const known = this.knownSource(stat);
    const unique = stat.unique.size;
    const stride = accessDelta(stat);
    const relation = this.relationShape(stat);
    const destBytes = Math.max(1, region.logicalLength);
    const copySized = span >= destBytes * 0.75 && span <= destBytes * 1.34;
    const hasTextureSampler = peers.some((peer) => {
      const owner = this.knownSource(peer);
      const peerSeq = peer.count > 1 ? peer.sequential / (peer.count - 1) : 0;
      return owner !== null && owner !== region && peer.count >= 128 && peerSeq < 0.75;
    });

    let type = 'unclassified memory input';
    let evidence = 'observed addresses';
    if (known !== null) {
      if (known === region) type = 'in-place buffer access';
      else if (seq >= 0.85 && copySized) type = 'buffer copy input';
      else if (seq < 0.75 && relation.cells >= 32) type = 'sampled texture input';
      else type = `${known.kind} input`;
      evidence = relation.cells >= 32 ? 'verified source-address map' : 'verified range';
    } else if (kind === 'f32' || kind === 'f64') {
      type = 'observed float work buffer';
    } else if (seq >= 0.85 && copySized) {
      type = 'linear buffer input';
    } else if (relation.rowLike && unique >= 12 && unique <= 1024
        && stride.support >= 0.35) {
      type = 'possible per-scanline lookup';
      evidence = 'inferred from destination-row correspondence';
    } else if ((size === 2 || size === 4) && stat.count >= 256 && unique >= 256
        && seq >= 0.65 && hasTextureSampler) {
      type = 'possible deformation-coordinate input';
      evidence = 'inferred from sequential table plus sampled texture';
    } else if (size === 1 && span >= 48 * 1024 && span <= 80 * 1024
        && unique >= 512 && seq < 0.30) {
      type = 'possible 64K palette/blend lookup';
      evidence = 'inferred from random byte indexing';
    } else if (span <= 16 * 1024 && unique >= 64 && relation.cells >= 64
        && stat.count >= unique * 2 && stride.support >= 0.20) {
      type = 'possible periodic/wave lookup';
      evidence = 'inferred from repeating address stride';
    } else if (span <= 512 || unique < 32 || same >= 0.80) {
      type = 'state / parameter block';
    }
    return {
      kind, size, span, seq, same, known, type, evidence, unique,
      uniqueSaturated: stat.uniqueOverflow !== 0,
      stride: stride.delta, strideSupport: stride.support, relation,
    };
  }

  sourcePixel(region, addr) {
    const offset = addr - region.start;
    let pixel;
    if (region.layout === 'rgb565' || region.kind === 'framebuffer') {
      pixel = Math.floor(offset / 2);
    } else if (region.layout === 'packed') {
      pixel = Math.floor(offset / 3);
    } else if (region.layout === 'planar' || region.layout === 'mono') {
      pixel = offset % Math.max(1, region.width * region.height);
    } else {
      return null;
    }
    if (pixel < 0 || pixel >= region.width * region.height) return null;
    return [pixel % region.width, Math.floor(pixel / region.width)];
  }

  accessPreview(stat, classification) {
    if (stat.relations.size < 24) return null;
    if (classification.known === null && !classification.type.startsWith('possible ')) return null;
    const pixels = new Uint8ClampedArray(ACCESS_MAP_SIDE * ACCESS_MAP_SIDE * 4);
    let minimum = Infinity, maximum = -Infinity;
    for (const { value } of stat.relations.values()) {
      if (Number.isFinite(value)) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    for (let cell = 0; cell < ACCESS_MAP_SIDE * ACCESS_MAP_SIDE; cell++) {
      const p = cell * 4;
      pixels[p] = 10; pixels[p + 1] = 13; pixels[p + 2] = 16; pixels[p + 3] = 255;
    }
    let mapped = 0;
    for (const [cell, sample] of stat.relations) {
      const p = cell * 4;
      const xy = classification.known === null
        ? null : this.sourcePixel(classification.known, sample.addr);
      if (xy !== null) {
        pixels[p] = Math.round(xy[0] * 255 / Math.max(1, classification.known.width - 1));
        pixels[p + 1] = Math.round(xy[1] * 255 / Math.max(1, classification.known.height - 1));
        pixels[p + 2] = 160;
      } else if (Number.isFinite(sample.value)) {
        if (classification.size === 1) {
          pixels[p] = sample.value & 255;
          pixels[p + 1] = sample.value & 255;
          pixels[p + 2] = sample.value & 255;
        } else {
          const value = sample.value >>> 0;
          pixels[p] = value & 255;
          pixels[p + 1] = (value >>> 8) & 255;
          pixels[p + 2] = classification.size >= 4 ? (value >>> 16) & 255
            : Math.round((sample.value - minimum) * 255 / Math.max(1, maximum - minimum));
        }
      }
      pixels[p + 3] = 255;
      mapped++;
    }
    return {
      width: ACCESS_MAP_SIDE,
      height: ACCESS_MAP_SIDE,
      kind: classification.known === null ? 'observed value map' : 'verified source-coordinate map',
      mapped,
      pixels,
    };
  }

  describeSources(region, width = 0, height = 0) {
    const all = [...region.sources.values()].flat().filter((stat) => stat.count >= 8);
    const describedAll = all.map((stat) => ({ stat, c: this.classifySource(stat, region, all) }));
    describedAll.sort((a, b) => {
      const rank = ({ c }) => c.known !== null ? 3
        : c.type.startsWith('possible ') ? 2
          : c.type === 'state / parameter block' ? 0 : 1;
      return rank(b) - rank(a)
        || b.c.unique - a.c.unique
        || b.stat.count - a.stat.count;
    });
    let parameters = 0;
    const selected = describedAll.filter(({ c }) => {
      if (c.type !== 'state / parameter block') return true;
      return parameters++ < 4;
    }).slice(0, 16);
    const total = all.reduce((sum, stat) => sum + stat.count, 0) || 1;
    return selected.map(({ stat, c }) => {
      const preview = this.accessPreview(stat, c);
      const described = {
        eip: stat.eip,
        eipHex: hex(stat.eip),
        start: stat.min,
        end: stat.max,
        range: `${hex(stat.min)}–${hex(stat.max)}`,
        reads: stat.count,
        share: stat.count / total,
        access: c.kind,
        sequential: c.seq,
        type: c.type,
        evidence: c.evidence,
        unique: c.unique,
        uniqueSaturated: c.uniqueSaturated,
        stride: c.stride,
        strideSupport: c.strideSupport,
        source: c.known ? [...c.known.labels].join('/') || c.known.key : null,
        preview,
      };
      Object.defineProperty(described, '_stat', { value: stat });
      return described;
    });
  }

  ancestorDepths(immediate, since) {
    const depths = new Map();
    let frontier = [];
    for (const source of immediate) {
      for (let page = source.start >>> PAGE_SHIFT; page <= source.end >>> PAGE_SHIFT; page++) {
        if (!depths.has(page)) {
          depths.set(page, 0);
          frontier.push(page);
        }
      }
    }
    for (let depth = 1; depth <= 2; depth++) {
      const next = [];
      for (const page of frontier) {
        const deps = this.pageDeps.get(page);
        if (deps === undefined) continue;
        for (const dep of deps.values()) {
          if (dep.lastAt < since || depths.has(dep.page)) continue;
          depths.set(dep.page, depth);
          next.push(dep.page);
        }
      }
      frontier = next;
    }
    return depths;
  }

  profileDepth(stat, depths) {
    let best = Infinity;
    for (let page = stat.min >>> PAGE_SHIFT; page <= stat.max >>> PAGE_SHIFT; page++) {
      const depth = depths.get(page);
      if (depth !== undefined) best = Math.min(best, depth);
    }
    return best;
  }

  scoreObservedMesh(group, stride, depth) {
    const reference = Math.min(...group.map((entry) => entry.stat.min));
    const byOffset = new Map();
    for (const entry of group) {
      const offset = ((entry.stat.min - reference) % stride + stride) % stride;
      const prior = byOffset.get(offset);
      if (prior === undefined || entry.support > prior.support) byOffset.set(offset, entry);
    }
    const offsets = [...byOffset.keys()].sort((a, b) => a - b);
    if (offsets.length < 3) return null;

    let best = null;
    for (let a = 0; a < offsets.length - 2; a++) {
      for (let b = a + 1; b < offsets.length - 1; b++) {
        for (let c = b + 1; c < offsets.length; c++) {
          const fields = [offsets[a], offsets[b], offsets[c]];
          const entries = fields.map((offset) => byOffset.get(offset));
          let firstRecord = 0, lastRecord = Infinity;
          for (let field = 0; field < 3; field++) {
            const stat = entries[field].stat;
            firstRecord = Math.max(firstRecord,
              Math.ceil((stat.min - reference - fields[field]) / stride));
            lastRecord = Math.min(lastRecord,
              Math.floor((stat.max - reference - fields[field]) / stride));
          }
          const records = Math.min(4096, lastRecord - firstRecord + 1);
          if (records < 8) continue;
          const start = reference + firstRecord * stride;
          const lo = [Infinity, Infinity, Infinity];
          const hi = [-Infinity, -Infinity, -Infinity];
          let valid = 0;
          for (let i = 0; i < records; i++) {
            const xyz = fields.map((offset) =>
              this.machine.mem.getFloat32(start + i * stride + offset, true));
            if (xyz.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e8)) {
              valid++;
              for (let axis = 0; axis < 3; axis++) {
                lo[axis] = Math.min(lo[axis], xyz[axis]);
                hi[axis] = Math.max(hi[axis], xyz[axis]);
              }
            }
          }
          const ratio = valid / records;
          const varying = lo.reduce(
            (count, value, axis) => count + (hi[axis] - value > 1e-6 ? 1 : 0), 0,
          );
          if (ratio < 0.98 || varying < 3) continue;
          const support = entries.reduce((sum, entry) => sum + entry.support, 0) / 3;
          const score = support * 0.55 + Math.min(records / 256, 1) * 0.20
            + ratio * 0.25;
          if (best === null || score > best.score) {
            const end = start + (records - 1) * stride + fields[2] + 3;
            best = {
              start,
              end,
              range: `${hex(start)}–${hex(end)}`,
              stride,
              fieldOffsets: fields,
              readerEips: entries.map((entry) => entry.stat.eip),
              readerEipHex: entries.map((entry) => hex(entry.stat.eip)),
              strideSupport: support,
              vertices: valid,
              records,
              score,
              depth,
              bounds: lo.map((value, axis) => [value, hi[axis]]),
              hash: fnv1a(this.machine.u8, start, Math.min(records * stride, 64 * 1024)),
            };
          }
        }
      }
    }
    return best;
  }

  scoreObservedIndices(stat, vertices, depth) {
    if (vertices < 8 || stat.samples.length < 24) return null;
    const kind = KIND_NAME[dominantKind(stat.kinds)];
    const size = KIND_SIZE[dominantKind(stat.kinds)];
    if (!['u16', 'i16', 'u32', 'i32'].includes(kind)) return null;
    const stride = accessDelta(stat);
    if (stride.delta !== size || stride.support < 0.60) return null;
    // The same draw list is commonly traversed once per frame. Collapse repeated reads
    // by physical address so five sampled frames do not masquerade as five concatenated
    // copies of the topology.
    const byAddress = new Map();
    for (const sample of stat.samples) byAddress.set(sample.addr, sample.value);
    const observed = [...byAddress].sort((a, b) => a[0] - b[0]);
    const values = [];
    const unique = new Set();
    let valid = 0, maximum = 0;
    for (const [, rawValue] of observed) {
      const value = size === 2 ? rawValue & 0xffff : rawValue >>> 0;
      if (value < vertices) {
        valid++;
        maximum = Math.max(maximum, value);
        unique.add(value);
        values.push(value);
      }
    }
    const ratio = valid / observed.length;
    if (ratio < 0.98 || maximum < 3 || unique.size < 8) return null;
    return {
      start: stat.min,
      end: stat.max,
      range: `${hex(stat.min)}–${hex(stat.max)}`,
      size,
      indices: values.length,
      triangles: Math.floor(values.length / 3),
      readerEip: stat.eip,
      readerEipHex: hex(stat.eip),
      strideSupport: stride.support,
      depth,
      values,
    };
  }

  /**
   * A mesh candidate now requires three observed float field streams with a shared record
   * stride and a path to the framebuffer. No arbitrary range is parsed looking for lucky
   * IEEE-754 bit patterns.
   */
  meshCandidates(frameRegion, width, height, immediate = null) {
    immediate ??= this.describeSources(frameRegion, width, height);
    const since = this.sceneStartAt > 0
      ? this.sceneStartAt
      : Math.max(0, frameRegion.lastWriteAt - 20_000_000);
    const depths = this.ancestorDepths(immediate, since);
    const profiles = [...this.floatReads.values()].flat().flatMap((stat) => {
      if (stat.lastAt < since || stat.count < 24) return [];
      const kind = KIND_NAME[dominantKind(stat.kinds)];
      if (kind !== 'f32') return [];
      const stride = accessDelta(stat);
      if (stride.delta < 12 || stride.delta > 256 || (stride.delta & 3) !== 0
          || stride.support < 0.35) return [];
      const depth = this.profileDepth(stat, depths);
      return Number.isFinite(depth) ? [{ stat, stride: stride.delta, support: stride.support, depth }] : [];
    });

    const candidates = [];
    const seen = new Set();
    for (const anchor of profiles) {
      const group = profiles.filter((entry) => entry.stride === anchor.stride
        && entry.depth === anchor.depth
        && entry.stat.min <= anchor.stat.max + anchor.stride
        && entry.stat.max >= anchor.stat.min - anchor.stride);
      const groupMin = Math.min(...group.map((entry) => entry.stat.min));
      const groupMax = Math.max(...group.map((entry) => entry.stat.max));
      const signature = `${anchor.stride}:${groupMin >>> PAGE_SHIFT}:${groupMax >>> PAGE_SHIFT}:`
        + group.map((entry) => entry.stat.eip).sort((a, b) => a - b).join(':');
      if (group.length < 3 || seen.has(signature)) continue;
      seen.add(signature);
      const candidate = this.scoreObservedMesh(group, anchor.stride, anchor.depth);
      if (candidate !== null) candidates.push(candidate);
    }

    const integerProfiles = [...this.integerReads.values()].flat()
      .filter((stat) => stat.lastAt >= since && Number.isFinite(this.profileDepth(stat, depths)));
    const best = candidates.sort((a, b) => b.score - a.score).slice(0, 4);
    for (const candidate of best) {
      let index = null;
      for (const stat of integerProfiles) {
        if (stat.min < candidate.end && stat.max >= candidate.start) continue;
        const scored = this.scoreObservedIndices(
          stat, candidate.records, this.profileDepth(stat, depths),
        );
        if (scored !== null && (index === null || scored.indices > index.indices)) index = scored;
      }
      candidate.index = index;
      candidate.preview = this.meshPreview(candidate);
      if (candidate.index !== null) delete candidate.index.values;
    }
    return best;
  }

  meshPreview(candidate) {
    const width = 240, height = 180;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      pixels[p] = 10; pixels[p + 1] = 13; pixels[p + 2] = 16; pixels[p + 3] = 255;
    }
    const ranges = candidate.bounds.map(([lo, hi]) => hi - lo);
    const axes = [0, 1, 2].sort((a, b) => ranges[b] - ranges[a]).slice(0, 2);
    const [ax, ay] = axes;
    const sx = ranges[ax] || 1, sy = ranges[ay] || 1;
    const points = [];
    const mem = this.machine.mem;
    const count = Math.min(candidate.records, 4096);
    for (let i = 0; i < count; i++) {
      const at = candidate.start + i * candidate.stride;
      const xyz = candidate.fieldOffsets.map((offset) => mem.getFloat32(at + offset, true));
      if (!xyz.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e8)) {
        points.push(null);
        continue;
      }
      points.push([
        8 + (xyz[ax] - candidate.bounds[ax][0]) / sx * (width - 16),
        height - 8 - (xyz[ay] - candidate.bounds[ay][0]) / sy * (height - 16),
      ]);
    }
    const topology = candidate.index?.values ?? null;
    if (topology !== null) {
      for (let i = 0; i + 2 < topology.length; i += 3) {
        const a = points[topology[i]], b = points[topology[i + 1]], c = points[topology[i + 2]];
        if (!a || !b || !c) continue;
        line(pixels, width, height, a[0], a[1], b[0], b[1], [28, 73, 91]);
        line(pixels, width, height, b[0], b[1], c[0], c[1], [28, 73, 91]);
        line(pixels, width, height, c[0], c[1], a[0], a[1], [28, 73, 91]);
      }
    }
    for (const point of points) {
      if (!point) continue;
      const x = Math.round(point[0]), y = Math.round(point[1]);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const p = (y * width + x) * 4;
      pixels[p] = 71; pixels[p + 1] = 190; pixels[p + 2] = 143; pixels[p + 3] = 255;
    }
    return {
      width,
      height,
      axes: axes.map((a) => 'xyz'[a]).join(''),
      topology: topology === null ? 'observed point cloud (no verified indices)'
        : 'observed index stream',
      pixels,
    };
  }

  scene(frameRegion, width, height, totalInstructions) {
    if (!frameRegion?.dirty) return null;
    frameRegion.width = width;
    frameRegion.height = height;
    const sources = this.describeSources(frameRegion, width, height);
    const meshes = this.meshCandidates(frameRegion, width, height, sources);
    const report = {
      at: totalInstructions,
      writes: frameRegion.epochWrites,
      destination: {
        start: frameRegion.start,
        end: frameRegion.start + width * height * 2 - 1,
        range: `${hex(frameRegion.start)}–${hex(frameRegion.start + width * height * 2 - 1)}`,
      },
      writers: this.describeWriters(frameRegion),
      sources,
      meshes,
    };
    // A screen flip is the exact semantic boundary for framebuffer provenance.
    frameRegion.chunks.fill(0);
    frameRegion.touched = 0;
    frameRegion.dirty = false;
    frameRegion.epochWrites = 0;
    frameRegion.sources.clear();
    frameRegion.sourceClusters = 0;
    frameRegion.writers.clear();
    frameRegion.lastReadSeq = this.readSeq;
    frameRegion.writerGroup = -1;
    this.sceneStartAt = totalInstructions;
    this.floatReads.clear();
    this.integerReads.clear();
    this.pageDeps.clear();
    this.pageWriter.fill(0);
    this.pageWrites.fill(0);
    this.pageLastRead.fill(this.readSeq);
    return report;
  }
}
