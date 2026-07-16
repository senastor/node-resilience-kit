'use strict';

/**
 * healthCheck.js
 * Production-ready health checks and graceful shutdown for Node.js microservices.
 *
 * - HealthChecker: liveness/readiness probes, async custom checks, Express-compatible
 *   middleware plus a native http handler.
 * - GracefulShutdown: signal-driven (SIGTERM/SIGINT/SIGHUP) shutdown that drains
 *   in-flight requests, runs cleanup hooks, and force-exits on timeout.
 *
 * Zero runtime dependencies — Node.js built-ins only.
 *
 * @module healthCheck
 */

const http = require('http');
const { EventEmitter } = require('events');

/* -------------------------------------------------------------------------- *
 * HealthChecker
 * -------------------------------------------------------------------------- */

/**
 * Default per-check timeout (ms). A single health check function that takes
 * longer than this is treated as a failure so one slow dependency cannot
 * stall a probe indefinitely.
 */
const DEFAULT_CHECK_TIMEOUT = 5000;

/**
 * Format a check result consistently.
 * @param {string} name
 * @param {boolean} ok
 * @param {number} durationMs
 * @param {Error|string|null} [err]
 * @param {*} [value] optional value returned by the check
 * @returns {object}
 */
function formatCheck(name, ok, durationMs, err, value) {
  const result = {
    name,
    status: ok ? 'pass' : 'fail',
    durationMs: Math.round(durationMs),
  };
  if (err) result.error = typeof err === 'string' ? err : (err && err.message) ? err.message : String(err);
  if (value !== undefined) result.value = value;
  return result;
}

/**
 * Run a single async check function with a timeout guard.
 * Resolves to a formatted check object.
 *
 * @param {string} name
 * @param {Function} fn async check function, may return a value or throw
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function runOneCheck(name, fn, timeoutMs) {
  const start = process.hrtime.bigint();
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => fn()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`check "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    return formatCheck(name, true, durationMs, null, value);
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    return formatCheck(name, false, durationMs, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * HealthChecker tracks liveness and readiness probes and exposes an
 * Express-compatible middleware as well as a plain Node.js http handler.
 *
 * Liveness probes answer "is the process alive?" — typically cheap and
 * always-true unless the process is wedged.
 * Readiness probes answer "is the service ready to serve traffic?" —
 * typically check downstream dependencies (DB, cache, upstream APIs).
 */
class HealthChecker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.checkTimeoutMs=5000] per-check timeout
   */
  constructor(opts = {}) {
    this.checkTimeoutMs = Number.isFinite(opts.checkTimeoutMs) ? opts.checkTimeoutMs : DEFAULT_CHECK_TIMEOUT;
    /** @type {Map<string, Function>} liveness checks by name */
    this._liveness = new Map();
    /** @type {Map<string, Function>} readiness checks by name */
    this._readiness = new Map();
    this._startedAt = Date.now();
  }

  /** Uptime in milliseconds. */
  uptimeMs() {
    return Date.now() - this._startedAt;
  }

  /**
   * Register a liveness check.
   * @param {string} name unique check name
   * @param {Function} fn async function; throw / reject to fail
   * @returns {this}
   */
  addLivenessCheck(name, fn) {
    if (typeof name !== 'string' || !name) throw new TypeError('check name must be a non-empty string');
    if (typeof fn !== 'function') throw new TypeError('check function must be a function');
    this._liveness.set(name, fn);
    return this;
  }

  /**
   * Register a readiness check.
   * @param {string} name unique check name
   * @param {Function} fn async function; throw / reject to fail
   * @returns {this}
   */
  addReadinessCheck(name, fn) {
    if (typeof name !== 'string' || !name) throw new TypeError('check name must be a non-empty string');
    if (typeof fn !== 'function') throw new TypeError('check function must be a function');
    this._readiness.set(name, fn);
    return this;
  }

  /**
   * Remove a liveness check by name.
   * @param {string} name
   * @returns {boolean}
   */
  removeLivenessCheck(name) {
    return this._liveness.delete(name);
  }

  /**
   * Remove a readiness check by name.
   * @param {string} name
   * @returns {boolean}
   */
  removeReadinessCheck(name) {
    return this._readiness.delete(name);
  }

  /**
   * Run a set of checks and return the aggregated result.
   * @param {Map<string, Function>} checks
   * @param {string} kind 'liveness' | 'readiness'
   * @returns {Promise<object>}
   */
  async _runChecks(checks, kind) {
    const names = [...checks.keys()];
    const results = await Promise.all(
      names.map((name) => runOneCheck(name, checks.get(name), this.checkTimeoutMs)),
    );
    const ok = results.every((r) => r.status === 'pass');
    return {
      status: ok ? 'ok' : 'fail',
      kind,
      timestamp: new Date().toISOString(),
      uptimeMs: this.uptimeMs(),
      checks: results,
    };
  }

  /** Run all liveness checks. */
  async checkLiveness() {
    return this._runChecks(this._liveness, 'liveness');
  }

  /** Run all readiness checks. */
  async checkReadiness() {
    return this._runChecks(this._readiness, 'readiness');
  }

  /**
   * Send a probe result as an HTTP response.
   * @param {http.ServerResponse} res
   * @param {object} payload result from checkLiveness/checkReadiness
   */
  _send(res, payload) {
    const status = payload.status === 'ok' ? 200 : 503;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  /**
   * Express-compatible middleware. Mount on whatever path you like:
   *
   *   const health = new HealthChecker();
   *   app.get('/health', health.middleware('liveness'));
   *   app.get('/ready',  health.middleware('readiness'));
   *
   * Also works with plain `http.createServer` routing (see `handler()`).
   *
   * @param {'liveness'|'readiness'} [kind='liveness']
   * @returns {(req: http.IncomingMessage, res: http.ServerResponse, next?: Function) => void}
   */
  middleware(kind = 'liveness') {
    const runner = kind === 'readiness' ? () => this.checkReadiness() : () => this.checkLiveness();
    return (req, res, next) => {
      Promise.resolve()
        .then(runner)
        .then((payload) => this._send(res, payload))
        .catch((err) => {
          // Should be unreachable (runOneCheck swallows errors), but be safe.
          const payload = {
            status: 'fail',
            kind,
            timestamp: new Date().toISOString(),
            error: err && err.message ? err.message : String(err),
          };
          this._send(res, payload);
          if (typeof next === 'function') next(err);
        });
    };
  }

  /**
   * Plain Node.js http request handler that routes `/health` → liveness and
   * `/ready` → readiness. Anything else returns 404. Useful without Express:
   *
   *   http.createServer(health.handler()).listen(8081);
   *
   * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
   */
  handler() {
    return (req, res) => {
      const url = (req.url || '').split('?')[0];
      if (url === '/health' || url === '/healthz' || url === '/live') {
        return this.middleware('liveness')(req, res);
      }
      if (url === '/ready' || url === '/readyz') {
        return this.middleware('readiness')(req, res);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
    };
  }
}

/* -------------------------------------------------------------------------- *
 * GracefulShutdown
 * -------------------------------------------------------------------------- */

/**
 * Default total shutdown timeout (ms). If drain + cleanup hasn't completed by
 * this deadline the process force-exits with code 1.
 */
const DEFAULT_SHUTDOWN_TIMEOUT = 30000;

/**
 * States the shutdown manager moves through.
 */
const STATE = Object.freeze({
  RUNNING: 'running',
  SHUTTING_DOWN: 'shutting_down',
  DONE: 'done',
});

/**
 * GracefulShutdown listens for SIGTERM/SIGINT/SIGHUP and orchestrates a
 * clean shutdown: stop accepting new connections, drain in-flight requests,
 * run cleanup hooks, and force-exit if the total time exceeds a deadline.
 *
 * Emits:
 *   - 'shutdown:start'   (signal)
 *   - 'drain:done'       ()
 *   - 'cleanup:start'    ()
 *   - 'cleanup:done'     ()
 *   - 'shutdown:done'    (code)
 *   - 'shutdown:timeout' ()
 *
 * @extends EventEmitter
 */
class GracefulShutdown extends EventEmitter {
  /**
   * @param {object} opts
   * @param {http.Server} opts.server the http.Server to drain & close
   * @param {number} [opts.timeout=30000] total shutdown budget in ms
   * @param {Array<{name:string, fn:Function}>} [opts.cleanup] cleanup hooks
   * @param {object} [opts.logger] optional {info,warn,error} logger
   * @param {string[]} [opts.signals] signals to trap
   * @param {boolean} [opts.exitOnTimeout=true] call process.exit on timeout
   */
  constructor(opts = {}) {
    super();
    if (!opts || !opts.server) {
      throw new TypeError('GracefulShutdown requires an opts.server (http.Server)');
    }
    this.server = opts.server;
    this.timeout = Number.isFinite(opts.timeout) ? opts.timeout : DEFAULT_SHUTDOWN_TIMEOUT;
    this.logger = opts.logger || console;
    this.signals = opts.signals || ['SIGTERM', 'SIGINT', 'SIGHUP'];
    this.exitOnTimeout = opts.exitOnTimeout !== false;
    /** @type {Array<{name:string, fn:Function}>} */
    this._cleanupHooks = [];
    if (Array.isArray(opts.cleanup)) {
      for (const h of opts.cleanup) this.addCleanupHook(h.name, h.fn);
    }
    this._state = STATE.RUNNING;
    this._signalHandlers = new Map();
    this._hardExitTimer = null;
  }

  /**
   * Register a cleanup hook (e.g. close DB, flush logs). Hooks run
   * sequentially in registration order during shutdown.
   * @param {string} name
   * @param {Function} fn async function
   * @returns {this}
   */
  addCleanupHook(name, fn) {
    if (typeof name !== 'string' || !name) throw new TypeError('cleanup hook name must be a non-empty string');
    if (typeof fn !== 'function') throw new TypeError('cleanup hook fn must be a function');
    this._cleanupHooks.push({ name, fn });
    return this;
  }

  /**
   * Attach signal listeners. Safe to call once.
   * @returns {this}
   */
  install() {
    if (this._signalHandlers.size > 0) return this;
    for (const sig of this.signals) {
      const handler = () => this.shutdown(sig);
      this._signalHandlers.set(sig, handler);
      process.on(sig, handler);
    }
    // Guard against unhandled errors during shutdown.
    process.on('uncaughtException', (err) => {
      if (this._state !== STATE.RUNNING) {
        this.logger.error('[graceful-shutdown] uncaughtException during shutdown:', err);
        this._forceExit(1);
      }
    });
    return this;
  }

  /**
   * Detach signal listeners (useful for tests).
   * @returns {this}
   */
  uninstall() {
    for (const [sig, handler] of this._signalHandlers) {
      process.removeListener(sig, handler);
    }
    this._signalHandlers.clear();
    return this;
  }

  /**
   * Whether a shutdown has been initiated.
   * @returns {boolean}
   */
  isShuttingDown() {
    return this._state !== STATE.RUNNING;
  }

  /**
   * Initiate graceful shutdown. Idempotent — subsequent calls resolve to the
   * same promise. Resolves with the exit code (does not call process.exit
   * unless the timeout fires and exitOnTimeout is true).
   *
   * @param {string} [signal='manual']
   * @returns {Promise<number>}
   */
  async shutdown(signal = 'manual') {
    // Idempotent: if already shutting down, return the in-flight promise.
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shutdownPromise = this._doShutdown(signal);
    return this._shutdownPromise;
  }

  async _doShutdown(signal) {
    this._state = STATE.SHUTTING_DOWN;
    this.logger.info(`[graceful-shutdown] received ${signal}, shutting down`);
    this.emit('shutdown:start', signal);

    // Absolute deadline for the whole shutdown sequence.
    const deadline = Date.now() + this.timeout;

    // Hard-exit watchdog: if we blow past the deadline, exit immediately.
    await new Promise((resolve) => {
      this._hardExitTimer = setTimeout(() => {
        this.logger.error(`[graceful-shutdown] total timeout (${this.timeout}ms) exceeded, forcing exit`);
        this.emit('shutdown:timeout');
        if (this.exitOnTimeout) {
          this._forceExit(1);
        } else {
          resolve();
        }
      }, this.timeout);
      this._hardExitTimer.unref?.();
      resolve(); // resolve immediately so the sequence proceeds; watchdog runs in background
    });

    // 1. Stop accepting new connections and drop idle keep-alive sockets so
    //    they don't hold up the drain. Node >= 18.2 provides these helpers.
    try {
      if (typeof this.server.closeIdleConnections === 'function') {
        this.server.closeIdleConnections();
      }
    } catch (e) {
      // non-fatal
    }

    // 2. server.close() stops the listener and fires its callback once all
    //    kept-alive connections have drained. We race it against a drain
    //    budget that is at most half the total timeout, leaving the rest
    //    for cleanup hooks.
    const drainBudget = Math.min(
      Math.max(Math.floor(this.timeout * 0.5), 500),
      deadline - Date.now()
    );
    const drainDeadline = Date.now() + drainBudget;
    const drainPromise = new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        this.server.close(done);
      } catch (e) {
        this.logger.warn('[graceful-shutdown] server.close threw:', e && e.message);
        done();
      }
      // Safety: if close() never calls back within drain budget, resolve
      // and force-close any remaining connections.
      const drainRemaining = drainDeadline - Date.now();
      setTimeout(() => {
        try {
          if (typeof this.server.closeAllConnections === 'function') {
            this.server.closeAllConnections();
          }
        } catch (e) { /* non-fatal */ }
        done();
      }, Math.max(drainRemaining, 0)).unref?.();
    });

    await drainPromise;
    if (this._state === STATE.DONE) return 1; // watchdog already fired
    this.emit('drain:done');

    // 3. Run cleanup hooks sequentially within the remaining budget.
    this.emit('cleanup:start');
    await this._runCleanupHooks(deadline);
    if (this._state === STATE.DONE) return 1;
    this.emit('cleanup:done');

    // 4. Finished cleanly.
    this._state = STATE.DONE;
    if (this._hardExitTimer) {
      clearTimeout(this._hardExitTimer);
      this._hardExitTimer = null;
    }
    this.emit('shutdown:done', 0);
    this.logger.info('[graceful-shutdown] shutdown complete');
    return 0;
  }

  /**
   * Run cleanup hooks sequentially. Each hook is guarded by the remaining
   * time before the deadline; a hook that throws or times out is logged but
   * does not abort the rest of the sequence.
   * @param {number} deadline absolute ms timestamp
   */
  async _runCleanupHooks(deadline) {
    for (const { name, fn } of this._cleanupHooks) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.logger.warn(`[graceful-shutdown] skipping cleanup hook "${name}" (out of time)`);
        break;
      }
      try {
        await Promise.race([
          Promise.resolve().then(() => fn()),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`cleanup hook "${name}" timed out`)), remaining).unref?.(),
          ),
        ]);
        this.logger.info(`[graceful-shutdown] cleanup hook "${name}" done`);
      } catch (err) {
        this.logger.error(`[graceful-shutdown] cleanup hook "${name}" failed:`, err && err.message ? err.message : err);
      }
    }
  }

  /**
   * Force-exit the process immediately, clearing timers first.
   * @param {number} code
   * @private
   */
  _forceExit(code) {
    this._state = STATE.DONE;
    if (this._hardExitTimer) {
      clearTimeout(this._hardExitTimer);
      this._hardExitTimer = null;
    }
    // Best-effort destruction of any lingering sockets.
    try {
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
    } catch (e) { /* ignore */ }
    this.emit('shutdown:done', code);
    if (this.exitOnTimeout) {
      // Slight delay to allow final log flush; then exit.
      setImmediate(() => process.exit(code));
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Exports
 * -------------------------------------------------------------------------- */

module.exports = {
  HealthChecker,
  GracefulShutdown,
  // Convenience re-exports
  DEFAULT_CHECK_TIMEOUT,
  DEFAULT_SHUTDOWN_TIMEOUT,
};
