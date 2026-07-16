'use strict';

/**
 * Debounce: delays execution until `delay` ms of inactivity.
 *
 * @param {Function} fn          – function to debounce
 * @param {number}   delay       – idle delay in ms
 * @param {object}   [opts]
 * @param {boolean}  [opts.leading=false]  – fire on leading edge
 * @param {number}   [opts.maxDelay]       – force execution after maxDelay ms
 * @returns {Function} debounced function with .cancel() and .flush()
 */
function debounce(fn, delay, opts) {
  opts = opts || {};
  var leading  = !!opts.leading;
  var maxDelay = typeof opts.maxDelay === 'number' ? opts.maxDelay : null;

  var timerId     = null;
  var maxTimerId  = null;
  var lastThis    = undefined;
  var lastArgs    = null;
  var pending     = false;   // true when at least one call has been queued
  var invokedLeading = false; // used only when leading===true

  function clear() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (maxTimerId !== null) {
      clearTimeout(maxTimerId);
      maxTimerId = null;
    }
  }

  function invoke() {
    if (!lastArgs) return;           // nothing pending
    var args = lastArgs;
    var ctx  = lastThis;
    lastArgs = null;
    pending  = false;
    invokedLeading = false;
    clear();
    return fn.apply(ctx, args);
  }

  function startTimer() {
    timerId = setTimeout(function () {
      timerId = null;
      if (leading) invokedLeading = false;
      invoke();
    }, delay);
  }

  function startMaxTimer() {
    if (maxDelay == null || maxTimerId !== null) return;
    maxTimerId = setTimeout(function () {
      maxTimerId = null;
      invoke();
    }, maxDelay);
  }

  function debounced(/* ...args */) {
    lastThis = this;
    lastArgs = Array.prototype.slice.call(arguments);
    pending  = true;

    var callNow = leading && (timerId === null && !invokedLeading);

    // reset the idle timer
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    startTimer();

    // start the max-delay timer on the very first call of a burst
    if (maxDelay != null && maxTimerId === null) {
      startMaxTimer();
    }

    if (callNow) {
      invokedLeading = true;
      return invoke();
    }
  }

  debounced.cancel = function () {
    clear();
    lastArgs = null;
    pending  = false;
    invokedLeading = false;
  };

  debounced.flush = function () {
    return invoke();
  };

  return debounced;
}


/**
 * Throttle: limits execution to once per `interval` ms.
 *
 * @param {Function} fn            – function to throttle
 * @param {number}   interval      – minimum gap between executions in ms
 * @param {object}   [opts]
 * @param {boolean}  [opts.leading=true]   – fire on leading edge
 * @param {boolean}  [opts.trailing=true]  – fire on trailing edge
 * @returns {Function} throttled function with .cancel() and .flush()
 */
function throttle(fn, interval, opts) {
  opts = opts || {};
  var leading  = opts.leading  !== undefined ? !!opts.leading  : true;
  var trailing = opts.trailing !== undefined ? !!opts.trailing : true;

  var timerId   = null;
  var lastTime  = 0;           // timestamp of last invocation
  var lastThis  = undefined;
  var lastArgs  = null;
  var pending   = false;

  function clear() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function invoke() {
    if (!lastArgs) return;
    var args = lastArgs;
    var ctx  = lastThis;
    lastArgs = null;
    lastTime = Date.now();
    return fn.apply(ctx, args);
  }

  function trailingTimer() {
    clear();
    timerId = setTimeout(function () {
      timerId = null;
      if (trailing && lastArgs) {
        invoke();
      }
      if (!lastArgs) pending = false;
    }, interval);
  }

  function throttled(/* ...args */) {
    var now = Date.now();
    lastThis = this;
    lastArgs = Array.prototype.slice.call(arguments);
    pending  = true;

    var remaining = interval - (now - lastTime);
    var callNow   = remaining <= 0;

    if (callNow) {
      if (leading) {
        lastTime = now;
        var result = invoke();
        // schedule trailing for the end of the interval
        if (trailing) trailingTimer();
        return result;
      } else {
        // leading disabled → schedule trailing
        lastTime = now;
        trailingTimer();
      }
    } else if (timerId === null && trailing) {
      // not time yet and no timer running → schedule trailing
      trailingTimer();
    }
  }

  throttled.cancel = function () {
    clear();
    lastArgs = null;
    lastTime = 0;
    pending  = false;
  };

  throttled.flush = function () {
    clear();
    pending = false;
    return invoke();
  };

  return throttled;
}


module.exports = { debounce: debounce, throttle: throttle };
