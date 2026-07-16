'use strict';

const { EventEmitter: NativeEmitter } = require('events');

class WildcardEventEmitter extends NativeEmitter {
  constructor() {
    super();
    this._wildcardListeners = [];
    this._wildcardOnceFlag = new Map(); // handler -> true if it should be removed after first call
  }

  /**
   * Register a listener. If event is '*', it catches all events.
   * If event is 'db:*', it catches events starting with 'db:'.
   */
  on(event, listener) {
    if (event === '*') {
      return this._addWildcard('*', listener, false);
    }
    if (typeof event === 'string' && event.endsWith(':*')) {
      return this._addWildcard(event, listener, false);
    }
    return super.on(event, listener);
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  /**
   * Register a one-time listener.
   */
  once(event, listener) {
    if (event === '*') {
      return this._addWildcard('*', listener, true);
    }
    if (typeof event === 'string' && event.endsWith(':*')) {
      return this._addWildcard(event, listener, true);
    }
    return super.once(event, listener);
  }

  /**
   * Convenience: listen to all events once then auto-remove.
   */
  onceWildcard(listener) {
    return this._addWildcard('*', listener, true);
  }

  /**
   * Prepend a wildcard listener so it fires before existing ones.
   */
  prependWildcardListener(event, listener) {
    if (event === '*') {
      this._wildcardListeners.unshift({ pattern: '*', listener, once: false });
      return this;
    }
    if (typeof event === 'string' && event.endsWith(':*')) {
      this._wildcardListeners.unshift({ pattern: event, listener, once: false });
      return this;
    }
    // For non-wildcard, delegate to built-in
    return super.prependListener(event, listener);
  }

  /**
   * Internal: add a wildcard entry.
   */
  _addWildcard(pattern, listener, once) {
    this._wildcardListeners.push({ pattern, listener, once });
    return this;
  }

  /**
   * Emit an event. Fires wildcard listeners for matching patterns.
   */
  emit(event, ...args) {
    // Fire matching wildcard listeners
    const toRemove = [];
    for (let i = 0; i < this._wildcardListeners.length; i++) {
      const entry = this._wildcardListeners[i];
      if (this._matchesWildcard(entry.pattern, event)) {
        try {
          entry.listener.call(this, event, ...args);
        } finally {
          if (entry.once) {
            toRemove.push(i);
          }
        }
      }
    }
    // Remove once-wildcard listeners (reverse order to keep indices valid)
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this._wildcardListeners.splice(toRemove[i], 1);
    }
    // Fire built-in listeners
    return super.emit(event, ...args);
  }

  /**
   * Check if a wildcard pattern matches an event name.
   */
  _matchesWildcard(pattern, event) {
    if (pattern === '*') return true;
    // pattern is like 'db:*' — match prefix
    const prefix = pattern.slice(0, -1); // remove trailing '*'
    return event.startsWith(prefix);
  }

  /**
   * Returns all registered event names including wildcard entries.
   */
  eventNames() {
    const builtIn = super.eventNames();
    const wildcardPatterns = [...new Set(this._wildcardListeners.map(e => e.pattern))];
    return [...new Set([...builtIn, ...wildcardPatterns])];
  }

  /**
   * Count listeners for an event. For 'db:connect', counts:
   *   - specific listeners on 'db:connect'
   *   - wildcard listeners matching 'db:connect' (i.e. '*' and 'db:*')
   */
  listenerCount(event) {
    let count = super.listenerCount(event);
    for (const entry of this._wildcardListeners) {
      if (this._matchesWildcard(entry.pattern, event)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Remove all listeners. If event is given, only remove for that event.
   * Wildcard entries are only removed if their pattern equals the event.
   * Calling with no args removes everything.
   */
  removeAllListeners(event) {
    if (event === undefined) {
      this._wildcardListeners = [];
      return super.removeAllListeners();
    }
    // Remove wildcard entries whose pattern matches the given event exactly
    this._wildcardListeners = this._wildcardListeners.filter(
      e => e.pattern !== event
    );
    return super.removeAllListeners(event);
  }

  /**
   * Remove a specific listener.
   */
  removeListener(event, listener) {
    if (event === '*') {
      this._wildcardListeners = this._wildcardListeners.filter(
        e => !(e.pattern === '*' && e.listener === listener)
      );
      return this;
    }
    if (typeof event === 'string' && event.endsWith(':*')) {
      this._wildcardListeners = this._wildcardListeners.filter(
        e => !(e.pattern === event && e.listener === listener)
      );
      return this;
    }
    return super.removeListener(event, listener);
  }

  /**
   * Get raw listeners including wildcard.
   */
  listeners(event) {
    const specific = super.listeners(event);
    const wildcards = this._wildcardListeners
      .filter(e => this._matchesWildcard(e.pattern, event))
      .map(e => e.listener);
    return [...specific, ...wildcards];
  }

  /**
   * Get all listeners (including wildcards) for inspection.
   */
  rawListeners(event) {
    return this.listeners(event);
  }
}

module.exports = WildcardEventEmitter;