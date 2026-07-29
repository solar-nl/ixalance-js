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
    this.generation = 0;
    this.port.onmessage = (ev) => {
      if (ev.data.cmd === 'load') {
        this.generation = ev.data.generation;
        this.sinceReport = 0;
        this.player = new XmPlayer(new Uint8Array(ev.data.xm), sampleRate);
        this.port.postMessage({
          type: 'ready',
          generation: this.generation,
          title: this.player.title,
          channels: this.player.channels,
          bpm: this.player.defaultBpm,
          speed: this.player.defaultSpeed,
          orders: this.player.songLength,
          unsupported: [...this.player.unsupported],
        });
      } else if (ev.data.cmd === 'stop') {
        this.generation = ev.data.generation;
        this.sinceReport = 0;
        this.player = null;
        this.port.postMessage({ type: 'stopped', generation: this.generation });
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
        generation: this.generation,
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
    this.initPromise = null;
    this.generation = 0;
  }

  /**
   * Build and unlock the worklet. Calling this method itself (rather than merely creating
   * XmAudio) from the Start click matters in Safari: waiting until the demo produces its
   * XM loses the user activation that Web Audio rendering requires.
   */
  init() {
    if (!this.initPromise) {
      this.initPromise = this.build().catch((error) => {
        this.initPromise = null;
        if (this.node) { this.node.disconnect(); this.node = null; }
        if (this.ctx) { this.ctx.close(); this.ctx = null; }
        throw error;
      });
    }
    return this.initPromise;
  }

  async build() {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) throw new Error('Web Audio is not supported by this browser');
    const ctx = this.ctx = new Context();
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      throw new Error('AudioWorklet is not supported (Safari 14.1 or newer is required)');
    }

    // Invoke resume before the first await, while the click's user activation is still
    // live. Keep preparing the graph before awaiting it: some Safari versions only finish
    // the transition to running once an output node has been connected.
    const resumed = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();

    // Version the worklet source explicitly: it is fetched as text and therefore is not
    // part of either the page's or worker's ES-module graph.
    const res = await fetch('./lib/xm.js?v=prod-switching-v15');
    if (!res.ok) throw new Error(`cannot read lib/xm.js (${res.status})`);
    // Strip the ES export keyword; worklet globals are plain script scope.
    const source = (await res.text()).replace(/^export\s+/gm, '');

    const url = URL.createObjectURL(
      new Blob([source, PROCESSOR_GLUE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    if (this.ctx !== ctx) throw new Error('audio initialization was cancelled');
    this.node = new AudioWorkletNode(ctx, 'xm-player', { outputChannelCount: [2] });
    this.node.port.onmessage = ({ data }) => {
      // A TBL1 handoff can race a position report already queued by the previous player.
      // Module generations make that old report harmless instead of letting XM 1's final
      // order overwrite XM 2's freshly reset 0:0 position.
      if (data.generation !== this.generation) return;
      if (data.type === 'position') this.onPosition(data);
      else if (data.type === 'ready') {
        this.onLog(`audio: ${data.channels} channels, ${data.orders} orders, `
                   + `speed ${data.speed}, ${data.bpm} BPM`
                   + (data.title ? ` — "${data.title}"` : ''));
        if (data.unsupported.length) {
          this.onLog(`audio: ignoring unsupported ${data.unsupported.join(', ')}`, 'warn');
        }
      } else if (data.type === 'stopped') this.onLog('audio: stopped');
    };
    this.node.onprocessorerror = () => {
      this.onLog('audio worklet processor stopped unexpectedly', 'err');
    };
    this.node.connect(ctx.destination);
    await resumed;
    if (ctx.state !== 'running') {
      throw new Error(`audio context did not start (state: ${ctx.state})`);
    }
    this.onLog(`audio: context running at ${ctx.sampleRate} Hz`);
  }

  /** Hand a generated XM module to the player. */
  async play(bytes, generation = this.generation + 1) {
    this.generation = generation;
    await this.init();
    if (this.ctx.state !== 'running') await this.resume();
    if (generation !== this.generation) return; // superseded while init/resume was pending
    // Copy, because the buffer is transferred away.
    const copy = bytes.slice();
    this.node.port.postMessage(
      { cmd: 'load', xm: copy.buffer, generation },
      [copy.buffer],
    );
  }

  stop() {
    const generation = ++this.generation;
    if (this.node) this.node.port.postMessage({ cmd: 'stop', generation });
  }

  async suspend() { if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend(); }
  async resume() {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      await this.ctx.resume();
    }
    if (this.ctx && this.ctx.state !== 'running') {
      throw new Error(`audio context did not resume (state: ${this.ctx.state})`);
    }
  }

  close() {
    this.stop();
    if (this.node) { this.node.disconnect(); this.node = null; }
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
    this.initPromise = null;
  }
}
