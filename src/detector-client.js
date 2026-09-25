/**
 * Main-thread client for the detector worker (blueprint §2, §11).
 *
 * - One active analysis and at most one pending (latest) request; an older
 *   pending request is superseded, never queued. Frames never accumulate.
 * - Replies for canceled or stale request IDs are ignored.
 * - If the worker fails to start, crashes or times out, the failed request is
 *   retried once on the main thread in small async chunks; later requests
 *   stay on the main thread. A second failure is a recoverable error.
 */
import { analyzePixelsChunked, createDetectorContext, DetectorError, measureCalibrationPatch } from './detection/pipeline.js';

const READY_TIMEOUT_MS = 8000;
const JOB_TIMEOUT_MS = 20000;

export class DetectorClient {
  #config;
  #palette;
  #settings = { profiles: [], groupingSettings: null };
  #worker = null;
  #mode = 'starting';
  #seq = 0;
  #active = null;
  #pending = null;
  #localCtx = null;

  constructor({ config, palette }) {
    this.#config = config;
    this.#palette = palette;
  }

  get mode() {
    return this.#mode;
  }

  /** Start the module worker; fall back to the main thread if it can't start. */
  async start() {
    try {
      const worker = new Worker(new URL('./worker/detector.worker.js', import.meta.url), { type: 'module' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker start timeout')), READY_TIMEOUT_MS);
        worker.onmessage = (event) => {
          const msg = event.data;
          if (msg.type === 'ready') {
            clearTimeout(timer);
            if (msg.configVersion !== this.#config.configVersion || msg.paletteVersion !== this.#palette.paletteVersion) {
              reject(new DetectorError('version-mismatch'));
            } else resolve();
          } else if (msg.type === 'init-error') {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          event.preventDefault?.();
          reject(new Error(event.message || 'worker error'));
        };
      });
      worker.onmessage = (event) => this.#onMessage(event.data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        this.#onWorkerFailure();
      };
      worker.onmessageerror = () => this.#onWorkerFailure();
      this.#worker = worker;
      this.#mode = 'worker';
      this.#postConfigure();
    } catch (err) {
      if (err instanceof DetectorError) throw err;
      this.#mode = 'main-thread';
    }
    return this.#mode;
  }

  /**
   * Update approved profiles and grouping settings for subsequent scans.
   * Sent directly (not queued): the worker handles messages in order, so a
   * later analyze always sees this configuration, and it can never
   * supersede a pending scan.
   */
  configure({ profiles, groupingSettings }) {
    this.#settings = { profiles: profiles ?? [], groupingSettings: groupingSettings ?? null };
    this.#localCtx = null;
    this.#postConfigure();
  }

  #postConfigure() {
    if (this.#mode === 'worker') this.#worker.postMessage({ type: 'configure', requestId: 0, ...this.#settings });
  }

  /**
   * request = { extract: () => ({rgba, width, height, sourcePx}), roi, source,
   *             calibration, debug }
   * `extract` is called when the job actually starts (and again for a retry).
   */
  analyze(request) {
    return this.#enqueue('analyze', request);
  }

  calibrate(request) {
    return this.#enqueue('calibrate', request);
  }

  /** Cancel the active and pending jobs; late replies are ignored. */
  cancel() {
    if (this.#pending) {
      this.#pending.reject(new DetectorError('canceled'));
      this.#pending = null;
    }
    if (this.#active) {
      this.#active.abort?.abort();
      this.#active.reject(new DetectorError('canceled'));
      clearTimeout(this.#active.timer);
      this.#active = null;
    }
  }

  #enqueue(kind, request) {
    return new Promise((resolve, reject) => {
      const job = { kind, request, resolve, reject };
      if (!this.#active) this.#run(job);
      else {
        this.#pending?.reject(new DetectorError('superseded'));
        this.#pending = job;
      }
    });
  }

  #finish(job, error, payload) {
    if (this.#active !== job) return;
    clearTimeout(job.timer);
    this.#active = null;
    if (error) job.reject(error);
    else job.resolve(payload);
    const next = this.#pending;
    this.#pending = null;
    if (next) this.#run(next);
  }

  #run(job) {
    job.id = ++this.#seq;
    this.#active = job;
    if (this.#mode === 'worker') this.#runWorker(job);
    else this.#runLocal(job);
  }

  #runWorker(job) {
    try {
      const px = job.request.extract();
      // Transfer the pixel buffer (copy first only if it is a view into a larger buffer).
      const rgba = px.rgba.buffer.byteLength === px.rgba.length ? px.rgba.buffer : px.rgba.slice().buffer;
      const message = {
        type: job.kind,
        requestId: job.id,
        rgba,
        width: px.width,
        height: px.height,
        sourceRoiPx: px.sourcePx,
        roi: job.request.roi,
        source: job.request.source,
        calibration: job.request.calibration ?? null,
        debug: Boolean(job.request.debug),
        configVersion: this.#config.configVersion,
        paletteVersion: this.#palette.paletteVersion,
      };
      job.timer = setTimeout(() => this.#onWorkerFailure(), JOB_TIMEOUT_MS);
      this.#worker.postMessage(message, [rgba]);
    } catch (err) {
      this.#finish(job, err instanceof DetectorError ? err : new DetectorError(err?.code ?? 'invalid-input', err?.message));
    }
  }

  #onMessage(msg) {
    const job = this.#active;
    if (!job || msg.requestId !== job.id) return; // stale or canceled
    if (msg.type === 'error') this.#finish(job, new DetectorError(msg.code, msg.message));
    else this.#finish(job, null, msg.payload);
  }

  #onWorkerFailure() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#mode = 'main-thread';
    const job = this.#active;
    if (!job) return;
    clearTimeout(job.timer);
    if (job.retried) {
      this.#finish(job, new DetectorError('analysis-failed'));
      return;
    }
    job.retried = true;
    this.#runLocal(job);
  }

  #context() {
    this.#localCtx ??= createDetectorContext({ config: this.#config, palette: this.#palette, ...this.#settings });
    return this.#localCtx;
  }

  async #runLocal(job) {
    try {
      const px = job.request.extract();
      if (job.kind === 'calibrate') {
        this.#finish(job, null, measureCalibrationPatch(px, this.#context()));
        return;
      }
      job.abort = new AbortController();
      const output = await analyzePixelsChunked(
        {
          rgba: px.rgba,
          width: px.width,
          height: px.height,
          roi: job.request.roi,
          sourceRoiPx: px.sourcePx,
          source: job.request.source,
          calibration: job.request.calibration ?? null,
        },
        this.#context(),
        { signal: job.abort.signal, debug: Boolean(job.request.debug) },
      );
      this.#finish(job, null, output);
    } catch (err) {
      const error = err instanceof DetectorError ? err : new DetectorError(job.retried ? 'analysis-failed' : 'internal', err?.message);
      this.#finish(job, error);
    }
  }
}
