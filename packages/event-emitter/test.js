'use strict';

const assert = require('assert');
const WildcardEventEmitter = require('./impl.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log('WildcardEventEmitter tests\n');

// 1. Basic emit/on
test('basic on and emit', () => {
  const ee = new WildcardEventEmitter();
  let called = false;
  ee.on('hello', (msg) => { called = msg; });
  ee.emit('hello', 'world');
  assert.strictEqual(called, 'world');
});

// 2. Wildcard catches all
test('wildcard * catches all events', () => {
  const ee = new WildcardEventEmitter();
  const events = [];
  ee.on('*', (event, ...args) => { events.push(event); });
  ee.emit('foo');
  ee.emit('bar');
  ee.emit('baz', 42);
  assert.deepStrictEqual(events, ['foo', 'bar', 'baz']);
});

// 3. Namespace prefix matching
test('namespace db:* matches db:connect', () => {
  const ee = new WildcardEventEmitter();
  const results = [];
  ee.on('db:*', (event, data) => { results.push(event + ':' + data); });
  ee.emit('db:connect', 'local');
  ee.emit('db:query', 'SELECT 1');
  ee.emit('http:get', 'ignored');
  assert.deepStrictEqual(results, ['db:connect:local', 'db:query:SELECT 1']);
});

// 4. onceWildcard fires once
test('onceWildcard fires once then auto-removes', () => {
  const ee = new WildcardEventEmitter();
  let count = 0;
  ee.onceWildcard((event) => { count++; });
  ee.emit('a');
  ee.emit('b');
  assert.strictEqual(count, 1);
});

// 5. once with wildcard pattern fires once
test('once with * fires once', () => {
  const ee = new WildcardEventEmitter();
  let count = 0;
  ee.once('*', () => { count++; });
  ee.emit('x');
  ee.emit('y');
  assert.strictEqual(count, 1);
});

// 6. once with namespace pattern fires once
test('once with db:* fires once', () => {
  const ee = new WildcardEventEmitter();
  let count = 0;
  ee.on('db:*', () => { count++; });
  ee.once('db:*', () => { count += 10; });
  ee.emit('db:connect');
  ee.emit('db:close');
  assert.strictEqual(count, 12); // permanent: 2, once: 10 (first only)
});

// 7. listenerCount aggregation
test('listenerCount includes wildcard + specific', () => {
  const ee = new WildcardEventEmitter();
  ee.on('db:connect', () => {});
  ee.on('db:connect', () => {});
  ee.on('db:*', () => {});
  ee.on('*', () => {});
  assert.strictEqual(ee.listenerCount('db:connect'), 4);
  assert.strictEqual(ee.listenerCount('other'), 1); // only * matches
});

// 8. eventNames includes wildcard entries
test('eventNames includes wildcard entries', () => {
  const ee = new WildcardEventEmitter();
  ee.on('foo', () => {});
  ee.on('*', () => {});
  ee.on('db:*', () => {});
  const names = ee.eventNames();
  assert.ok(names.includes('foo'));
  assert.ok(names.includes('*'));
  assert.ok(names.includes('db:*'));
});

// 9. removeAllListeners respects wildcard boundaries
test('removeAllListeners(event) only removes matching wildcard pattern', () => {
  const ee = new WildcardEventEmitter();
  let wildcardCount = 0;
  let nsCount = 0;
  ee.on('*', () => { wildcardCount++; });
  ee.on('db:*', () => { nsCount++; });
  ee.on('db:connect', () => {});
  // Remove only db:* pattern
  ee.removeAllListeners('db:*');
  ee.emit('db:connect');
  assert.strictEqual(wildcardCount, 1);
  assert.strictEqual(nsCount, 0);
  assert.strictEqual(ee.listenerCount('db:connect'), 2); // * + specific
});

// 10. removeAllListeners() with no args clears everything
test('removeAllListeners() clears all', () => {
  const ee = new WildcardEventEmitter();
  ee.on('*', () => {});
  ee.on('db:*', () => {});
  ee.on('foo', () => {});
  ee.removeAllListeners();
  assert.strictEqual(ee.eventNames().length, 0);
});

// 11. prependWildcardListener ordering
test('prependWildcardListener fires before regular wildcard', () => {
  const ee = new WildcardEventEmitter();
  const order = [];
  ee.on('*', () => { order.push('regular'); });
  ee.prependWildcardListener('*', () => { order.push('prepended'); });
  ee.emit('test');
  assert.deepStrictEqual(order, ['prepended', 'regular']);
});

// 12. Context binding (this)
test('wildcard listener has emitter as this', () => {
  const ee = new WildcardEventEmitter();
  let ctx = null;
  ee.on('*', function () { ctx = this; });
  ee.emit('x');
  assert.strictEqual(ctx, ee);
});

// 13. Wildcard receives event name as first arg
test('wildcard * receives event name as first argument', () => {
  const ee = new WildcardEventEmitter();
  const calls = [];
  ee.on('*', (event, a, b) => { calls.push([event, a, b]); });
  ee.emit('tick', 1, 2);
  assert.deepStrictEqual(calls, [['tick', 1, 2]]);
});

// 14. Namespace wildcard receives event name as first arg
test('namespace wildcard receives event name as first argument', () => {
  const ee = new WildcardEventEmitter();
  let received = null;
  ee.on('db:*', (event, data) => { received = { event, data }; });
  ee.emit('db:ping', 'pong');
  assert.deepStrictEqual(received, { event: 'db:ping', data: 'pong' });
});

// 15. removeListener for specific wildcard
test('removeListener removes specific wildcard handler', () => {
  const ee = new WildcardEventEmitter();
  let count = 0;
  const handler = () => { count++; };
  ee.on('*', handler);
  ee.emit('a');
  ee.removeListener('*', handler);
  ee.emit('b');
  assert.strictEqual(count, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);