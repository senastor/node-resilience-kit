'use strict';

/**
 * Test suite for CircuitBreaker.
 * Uses only Node.js built-in modules — no external test framework.
 *
 * Run: node test.js
 */

const CircuitBreaker = require('./impl.js');
const { STATES, TimeoutError } = CircuitBreaker;

const assert = require('assert');

let passed = 0;
let failed = 0;
const failures = [];

// Minimal test harness ------------------------------------------------------
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    const detail = err && err.stack ? err.stack : String(err);
    console.log(`  \u2717 ${name}\n    ${detail.split('\n').join('\n    ')}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper that fails N times then succeeds.
function makeFlakyService(failTimes, failErr) {
  let calls = 0;
  const fn = async (value) => {
    calls++;
    if (calls <= failTimes) {
      throw failErr || new Error(`service failure #${calls}`);
    }
    return { ok: true, calls, value };
  };
  fn._calls = () => calls;
  return fn;
}

// Helper that always fails.
function alwaysFail(message) {
  const err = new Error(message || 'permanent failure');
  let calls = 0;
  const fn = async () => { calls++; throw err; };
  fn._calls = () => calls;
  return fn;
}

// ---------------------------------------------------------------------------
console.log('\nCircuitBreaker tests\n');

(async () => {
// 1. Circuit opens after N consecutive failures -----------------------------
await test('circuit opens after N consecutive failures', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 50 });
  const fn = alwaysFail('boom');

  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => cb.call(fn), /boom/);
  }

  const st = cb.getState();
  assert.strictEqual(st.state, STATES.OPEN, 'should be OPEN after 3 failures');
  assert.strictEqual(st.failureCount, 3, 'failureCount should be 3');
  assert.strictEqual(st.lastFailureTime !== null, true, 'lastFailureTime should be set');
  cb.destroy();
});

// 2. Circuit rejects fast when OPEN (does not call the function) ------------
await test('circuit rejects fast when OPEN without calling fn', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 10000 });
  const fn = alwaysFail('fail');

  // Open it.
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => cb.call(fn), /fail/);
  }
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  // Now a fresh service that should NOT be invoked.
  let invoked = false;
  const quietFn = async () => { invoked = true; return 'secret'; };

  const start = Date.now();
  await assert.rejects(() => cb.call(quietFn), /fail/);
  const elapsed = Date.now() - start;

  assert.strictEqual(invoked, false, 'function must not be called when OPEN');
  assert.ok(elapsed < 20, `should reject fast (<20ms), took ${elapsed}ms`);

  cb.destroy();
});

// 3. Circuit transitions to HALF_OPEN after reset timeout -------------------
await test('circuit transitions to HALF_OPEN after reset timeout', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 40 });
  const fn = alwaysFail('x');

  // Register listener BEFORE opening the circuit
  const events = [];
  cb.on('halfOpen', () => events.push('halfOpen'));

  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => cb.call(fn), /x/);
  }
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  await sleep(60);

  // A call now enters HALF_OPEN; it will run the trial and since fn still
  // fails, it will re-open. We observe the HALF_OPEN transition via state.
  let trialWasHalfOpen = false;
  const failFn = async () => { trialWasHalfOpen = (cb.getState().state === STATES.HALF_OPEN); throw new Error('still broken'); };

  await assert.rejects(() => cb.call(failFn), /still broken/);

  assert.ok(
    trialWasHalfOpen || cb.getTransitions().some(t => t.to === STATES.HALF_OPEN),
    'circuit should have visited HALF_OPEN after reset timeout'
  );
  assert.ok(events.length >= 1, `halfOpen event should fire at least once, got ${events.length}`);
  cb.destroy();
});

// 3b. Timer-based HALF_OPEN transition (without a triggering call) ----------
await test('timer transitions OPEN to HALF_OPEN autonomously', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 30 });
  const fn = alwaysFail('y');
  await assert.rejects(() => cb.call(fn), /y/);
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  let halfOpenEventFired = false;
  cb.on('halfOpen', () => { halfOpenEventFired = true; });

  await sleep(60);

  assert.strictEqual(cb.getState().state, STATES.HALF_OPEN, 'timer should move to HALF_OPEN');
  assert.strictEqual(halfOpenEventFired, true, 'halfOpen event should fire from timer');
  cb.destroy();
});

// 4. Circuit closes after successful calls in HALF_OPEN ---------------------
await test('circuit closes after successful calls in HALF_OPEN', async () => {
  const cb = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeout: 30,
    halfOpenMaxCalls: 3,
  });

  // Open it.
  const bad = alwaysFail('down');
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => cb.call(bad), /down/);
  }
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  await sleep(50);

  // Service has recovered.
  const good = async () => 'ok';

  let closeEvents = 0;
  cb.on('close', () => closeEvents++);

  // First two calls: should be HALF_OPEN, succeed, stay HALF_OPEN.
  let r1 = await cb.call(good);
  assert.strictEqual(r1, 'ok');
  assert.strictEqual(cb.getState().state, STATES.HALF_OPEN, 'still HALF_OPEN after 1 success');

  let r2 = await cb.call(good);
  assert.strictEqual(r2, 'ok');
  assert.strictEqual(cb.getState().state, STATES.HALF_OPEN, 'still HALF_OPEN after 2 successes');

  // Third success closes the circuit.
  let r3 = await cb.call(good);
  assert.strictEqual(r3, 'ok');
  assert.strictEqual(cb.getState().state, STATES.CLOSED, 'should be CLOSED after 3 successes');
  assert.strictEqual(closeEvents, 1, 'close event should fire once');

  // Subsequent calls flow normally in CLOSED.
  let r4 = await cb.call(good);
  assert.strictEqual(r4, 'ok');
  assert.strictEqual(cb.getState().state, STATES.CLOSED);

  cb.destroy();
});

// 4b. A failure during HALF_OPEN re-opens immediately ----------------------
await test('failure during HALF_OPEN re-opens the circuit', async () => {
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 30,
    halfOpenMaxCalls: 3,
  });

  await assert.rejects(() => cb.call(alwaysFail('initial')), /initial/);
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  await sleep(50);
  assert.strictEqual(cb.getState().state, STATES.HALF_OPEN);

  // Trial fails.
  await assert.rejects(() => cb.call(async () => { throw new Error('still bad'); }), /still bad/);

  assert.strictEqual(cb.getState().state, STATES.OPEN, 'should re-open on trial failure');
  cb.destroy();
});

// 5. Fallback function is called when circuit is open -----------------------
await test('fallback function is called when circuit is OPEN', async () => {
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 100000, // keep open
    fallback: (err) => ({ fallback: true, message: err.message }),
  });

  const fn = alwaysFail('primary-down');
  await assert.rejects(() => cb.call(fn), /primary-down/);
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  let fallbackEvent = null;
  cb.on('fallback', (info) => { fallbackEvent = info; });

  // A new call that should NOT be invoked; fallback runs instead.
  let invoked = false;
  const quietFn = async () => { invoked = true; return 'real'; };

  const result = await cb.call(quietFn);

  assert.strictEqual(invoked, false, 'primary fn must not be called when OPEN');
  assert.strictEqual(result.fallback, true, 'should return fallback result');
  assert.strictEqual(result.message, 'primary-down', 'fallback receives the error');
  assert.ok(fallbackEvent, 'fallback event should be emitted');
  assert.strictEqual(fallbackEvent.source, 'open');

  cb.destroy();
});

// 5b. Fallback that throws propagates the error ----------------------------
await test('fallback that throws propagates its error', async () => {
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 100000,
    fallback: () => { throw new Error('fallback-also-failed'); },
  });

  await assert.rejects(() => cb.call(alwaysFail('primary')), /primary/);
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  await assert.rejects(
    () => cb.call(async () => 'never'),
    /fallback-also-failed/
  );
  cb.destroy();
});

// 6. Events are emitted on state transitions -------------------------------
await test('events are emitted on state transitions', async () => {
  const cb = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeout: 30,
    halfOpenMaxCalls: 1,
  });

  const events = [];
  cb.on('open', () => events.push('open'));
  cb.on('halfOpen', () => events.push('halfOpen'));
  cb.on('close', () => events.push('close'));
  cb.on('fallback', () => events.push('fallback'));

  // Two failures -> open
  const bad = alwaysFail('evt-fail');
  await assert.rejects(() => cb.call(bad), /evt-fail/);
  await assert.rejects(() => cb.call(bad), /evt-fail/);
  assert.strictEqual(events.includes('open'), true, 'open event should fire');

  // Wait for reset.
  await sleep(50);

  // One success in HALF_OPEN -> close (halfOpenMaxCalls=1)
  const good = async () => 'ok';
  await cb.call(good);

  assert.strictEqual(events.includes('halfOpen'), true, 'halfOpen event should fire');
  assert.strictEqual(events.includes('close'), true, 'close event should fire');

  cb.destroy();
});

// 7. Full open -> half-open -> close -> open lifecycle ----------------------
await test('full lifecycle: open -> half-open -> close -> open', async () => {
  const cb = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeout: 30,
    halfOpenMaxCalls: 2,
  });

  const states = [];
  const record = () => states.push(cb.getState().state);
  cb.on('open', record);
  cb.on('halfOpen', record);
  cb.on('close', record);

  // Open.
  const bad = alwaysFail('life');
  await assert.rejects(() => cb.call(bad), /life/);
  await assert.rejects(() => cb.call(bad), /life/);

  await sleep(50);

  // Recover and close after 2 successful trial calls.
  const good = async () => 'ok';
  await cb.call(good);
  await cb.call(good);
  assert.strictEqual(cb.getState().state, STATES.CLOSED);

  // Break again.
  await assert.rejects(() => cb.call(bad), /life/);
  await assert.rejects(() => cb.call(bad), /life/);
  assert.strictEqual(cb.getState().state, STATES.OPEN);

  // Transitions recorded.
  const trans = cb.getTransitions().map((t) => t.to);
  assert.deepStrictEqual(
    trans,
    [STATES.OPEN, STATES.HALF_OPEN, STATES.CLOSED, STATES.OPEN],
    'transition sequence should be open, half-open, close, open'
  );

  cb.destroy();
});

// 8. Consecutive success in CLOSED resets failure counter -------------------
await test('a success in CLOSED resets the failure count', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 100 });

  const flaky = makeFlakyService(2, new Error('flaky'));
  await assert.rejects(() => cb.call(flaky), /flaky/);
  await assert.rejects(() => cb.call(flaky), /flaky/);
  assert.strictEqual(cb.getState().failureCount, 2);

  // Third call succeeds.
  const r = await cb.call(flaky);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(cb.getState().failureCount, 0, 'success should reset failure count');
  assert.strictEqual(cb.getState().state, STATES.CLOSED);

  cb.destroy();
});

// 9. Per-call timeout triggers a failure ------------------------------------
await test('per-call timeout counts as a failure', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, timeout: 30 });
  const slow = async () => { await sleep(200); return 'late'; };

  let threwTimeout = false;
  try {
    await cb.call(slow);
  } catch (err) {
    threwTimeout = err instanceof TimeoutError;
  }
  assert.strictEqual(threwTimeout, true, 'should reject with TimeoutError');
  assert.strictEqual(cb.getState().failureCount, 1, 'timeout should count as failure');

  cb.destroy();
});

// 10. getState returns the documented shape ---------------------------------
await test('getState returns correct shape', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 5 });
  const st = cb.getState();
  assert.strictEqual(typeof st.state, 'string');
  assert.strictEqual(typeof st.failureCount, 'number');
  assert.strictEqual(typeof st.successCount, 'number');
  assert.strictEqual(st.lastFailureTime === null || typeof st.lastFailureTime === 'number', true);
  assert.strictEqual(st.state, STATES.CLOSED);
  assert.strictEqual(st.failureCount, 0);
  assert.strictEqual(st.successCount, 0);
  assert.strictEqual(st.lastFailureTime, null);
  cb.destroy();
});

// 11. forceOpen / forceClose helpers ----------------------------------------
await test('forceOpen and forceClose work', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 10 });

  cb.forceOpen();
  assert.strictEqual(cb.getState().state, STATES.OPEN);
  await assert.rejects(() => cb.call(async () => 'x'), /CircuitBreaker/);

  cb.forceClose();
  assert.strictEqual(cb.getState().state, STATES.CLOSED);
  const r = await cb.call(async () => 'y');
  assert.strictEqual(r, 'y');

  cb.destroy();
});

// 12. Option validation ------------------------------------------------------
await test('invalid options throw on construction', async () => {
  assert.throws(() => new CircuitBreaker({ failureThreshold: 0 }), RangeError);
  assert.throws(() => new CircuitBreaker({ halfOpenMaxCalls: 0 }), RangeError);
  assert.throws(() => new CircuitBreaker({ failureThreshold: 'x' }), TypeError);
  assert.throws(() => new CircuitBreaker({ fallback: 'notafn' }), TypeError);
  assert.throws(() => new CircuitBreaker(null), TypeError);
});

// 13. Non-function passed to call() throws ----------------------------------
await test('call() throws on non-function argument', async () => {
  const cb = new CircuitBreaker();
  await assert.rejects(() => cb.call('not a fn'), TypeError);
  cb.destroy();
});

// 14. Concurrency control in HALF_OPEN --------------------------------------
await test('HALF_OPEN limits concurrent trial calls', async () => {
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 30,
    halfOpenMaxCalls: 2,
    halfOpenMaxConcurrent: 1,
  });

  await assert.rejects(() => cb.call(alwaysFail('c')), /c/);
  await sleep(50);
  assert.strictEqual(cb.getState().state, STATES.HALF_OPEN);

  // Launch two concurrent calls; only one trial should run at a time.
  let active = 0;
  let maxActive = 0;
  const slowGood = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(30);
    active--;
    return 'ok';
  };

  const p1 = cb.call(slowGood);
  const p2 = cb.call(slowGood);
  await Promise.all([p1, p2]);

  assert.strictEqual(maxActive, 1, 'only one trial should run concurrently in HALF_OPEN');
  cb.destroy();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.err && f.err.message ? f.err.message : f.err}`);
  }
  process.exit(1);
}
})();
