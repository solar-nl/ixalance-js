// Own the browser resources for exactly one production run. Starting a replacement is
// deliberately synchronous: the previous worker, download, queued messages and audio
// context lose ownership before any asynchronous setup for the new production begins.

export class RunSessionManager {
  constructor({ onDeactivate } = {}) {
    this.current = null;
    this.onDeactivate = onDeactivate ?? (() => {});
  }

  begin(config = {}) {
    this.stop(this.current);
    const run = {
      ...config,
      worker: null,
      audio: null,
      abort: new AbortController(),
      closed: false,
    };
    this.current = run;
    return run;
  }

  isActive(run) {
    return this.current === run && !run.closed;
  }

  stop(run = this.current) {
    if (!run || run.closed) return false;
    run.closed = true;
    const wasCurrent = this.current === run;
    if (wasCurrent) this.current = null;

    run.abort.abort();
    if (run.worker) {
      try { run.worker.postMessage({ cmd: 'stop' }); } catch {}
      try { run.worker.terminate(); } catch {}
      run.worker = null;
    }
    if (run.audio) {
      try { run.audio.close(); } catch {}
      run.audio = null;
    }

    if (wasCurrent) this.onDeactivate(run);
    return wasCurrent;
  }
}
