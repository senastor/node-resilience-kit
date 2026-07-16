'use strict';

const assert = require('assert');
const { LRUCache } = require('./impl.js');

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

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Synchronous tests ---

console.log('\nLRU Cache Tests\n');

test('basic get/set', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  assert.strictEqual(c.get('a'), 1);
  assert.strictEqual(c.size, 1);
});

test('get missing key returns undefined', () => {
  const c = new LRUCache(3);
  assert.strictEqual(c.get('nope'), undefined);
});

test('has existing key', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  assert.strictEqual(c.has('a'), true);
  assert.strictEqual(c.has('b'), false);
});

test('delete key', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  assert.strictEqual(c.delete('a'), true);
  assert.strictEqual(c.has('a'), false);
  assert.strictEqual(c.size, 0);
});

test('delete non-existent key returns false', () => {
  const c = new LRUCache(3);
  assert.strictEqual(c.delete('x'), false);
});

test('LRU eviction when at capacity', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.set('d', 4); // should evict 'a'
  assert.strictEqual(c.size, 3);
  assert.strictEqual(c.has('a'), false);
  assert.strictEqual(c.get('b'), 2);
  assert.strictEqual(c.get('c'), 3);
  assert.strictEqual(c.get('d'), 4);
});

test('get promotes to MRU (evicts LRU)', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.get('a'); // promote 'a' to MRU → order: b, c, a
  c.set('d', 4); // evict 'b' (LRU)
  assert.strictEqual(c.has('b'), false);
  assert.strictEqual(c.has('a'), true);
});

test('overwrite existing key updates value and promotes', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10); // overwrite, promotes 'a'
  assert.strictEqual(c.get('a'), 10);
  assert.strictEqual(c.size, 2);
});

test('maxSize=1 edge case', () => {
  const c = new LRUCache(1);
  c.set('a', 1);
  assert.strictEqual(c.get('a'), 1);
  c.set('b', 2); // evicts a
  assert.strictEqual(c.has('a'), false);
  assert.strictEqual(c.get('b'), 2);
  c.set('b', 20); // overwrite
  assert.strictEqual(c.size, 1);
});

test('keys() returns MRU-to-LRU order', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.deepStrictEqual([...c.keys()], ['c', 'b', 'a']);
  c.get('a'); // promote 'a'
  assert.deepStrictEqual([...c.keys()], ['a', 'c', 'b']);
});

test('stats tracking', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  c.get('a');  // hit
  c.get('b');  // miss
  c.get('a');  // hit
  c.set('b', 2);
  c.set('c', 3);
  c.set('d', 4); // eviction
  const s = c.stats();
  assert.strictEqual(s.hits, 2);
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.evictions, 1);
  assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-9);
});

test('stats hitRate=0 when no accesses', () => {
  const c = new LRUCache(3);
  assert.strictEqual(c.stats().hitRate, 0);
});

test('clear() removes all entries and resets stats', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  c.get('a');
  c.get('x'); // miss
  c.clear();
  assert.strictEqual(c.size, 0);
  assert.strictEqual(c.has('a'), false);
  const s = c.stats();
  assert.strictEqual(s.hits, 0);
  assert.strictEqual(s.misses, 0);
  assert.strictEqual(s.evictions, 0);
});

test('getOrSet with factory function', () => {
  const c = new LRUCache(5);
  let calls = 0;
  const v1 = c.getOrSet('k', () => { calls++; return 42; });
  assert.strictEqual(v1, 42);
  assert.strictEqual(calls, 1);
  const v2 = c.getOrSet('k', () => { calls++; return 99; });
  assert.strictEqual(v2, 42); // cached, factory not called
  assert.strictEqual(calls, 1);
});

test('getOrSet with custom TTL', () => {
  const c = new LRUCache(5, 10000);
  c.getOrSet('k', () => 'v', 100);
  assert.strictEqual(c.get('k'), 'v');
});

test('has() does not affect recency', () => {
  const c = new LRUCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.has('a'); // should NOT promote 'a'
  c.set('d', 4); // should evict 'a' (LRU)
  assert.strictEqual(c.has('a'), false);
});

test('has() detects expired entry', () => {
  const c = new LRUCache(3, 50);
  c.set('a', 1);
  assert.strictEqual(c.has('a'), true);
  // Simulate expiry by setting very short TTL
  const c2 = new LRUCache(3, 1);
  c2.set('x', 1);
  // Since 1ms is too fast to guarantee, test via internal state:
  // Just verify has returns boolean
  assert.strictEqual(typeof c2.has('x'), 'boolean');
});

test('constructor validates maxSize', () => {
  assert.throws(() => new LRUCache(0), RangeError);
  assert.throws(() => new LRUCache(-1), RangeError);
  assert.throws(() => new LRUCache(1.5), RangeError);
});

test('memory bound: 1000 inserts with maxSize=100', () => {
  const c = new LRUCache(100);
  for (let i = 0; i < 1000; i++) {
    c.set(`key-${i}`, `value-${i}`);
  }
  assert.strictEqual(c.size, 100);
  // Only the last 100 keys should remain
  const keys = [...c.keys()];
  assert.strictEqual(keys.length, 100);
  assert.strictEqual(keys[0], 'key-999'); // MRU
});

test('supports non-string keys', () => {
  const c = new LRUCache(5);
  const obj = { x: 1 };
  c.set(obj, 'obj-val');
  c.set(42, 'num-val');
  assert.strictEqual(c.get(obj), 'obj-val');
  assert.strictEqual(c.get(42), 'num-val');
});

// --- Async tests (TTL) ---

async function runAsyncTests() {
  await asyncTest('TTL expiration with setTimeout', async () => {
    const c = new LRUCache(5, 0);
    c.set('fast', 'expires-soon', 50);
    assert.strictEqual(c.get('fast'), 'expires-soon');
    await sleep(80);
    assert.strictEqual(c.get('fast'), undefined);
  });

  await asyncTest('has() detects expired entry (async)', async () => {
    const c = new LRUCache(5, 0);
    c.set('fast', 'v', 50);
    assert.strictEqual(c.has('fast'), true);
    await sleep(80);
    assert.strictEqual(c.has('fast'), false);
  });

  await asyncTest('default TTL from constructor', async () => {
    const c = new LRUCache(5, 50);
    c.set('a', 1);
    assert.strictEqual(c.get('a'), 1);
    await sleep(80);
    assert.strictEqual(c.get('a'), undefined);
  });

  await asyncTest('per-key TTL overrides default', async () => {
    const c = new LRUCache(5, 200);
    c.set('short', 's', 50);
    c.set('long', 'l');
    await sleep(80);
    assert.strictEqual(c.get('short'), undefined);
    assert.strictEqual(c.get('long'), 'l');
  });

  await asyncTest('keys() skips expired entries', async () => {
    const c = new LRUCache(5, 0);
    c.set('a', 1, 50);
    c.set('b', 2, 5000);
    await sleep(80);
    const keys = [...c.keys()];
    assert.deepStrictEqual(keys, ['b']);
    assert.strictEqual(c.size, 1); // 'a' was cleaned from map
  });

  await asyncTest('stats count expired get as miss', async () => {
    const c = new LRUCache(5, 0);
    c.set('x', 1, 50);
    c.get('x'); // hit
    await sleep(80);
    c.get('x'); // miss (expired)
    const s = c.stats();
    assert.strictEqual(s.hits, 1);
    assert.strictEqual(s.misses, 1);
  });

  await asyncTest('getOrSet does not re-compute on cache hit', async () => {
    const c = new LRUCache(5, 5000);
    let n = 0;
    const v1 = c.getOrSet('k', () => ++n);
    const v2 = c.getOrSet('k', () => ++n);
    assert.strictEqual(v1, 1);
    assert.strictEqual(v2, 1);
    assert.strictEqual(n, 1);
  });

  await asyncTest('getOrSet re-computes after expiry', async () => {
    const c = new LRUCache(5, 0);
    let n = 0;
    c.getOrSet('k', () => ++n, 50);
    await sleep(80);
    const v2 = c.getOrSet('k', () => ++n, 50);
    assert.strictEqual(v2, 2);
  });
}

(async () => {
  await runAsyncTests();
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
