// Audio output for the port.
//
// The replayer runs in an AudioWorklet, on the audio thread. That matters: the CPU
// interpreter is slower than real time in places, and music that stalls whenever the
// emulation does would be worse than no music. Running the player on the audio thread
// keeps playback continuous, and the demo follows the music rather than the reverse —
// which is what the real loader did, since it asked MIDAS where the module had got to.
//
// The worklet module is assembled from lib/xm.js's own source text rather than importing
// it, so there is exactly one copy of the replayer and no dependency on static imports
// being supported inside worklets.

const PROCESSOR_GLUE = `
class XmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.player = null;
    this.sinceReport = 0;
    this.port.onmessage = (ev) => {
      if (ev.data.cmd === 'load') {
        this.player = new XmPlayer(new Uint8Array(ev.data.xm), sampleRate);
        this.port.postMessage({
          type: 'ready',
          title: this.player.title,
          channels: this.player.channels,
          bpm: this.player.defaultBpm,
          speed: this.player.defaultSpeed,
          orders: this.player.songLength,
          unsupported: [...this.player.unsupported],
        });
      } else if (ev.data.cmd === 'stop') {
        this.player = null;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.player) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    this.player.render(left, right, left.length);

    // Report position roughly every 100 ms; the demo polls it far less often than that.
    this.sinceReport += left.length;
    if (this.sinceReport >= sampleRate / 10) {
      this.sinceReport = 0;
      this.port.postMessage({
        type: 'position',
        pos: this.player.position,
        row: this.player.row,
        loops: this.player.loops,
      });
    }
    return true;
  }
}
registerProcessor('xm-player', XmProcessor);
`;

export class XmAudio {
  constructor({ onPosition, onLog } = {}) {
    this.onPosition = onPosition ?? (() => {});
    this.onLog = onLog ?? (() => {});
    this.ctx = null;
    this.node = null;
  }

  /** Build the worklet. Must be called from a user gesture so the context can start. */
  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();

    const res = await fetch('./lib/xm.js');
    if (!res.ok) throw new Error(`cannot read lib/xm.js (${res.status})`);
    // Strip the ES export keyword; worklet globals are plain script scope.
    const source = (await res.text()).replace(/^export\s+/gm, '');

    const url = URL.createObjectURL(
      new Blob([source, PROCESSOR_GLUE], { type: 'text/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.node = new AudioWorkletNode(this.ctx, 'xm-player', { outputChannelCount: [2] });
    this.node.port.onmessage = ({ data }) => {
      if (data.type === 'position') this.onPosition(data);
      else if (data.type === 'ready') {
        this.onLog(`audio: ${data.channels} channels, ${data.orders} orders, `
                   + `speed ${data.speed}, ${data.bpm} BPM`
                   + (data.title ? ` — "${data.title}"` : ''));
        if (data.unsupported.length) {
          this.onLog(`audio: ignoring unsupported ${data.unsupported.join(', ')}`, 'warn');
        }
      }
    };
    this.node.connect(this.ctx.destination);
  }

  /** Hand a generated XM module to the player. */
  async play(bytes) {
    await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // Copy, because the buffer is transferred away.
    const copy = bytes.slice();
    this.node.port.postMessage({ cmd: 'load', xm: copy.buffer }, [copy.buffer]);
  }

  stop() {
    if (this.node) this.node.port.postMessage({ cmd: 'stop' });
  }

  async suspend() { if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend(); }
  async resume() { if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume(); }

  close() {
    this.stop();
    if (this.node) { this.node.disconnect(); this.node = null; }
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}
