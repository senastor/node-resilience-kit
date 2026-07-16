'use strict';

var assert = require('assert');
var debounce = require('./impl.js').debounce;
var throttle = require('./impl.js').throttle;

// Helper: wrap setTimeout in a Promise
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

var passed = 0;
var failed = 0;
var total  = 0;

async function runTest(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL: ' + name);
    console.log('        ' + (err.message || err));
  }
}

// ── Debounce tests ──────────────────────────────────────────────────────────

async function test_debounce_delays_execution() {
  var calls = [];
  var db = debounce(function (v) { calls.push(v); }, 50);
  db('a');
  assert.deepStrictEqual(calls, []);
  await delay(80);
  assert.deepStrictEqual(calls, ['a']);
}
runTest('Debounce delays execution until idle period', test_debounce_delays_execution);

async function test_debounce_resets_timer() {
  var calls = [];
  var db = debounce(function (v) { calls.push(v); }, 50);
  db('a');
  await delay(30);
  db('b');
  await delay(30);          // 60 ms total but only 30 since last call
  assert.deepStrictEqual(calls, []);
  await delay(30);          // now 60 ms since last call
  assert.deepStrictEqual(calls, ['b']);
}
runTest('Debounce resets timer on repeated calls', test_debounce_resets_timer);

async function test_debounce_leading_edge() {
  var calls = [];
  var db = debounce(function (v) { calls.push(v); }, 50, { leading: true });
  db('a');
  assert.deepStrictEqual(calls, ['a']); // fires immediately
  await delay(80);
  assert.deepStrictEqual(calls, ['a']); // no trailing duplicate
}
runTest('Debounce leading edge fires immediately on first call', test_debounce_leading_edge);

async function test_debounce_cancel() {
  var calls = [];
  var db = debounce(function (v) { calls.push(v); }, 50);
  db('a');
  db.cancel();
  await delay(80);
  assert.deepStrictEqual(calls, []);
}
runTest('Debounce cancel() prevents pending execution', test_debounce_cancel);

async function test_debounce_flush() {
  var calls = [];
  var db = debounce(function (v) { calls.push(v); }, 200);
  db('a');
  assert.deepStrictEqual(calls, []);
  var result = db.flush();
  assert.deepStrictEqual(calls, ['a']);
  assert.strictEqual(result, undefined); // fn returns undefined
}
runTest('Debounce flush() executes immediately', test_debounce_flush);

async function test_debounce_max_delay() {
  var calls = [];
  var db = debounce(function (v) { calls.push(v); }, 100, { maxDelay: 200 });
  // keep calling every 50 ms – the 100 ms idle timer never fires
  db('a');
  await delay(50);
  db('b');
  await delay(50);
  db('c');
  await delay(50);
  db('d');
  // 150 ms elapsed, still under maxDelay=200, not yet fired
  assert.strictEqual(calls.length, 0);
  await delay(60);
  // 210 ms elapsed – maxDelay should have fired
  assert.ok(calls.length >= 1, 'maxDelay should have forced execution');
}
runTest('Debounce maxDelay forces execution after max time', test_debounce_max_delay);

// ── Throttle tests ──────────────────────────────────────────────────────────

async function test_throttle_limits_execution() {
  var calls = [];
  var th = throttle(function (v) { calls.push(v); }, 100);
  th('a');
  th('b');
  th('c');
  // leading fires immediately, trailing fires after 100 ms
  assert.strictEqual(calls.length, 1);
  await delay(120);
  assert.strictEqual(calls.length, 2);
}
runTest('Throttle limits execution to once per interval', test_throttle_limits_execution);

async function test_throttle_leading() {
  var calls = [];
  var th = throttle(function (v) { calls.push(v); }, 100, { leading: true, trailing: false });
  th('a');
  assert.deepStrictEqual(calls, ['a']);
  th('b');
  await delay(120);
  assert.deepStrictEqual(calls, ['a']); // trailing disabled
}
runTest('Throttle leading edge fires on first call', test_throttle_leading);

async function test_throttle_trailing() {
  var calls = [];
  var th = throttle(function (v) { calls.push(v); }, 100, { leading: true, trailing: true });
  th('a');
  await delay(50);
  th('b');
  await delay(120);
  assert.strictEqual(calls.length, 2); // leading 'a' + trailing 'b'
  assert.deepStrictEqual(calls, ['a', 'b']);
}
runTest('Throttle trailing edge fires after last call within interval', test_throttle_trailing);

async function test_throttle_leading_false_trailing_true() {
  var calls = [];
  var th = throttle(function (v) { calls.push(v); }, 100, { leading: false, trailing: true });
  th('a');
  assert.deepStrictEqual(calls, []); // leading suppressed
  await delay(120);
  assert.deepStrictEqual(calls, ['a']); // trailing fires
}
runTest('Throttle with leading=false and trailing=true', test_throttle_leading_false_trailing_true);

async function test_throttle_cancel() {
  var calls = [];
  var th = throttle(function (v) { calls.push(v); }, 100);
  th('a');
  await delay(50);
  th('b');
  th.cancel();
  await delay(120);
  assert.strictEqual(calls.length, 1); // leading only, trailing cancelled
}
runTest('Throttle cancel() works', test_throttle_cancel);

async function test_throttle_flush() {
  var calls = [];
  var th = throttle(function (v) { calls.push(v); }, 5000);
  th('a');
  await delay(50);
  th('b');
  assert.strictEqual(calls.length, 1);
  th.flush();
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls, ['a', 'b']);
}
runTest('Throttle flush() works', test_throttle_flush);

// ── Context & arguments ─────────────────────────────────────────────────────

async function test_debounce_context_and_args() {
  var ctx = { x: 42 };
  var received;
  var db = debounce(function (a, b) { received = { ctx: this, args: [a, b] }; }, 30);
  db.call(ctx, 1, 2);
  await delay(60);
  assert.strictEqual(received.ctx, ctx);
  assert.deepStrictEqual(received.args, [1, 2]);
}

async function test_throttle_context_and_args() {
  var ctx = { x: 99 };
  var received;
  var th = throttle(function (a, b) { received = { ctx: this, args: [a, b] }; }, 50);
  th.call(ctx, 'hello', 'world');
  assert.strictEqual(received.ctx, ctx);
  assert.deepStrictEqual(received.args, ['hello', 'world']);
}

async function test_context_and_args() {
  await test_debounce_context_and_args();
  await test_throttle_context_and_args();
}
runTest('Both pass correct arguments and context', test_context_and_args);

// ── Edge: delay / interval of 0 ─────────────────────────────────────────────

async function test_delay_zero() {
  var calls = [];
  var db = debounce(function (v) { calls.push(v); }, 0);
  db('a');
  await delay(10);
  assert.deepStrictEqual(calls, ['a']);
}

async function test_interval_zero() {
  var calls = [];
  var th = throttle(function (v) { calls.push(v); }, 0);
  th('a');
  assert.ok(calls.length >= 1);
  await delay(10);
  assert.ok(calls.length >= 1);
}

async function test_edge_zero() {
  await test_delay_zero();
  await test_interval_zero();
}
runTest('Edge: delay/interval of 0', test_edge_zero);

// ── Summary ─────────────────────────────────────────────────────────────────

(async function () {
  // give async tests time to settle
  await delay(500);
  console.log('\n  Results: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
