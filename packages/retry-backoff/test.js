'use strict';

const assert = require('assert');
const { retry, retryWithCondition } = require('./impl.js');

// Helper: run with real timers
async function pass(n, label) { process.stdout.write(`  ✓ ${label}\n`); }
async function fail(label, err) { process.stderr.write(`  ✗ ${label}: ${err.message}\n`); process.exitCode = 1; }

(async () => {
  process.stdout.write('retry-backoff tests\n');

  // 1. Succeeds on first try
  {
    let calls = 0;
    const result = await retry(async () => { calls++; return 'ok'; }, { baseDelay: 10 });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 1);
    await pass(1, 'succeeds on first try (no retry)');
  }

  // 2. Retries on failure, succeeds eventually
  {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'recovered';
    }, { maxRetries: 5, baseDelay: 5 });
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(calls, 3);
    await pass(2, 'retries on failure, succeeds eventually');
  }

  // 3. Exhausts all retries, throws last error
  {
    let calls = 0;
    try {
      await retry(async () => { calls++; throw new Error(`e${calls}`); }, { maxRetries: 2, baseDelay: 5 });
      assert.fail('should throw');
    } catch (err) {
      assert.strictEqual(err.message, 'e3'); // attempt 0,1,2 => 3 calls
      assert.strictEqual(calls, 3);
    }
    await pass(3, 'exhausts all retries, throws last error');
  }

  // 4. Exponential delay increases (verify via mock timestamps)
  {
    const delays = [];
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    // Monkey-patch setTimeout to capture delays
    let fakeTime = 0;
    const fakeTimers = [];
    global.setTimeout = (fn, ms) => {
      if (ms > 0) delays.push(ms);
      // Execute immediately for speed
      fn();
      return { id: 0 };
    };
    global.clearTimeout = () => {};

    try {
      let calls = 0;
      await retry(async () => { calls++; if (calls <= 3) throw new Error('f'); }, { maxRetries: 3, baseDelay: 100, factor: 2, jitter: false });
      // Delays: attempt0=100, attempt1=200, attempt2=400
      assert.strictEqual(delays.length, 3);
      assert.strictEqual(delays[0], 100);
      assert.strictEqual(delays[1], 200);
      assert.strictEqual(delays[2], 400);
      await pass(4, 'exponential delay increases');
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  }

  // 5. Jitter produces varied delays
  {
    const seen = new Set();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => {
      if (ms > 0) seen.add(ms);
      fn();
      return { id: 0 };
    };
    try {
      // Run multiple times with jitter=true to observe varied delays
      for (let run = 0; run < 20; run++) {
        let calls = 0;
        await retry(async () => { calls++; if (calls <= 2) throw new Error('f'); },
          { maxRetries: 2, baseDelay: 1000, jitter: true });
      }
      assert.ok(seen.size > 1, `Expected varied delays, got ${seen.size} unique values`);
      await pass(5, 'jitter produces varied delays');
    } finally {
      global.setTimeout = realSetTimeout;
    }
  }

  // 6. AbortSignal cancels retry loop
  {
    const controller = new AbortController();
    let calls = 0;
    const p = retry(async () => {
      calls++;
      if (calls === 2) controller.abort();
      throw new Error('fail');
    }, { maxRetries: 5, baseDelay: 5, abortSignal: controller.signal });

    await assert.rejects(p, { name: 'AbortError' });
    assert.ok(calls <= 3);
    await pass(6, 'AbortSignal cancels retry loop');
  }

  // 7. onRetry callback called with correct args
  {
    const retries = [];
    try {
      await retry(async () => { throw new Error('boom'); }, {
        maxRetries: 2,
        baseDelay: 5,
        onRetry: (err, attempt) => retries.push({ msg: err.message, attempt })
      });
    } catch (_) {}
    assert.strictEqual(retries.length, 2);
    assert.deepStrictEqual(retries[0], { msg: 'boom', attempt: 0 });
    assert.deepStrictEqual(retries[1], { msg: 'boom', attempt: 1 });
    await pass(7, 'onRetry callback called with correct args');
  }

  // 8. shouldRetry predicate controls retry behavior
  {
    let calls = 0;
    class RetryableError extends Error {}
    try {
      await retryWithCondition(
        async () => { calls++; throw new RetryableError('nope'); },
        (err) => err instanceof RetryableError,
        { maxRetries: 5, baseDelay: 5 }
      );
    } catch (_) {}
    assert.strictEqual(calls, 6); // 1 initial + 5 retries
    calls = 0;
    try {
      await retryWithCondition(
        async () => { calls++; throw new Error('nope'); },
        (err) => err instanceof RetryableError,
        { maxRetries: 5, baseDelay: 5 }
      );
    } catch (_) {}
    assert.strictEqual(calls, 1); // shouldRetry returns false => no retry
    await pass(8, 'shouldRetry predicate controls retry behavior');
  }

  // 9. Max delay cap works
  {
    const delays = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => {
      if (ms > 0) delays.push(ms);
      fn();
      return { id: 0 };
    };
    try {
      let calls = 0;
      await retry(async () => { calls++; if (calls <= 4) throw new Error('f'); },
        { maxRetries: 4, baseDelay: 1000, factor: 10, maxDelay: 500, jitter: false });
      // All delays should be capped at 500
      for (const d of delays) assert.ok(d <= 500, `delay ${d} > 500`);
      assert.ok(delays.every(d => d === 500));
      await pass(9, 'max delay cap works');
    } finally {
      global.setTimeout = realSetTimeout;
    }
  }

  // 10. maxRetries=0 means no retry
  {
    let calls = 0;
    try {
      await retry(async () => { calls++; throw new Error('fail'); }, { maxRetries: 0, baseDelay: 5 });
      assert.fail('should throw');
    } catch (err) {
      assert.strictEqual(err.message, 'fail');
      assert.strictEqual(calls, 1);
    }
    await pass(10, 'maxRetries=0 means no retry');
  }

  process.stdout.write('\nAll 10 tests passed.\n');
})();
