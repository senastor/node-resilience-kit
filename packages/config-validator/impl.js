'use strict';

/**
 * Config / schema validator
 *
 * validate(config, schema, options)
 * - options.coerce: boolean (default false)
 * - options.collectAllErrors: boolean (default true)
 *
 * Returns { valid, errors, config }
 */

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toString(v) {
  return Object.prototype.toString.call(v);
}

function cloneDeep(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cloneDeep);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = cloneDeep(obj[k]);
  return out;
}

function mergeDeep(target, source) {
  if (!isObject(source)) return source;
  const out = isObject(target) ? cloneDeep(target) : {};
  for (const key of Object.keys(source)) {
    if (isObject(source[key]) && isObject(target ? target[key] : undefined)) {
      out[key] = mergeDeep(target[key], source[key]);
    } else {
      out[key] = cloneDeep(source[key]);
    }
  }
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'string','number','boolean','object','function','symbol','bigint','undefined'
}

function coerceValue(value, targetType) {
  if (value === undefined || value === null) return value;

  switch (targetType) {
    case 'string': {
      return String(value);
    }
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }
    default:
      return value;
  }
}

function validateField(fieldName, value, fieldSchema, opts, pathPrefix) {
  const errors = [];
  const coerce = !!opts.coerce;
  const path = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;

  // Apply default if missing
  if (value === undefined && fieldSchema && fieldSchema.default !== undefined) {
    value = cloneDeep(fieldSchema.default);
  }

  const isMissing = value === undefined;

  // Required
  if (fieldSchema && fieldSchema.required && isMissing) {
    errors.push(`'${path}' is required`);
    return { errors, value };
  }

  // If missing and not required, nothing more to validate
  if (isMissing || fieldSchema === undefined) {
    return { errors, value };
  }

  // Coerce if requested and not null
  if (coerce && value !== null && fieldSchema.type) {
    value = coerceValue(value, fieldSchema.type);
  }

  // Type check (skip for null values unless required already handled)
  if (fieldSchema.type && value !== null) {
    const actual = typeOf(value);
    if (actual !== fieldSchema.type) {
      errors.push(`'${path}' must be ${fieldSchema.type}, got ${actual}`);
      return { errors, value };
    }
  }

  // Enum
  if (fieldSchema.enum && Array.isArray(fieldSchema.enum)) {
    if (!fieldSchema.enum.includes(value)) {
      errors.push(`'${path}' must be one of: ${fieldSchema.enum.join(', ')}`);
    }
  }

  // Number constraints
  if (fieldSchema.type === 'number' && typeof value === 'number') {
    if (fieldSchema.min !== undefined && value < fieldSchema.min) {
      errors.push(`'${path}' must be >= ${fieldSchema.min}`);
    }
    if (fieldSchema.max !== undefined && value > fieldSchema.max) {
      errors.push(`'${path}' must be <= ${fieldSchema.max}`);
    }
  }

  // String constraints
  if (fieldSchema.type === 'string' && typeof value === 'string') {
    if (fieldSchema.minLength !== undefined && value.length < fieldSchema.minLength) {
      errors.push(`'${path}' must be at least ${fieldSchema.minLength} characters`);
    }
    if (fieldSchema.maxLength !== undefined && value.length > fieldSchema.maxLength) {
      errors.push(`'${path}' must be at most ${fieldSchema.maxLength} characters`);
    }
    if (fieldSchema.pattern) {
      const re = new RegExp(fieldSchema.pattern);
      if (!re.test(value)) {
        errors.push(`'${path}' must match pattern ${fieldSchema.pattern}`);
      }
    }
  }

  // Nested object
  if (fieldSchema.type === 'object' && fieldSchema.properties && isObject(value)) {
    const res = validateInternal(value, fieldSchema.properties, opts, path);
    errors.push(...res.errors);
    value = res.config;
  }

  // Array item validation
  if (fieldSchema.type === 'array' && Array.isArray(value)) {
    if (fieldSchema.items) {
      const arrOut = [];
      for (let i = 0; i < value.length; i++) {
        const itemPath = `${path}[${i}]`;
        const itemType = fieldSchema.items.type;
        const itemVal = value[i];

        if (itemType) {
          if (itemVal !== null && typeOf(itemVal) !== itemType) {
            errors.push(`${itemPath} must be ${itemType}, got ${typeOf(itemVal)}`);
          } else {
            // Nested object/array schema inside items
            if (itemType === 'object' && fieldSchema.items.properties && isObject(itemVal)) {
              const nested = validateInternal(itemVal, fieldSchema.items.properties, opts, itemPath);
              errors.push(...nested.errors);
              arrOut.push(nested.config);
              continue;
            }
            arrOut.push(itemVal);
            continue;
          }
        }
        arrOut.push(itemVal);
      }
      value = arrOut;
    }
  }

  // Custom validator function
  if (typeof fieldSchema.validate === 'function') {
    const res = fieldSchema.validate(value, undefined);
    if (res !== true) {
      const msg = typeof res === 'string' ? res : `'${path}' custom validation failed`;
      errors.push(msg);
    }
  }

  return { errors, value };
}

function validateInternal(config, schema, opts, pathPrefix) {
  const errors = [];
  const out = isObject(config) ? cloneDeep(config) : {};

  const schemaKeys = schema ? Object.keys(schema) : [];
  const configKeys = isObject(config) ? Object.keys(config) : [];

  // Validate schema-defined fields
  for (const key of schemaKeys) {
    const res = validateField(key, out[key], schema[key], opts, pathPrefix);
    if (res.errors.length && opts.collectAllErrors) {
      errors.push(...res.errors);
    } else if (res.errors.length) {
      errors.push(res.errors[0]);
    }
    out[key] = res.value;
  }

  return { config: out, errors };
}

function validate(config, schema, options) {
  const opts = {
    coerce: !!(options && options.coerce),
    collectAllErrors: options && options.collectAllErrors !== undefined ? !!options.collectAllErrors : true,
  };

  const cfg = isObject(config) ? cloneDeep(config) : {};

  // Root must be an object
  if (!isObject(cfg)) {
    return { valid: false, errors: ['Root config must be an object'], config: cfg };
  }

  if (!schema || !isObject(schema)) {
    return { valid: true, errors: [], config: cfg };
  }

  const result = validateInternal(cfg, schema, opts, '');

  return {
    valid: result.errors.length === 0,
    errors: result.errors,
    config: result.config,
  };
}

module.exports = { validate };
