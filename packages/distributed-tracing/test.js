'use strict';

const assert = require('assert');
const {
  Tracer,
  Span,
  SpanContext,
  SpanExporter,
  TraceContext,
  Status,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  TestClock,
} = require('./impl.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const HEX_16 = /^[0-9a-f]{16}$/i;   // 8 bytes
const HEX_32 = /^[0-9a-f]{32}$/i;   // 16 bytes
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/i;

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
  } catch (e) {
    testsFailed++;
    console.error(`FAIL: ${name} — ${e.message}`);
  }
}

function assertHex16(val, msg) {
  assert.ok(HEX_16.test(val), `${msg}: expected 16-char hex, got "${val}"`);
}

function assertHex32(val, msg) {
  assert.ok(HEX_32.test(val), `${msg}: expected 32-char hex, got "${val}"`);
}

// ==========================================================================
// 1. Tracer creates spans with traceId, spanId
// ==========================================================================
test('Tracer generates valid span IDs on new trace', () => {
  const tracer = new Tracer();
  const span = tracer.startSpan('root');

  assertHex32(span.traceId, 'traceId');
  assertHex16(span.spanId, 'spanId');
  assert.strictEqual(span.parentSpanId, null, 'root should have no parentSpanId');
  assert.strictEqual(span.name, 'root');
});

test('Tracer creates child span inheriting traceId from parent Span', () => {
  const tracer = new Tracer();
  const root = tracer.startSpan('root');
  const child = tracer.startSpan('child', { parent: root });

  assert.strictEqual(child.traceId, root.traceId, 'child must inherit traceId');
  assertHex16(child.spanId, 'child spanId');
  assert.strictEqual(child.parentSpanId, root.spanId, 'child parentSpanId must match root spanId');
  assert.notStrictEqual(child.spanId, root.spanId, 'spanIds must be different');
});

test('Tracer creates child span from SpanContext', () => {
  const tracer = new Tracer();
  const ctx = new SpanContext(tracer.generateTraceId(), tracer.generateSpanId(), TraceFlags.SAMPLED);
  const span = tracer.startSpan('from-context', { parent: ctx });

  assert.strictEqual(span.traceId, ctx.traceId);
  assert.strictEqual(span.parentSpanId, ctx.spanId);
  assert.strictEqual(span.spanContext.traceFlags, TraceFlags.SAMPLED);
});

test('Tracer different spans get different spanIds', () => {
  const tracer = new Tracer();
  const s1 = tracer.startSpan('s1');
  const s2 = tracer.startSpan('s2');

  assert.notStrictEqual(s1.spanId, s2.spanId, 'spanIds must be unique');
});

// ==========================================================================
// 2. Span records start/end timestamps
// ==========================================================================
test('Span records start time on creation', async () => {
  const clock = new TestClock();
  const tracer = new Tracer({ clock });
  const span = tracer.startSpan('test', { startTime: clock.now() });

  assert.ok(span.startTime > 0n, 'startTime must be > 0');
  assert.strictEqual(span.endTime, null, 'endTime must be null before end()');
});

test('Span records end time', () => {
  const clock = new TestClock();
  const tracer = new Tracer({ clock });
  const span = tracer.startSpan('test', { startTime: clock.now() });
  span.end(clock.now());

  assert.ok(span.endTime !== null, 'endTime must be set after end()');
  assert.ok(span.endTime >= span.startTime, 'endTime >= startTime');
});

test('Span.end() is idempotent', () => {
  const clock = new TestClock();
  const tracer = new Tracer({ clock });
  const span = tracer.startSpan('test', { startTime: clock.now() });
  span.end(clock.now());
  const firstEnd = span.endTime;
  span.end(); // second call
  assert.strictEqual(span.endTime, firstEnd, 'second end() must not change endTime');
});

// ==========================================================================
// 3. Span tags (attributes)
// ==========================================================================
test('Span.setAttribute and setAttributes', () => {
  const tracer = new Tracer();
  const span = tracer.startSpan('tagged');

  span.setAttribute('http.method', 'GET');
  span.setAttributes({ 'http.url': '/api/users', 'http.status_code': 200 });

  assert.deepStrictEqual(span.attributes, {
    'http.method': 'GET',
    'http.url': '/api/users',
    'http.status_code': 200,
  });
});

test('Span constructor accepts initial attributes', () => {
  const tracer = new Tracer();
  const span = tracer.startSpan('attrs', { attributes: { component: 'test' } });

  assert.deepStrictEqual(span.attributes, { component: 'test' });
});

// ==========================================================================
// 4. Span events
// ==========================================================================
test('Span.addEvent records events with timestamps', () => {
  const clock = new TestClock();
  const tracer = new Tracer({ clock });
  const span = tracer.startSpan('eventful', { startTime: clock.now() });

  span.addEvent('cache.miss', { key: 'user:42' }, clock.now());
  span.addEvent('cache.hit');

  assert.strictEqual(span.events.length, 2);
  assert.strictEqual(span.events[0].name, 'cache.miss');
  assert.deepStrictEqual(span.events[0].attributes, { key: 'user:42' });
  assert.ok(span.events[0].time > 0n);
  assert.strictEqual(span.events[1].name, 'cache.hit');
});

// ==========================================================================
// 5. Status (ok/error)
// ==========================================================================
test('Span default status is UNSET', () => {
  const tracer = new Tracer();
  const span = tracer.startSpan('status-test');

  assert.strictEqual(span.status.code, SpanStatusCode.UNSET);
  assert.strictEqual(span.status.message, '');
});

test('Span.setStatus OK', () => {
  const tracer = new Tracer();
  const span = tracer.startSpan('ok');
  span.setStatus({ code: SpanStatusCode.OK });

  assert.strictEqual(span.status.code, SpanStatusCode.OK);
});

test('Span.setStatus ERROR with message', () => {
  const tracer = new Tracer();
  const span = tracer.startSpan('error');
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'timeout' });

  assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
  assert.strictEqual(span.status.message, 'timeout');
});

// ==========================================================================
// 6. TraceContext propagation (W3C)
// ==========================================================================
test('TraceContext.inject writes traceparent header', () => {
  const ctx = new SpanContext(
    '0af7651916cd43dd8448eb211c80319c',
    'b7ad6b7169203331',
    TraceFlags.SAMPLED
  );
  const carrier = {};

  TraceContext.inject(ctx, carrier);

  assert.ok(TRACEPARENT_RE.test(carrier.traceparent), `invalid traceparent: ${carrier.traceparent}`);
  assert.strictEqual(
    carrier.traceparent,
    '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
  );
});

test('TraceContext.inject writes tracestate when present', () => {
  const ctx = new SpanContext(
    '0af7651916cd43dd8448eb211c80319c',
    'b7ad6b7169203331',
    TraceFlags.SAMPLED,
    'vendor=opaque'
  );
  const carrier = {};

  TraceContext.inject(ctx, carrier);

  assert.strictEqual(carrier.tracestate, 'vendor=opaque');
});

test('TraceContext.inject skips tracestate when empty', () => {
  const ctx = new SpanContext(
    '0af7651916cd43dd8448eb211c80319c',
    'b7ad6b7169203331',
    TraceFlags.SAMPLED
  );
  const carrier = {};

  TraceContext.inject(ctx, carrier);

  assert.strictEqual(carrier.tracestate, undefined);
});

test('TraceContext.extract parses valid traceparent', () => {
  const carrier = {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    tracestate: 'foo=bar',
  };

  const ctx = TraceContext.extract(carrier);

  assert.ok(ctx !== null);
  assert.strictEqual(ctx.traceId, '0af7651916cd43dd8448eb211c80319c');
  assert.strictEqual(ctx.spanId, 'b7ad6b7169203331');
  assert.strictEqual(ctx.traceFlags, TraceFlags.SAMPLED);
  assert.strictEqual(ctx.traceState, 'foo=bar');
  assert.strictEqual(ctx.isRemote, true);
});

test('TraceContext.extract handles missing traceparent', () => {
  const ctx = TraceContext.extract({});
  assert.strictEqual(ctx, null);
});

test('TraceContext.extract handles null carrier', () => {
  const ctx = TraceContext.extract(null);
  assert.strictEqual(ctx, null);
});

test('TraceContext.extract rejects all-zero traceId', () => {
  const carrier = {
    traceparent: '00-00000000000000000000000000000000-b7ad6b7169203331-01',
  };
  const ctx = TraceContext.extract(carrier);
  assert.strictEqual(ctx, null);
});

test('TraceContext.extract rejects all-zero spanId', () => {
  const carrier = {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
  };
  const ctx = TraceContext.extract(carrier);
  assert.strictEqual(ctx, null);
});

test('TraceContext.extract handles case-insensitive hex', () => {
  const carrier = {
    traceparent: '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01',
  };
  const ctx = TraceContext.extract(carrier);
  assert.ok(ctx !== null);
  assert.strictEqual(ctx.traceId, '0af7651916cd43dd8448eb211c80319c');
  assert.strictEqual(ctx.spanId, 'b7ad6b7169203331');
});

// ==========================================================================
// 7. Span.traceparent getter
// ==========================================================================
test('Span.traceparent returns correctly formatted header', () => {
  const tracer = new Tracer();
  const span = tracer.startSpan('test');

  const tp = span.traceparent;
  assert.ok(TRACEPARENT_RE.test(tp), `invalid traceparent: ${tp}`);
  assert.ok(tp.includes(span.traceId));
  assert.ok(tp.includes(span.spanId));
});

// ==========================================================================
// 8. SpanExporter (in-memory collector)
// ==========================================================================
test('SpanExporter collects finished spans', () => {
  const exporter = new SpanExporter();
  const tracer = new Tracer({ exporter });

  const root = tracer.startSpan('root');
  const child = tracer.startSpan('child', { parent: root });

  child.end();
  root.end();

  assert.strictEqual(exporter.count, 2, 'should have 2 finished spans');

  const spans = exporter.getFinishedSpans();
  assert.strictEqual(spans.length, 2);

  // Verify JSON structure
  for (const s of spans) {
    assertHex32(s.traceId, 'exported traceId');
    assertHex16(s.spanId, 'exported spanId');
    assert.ok(typeof s.startTime === 'number', 'startTime must be number (ns)');
    assert.ok(typeof s.endTime === 'number', 'endTime must be number (ns)');
    assert.ok(s.endTime >= s.startTime, 'endTime >= startTime');
    assert.ok(s.status && typeof s.status.code === 'number');
    assert.ok(Array.isArray(s.events));
  }
});

test('SpanExporter does not collect un-finished spans', () => {
  const exporter = new SpanExporter();
  const tracer = new Tracer({ exporter });

  tracer.startSpan('open');

  assert.strictEqual(exporter.count, 0);
});

test('SpanExporter.clear() resets', () => {
  const exporter = new SpanExporter();
  const tracer = new Tracer({ exporter });

  const span = tracer.startSpan('s');
  span.end();

  assert.strictEqual(exporter.count, 1);
  exporter.clear();
  assert.strictEqual(exporter.count, 0);
});

test('SpanExporter.exportSpans batch', () => {
  const exporter = new SpanExporter();
  const tracer = new Tracer();

  const spans = [];
  for (let i = 0; i < 5; i++) {
    const s = tracer.startSpan(`s${i}`);
    s.end();
    spans.push(s);
  }

  exporter.exportSpans(spans);
  assert.strictEqual(exporter.count, 5);
});

test('SpanExporter skips null spans', () => {
  const exporter = new SpanExporter();
  exporter.exportSpan(null);
  assert.strictEqual(exporter.count, 0);
});

// ==========================================================================
// 9. Integration: full hierarchy + propagation round-trip
// ==========================================================================
test('Full round-trip: create hierarchy, propagate, extract, continue', () => {
  const exporter = new SpanExporter();
  const tracer = new Tracer({ exporter });

  // Service A
  const root = tracer.startSpan('GET /users', { kind: SpanKind.SERVER });
  root.setAttribute('http.method', 'GET');

  // Simulate outbound call: inject into headers
  const headers = {};
  TraceContext.inject(root.spanContext, headers);

  // Service B – extract from headers
  const remoteCtx = TraceContext.extract(headers);
  assert.ok(remoteCtx !== null);
  assert.strictEqual(remoteCtx.isRemote, true);

  const serverB = tracer.startSpan('handle /users', {
    parent: remoteCtx,
    kind: SpanKind.SERVER,
  });
  assert.strictEqual(serverB.traceId, root.traceId, 'traceId must propagate');
  assert.strictEqual(serverB.parentSpanId, root.spanId, 'parentSpanId must be root spanId');

  // Nested child in service B
  const dbQuery = tracer.startSpan('db.query', {
    parent: serverB,
    kind: SpanKind.CLIENT,
  });
  dbQuery.setAttribute('db.statement', 'SELECT * FROM users');
  dbQuery.addEvent('query.start');
  dbQuery.addEvent('query.end');
  dbQuery.setStatus({ code: SpanStatusCode.OK });
  dbQuery.end();

  serverB.setStatus({ code: SpanStatusCode.OK });
  serverB.end();

  root.setStatus({ code: SpanStatusCode.OK });
  root.end();

  // Verify exporter
  const exported = exporter.getFinishedSpans();
  assert.strictEqual(exported.length, 3, 'should export 3 spans');

  // Verify hierarchy in exported data
  const rootExported = exported.find((s) => s.name === 'GET /users');
  const serverBExported = exported.find((s) => s.name === 'handle /users');
  const dbExported = exported.find((s) => s.name === 'db.query');

  assert.ok(rootExported);
  assert.ok(serverBExported);
  assert.ok(dbExported);

  // All share same traceId
  assert.strictEqual(rootExported.traceId, serverBExported.traceId);
  assert.strictEqual(rootExported.traceId, dbExported.traceId);

  // Parent links
  assert.strictEqual(rootExported.parentSpanId, null);
  assert.strictEqual(serverBExported.parentSpanId, rootExported.spanId);
  assert.strictEqual(dbExported.parentSpanId, serverBExported.spanId);

  // DB span has events
  assert.strictEqual(dbExported.events.length, 2);

  // All have valid hex IDs
  assertHex16(rootExported.spanId, 'root spanId');
  assertHex16(serverBExported.spanId, 'serverB spanId');
  assertHex16(dbExported.spanId, 'db spanId');
  assertHex32(rootExported.traceId, 'root traceId');
});

// ==========================================================================
// 10. SpanKind constants
// ==========================================================================
test('SpanKind constants are defined', () => {
  assert.strictEqual(SpanKind.INTERNAL, 'INTERNAL');
  assert.strictEqual(SpanKind.SERVER, 'SERVER');
  assert.strictEqual(SpanKind.CLIENT, 'CLIENT');
  assert.strictEqual(SpanKind.PRODUCER, 'PRODUCER');
  assert.strictEqual(SpanKind.CONSUMER, 'CONSUMER');
});

// ==========================================================================
// 11. TraceFlags constants
// ==========================================================================
test('TraceFlags constants are defined', () => {
  assert.strictEqual(TraceFlags.NONE, 0x00);
  assert.strictEqual(TraceFlags.SAMPLED, 0x01);
});

// ==========================================================================
// 12. toJSON serialisation
// ==========================================================================
test('Span.toJSON produces valid export format', () => {
  const clock = new TestClock();
  const tracer = new Tracer({ clock });
  const span = tracer.startSpan('to-json', {
    startTime: clock.now(),
    attributes: { 'service.name': 'test' },
  });
  span.addEvent('start', {}, clock.now());
  span.setStatus({ code: SpanStatusCode.OK });
  span.end(clock.now());

  const json = span.toJSON();

  assert.strictEqual(json.name, 'to-json');
  assertHex32(json.traceId, 'json traceId');
  assertHex16(json.spanId, 'json spanId');
  assert.strictEqual(json.parentSpanId, null);
  assert.deepStrictEqual(json.attributes, { 'service.name': 'test' });
  assert.strictEqual(json.status.code, SpanStatusCode.OK);
  assert.strictEqual(json.events.length, 1);
  assert.ok(typeof json.startTime === 'number');
  assert.ok(typeof json.endTime === 'number');
  assert.ok(json.endTime >= json.startTime);
});

// ==========================================================================
// 13. Idempotent end and endSpan
// ==========================================================================
test('Tracer.endSpan works and is idempotent', () => {
  const exporter = new SpanExporter();
  const tracer = new Tracer({ exporter });
  const span = tracer.startSpan('end-span-test');

  tracer.endSpan(span);
  assert.strictEqual(exporter.count, 1);

  // Second call should be no-op
  tracer.endSpan(span);
  assert.strictEqual(exporter.count, 1); // still 1
});

// ==========================================================================
// Results
// ==========================================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
console.log(`${'='.repeat(50)}`);

if (testsFailed > 0) {
  process.exit(1);
}
