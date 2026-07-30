// Opt-in DataView instrumentation for guest data accesses.
//
// CPU instruction fetch/decode deliberately keeps using CPU.rawMem. When this view is
// installed as CPU.mem, interpreter operands, x87 callouts and the generated JIT all pass
// through the same hooks. Normal playback retains the original DataView object and pays
// none of this indirection.

export class TracedDataView {
  constructor(view, cpu, sink) {
    this.view = view;
    this.cpu = cpu;
    this.sink = sink;
  }

  get buffer() { return this.view.buffer; }
  get byteLength() { return this.view.byteLength; }
  get byteOffset() { return this.view.byteOffset; }

  read(at, size, kind, value) {
    this.sink.read(
      at >>> 0, size, kind, value, this.cpu.insStart >>> 0, this.cpu.count,
    );
    return value;
  }

  before(at, size, kind, value) {
    this.sink.beforeWrite(
      at >>> 0, size, kind, value, this.cpu.insStart >>> 0, this.cpu.count,
    );
  }

  wrote(at, size, kind, value) {
    this.sink.write(
      at >>> 0, size, kind, value, this.cpu.insStart >>> 0, this.cpu.count,
    );
  }

  getUint8(at) {
    return this.read(at, 1, 'u8', this.view.getUint8(at));
  }

  getInt8(at) {
    return this.read(at, 1, 'i8', this.view.getInt8(at));
  }

  getUint16(at, littleEndian = false) {
    return this.read(at, 2, 'u16', this.view.getUint16(at, littleEndian));
  }

  getInt16(at, littleEndian = false) {
    return this.read(at, 2, 'i16', this.view.getInt16(at, littleEndian));
  }

  getUint32(at, littleEndian = false) {
    return this.read(at, 4, 'u32', this.view.getUint32(at, littleEndian));
  }

  getInt32(at, littleEndian = false) {
    return this.read(at, 4, 'i32', this.view.getInt32(at, littleEndian));
  }

  getFloat32(at, littleEndian = false) {
    return this.read(at, 4, 'f32', this.view.getFloat32(at, littleEndian));
  }

  getFloat64(at, littleEndian = false) {
    return this.read(at, 8, 'f64', this.view.getFloat64(at, littleEndian));
  }

  setUint8(at, value) {
    this.before(at, 1, 'u8', value);
    this.view.setUint8(at, value);
    this.wrote(at, 1, 'u8', value);
  }

  setInt8(at, value) {
    this.before(at, 1, 'i8', value);
    this.view.setInt8(at, value);
    this.wrote(at, 1, 'i8', value);
  }

  setUint16(at, value, littleEndian = false) {
    this.before(at, 2, 'u16', value);
    this.view.setUint16(at, value, littleEndian);
    this.wrote(at, 2, 'u16', value);
  }

  setInt16(at, value, littleEndian = false) {
    this.before(at, 2, 'i16', value);
    this.view.setInt16(at, value, littleEndian);
    this.wrote(at, 2, 'i16', value);
  }

  setUint32(at, value, littleEndian = false) {
    this.before(at, 4, 'u32', value);
    this.view.setUint32(at, value, littleEndian);
    this.wrote(at, 4, 'u32', value);
  }

  setInt32(at, value, littleEndian = false) {
    this.before(at, 4, 'i32', value);
    this.view.setInt32(at, value, littleEndian);
    this.wrote(at, 4, 'i32', value);
  }

  setFloat32(at, value, littleEndian = false) {
    this.before(at, 4, 'f32', value);
    this.view.setFloat32(at, value, littleEndian);
    this.wrote(at, 4, 'f32', value);
  }

  setFloat64(at, value, littleEndian = false) {
    this.before(at, 8, 'f64', value);
    this.view.setFloat64(at, value, littleEndian);
    this.wrote(at, 8, 'f64', value);
  }
}

/** Install or remove tracing without changing any normal-playback memory call site. */
export function setMemoryTrace(cpu, sink = null) {
  const changed = (cpu.mem === cpu.rawMem) !== (sink === null);
  cpu.mem = sink === null ? cpu.rawMem : new TracedDataView(cpu.rawMem, cpu, sink);
  // Generated functions bake whether they publish per-instruction trace context. A
  // debugger normally attaches before the first block runs, but clearing here also makes
  // late attach/detach exact and prevents a traced variant leaking into normal playback.
  if (changed && cpu.jitTab instanceof Map) {
    cpu.jitTab.clear();
    cpu.jitSlot?.fill(null);
    cpu.jitEmits = 0;
  }
}
