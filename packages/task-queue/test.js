'use strict';
const assert = require('assert');
const { TaskQueue } = require('./impl.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function delay(ms, val) {
  return () => new Promise(r => setTimeout(() => r(val), ms));
}

function delayFail(ms, err) {
  return () => new Promise((_, rej) => setTimeout(() => rej(new Error(err)), ms));
}

(async () => {
  console.log('TaskQueue Tests\n');

  // 1. Basic enqueue + execute
  await test('basic enqueue and execute', async () => {
    const q = new TaskQueue(2);
    const r = await q.enqueue(() => 42);
    assert.strictEqual(r, 42);
  });

  // 2. Priority ordering (higher priority runs first)
  await test('priority ordering', async () => {
    const q = new TaskQueue(1); // concurrency 1 forces ordering
    const order = [];
    // Block with a slow task, then enqueue others
    const p1 = q.enqueue(async () => { await new Promise(r => setTimeout(r, 50)); order.push('low'); }, { priority: 1 });
    // These get queued while first runs
    await new Promise(r => setTimeout(r, 5));
    const p2 = q.enqueue(async () => { order.push('high'); }, { priority: 10 });
    const p3 = q.enqueue(async () => { order.push('med'); }, { priority: 5 });
    await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(order, ['low', 'high', 'med']);
  });

  // 3. Concurrency limit
  await test('concurrency limit', async () => {
    const q = new TaskQueue(2);
    let running = 0;
    let maxRunning = 0;
    const task = () => new Promise(resolve => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      setTimeout(() => { running--; resolve(); }, 50);
    });
    await Promise.all([q.enqueue(task), q.enqueue(task), q.enqueue(task), q.enqueue(task)]);
    assert.ok(maxRunning <= 2, `maxRunning was ${maxRunning}`);
  });

  // 4. Retry on failure
  await test('retry on failure', async () => {
    const q = new TaskQueue(2);
    let attempts = 0;
    const r = await q.enqueue(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    }, { retries: 3 });
    assert.strictEqual(r, 'ok');
    assert.strictEqual(attempts, 3);
  });

  // 5. Pause / resume
  await test('pause and resume', async () => {
    const q = new TaskQueue(1);
    let executed = false;
    q.pause();
    const p = q.enqueue(() => { executed = true; });
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(executed, false);
    assert.strictEqual(q.isPaused, true);
    q.resume();
    const r = await p;
    assert.strictEqual(executed, true);
    assert.strictEqual(q.isPaused, false);
  });

  // 6. Drain event
  await test('drain event', async () => {
    const q = new TaskQueue(2);
    let drained = false;
    q._onDrain = () => { drained = true; };
    await q.enqueue(() => 1);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(drained, true);
  });

  // 7. Clear queue
  await test('clear queue', async () => {
    const q = new TaskQueue(1);
    // Block with slow task
    const p1 = q.enqueue(() => new Promise(r => setTimeout(r, 50)));
    // Queue another that will be cleared
    const p2 = q.enqueue(() => 2).catch(() => 'cleared');
    q.clear();
    const r = await p2;
    assert.strictEqual(r, 'cleared');
    assert.strictEqual(q.size, 0);
    await p1;
  });

  // 8. Size / pending tracking
  await test('size and pending getters', async () => {
    const q = new TaskQueue(1);
    assert.strictEqual(q.size, 0);
    assert.strictEqual(q.pending, 0);
    const p1 = q.enqueue(() => new Promise(r => setTimeout(r, 50)));
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(q.pending, 1);
    const p2 = q.enqueue(() => 2);
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(q.size, 1); // second task waiting
    await Promise.all([p1, p2]);
    assert.strictEqual(q.size, 0);
    assert.strictEqual(q.pending, 0);
  });

  // 9. Empty queue edge cases
  await test('empty queue operations', async () => {
    const q = new TaskQueue(2);
    assert.strictEqual(q.size, 0);
    assert.strictEqual(q.pending, 0);
    assert.strictEqual(q.isPaused, false);
    q.pause();
    q.resume();
    q.clear();
    assert.strictEqual(q.size, 0);
  });

  // 10. onFailed callback
  await test('onFailed callback on exhausted retries', async () => {
    let failedTask = null;
    const q = new TaskQueue(1, {
      onFailed: (task, err, retriesLeft) => { failedTask = { err: err.message, retriesLeft }; }
    });
    await q.enqueue(() => { throw new Error('boom'); }, { retries: 1 }).catch(() => {});
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(failedTask.err, 'boom');
    assert.strictEqual(failedTask.retriesLeft, 0);
  });

  // 11. onDrain via constructor option
  await test('onDrain via constructor option', async () => {
    let drained = false;
    const q = new TaskQueue(2, { onDrain: () => { drained = true; } });
    await q.enqueue(() => 1);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(drained, true);
  });

  console.log(`\n${passed} passing, ${failed} failing`);
  if (failed > 0) process.exit(1);
})();
