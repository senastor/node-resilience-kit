'use strict';

/**
 * Abort-aware retry with exponential backoff and jitter.
 *
 * @param {() => Promise<T>} fn - Async function to execute.
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=3] - Maximum retry attempts (failures).
 * @param {number} [opts.baseDelay=1000] - Initial delay in ms.
 * @param {number} [opts.maxDelay=30000] - Upper bound delay in ms.
 * @param {number} [opts.factor=2] - Exponential growth factor.
 * @param {boolean} [opts.jitter=true] - Apply full-jitter.
 * @param {(err: Error, attempt: number) => void} [opts.onRetry] - Callback on each retry.
 * @param {AbortSignal} [opts.abortSignal] - Signal to cancel retries.
 * @returns {Promise<T>}
 */
async function retry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true,
    onRetry,
    abortSignal
  } = opts;

  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  if (!Number.isInteger(maxRetries) || maxRetries < 0)
    throw new RangeError('maxRetries must be a non-negative integer');
  if (!Number.isFinite(baseDelay) || baseDelay < 0)
    throw new RangeError('baseDelay must be a non-negative number');
  if (!Number.isFinite(maxDelay) || maxDelay < 0)
    throw new RangeError('maxDelay must be a non-negative number');
  if (!Number.isFinite(factor) || factor <= 0)
    throw new RangeError('factor must be a positive number');

  let attempt = 0;
  let lastErr;

  while (attempt <= maxRetries) {
    checkAbort(abortSignal);
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      if (typeof onRetry === 'function') onRetry(err, attempt);
      const delay = computeDelay(attempt, baseDelay, factor, maxDelay, jitter);
      await sleep(delay, abortSignal);
      attempt++;
    }
  }

  throw lastErr;
}

/**
 * Retry with a custom predicate controlling whether to retry.
 */
async function retryWithCondition(fn, shouldRetry, opts = {}) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  if (typeof shouldRetry !== 'function')
    throw new TypeError('shouldRetry must be a function');

  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true,
    onRetry,
    abortSignal
  } = opts;

  let attempt = 0;
  let lastErr;

  while (attempt <= maxRetries) {
    checkAbort(abortSignal);
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !shouldRetry(err, attempt)) break;
      if (typeof onRetry === 'function') onRetry(err, attempt);
      const delay = computeDelay(attempt, baseDelay, factor, maxDelay, jitter);
      await sleep(delay, abortSignal);
      attempt++;
    }
  }

  throw lastErr;
}

// Internal helpers

function computeDelay(attempt, base, factor, max, jitterEnabled) {
  let delay = base * Math.pow(factor, attempt);
  if (delay > max) delay = max;
  if (jitterEnabled) delay = Math.random() * delay; // full jitter
  return delay;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    if (signal) {
      if (signal.aborted)
        return reject(new DOMException('Aborted', 'AbortError'));
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    } else {
      setTimeout(resolve, ms);
    }
  });
}

function checkAbort(signal) {
  if (signal && signal.aborted)
    throw new DOMException('Aborted', 'AbortError');
}

module.exports = { retry, retryWithCondition };
