'use strict';

const assert = require('assert');
const { deepMerge, mergeAll, clone } = require('./impl.js');

// 1. Basic deep merge
{
  const target = { a: 1, b: { c: 2, d: 3 } };
  const source = { b: { c: 10, e: 5 }, f: 6 };
  const result = deepMerge(target, source);
  assert.deepStrictEqual(result, { a: 1, b: { c: 10, d: 3, e: 5 }, f: 6 });
}

// 2. Array strategy: replace (default)
{
  const target = { arr: [1, 2, 3] };
  const source = { arr: [4, 5] };
  const result = deepMerge(target, source, { strategy: 'merge' });
  assert.deepStrictEqual(result.arr, [4, 5]);
}

// 3. Array strategy: concat
{
  const target = { arr: [1, 2] };
  const source = { arr: [3, 4] };
  const result = deepMerge(target, source, { strategy: 'concat' });
  assert.deepStrictEqual(result.arr, [1, 2, 3, 4]);
}

// 4. Circular reference detection - clone
{
  const obj = { a: 1 };
  obj.self = obj;
  const cloned = clone(obj);
  assert.strictEqual(cloned.a, 1);
  assert.strictEqual(cloned.self, cloned);
  assert.notStrictEqual(cloned, obj);
}

// 5. Circular reference detection - merge
{
  const target = { a: 1 };
  target.self = target;
  const source = { b: 2 };
  const result = deepMerge(target, source);
  assert.strictEqual(result.a, 1);
  assert.strictEqual(result.b, 2);
  assert.strictEqual(result.self, result);
}

// 6. mergeAll
{
  const a = { x: 1 };
  const b = { y: 2 };
  const c = { z: 3 };
  const result = mergeAll(a, b, c);
  assert.deepStrictEqual(result, { x: 1, y: 2, z: 3 });
}

// 7. mergeAll with overlapping keys
{
  const a = { x: { a: 1 } };
  const b = { x: { b: 2 } };
  const result = mergeAll(a, b);
  assert.deepStrictEqual(result, { x: { a: 1, b: 2 } });
}

// 8. clone with circular refs (Map)
{
  const m = new Map([['a', 1]]);
  m.self = m;
  const cloned = clone(m);
  assert.strictEqual(cloned.get('a'), 1);
  assert.strictEqual(cloned.self, cloned);
  assert.notStrictEqual(cloned, m);
}

// 9. Date handling
{
  const d = new Date('2025-01-01');
  const target = { date: d };
  const source = { date: new Date('2025-06-15') };
  const result = deepMerge(target, source);
  assert.strictEqual(result.date.getTime(), new Date('2025-06-15').getTime());
  assert.notStrictEqual(result.date, source.date);
}

// 10. RegExp handling
{
  const target = { pattern: /foo/i };
  const source = { pattern: /bar/g };
  const result = deepMerge(target, source);
  assert.strictEqual(result.pattern.source, 'bar');
  assert.strictEqual(result.pattern.flags, 'g');
}

// 11. Map handling
{
  const target = { m: new Map([['a', 1]]) };
  const source = { m: new Map([['b', 2]]) };
  const result = deepMerge(target, source);
  assert.ok(result.m instanceof Map);
  assert.strictEqual(result.m.get('b'), 2);
}

// 12. Set handling
{
  const target = { s: new Set([1, 2]) };
  const source = { s: new Set([3, 4]) };
  const result = deepMerge(target, source);
  assert.ok(result.s instanceof Set);
  assert.ok(result.s.has(3));
  assert.ok(result.s.has(4));
}

// 13. Buffer handling
{
  const target = { buf: Buffer.from('hello') };
  const source = { buf: Buffer.from('world') };
  const result = deepMerge(target, source);
  assert.ok(Buffer.isBuffer(result.buf));
  assert.strictEqual(result.buf.toString(), 'world');
}

// 14. Custom merge function
{
  const target = { x: 1, y: 2 };
  const source = { x: 10, y: 20 };
  const result = deepMerge(target, source, {
    customMerge(key, tVal, sVal) {
      if (key === 'x') return tVal + sVal;
      return undefined; // use default
    }
  });
  assert.strictEqual(result.x, 11);  // 1 + 10
  assert.strictEqual(result.y, 20);  // source wins
}

// 15. Symbol key support
{
  const sym = Symbol('test');
  const target = { [sym]: 'original', a: 1 };
  const source = { [sym]: 'updated', b: 2 };
  const result = deepMerge(target, source);
  assert.strictEqual(result[sym], 'updated');
  assert.strictEqual(result.a, 1);
  assert.strictEqual(result.b, 2);
}

// 16. Immutability: inputs not modified
{
  const target = { a: 1, b: { c: 2 } };
  const source = { b: { d: 3 }, e: 4 };
  const targetCopy = clone(target);
  const sourceCopy = clone(source);
  deepMerge(target, source);
  assert.deepStrictEqual(target, targetCopy);
  assert.deepStrictEqual(source, sourceCopy);
}

// 17. Edge: null/undefined/primitives
{
  assert.strictEqual(deepMerge(null, null), null);
  assert.strictEqual(deepMerge(null, 42), 42);
  assert.strictEqual(deepMerge(42, null), null);
  assert.strictEqual(deepMerge(undefined, 'hello'), 'hello');
  assert.strictEqual(deepMerge('hello', undefined), undefined);
  assert.strictEqual(deepMerge(1, 2), 2);
}

// 18. clone primitives
{
  assert.strictEqual(clone(42), 42);
  assert.strictEqual(clone(null), null);
  assert.strictEqual(clone(undefined), undefined);
  assert.strictEqual(clone('str'), 'str');
}

// 19. mergeAll with no args
{
  const result = mergeAll();
  assert.deepStrictEqual(result, {});
}

// 20. replace strategy
{
  const target = { a: 1, b: { c: 2, d: 3 } };
  const source = { b: { c: 10 } };
  const result = deepMerge(target, source, { strategy: 'replace' });
  assert.deepStrictEqual(result, { a: 1, b: { c: 10 } });
}

// 21. Deep nested circular merge
{
  const target = { a: { b: {} } };
  target.a.b.ref = target;
  const source = { a: { c: 3 } };
  const result = deepMerge(target, source);
  assert.strictEqual(result.a.c, 3);
  assert.strictEqual(result.a.b.ref, result);
}

console.log('All tests passed!');
