'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function nowHrTime() {
  return process.hrtime.bigint();
}

function hrTimeToMs(bigint) {
  return Number(bigint) / 1_000_000;
}

function hrTimeToNs(bigint) {
  return Number(bigint);
}

// ---------------------------------------------------------------------------
// SpanKind enum
// ---------------------------------------------------------------------------
const SpanKind = Object.freeze({
  INTERNAL: 'INTERNAL',
  SERVER: 'SERVER',
  CLIENT: 'CLIENT',
  PRODUCER: 'PRODUCER',
  CONSUMER: 'CONSUMER',
});

// ---------------------------------------------------------------------------
// SpanStatusCode enum
// ---------------------------------------------------------------------------
const SpanStatusCode = Object.freeze({
  UNSET: 0,
  OK: 1,
  ERROR: 2,
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
class Status {
  constructor(code = SpanStatusCode.UNSET, message = '') {
    this.code = code;
    this.message = message;
  }
}

// ---------------------------------------------------------------------------
// SpanContext – immutable identity for a span
// ---------------------------------------------------------------------------
class SpanContext {
  constructor(traceId, spanId, traceFlags = 0, traceState = '') {
    this.traceId = traceId;       // 32-char hex
    this.spanId = spanId;         // 16-char hex
    this.traceFlags = traceFlags; // bitfield
    this.traceState = traceState;
  }

  get isRemote() {
    return this._isRemote || false;
  }

  set isRemote(v) {
    this._isRemote = v;
  }
}

// ---------------------------------------------------------------------------
// TraceFlags
// ---------------------------------------------------------------------------
const TraceFlags = Object.freeze({
  NONE: 0x00,
  SAMPLED: 0x01,
});

// ---------------------------------------------------------------------------
// Drop-in simple clock for tests that need deterministic timestamps
// ---------------------------------------------------------------------------
class TestClock {
  constructor() {
    this._base = nowHrTime();
  }
  now() {
    return this._base;
  }
}

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------
class Span {
  /**
   * @param {Tracer} tracer
   * @param {string} name
   * @param {SpanContext} spanContext
   * @param {SpanKind} kind
   * @param {object} [attributes]
   * @param {number} [startTime] – hrtime bigint (wall-clock override for tests)
   */
  constructor(tracer, name, spanContext, kind, attributes = {}, startTime = null) {
    this._tracer = tracer;
    this._name = name;
    this._spanContext = spanContext;
    this._kind = kind;
    this._startTime = startTime !== null ? startTime : nowHrTime();
    this._endTime = null;
    this._status = new Status();
    this._attributes = Object.assign({}, attributes);
    this._events = [];
    this._parentSpanId = null; // set externally by Tracer when parent exists
  }

  /** W3C traceId (32 hex chars) */
  get traceId() {
    return this._spanContext.traceId;
  }

  /** W3C spanId (16 hex chars) */
  get spanId() {
    return this._spanContext.spanId;
  }

  get parentSpanId() {
    return this._parentSpanId;
  }

  set parentSpanId(v) {
    this._parentSpanId = v;
  }

  get name() {
    return this._name;
  }

  get kind() {
    return this._kind;
  }

  get status() {
    return this._status;
  }

  get startTime() {
    return this._startTime;
  }

  get endTime() {
    return this._endTime;
  }

  get attributes() {
    return this._attributes;
  }

  get events() {
    return this._events;
  }

  get spanContext() {
    return this._spanContext;
  }

  /** Return the W3C traceparent header value for this span */
  get traceparent() {
    return `00-${this.traceId}-${this.spanId}-${this._spanContext.traceFlags.toString(16).padStart(2, '0')}`;
  }

  // --- mutation methods ---

  /** @param {string} key @param {*} value */
  setAttribute(key, value) {
    this._attributes[key] = value;
    return this;
  }

  /** @param {object} obj */
  setAttributes(obj) {
    Object.assign(this._attributes, obj);
    return this;
  }

  /**
   * @param {string} name
   * @param {object} [attributes]
   * @param {number|bigint} [timestamp] – hrtime bigint
   */
  addEvent(name, attributes = {}, timestamp = null) {
    this._events.push({
      name,
      attributes: Object.assign({}, attributes),
      time: timestamp !== null ? timestamp : nowHrTime(),
    });
    return this;
  }

  /** @param {object} status  { code: SpanStatusCode.OK|ERROR, message?: string } */
  setStatus(status) {
    if (typeof status === 'object' && status !== null) {
      this._status = new Status(status.code, status.message || '');
    }
    return this;
  }

  /**
   * End the span.
   * @param {number|bigint} [endTime] – hrtime bigint
   */
  end(endTime = null) {
    if (this._endTime !== null) return; // idempotent
    this._endTime = endTime !== null ? endTime : nowHrTime();

    // Auto-export if tracer has an exporter
    if (this._tracer && this._tracer._exporter) {
      this._tracer._exporter.exportSpan(this);
    }
  }

  /** Serialise key fields for export */
  toJSON() {
    return {
      name: this._name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this._parentSpanId,
      kind: this._kind,
      startTime: hrTimeToNs(this._startTime),
      endTime: this._endTime ? hrTimeToNs(this._endTime) : null,
      status: { code: this._status.code, message: this._status.message },
      attributes: this._attributes,
      events: this._events.map((e) => ({
        name: e.name,
        attributes: e.attributes,
        time: hrTimeToNs(e.time),
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// TraceContext – W3C TraceContext inject / extract
// ---------------------------------------------------------------------------
const TRACEPARENT_HEADER = 'traceparent';
const TRACESTATE_HEADER = 'tracestate';

// Regex for: version-traceId-spanId-traceFlags
// version: 2 hex, traceId: 32 hex, spanId: 16 hex, traceFlags: 2 hex
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

class TraceContext {
  /**
   * Extract SpanContext from carrier headers (e.g. HTTP headers object).
   * @param {object} carrier  – { 'traceparent': '00-...', 'tracestate': '...' }
   * @returns {SpanContext|null}
   */
  static extract(carrier) {
    if (!carrier) return null;

    const tp = carrier[TRACEPARENT_HEADER];
    if (!tp) return null;

    const m = tp.match(TRACEPARENT_RE);
    if (!m) return null;

    const traceId = m[2].toLowerCase();
    const spanId = m[3].toLowerCase();
    const traceFlags = parseInt(m[4], 16);

    // Reject all-zero traceId / spanId (W3C spec)
    if (traceId === '00000000000000000000000000000000') return null;
    if (spanId === '0000000000000000') return null;

    const traceState = carrier[TRACESTATE_HEADER] || '';

    const ctx = new SpanContext(traceId, spanId, traceFlags, traceState);
    ctx.isRemote = true;
    return ctx;
  }

  /**
   * Inject SpanContext into carrier.
   * @param {SpanContext} spanContext
   * @param {object} carrier  – mutable object to write headers into
   */
  static inject(spanContext, carrier) {
    if (!spanContext || !carrier) return;

    carrier[TRACEPARENT_HEADER] =
      `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, '0')}`;

    if (spanContext.traceState) {
      carrier[TRACESTATE_HEADER] = spanContext.traceState;
    }
  }
}

// ---------------------------------------------------------------------------
// SpanExporter – in-memory collector
// ---------------------------------------------------------------------------
class SpanExporter {
  constructor() {
    this._spans = [];
  }

  /** @param {Span} span */
  exportSpan(span) {
    if (!span || span.endTime === null) {
      // Only export finished spans
      return;
    }
    this._spans.push(span.toJSON());
  }

  /** @param {Span[]} spans */
  exportSpans(spans) {
    for (const s of spans) {
      this.exportSpan(s);
    }
  }

  /** Return a shallow copy of collected spans */
  getFinishedSpans() {
    return this._spans.slice();
  }

  /** Clear collected spans */
  clear() {
    this._spans.length = 0;
  }

  get count() {
    return this._spans.length;
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------
class Tracer {
  /**
   * @param {object} [options]
   * @param {SpanExporter} [options.exporter]
   * @param {object} [options.clock] – object with .now() returning hrtime bigint
   */
  constructor(options = {}) {
    this._exporter = options.exporter || null;
    this._clock = options.clock || null;
  }

  /**
   * Generate a new traceId.
   * @returns {string} 32 hex chars
   */
  generateTraceId() {
    return randomHex(16);
  }

  /**
   * Generate a new spanId.
   * @returns {string} 16 hex chars
   */
  generateSpanId() {
    return randomHex(8);
  }

  /** Return current high-resolution time */
  now() {
    return this._clock ? this._clock.now() : nowHrTime();
  }

  /**
   * Start a new span.
   *
   * @param {string} name
   * @param {object} [options]
   * @param {SpanContext|Span|null} [options.parent]  – parent SpanContext, Span, or null for new trace
   * @param {SpanKind} [options.kind]
   * @param {object} [options.attributes]
   * @param {number|bigint} [options.startTime] – override for tests
   * @returns {Span}
   */
  startSpan(name, options = {}) {
    const { parent = null, kind = SpanKind.INTERNAL, attributes = {}, startTime = null } = options;

    let traceId, parentSpanId, traceFlags, traceState;
    let parentCtx = null;

    // Resolve parent
    if (parent) {
      if (parent instanceof Span) {
        parentCtx = parent.spanContext;
        parentSpanId = parent.spanId;
      } else if (parent instanceof SpanContext) {
        parentCtx = parent;
        parentSpanId = parent.spanId;
      }
    }

    if (parentCtx) {
      // Part of an existing trace
      traceId = parentCtx.traceId;
      traceFlags = parentCtx.traceFlags;
      traceState = parentCtx.traceState;
    } else {
      // New trace
      traceId = this.generateTraceId();
      traceFlags = TraceFlags.SAMPLED;
      traceState = '';
    }

    const spanId = this.generateSpanId();
    const ctx = new SpanContext(traceId, spanId, traceFlags, traceState);

    const effectiveStart = startTime !== null ? startTime : this.now();

    const span = new Span(this, name, ctx, kind, attributes, effectiveStart);
    if (parentSpanId) {
      span.parentSpanId = parentSpanId;
    }

    return span;
  }

  /**
   * End a span.
   * @param {Span} span
   * @param {number|bigint} [endTime]
   */
  endSpan(span, endTime = null) {
    if (!span || span.endTime !== null) return;
    span.end(endTime !== null ? endTime : this.now());
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  Tracer,
  Span,
  SpanContext,
  SpanExporter,
  TraceContext,
  Status,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  // Helpers
  randomHex,
  nowHrTime,
  hrTimeToMs,
  hrTimeToNs,
  TestClock,
};
