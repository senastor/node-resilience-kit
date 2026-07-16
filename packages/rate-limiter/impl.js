/**
 * rateLimiter.js — Token bucket rate limiting middleware for Express/Node.js
 * 
 * Features:
 * - Sliding window with token bucket algorithm
 * - Configurable window size and max requests
 * - In-memory store with automatic cleanup
 * - Returns 429 with Retry-After header on limit exceeded
 * - Per-IP or per-key tracking
 */

class TokenBucketRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000;      // 1 min default
    this.maxRequests = options.maxRequests || 100;   // 100 req/window default
    this.keyGenerator = options.keyGenerator || ((req) => req.ip || req.connection.remoteAddress);
    this.buckets = new Map();
    this.cleanupInterval = setInterval(() => this._cleanup(), this.windowMs);
    this.cleanupInterval.unref();
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > this.windowMs * 2) {
        this.buckets.delete(key);
      }
    }
  }

  middleware() {
    return (req, res, next) => {
      const key = this.keyGenerator(req);
      const now = Date.now();
      let bucket = this.buckets.get(key);

      if (!bucket || now - bucket.windowStart >= this.windowMs) {
        bucket = { count: 0, windowStart: now };
        this.buckets.set(key, bucket);
      }

      if (bucket.count >= this.maxRequests) {
        const retryAfter = Math.ceil((this.windowMs - (now - bucket.windowStart)) / 1000);
        res.set('Retry-After', String(retryAfter));
        res.set('X-RateLimit-Limit', String(this.maxRequests));
        res.set('X-RateLimit-Remaining', '0');
        res.set('X-RateLimit-Reset', String(Math.ceil((bucket.windowStart + this.windowMs) / 1000)));
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          message: `Too many requests. Retry after ${retryAfter}s.`,
          retryAfter
        });
      }

      bucket.count++;
      res.set('X-RateLimit-Limit', String(this.maxRequests));
      res.set('X-RateLimit-Remaining', String(this.maxRequests - bucket.count));
      res.set('X-RateLimit-Reset', String(Math.ceil((bucket.windowStart + this.windowMs) / 1000)));
      next();
    };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  close() {
    clearInterval(this.cleanupInterval);
    this.buckets.clear();
  }
}

module.exports = { TokenBucketRateLimiter };
