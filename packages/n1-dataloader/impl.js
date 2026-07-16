'use strict';

/**
 * DataLoader — Batches multiple individual loads into a single batched call.
 *
 * Usage:
 *   const loader = new DataLoader(async (keys) => {
 *     const rows = await db.query('SELECT * FROM users WHERE id IN (?)', [keys]);
 *     return keys.map(k => rows.find(r => r.id === k) || null);
 *   });
 *
 *   const [alice, bob] = await Promise.all([loader.load(1), loader.load(2)]);
 */

class DataLoader {
  #batchFn;
  #cache;
  #cacheEnabled;
  #maxBatchSize;
  #batchScheduleFn;
  #queue;
  #scheduled;

  /**
   * @param {Function} batchFn — async (keys: any[]) => any[]
   *   Receives an array of unique keys and must return an array of values
   *   in the same order.  Return null/undefined for missing keys.
   * @param {Object} [options]
   * @param {boolean} [options.cache=true]      Enable per-instance cache
   * @param {number}  [options.maxBatchSize=Infinity] Max keys per batch
   * @param {Function} [options.batchScheduleFn] Scheduler, default: queueMicrotask
   */
  constructor(batchFn, options = {}) {
    if (typeof batchFn !== 'function') {
      throw new TypeError('DataLoader: batchFn must be a function');
    }

    this.#batchFn = batchFn;
    this.#cache = options.cache !== false ? new Map() : null;
    this.#cacheEnabled = options.cache !== false;
    this.#maxBatchSize = options.maxBatchSize || Infinity;
    this.#batchScheduleFn = options.batchScheduleFn || ((cb) => queueMicrotask(cb));
    this.#queue = [];
    this.#scheduled = false;
  }

  /**
   * Load a single key. Returns a Promise that resolves to the value.
   */
  load(key) {
    if (key == null) {
      return Promise.reject(
        new TypeError('DataLoader.load: key must not be null or undefined')
      );
    }

    // Cache hit — return immediately
    if (this.#cacheEnabled && this.#cache.has(key)) {
      return Promise.resolve(this.#cache.get(key));
    }

    // Check if already in-flight (dedup within same tick)
    const existing = this.#queue.find((entry) => entry.key === key);
    if (existing) {
      return existing.promise;
    }

    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.#queue.push({ key, resolve, reject });

    if (!this.#scheduled) {
      this.#scheduled = true;
      this.#batchScheduleFn(() => this.#dispatch());
    }

    return promise;
  }

  /**
   * Load multiple keys. Returns a Promise<Array> in the same order.
   */
  loadMany(keys) {
    return Promise.all(keys.map((k) => this.load(k)));
  }

  /**
   * Prime the cache with a key-value pair.
   */
  prime(key, value) {
    if (this.#cacheEnabled) {
      this.#cache.set(key, value);
    }
    return this;
  }

  /**
   * Clear a specific key from cache, or the entire cache.
   */
  clear(key) {
    if (this.#cacheEnabled) {
      if (key === undefined) {
        this.#cache.clear();
      } else {
        this.#cache.delete(key);
      }
    }
    return this;
  }

  /**
   * Execute the batch function with all queued keys.
   */
  async #dispatch() {
    this.#scheduled = false;

    const batch = this.#queue.splice(0);
    if (batch.length === 0) return;

    // Dedup keys while preserving order for the first occurrence
    const seen = new Set();
    const uniqueBatch = [];
    for (const entry of batch) {
      if (!seen.has(entry.key)) {
        seen.add(entry.key);
        uniqueBatch.push(entry);
      }
    }

    const keys = uniqueBatch.map((e) => e.key);

    // Respect maxBatchSize — split into sub-batches
    const subBatches = [];
    for (let i = 0; i < keys.length; i += this.#maxBatchSize) {
      subBatches.push(keys.slice(i, i + this.#maxBatchSize));
    }

    let allResults;
    try {
      const resultArrays = await Promise.all(
        subBatches.map((subKeys) => this.#batchFn(subKeys))
      );
      allResults = resultArrays.flat();
    } catch (err) {
      // Reject all pending promises from this batch
      for (const entry of batch) {
        entry.reject(err);
      }
      return;
    }

    // Build a key → result map
    const resultMap = new Map();
    for (let i = 0; i < keys.length; i++) {
      resultMap.set(keys[i], allResults[i]);
    }

    // Resolve all promises, including duplicates
    for (const entry of batch) {
      const value = resultMap.get(entry.key);
      if (this.#cacheEnabled) {
        // Cache null/undefined results too?  No — only cache non-nullish values
        // to avoid poisoning the cache for keys that don't exist.
        if (value !== null && value !== undefined) {
          this.#cache.set(entry.key, value);
        }
      }
      entry.resolve(value);
    }
  }
}

// ---------------------------------------------------------------------------
// Key normalization utility (shared)
// ---------------------------------------------------------------------------

function makeKey(label, args) {
  const norm = args.map((a) => {
    if (typeof a === 'object' && a !== null) {
      try {
        return JSON.stringify(a, Object.keys(a).sort());
      } catch {
        return String(a);
      }
    }
    return String(a);
  });
  return `${label}::${norm.join('|')}`;
}

// ---------------------------------------------------------------------------
// N+1 Detector — middleware / interceptor that detects repeated query patterns
// ---------------------------------------------------------------------------

/**
 * NPlusOneDetector — wraps a data-fetching function and detects when the same
 * query pattern repeats N times within a tick, flagging N+1 problems.
 *
 * Usage:
 *   const detector = new NPlusOneDetector({ threshold: 3, onDetect: (report) => console.warn(report) });
 *   const safeFetch = detector.wrap(myFetchFunction);
 */
class NPlusOneDetector {
  #threshold;
  #onDetect;
  #windowMs;
  #counters;
  #cleanupTimer;

  /**
   * @param {Object} options
   * @param {number} [options.threshold=5]    How many repeats trigger detection
   * @param {Function} [options.onDetect]     Callback(report) when N+1 is detected
   * @param {number} [options.windowMs=0]     Time window in ms (0 = same microtask tick)
   */
  constructor(options = {}) {
    this.#threshold = options.threshold ?? 5;
    this.#onDetect = options.onDetect || null;
    this.#windowMs = options.windowMs ?? 0;
    this.#counters = new Map();

    if (this.#windowMs > 0) {
      this.#cleanupTimer = setInterval(() => this.#prune(), Math.max(this.#windowMs, 100));
      if (this.#cleanupTimer.unref) this.#cleanupTimer.unref();
    }
  }

  get threshold() {
    return this.#threshold;
  }

  /**
   * Wrap a function to detect N+1 patterns.
   * The wrapped function returns the same result as the original.
   */
  wrap(fn, label = 'unknown') {
    const self = this;
    const wrapped = function (...args) {
      const key = makeKey(label, args);
      self.#record(key, label, args);
      return fn.apply(this, args);
    };
    return wrapped;
  }

  /**
   * Manually record a query call (for async functions or interceptors).
   * Returns an object with { detected, key, count, label, args }.
   */
  record(keyOrLabel, labelOrArgs, maybeArgs) {
    // Support both: record(key, label, args) and record(label, args)
    let key, label, args;
    if (maybeArgs !== undefined) {
      // record(key, label, args)
      key = keyOrLabel;
      label = labelOrArgs;
      args = maybeArgs;
    } else {
      // record(label, args)
      label = keyOrLabel;
      args = labelOrArgs || [];
      key = makeKey(label, args);
    }
    return this.#record(key, label, args);
  }

  /**
   * Check if a key has already been seen enough times to be flagged.
   */
  isDetected(key) {
    const entry = this.#counters.get(key);
    return entry ? entry.count >= this.#threshold : false;
  }

  /**
   * Get current stats.
   */
  getStats() {
    const stats = [];
    for (const [key, entry] of this.#counters) {
      stats.push({ key, label: entry.label, count: entry.count, firstSeen: entry.firstSeen });
    }
    return stats;
  }

  /**
   * Reset all counters.
   */
  reset() {
    this.#counters.clear();
  }

  /**
   * Clean up (stop timers, etc.)
   */
  destroy() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    this.#counters.clear();
  }

  #record(key, label, args) {
    let entry = this.#counters.get(key);
    const now = Date.now();

    if (!entry) {
      entry = { count: 0, label, args, firstSeen: now, lastSeen: now };
      this.#counters.set(key, entry);
    }

    entry.count++;
    entry.lastSeen = now;

    const detected = entry.count >= this.#threshold;
    if (detected && this.#onDetect) {
      const report = {
        key,
        keyParts: key.split('::'),
        count: entry.count,
        label,
        args,
        threshold: this.#threshold,
        suggestion: `Consider batching these ${label} queries or using a JOIN to avoid N+1.`,
      };
      this.#onDetect(report);
    }

    return { detected, key, count: entry.count, label, args };
  }

  #prune() {
    const cutoff = Date.now() - this.#windowMs;
    for (const [key, entry] of this.#counters) {
      if (entry.lastSeen < cutoff) {
        this.#counters.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// QueryTracker — counts identical queries, warns when threshold exceeded
// ---------------------------------------------------------------------------

/**
 * QueryTracker — tracks and analyzes query patterns over time.
 * Counts identical queries, warns on threshold exceedance, and suggests
 * joins or batching optimizations.
 *
 * Usage:
 *   const tracker = new QueryTracker({ threshold: 10, onWarning: (w) => console.warn(w) });
 *   tracker.track('SELECT * FROM users WHERE id = ?', [userId]);
 */
class QueryTracker {
  #threshold;
  #onWarning;
  #queries;
  #totalCalls;
  #suggestions;

  /**
   * @param {Object} options
   * @param {number} [options.threshold=10]    Warning threshold per query pattern
   * @param {Function} [options.onWarning]     Callback(warning) when threshold exceeded
   */
  constructor(options = {}) {
    this.#threshold = options.threshold ?? 10;
    this.#onWarning = options.onWarning || null;
    this.#queries = new Map();
    this.#totalCalls = 0;
    this.#suggestions = [];
  }

  /**
   * Track a query execution.
   *
   * @param {string} sqlOrLabel  The query string or descriptive label
   * @param {any[]}  [params=[]] Bound parameters (used to differentiate patterns)
   * @param {Object} [meta={}]   Additional metadata (table name, etc.)
   */
  track(sqlOrLabel, params = [], meta = {}) {
    this.#totalCalls++;

    // Build a normalized fingerprint: strip specific values, keep structure
    const fingerprint = this.#fingerprint(sqlOrLabel);

    let entry = this.#queries.get(fingerprint);
    if (!entry) {
      entry = {
        fingerprint,
        original: sqlOrLabel,
        calls: [],
        totalCount: 0,
        uniqueParams: new Set(),
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        warned: false,
      };
      this.#queries.set(fingerprint, entry);
    }

    entry.totalCount++;
    entry.lastSeen = Date.now();
    entry.calls.push({ params, meta, time: Date.now() });

    const paramSig = this.#paramSignature(params);
    entry.uniqueParams.add(paramSig);

    // Check threshold
    if (entry.totalCount >= this.#threshold && !entry.warned) {
      entry.warned = true;
      const uniqueCount = entry.uniqueParams.size;
      const suggestion = this.#generateSuggestion(entry);

      const warning = {
        fingerprint,
        original: entry.original,
        totalCalls: entry.totalCount,
        uniqueParams: uniqueCount,
        threshold: this.#threshold,
        suggestion,
        isNPlusOne: uniqueCount > 1 && entry.totalCount > uniqueCount,
      };

      this.#suggestions.push(suggestion);

      if (this.#onWarning) {
        this.#onWarning(warning);
      }

      return { warned: true, ...warning };
    }

    return { warned: false, fingerprint, totalCount: entry.totalCount };
  }

  /**
   * Get all tracked query patterns and their stats.
   */
  getStats() {
    const stats = [];
    for (const [, entry] of this.#queries) {
      stats.push({
        fingerprint: entry.fingerprint,
        original: entry.original,
        totalCount: entry.totalCount,
        uniqueParams: entry.uniqueParams.size,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        warned: entry.warned,
      });
    }
    return stats;
  }

  /**
   * Get all generated optimization suggestions.
   */
  getSuggestions() {
    return [...this.#suggestions];
  }

  /**
   * Get the total number of tracked calls.
   */
  get totalCalls() {
    return this.#totalCalls;
  }

  /**
   * Reset all tracking state.
   */
  reset() {
    this.#queries.clear();
    this.#totalCalls = 0;
    this.#suggestions = [];
  }

  /**
   * Create a fingerprint from a SQL-like string or label.
   * Strips literal values, keeps structural elements like table names and keywords.
   */
  #fingerprint(sql) {
    // Normalize: collapse whitespace, lowercase
    let fp = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    // Replace quoted string literals with placeholders
    fp = fp.replace(/'[^']*'/g, '?');

    // Replace numeric literals
    fp = fp.replace(/\b\d+(\.\d+)?\b/g, '?');

    // Replace IN (...) lists
    fp = fp.replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, '(?)');

    return fp;
  }

  /**
   * Create a stable signature from parameter arrays.
   */
  #paramSignature(params) {
    if (!params || params.length === 0) return '[]';
    return JSON.stringify(params.map((p) => (typeof p === 'object' ? '[obj]' : String(p))));
  }

  /**
   * Generate an optimization suggestion based on query pattern.
   */
  #generateSuggestion(entry) {
    const uniqueCount = entry.uniqueParams.size;
    const totalCount = entry.totalCount;

    if (uniqueCount > 1 && totalCount > uniqueCount) {
      // Same params used multiple times → caching opportunity
      if (totalCount / uniqueCount >= 3) {
        return `N+1 detected: "${entry.original}" called ${totalCount} times with only ${uniqueCount} unique parameter sets. Consider adding a DataLoader to batch and deduplicate these calls.`;
      }
      return `Repeated pattern: "${entry.original}" called ${totalCount} times. Consider batching with DataLoader.`;
    }

    if (uniqueCount === totalCount && totalCount > 1) {
      // Every call has different params → classic N+1
      return `Classic N+1: "${entry.original}" called ${totalCount} times with all different parameters. Replace with a single batched query using IN (...) or a JOIN.`;
    }

    return `Query "${entry.original}" called ${totalCount} times. Consider caching or batching.`;
  }
}

// ---------------------------------------------------------------------------
// Async interceptor helper — wraps async functions with N+1 detection
// ---------------------------------------------------------------------------

/**
 * createInterceptor — creates an async interceptor that combines DataLoader
 * batching with N+1 detection.
 *
 * @param {Function} batchFn        Batch load function for DataLoader
 * @param {Object}   [options]
 * @param {number}   [options.n1Threshold=5]  Threshold for N+1 detection
 * @param {Function} [options.onN1Detect]     Callback when N+1 is detected
 * @param {boolean}  [options.cache=true]     Enable DataLoader cache
 * @returns {{ loader: DataLoader, detector: NPlusOneDetector, load: Function }}
 */
function createInterceptor(batchFn, options = {}) {
  const loader = new DataLoader(batchFn, { cache: options.cache });
  const detector = new NPlusOneDetector({
    threshold: options.n1Threshold ?? 5,
    onDetect: options.onN1Detect || null,
  });

  /**
   * Load a key through both the DataLoader (batching) and N+1 detector.
   */
  async function load(key, label = 'load') {
    const recordKey = makeKey(label, [key]);
    detector.record(recordKey, label, [key]);
    return loader.load(key);
  }

  return { loader, detector, load };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DataLoader,
  NPlusOneDetector,
  QueryTracker,
  createInterceptor,
};
