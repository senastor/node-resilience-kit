'use strict';

class LRUCache {
  /**
   * @param {number} maxSize - Maximum number of entries
   * @param {number} [defaultTTL] - Default TTL in milliseconds (0 = no expiry)
   */
  constructor(maxSize, defaultTTL = 0) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError('maxSize must be a positive integer');
    }
    this._maxSize = maxSize;
    this._defaultTTL = defaultTTL;
    // Map preserves insertion order; we delete+re-insert to move to "most recent"
    this._map = new Map();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  // --- internal helpers ---

  _isExpired(entry) {
    return entry.expiresAt !== 0 && Date.now() >= entry.expiresAt;
  }

  _touch(key) {
    const entry = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, entry);
  }

  _evictOne() {
    // Map iterator gives insertion order; first = LRU
    const lruKey = this._map.keys().next().value;
    this._map.delete(lruKey);
    this._evictions++;
  }

  // --- public API ---

  /** Number of live entries (does not count expired-but-unreaped) */
  get size() {
    return this._map.size;
  }

  /**
   * Get value by key. Returns undefined if missing or expired.
   * Marks entry as most-recently-used.
   */
  get(key) {
    if (!this._map.has(key)) {
      this._misses++;
      return undefined;
    }
    const entry = this._map.get(key);
    if (this._isExpired(entry)) {
      this._map.delete(key);
      this._misses++;
      return undefined;
    }
    this._touch(key);
    this._hits++;
    return entry.value;
  }

  /**
   * Insert or update a key.
   * @param {*} key
   * @param {*} value
   * @param {number} [ttl] - TTL in ms (0 = no expiry, default uses constructor default)
   */
  set(key, value, ttl) {
    const effectiveTTL = ttl !== undefined ? ttl : this._defaultTTL;
    const expiresAt = effectiveTTL > 0 ? Date.now() + effectiveTTL : 0;

    if (this._map.has(key)) {
      // Overwrite – delete first so re-insertion goes to MRU position
      this._map.delete(key);
    } else if (this._map.size >= this._maxSize) {
      this._evictOne();
    }
    this._map.set(key, { value, expiresAt });
  }

  /**
   * Check if key exists and is not expired.
   * Does NOT affect recency order.
   */
  has(key) {
    if (!this._map.has(key)) return false;
    const entry = this._map.get(key);
    if (this._isExpired(entry)) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  /** Remove an entry. Returns true if it existed and was removed. */
  delete(key) {
    return this._map.delete(key);
  }

  /** Remove all entries and reset stats. */
  clear() {
    this._map.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Iterator yielding keys from most-recently-used to least-recently-used.
   * Skips expired entries (lazy cleanup).
   */
  *keys() {
    const now = Date.now();
    // Iterate from end (MRU) to start (LRU) of Map
    const entries = [...this._map.entries()];
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, entry] = entries[i];
      if (entry.expiresAt !== 0 && now >= entry.expiresAt) {
        this._map.delete(key);
        continue;
      }
      yield key;
    }
  }

  /**
   * Return cached value or compute via factory, store, and return.
   * @param {*} key
   * @param {Function} factory - () => value (may be async)
   * @param {number} [ttl]
   */
  getOrSet(key, factory, ttl) {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    // get() above counted a miss; revert since we'll supply the value
    this._misses--;
    const value = factory();
    this.set(key, value, ttl);
    return value;
  }

  /** Returns a snapshot of cache statistics. */
  stats() {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }
}

module.exports = { LRUCache };
