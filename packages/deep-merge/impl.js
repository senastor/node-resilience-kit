'use strict';

function isPlainObject(val) {
  if (val === null || typeof val !== 'object') return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function isMergeable(val) {
  if (val === null || typeof val !== 'object') return false;
  if (typeof val === 'function') return false;
  if (Buffer.isBuffer(val)) return false;
  if (val instanceof Date) return false;
  if (val instanceof RegExp) return false;
  if (val instanceof Map) return false;
  if (val instanceof Set) return false;
  if (Array.isArray(val)) return true;
  return isPlainObject(val);
}

function cloneValue(val, seen) {
  if (val === null || typeof val !== 'object') return val;
  if (seen.has(val)) return seen.get(val);

  if (val instanceof Date) return new Date(val.getTime());
  if (val instanceof RegExp) return new RegExp(val.source, val.flags);
  if (Buffer.isBuffer(val)) return Buffer.from(val);

  if (val instanceof Map) {
    const m = new Map();
    seen.set(val, m);
    for (const [k, v] of val) m.set(k, cloneValue(v, seen));
    for (const key of Reflect.ownKeys(val)) m[key] = cloneValue(val[key], seen);
    return m;
  }
  if (val instanceof Set) {
    const s = new Set();
    seen.set(val, s);
    for (const v of val) s.add(cloneValue(v, seen));
    for (const key of Reflect.ownKeys(val)) s[key] = cloneValue(val[key], seen);
    return s;
  }

  if (Array.isArray(val)) {
    const arr = [];
    seen.set(val, arr);
    for (let i = 0; i < val.length; i++) arr[i] = cloneValue(val[i], seen);
    return arr;
  }

  const result = Object.create(Object.getPrototypeOf(val));
  seen.set(val, result);
  for (const key of Reflect.ownKeys(val)) {
    result[key] = cloneValue(val[key], seen);
  }
  return result;
}

function clone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return cloneValue(obj, new WeakMap());
}

function deepMerge(target, source, opts) {
  opts = opts || {};
  return _deepMerge(target, source, opts, new WeakMap(), new WeakMap());
}

function _deepMerge(target, source, opts, sourceCloned, targetCloned) {
  const strategy = opts.strategy || 'merge';
  const customMerge = opts.customMerge || null;

  if (!isMergeable(target)) {
    if (isMergeable(source)) return cloneValue(source, sourceCloned);
    return source;
  }
  if (!isMergeable(source)) {
    return cloneValue(target, targetCloned);
  }

  if (targetCloned.has(target)) return targetCloned.get(target);

  const result = Array.isArray(source) ? [] : {};

  targetCloned.set(target, result);
  sourceCloned.set(source, result);

  if (Array.isArray(target) && Array.isArray(source)) {
    if (strategy === 'concat') {
      for (let i = 0; i < target.length; i++) result.push(cloneValue(target[i], new WeakMap()));
      for (let i = 0; i < source.length; i++) result.push(cloneValue(source[i], sourceCloned));
      return result;
    }
    for (let i = 0; i < source.length; i++) {
      if (i < target.length && isMergeable(target[i]) && isMergeable(source[i])) {
        result[i] = _deepMerge(target[i], source[i], opts, sourceCloned, targetCloned);
      } else {
        result[i] = cloneValue(source[i], sourceCloned);
      }
    }
    return result;
  }

  // Copy target keys not in source
  for (const key of Reflect.ownKeys(target)) {
    if (!(key in source)) {
      result[key] = cloneValue(target[key], targetCloned);
    }
  }

  // Merge source keys
  for (const key of Reflect.ownKeys(source)) {
    const tVal = target[key];
    const sVal = source[key];

    if (customMerge) {
      const custom = customMerge(key, tVal, sVal);
      if (custom !== undefined) { result[key] = custom; continue; }
    }

    if (strategy === 'replace') {
      result[key] = cloneValue(sVal, sourceCloned);
    } else if (isMergeable(tVal) && isMergeable(sVal)) {
      result[key] = _deepMerge(tVal, sVal, opts, sourceCloned, targetCloned);
    } else {
      result[key] = cloneValue(sVal, sourceCloned);
    }
  }

  return result;
}

function mergeAll(...objects) {
  if (objects.length === 0) return {};
  let result = objects[0];
  for (let i = 1; i < objects.length; i++) {
    result = deepMerge(result, objects[i]);
  }
  return result;
}

module.exports = { deepMerge, mergeAll, clone };
