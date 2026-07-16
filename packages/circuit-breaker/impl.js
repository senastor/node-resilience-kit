'use strict';

const { EventEmitter } = require('events');

/**
 * Circuit states enumeration.
 * @readonly
 * @enum {string}
 */
const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

/**
 * Default configuration values.
 */
const DEFAULTS = Object.freeze({
  failureThreshold: 5,        // consecutive failures before opening
  resetTimeout: 30000,        // ms before transitioning OPEN -> HALF_OPEN
  halfOpenMaxCalls: 3,        // successful calls required in HALF_OPEN to close
  halfOpenMaxConcurrent: 1,   // concurrent trial calls allowed in HALF_OPEN
  timeout: 0,                 // per-call timeout in ms (0 = disabled)
  fallback: null,             // function to invoke when rejecting fast
});

/**
 * CircuitBreaker implements the circuit breaker pattern for protecting
 * downstream service calls. It maintains three states:
 *
 *   CLOSED    — calls flow through normally; consecutive failures are counted.
 *   OPEN      — calls are rejected immediately (fast-fail) and the fallback
 *               (if any) is invoked. After `resetTimeout` ms, the breaker
 *               transitions to HALF_OPEN.
 *   HALF_OPEN — a limited number of trial calls are permitted. If they all
 *               succeed, the breaker returns to CLOSED. Any failure re-opens
 *               the circuit.
 *
 * @class CircuitBreaker
 * @extends {EventEmitter}
 * @fires CircuitBreaker#open       Emitted on CLOSED -> OPEN.
 * @fires CircuitBreaker#close      Emitted on HALF_OPEN -> CLOSED.
 * @fires CircuitBreaker#halfOpen   Emitted on OPEN -> HALF_OPEN.
 * @fires CircuitBreaker#fallback   Emitted when a fallback is invoked.
 */
class CircuitBreaker extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.failureThreshold]       Consecutive failures to open. Default 5.
   * @param {number} [options.resetTimeout]           ms before OPEN -> HALF_OPEN. Default 30000.
   * @param {number} [options.halfOpenMaxCalls]       Successful trial calls to close. Default 3.
   * @param {number} [options.halfOpenMaxConcurrent]  Concurrent trial calls in HALF_OPEN. Default 1.
   * @param {number} [options.timeout]                Per-call timeout ms (0 disables). Default 0.
   * @param {function} [options.fallback]             Fallback invoked on fast-fail.
   * @param {string}   [options.name]                 Optional descriptive name.
   */
  constructor(options = {}) {
    super();
    if (options === null || typeof options !== 'object') {
      throw new TypeError('CircuitBreaker options must be an object');
    }

    this.options = Object.assign({}, DEFAULTS, options);

    // Validate numeric options.
    const numericKeys = ['failureThreshold', 'resetTimeout', 'halfOpenMaxCalls', 'halfOpenMaxConcurrent', 'timeout'];
    for (const key of numericKeys) {
      const val = this.options[key];
      if (typeof val !== 'number' || Number.isNaN(val) || val < 0) {
        throw new TypeError(`options.${key} must be a non-negative number`);
      }
    }
    if (this.options.failureThreshold < 1) {
      throw new RangeError('options.failureThreshold must be >= 1');
    }
    if (this.options.halfOpenMaxCalls < 1) {
      throw new RangeError('options.halfOpenMaxCalls must be >= 1');
    }
    if (this.options.fallback != null && typeof this.options.fallback !== 'function') {
      throw new TypeError('options.fallback must be a function or null/undefined');
    }

    this.name = this.options.name || 'CircuitBreaker';

    // Runtime state.
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;            // consecutive successes since last reset
    this.totalFailures = 0;           // lifetime failure tally
    this.totalSuccesses = 0;          // lifetime success tally
    this.lastFailureTime = null;      // Date.now() of most recent failure
    this.lastFailureError = null;     // most recent failure error
    this.openedAt = null;             // timestamp when OPEN began
    this._halfOpenInFlight = 0;       // trial calls currently running in HALF_OPEN
    this._halfOpenSuccesses = 0;      // trial successes in current HALF_OPEN window
    this._resetTimer = null;
    this._halfOpenConcurrentGuard = 0;
    this._halfOpenPending = 0;        // calls deferred until a trial slot frees up

    // Track transitions for diagnostics: [{ from, to, at }]
    this.transitions = [];

    this._emitTransition = this._emitTransition.bind(this);
  }

  /* --------------------------------------------------------------------- *
   * Public API
   * --------------------------------------------------------------------- */

  /**
   * Invoke `fn` through the circuit breaker.
   *
   * - In CLOSED: calls fn directly; counts successes/failures.
   * - In OPEN: rejects immediately with the last failure error (or a generic
   *   error). If a fallback is configured, the fallback's result is emitted
   *   and returned.
   * - In HALF_OPEN: allows a bounded number of concurrent trial calls. Extra
   *   callers wait for a trial slot. Trial success counts toward closing the
   *   circuit; trial failure re-opens it immediately.
   *
   * @param {function} fn Async or sync function to wrap.
   * @param {...*} args   Arguments forwarded to fn.
   * @returns {Promise<*>} Result of fn, or fallback result when OPEN.
   * @rejects {Error} If the call fails and no fallback is available.
   */
  async call(fn, ...args) {
    if (typeof fn !== 'function') {
      throw new TypeError('call() requires a function argument');
    }

    // Refresh state if reset timeout has elapsed while OPEN.
    this._maybeTransitionToHalfOpen();

    if (this.state === STATES.OPEN) {
      return this._fastFail();
    }

    if (this.state === STATES.HALF_OPEN) {
      return this._callHalfOpen(fn, args);
    }

    // CLOSED
    return this._callClosed(fn, args);
  }

  /**
   * Returns a snapshot of the circuit breaker's current runtime metrics.
   * @returns {{state: string, failureCount: number, successCount: number, lastFailureTime: number|null}}
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Force the circuit into the OPEN state (e.g. from external health checks).
   * @returns {void}
   */
  forceOpen() {
    if (this.state !== STATES.OPEN) {
      this._transitionTo(STATES.OPEN);
    }
  }

  /**
   * Force the circuit into the CLOSED state, resetting counters.
   * @returns {void}
   */
  forceClose() {
    this._clearResetTimer();
    if (this.state !== STATES.CLOSED) {
      this._transitionTo(STATES.CLOSED);
    }
    this._resetCounters();
  }

  /**
   * Returns the list of recorded state transitions.
   * @returns {Array<{from: string, to: string, at: number}>}
   */
  getTransitions() {
    return this.transitions.slice();
  }

  /* --------------------------------------------------------------------- *
   * Internal helpers
   * --------------------------------------------------------------------- */

  /**
   * Run a call in CLOSED state.
   * @private
   */
  async _callClosed(fn, args) {
    try {
      const result = await this._invoke(fn, args);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  /**
   * Run a call in HALF_OPEN state, limiting concurrency of trial calls.
   * @private
   */
  async _callHalfOpen(fn, args) {
    // Wait for a trial slot if concurrency is at the limit.
    if (this._halfOpenConcurrentGuard >= this.options.halfOpenMaxConcurrent) {
      await this._waitForTrialSlot();
      // After waiting, the circuit may have re-opened (another trial failed)
      // or fully closed (enough trials succeeded).
      if (this.state === STATES.OPEN) {
        return this._fastFail();
      }
      if (this.state === STATES.CLOSED) {
        // Circuit closed by another trial — call normally now.
        return this._callClosed(fn, args);
      }
    }

    this._halfOpenConcurrentGuard++;
    this._halfOpenInFlight++;
    try {
      const result = await this._invoke(fn, args);
      this._onHalfOpenSuccess();
      return result;
    } catch (err) {
      this._onHalfOpenFailure(err);
      throw err;
    } finally {
      this._halfOpenInFlight--;
      this._halfOpenConcurrentGuard--;
      this._drainPending();
    }
  }

  /**
   * Wait until a trial slot is available in HALF_OPEN.
   * @private
   */
  _waitForTrialSlot() {
    return new Promise((resolve) => {
      this._halfOpenPending++;
      this._pendingResolvers = this._pendingResolvers || [];
      this._pendingResolvers.push(resolve);
    });
  }

  /**
   * Release the next pending caller (if any) into a trial slot.
   * @private
   */
  _drainPending() {
    if (this._pendingResolvers && this._pendingResolvers.length) {
      const resolve = this._pendingResolvers.shift();
      this._halfOpenPending--;
      resolve();
    }
  }

  /**
   * Invoke fn with optional per-call timeout.
   * @private
   */
  _invoke(fn, args) {
    if (this.options.timeout > 0) {
      return this._invokeWithTimeout(fn, args, this.options.timeout);
    }
    return Promise.resolve().then(() => fn(...args));
  }

  /**
   * Invoke fn with a timeout. Rejects with a TimeoutError if the call does
   * not settle within `ms` milliseconds.
   * @private
   */
  _invokeWithTimeout(fn, args, ms) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new TimeoutError(`CircuitBreaker "${this.name}" call timed out after ${ms}ms`));
        }
      }, ms);

      Promise.resolve()
        .then(() => fn(...args))
        .then((val) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(val);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
    });
  }

  /**
   * Fast-fail path used when the circuit is OPEN. Invokes the fallback if
   * configured and emits a 'fallback' event.
   * @private
   */
  async _fastFail() {
    const err = this.lastFailureError
      || new Error(`CircuitBreaker "${this.name}" is open`);

    if (this.options.fallback) {
      try {
        const fbResult = await this.options.fallback(err);
        this.emit('fallback', { error: err, result: fbResult, source: 'open' });
        return fbResult;
      } catch (fbErr) {
        this.emit('fallback', { error: err, fallbackError: fbErr, source: 'open' });
        throw fbErr;
      }
    }
    throw err;
  }

  /* --------------------------------------------------------------------- *
   * State management
   * --------------------------------------------------------------------- */

  /**
   * Called on every successful call (in CLOSED state).
   * @private
   */
  _onSuccess() {
    this.totalSuccesses++;
    this.successCount++;
    // In CLOSED state a single success resets the consecutive failure counter.
    this.failureCount = 0;
  }

  /**
   * Called on every failed call (in CLOSED state).
   * @private
   */
  _onFailure(err) {
    this.failureCount++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();
    this.lastFailureError = err;

    if (this.failureCount >= this.options.failureThreshold) {
      this._transitionTo(STATES.OPEN);
    }
  }

  /**
   * Called on a successful trial call in HALF_OPEN.
   * @private
   */
  _onHalfOpenSuccess() {
    this.totalSuccesses++;
    this._halfOpenSuccesses++;
    if (this._halfOpenSuccesses >= this.options.halfOpenMaxCalls) {
      this._transitionTo(STATES.CLOSED);
    }
  }

  /**
   * Called on a failed trial call in HALF_OPEN. Immediately re-opens.
   * @private
   */
  _onHalfOpenFailure(err) {
    this.totalFailures++;
    this.lastFailureTime = Date.now();
    this.lastFailureError = err;
    this._halfOpenSuccesses = 0;
    this._transitionTo(STATES.OPEN);
  }

  /**
   * Synchronously transition to a new state, recording and emitting events.
   * @private
   */
  _transitionTo(newState) {
    const prev = this.state;
    if (prev === newState) return;

    this.transitions.push({ from: prev, to: newState, at: Date.now() });
    this.state = newState;

    if (newState === STATES.OPEN) {
      this.openedAt = Date.now();
      this._scheduleReset();
      this._emitTransition('open', prev, newState);
      this.emit('open', { from: prev, to: newState, openedAt: this.openedAt });
    } else if (newState === STATES.HALF_OPEN) {
      this._halfOpenSuccesses = 0;
      this._halfOpenInFlight = 0;
      this._halfOpenConcurrentGuard = 0;
      this._emitTransition('halfOpen', prev, newState);
      this.emit('halfOpen', { from: prev, to: newState });
    } else if (newState === STATES.CLOSED) {
      this._emitTransition('close', prev, newState);
      this.emit('close', { from: prev, to: newState });
      this._resetCounters();
    }
  }

  /**
   * Reset failure/success counters (called when entering CLOSED).
   * @private
   */
  _resetCounters() {
    this.failureCount = 0;
    this.successCount = 0;
    this._halfOpenSuccesses = 0;
    this._halfOpenInFlight = 0;
    this._halfOpenConcurrentGuard = 0;
    this._clearResetTimer();
  }

  /**
   * Schedule the transition from OPEN to HALF_OPEN after resetTimeout.
   * @private
   */
  _scheduleReset() {
    this._clearResetTimer();
    if (this.options.resetTimeout <= 0) return;
    this._resetTimer = setTimeout(() => {
      this._resetTimer = null;
      if (this.state === STATES.OPEN) {
        this._transitionTo(STATES.HALF_OPEN);
      }
    }, this.options.resetTimeout);
    // Don't keep the event loop alive solely for this timer.
    if (this._resetTimer && typeof this._resetTimer.unref === 'function') {
      this._resetTimer.unref();
    }
  }

  /**
   * Clear any pending reset timer.
   * @private
   */
  _clearResetTimer() {
    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
  }

  /**
   * Lazily transition OPEN -> HALF_OPEN if resetTimeout has elapsed.
   * Called at the start of every call() invocation so that callers don't have
   * to wait for the timer callback — they observe the transition immediately.
   * @private
   */
  _maybeTransitionToHalfOpen() {
    if (this.state !== STATES.OPEN) return;
    if (this.options.resetTimeout <= 0) return;
    if (this.openedAt === null) return;
    if (Date.now() - this.openedAt >= this.options.resetTimeout) {
      this._clearResetTimer();
      this._transitionTo(STATES.HALF_OPEN);
    }
  }

  /**
   * Emit a low-level transition event (used for logging/diagnostics).
   * @private
   */
  _emitTransition(eventName, from, to) {
    // no-op; placeholder for structured logging hooks
  }

  /* --------------------------------------------------------------------- *
   * Cleanup
   * --------------------------------------------------------------------- */

  /**
   * Clear timers and remove all listeners. Call when discarding the breaker.
   * @returns {void}
   */
  destroy() {
    this._clearResetTimer();
    if (this._pendingResolvers) {
      this._pendingResolvers.forEach((r) => r());
      this._pendingResolvers = [];
    }
    this.removeAllListeners();
  }
}

/**
 * Error thrown when a per-call timeout fires.
 */
class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'CIRCUIT_BREAKER_TIMEOUT';
  }
}

/**
 * Factory helper for creating a CircuitBreaker with options.
 * @param {object} [options] Same options as the constructor.
 * @returns {CircuitBreaker}
 */
function createCircuitBreaker(options) {
  return new CircuitBreaker(options);
}

module.exports = CircuitBreaker;
module.exports.CircuitBreaker = CircuitBreaker;
module.exports.STATES = STATES;
module.exports.TimeoutError = TimeoutError;
module.exports.createCircuitBreaker = createCircuitBreaker;
module.exports.DEFAULTS = DEFAULTS;
