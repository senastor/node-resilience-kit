'use strict';

class SlidingWindowLimiter {
  /**
   * @param {number} maxRequests - Maximum requests allowed per window
   * @param {number} windowMs - Window duration in milliseconds
   */
  constructor(maxRequests, windowMs) {
    if (!Number.isFinite(maxRequests) || maxRequests < 0) {
      throw new Error('maxRequests must be a non-negative finite number');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('windowMs must be a positive finite number');
    }
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} key -> sorted array of timestamps */
    this._store = new Map();
    this._lastCleanup = Date.now();
    this._cleanupIntervalMs = Math.max(windowMs * 2, 60000);
  }

  /** Remove timestamps outside the current window for a key's entry list. */
  _prune(entries, now) {
    const cutoff = now - this.windowMs;
    // Binary search for first entry >= cutoff
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid] <= cutoff) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) entries.splice(0, lo);
  }

  /** Periodically remove keys whose entries are all expired. */
  _cleanup(now) {
    if (now - this._lastCleanup < this._cleanupIntervalMs) return;
    this._lastCleanup = now;
    const cutoff = now - this.windowMs;
    for (const [key, entries] of this._store) {
      if (entries.length === 0 || entries[entries.length - 1] <= cutoff) {
        this._store.delete(key);
      }
    }
  }

  /**
   * Check if a request is allowed without consuming a token.
   * @param {string} key
   * @returns {{allowed: boolean, remaining: number, resetAt: number}}
   */
  isAllowed(key) {
    const now = Date.now();
    const entries = this._store.get(key);
    if (!entries) {
      return {
        allowed: this.maxRequests > 0,
        remaining: this.maxRequests > 0 ? this.maxRequests - 1 : 0,
        resetAt: now + this.windowMs,
      };
    }
    this._prune(entries, now);
    const count = entries.length;
    const remaining = Math.max(0, this.maxRequests - count - (this.maxRequests > 0 ? 1 : 0));
    const resetAt = count > 0 ? entries[0] + this.windowMs : now + this.windowMs;
    return {
      allowed: count < this.maxRequests,
      remaining,
      resetAt,
    };
  }

  /**
   * Consume one token for the given key.
   * @param {string} key
   * @returns {{allowed: boolean, remaining: number, resetAt: number}}
   */
  consume(key) {
    const now = Date.now();
    this._cleanup(now);

    let entries = this._store.get(key);
    if (!entries) {
      entries = [];
      this._store.set(key, entries);
    }
    this._prune(entries, now);

    if (this.maxRequests === 0) {
      return { allowed: false, remaining: 0, resetAt: now + this.windowMs };
    }

    if (entries.length < this.maxRequests) {
      entries.push(now);
      const remaining = this.maxRequests - entries.length;
      const resetAt = entries[0] + this.windowMs;
      return { allowed: true, remaining, resetAt };
    }

    // Over limit – don't append
    const resetAt = entries[0] + this.windowMs;
    return { allowed: false, remaining: 0, resetAt };
  }

  /**
   * Clear history for a key.
   * @param {string} key
   */
  reset(key) {
    this._store.delete(key);
  }

  /**
   * Return stats for a key.
   * @param {string} key
   * @returns {{count: number, remaining: number, windowStart: number, windowEnd: number}}
   */
  getStats(key) {
    const now = Date.now();
    const entries = this._store.get(key);
    if (!entries) {
      return {
        count: 0,
        remaining: this.maxRequests,
        windowStart: now - this.windowMs,
        windowEnd: now,
      };
    }
    this._prune(entries, now);
    const count = entries.length;
    return {
      count,
      remaining: Math.max(0, this.maxRequests - count),
      windowStart: entries.length > 0 ? entries[0] : now - this.windowMs,
      windowEnd: now,
    };
  }
}

module.exports = { SlidingWindowLimiter };
