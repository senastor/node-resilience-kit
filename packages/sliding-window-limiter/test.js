'use strict';

const assert = require('assert');
const { SlidingWindowLimiter } = require('./impl.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {} // busy-wait (no deps)
}

// ─── Tests ───────────────────────────────────────────────────────

console.log('SlidingWindowLimiter Tests\n');

test('allows requests under limit', () => {
  const lim = new SlidingWindowLimiter(3, 1000);
  const r1 = lim.consume('a');
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 2);
  const r2 = lim.consume('a');
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 1);
  const r3 = lim.consume('a');
  assert.strictEqual(r3.allowed, true);
  assert.strictEqual(r3.remaining, 0);
});

test('rejects when limit exceeded', () => {
  const lim = new SlidingWindowLimiter(2, 1000);
  lim.consume('k');
  lim.consume('k');
  const r = lim.consume('k');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.remaining, 0);
});

test('window slides correctly (old entries expire)', () => {
  const lim = new SlidingWindowLimiter(2, 100); // 100ms window
  lim.consume('s');
  lim.consume('s');
  const blocked = lim.consume('s');
  assert.strictEqual(blocked.allowed, false);
  sleep(110);
  const after = lim.consume('s');
  assert.strictEqual(after.allowed, true);
});

test('independent key isolation', () => {
  const lim = new SlidingWindowLimiter(2, 1000);
  lim.consume('x');
  lim.consume('x');
  assert.strictEqual(lim.consume('x').allowed, false);
  assert.strictEqual(lim.consume('y').allowed, true);
  assert.strictEqual(lim.consume('y').allowed, true);
  assert.strictEqual(lim.consume('y').allowed, false);
});

test('isAllowed does not consume tokens', () => {
  const lim = new SlidingWindowLimiter(2, 1000);
  const c1 = lim.isAllowed('z');
  assert.strictEqual(c1.allowed, true);
  assert.strictEqual(c1.remaining, 1); // would be 1 after hypothetical consume
  // Actually isAllowed should show remaining as if we *would* consume
  // But actual count is still 0
  const stats = lim.getStats('z');
  assert.strictEqual(stats.count, 0);
});

test('stats accuracy', () => {
  const lim = new SlidingWindowLimiter(5, 2000);
  lim.consume('s1');
  lim.consume('s1');
  lim.consume('s1');
  const stats = lim.getStats('s1');
  assert.strictEqual(stats.count, 3);
  assert.strictEqual(stats.remaining, 2);
  assert.ok(stats.windowStart > 0);
  assert.ok(stats.windowEnd >= stats.windowStart);
});

test('reset clears state', () => {
  const lim = new SlidingWindowLimiter(2, 1000);
  lim.consume('r');
  lim.consume('r');
  assert.strictEqual(lim.consume('r').allowed, false);
  lim.reset('r');
  assert.strictEqual(lim.consume('r').allowed, true);
  assert.strictEqual(lim.getStats('r').count, 1);
});

test('memory cleanup removes expired entries', () => {
  // Use a very short window so cleanup triggers quickly
  const lim = new SlidingWindowLimiter(5, 50);
  lim.consume('gc1');
  lim.consume('gc2');
  sleep(60);
  // Force cleanup by consuming on another key (cleanup is periodic)
  // Override cleanup interval for test
  lim._cleanupIntervalMs = 0;
  lim.consume('trigger');
  // After cleanup, gc1 and gc2 entries should be pruned on next access
  const stats1 = lim.getStats('gc1');
  assert.strictEqual(stats1.count, 0);
  const stats2 = lim.getStats('gc2');
  assert.strictEqual(stats2.count, 0);
});

test('resetAt is in the future', () => {
  const lim = new SlidingWindowLimiter(3, 5000);
  const r = lim.consume('t');
  assert.ok(r.resetAt > Date.now());
  assert.ok(r.resetAt <= Date.now() + 5000);
});

test('returns for unknown key in getStats', () => {
  const lim = new SlidingWindowLimiter(10, 1000);
  const s = lim.getStats('unknown');
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.remaining, 10);
});

test('edge case: zero maxRequests always rejects', () => {
  const lim = new SlidingWindowLimiter(0, 1000);
  const r = lim.consume('z');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.remaining, 0);
  const i = lim.isAllowed('z');
  assert.strictEqual(i.allowed, false);
});

test('edge case: very short window (10ms)', () => {
  const lim = new SlidingWindowLimiter(1, 10);
  const r1 = lim.consume('f');
  assert.strictEqual(r1.allowed, true);
  const r2 = lim.consume('f');
  assert.strictEqual(r2.allowed, false);
  sleep(15);
  const r3 = lim.consume('f');
  assert.strictEqual(r3.allowed, true);
});

test('constructor rejects invalid args', () => {
  assert.throws(() => new SlidingWindowLimiter(-1, 1000));
  assert.throws(() => new SlidingWindowLimiter(1, 0));
  assert.throws(() => new SlidingWindowLimiter(1, -100));
});

test('many keys stay independent', () => {
  const lim = new SlidingWindowLimiter(1, 5000);
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(lim.consume(`key${i}`).allowed, true);
    assert.strictEqual(lim.consume(`key${i}`).allowed, false);
  }
});

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
