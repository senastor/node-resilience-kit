'use strict';

/**
 * Production-ready Input Sanitizer Module
 * All functions return {valid: bool, sanitized: value, errors: [string]}
 */

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decode HTML entities in a string
 */
function decodeHtmlEntities(input) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&#x2F;': '/',
    '&#x60;': '`',
    '&apos;': "'",
    '&nbsp;': ' ',
    '&#60;': '<',
    '&#62;': '>',
    '&#38;': '&',
    '&#34;': '"',
  };
  let result = input;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  // Also handle numeric entities &#NNN; and &#xHHH;
  result = result.replace(/&#x([0-9a-fA-F]+);/g, function (match, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
  result = result.replace(/&#([0-9]+);/g, function (match, dec) {
    return String.fromCharCode(parseInt(dec, 10));
  });
  return result;
}

/**
 * Sanitize a string input.
 * @param {*} input
 * @param {Object} [opts]
 * @param {number} [opts.maxLength=10000]
 * @param {boolean} [opts.trim=true]
 * @param {RegExp} [opts.allowedChars] - regex to match allowed chars
 * @param {boolean} [opts.stripControlChars=true]
 * @returns {{valid: boolean, sanitized: string, errors: string[]}}
 */
function sanitizeString(input, opts) {
  const errors = [];
  const config = Object.assign(
    { maxLength: 10000, trim: true, stripControlChars: true, allowedChars: null },
    opts || {}
  );

  if (input === null || input === undefined) {
    return { valid: false, sanitized: '', errors: ['Input is null or undefined'] };
  }

  // Coerce to string
  let value = typeof input === 'string' ? input : String(input);

  // Trim
  if (config.trim) {
    value = value.trim();
  }

  // Strip control characters (U+0000 to U+001F except \t \n \r, and U+007F)
  if (config.stripControlChars) {
    value = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  // Enforce allowed chars regex
  if (config.allowedChars instanceof RegExp) {
    const filtered = value.split('').filter(function (ch) {
      return config.allowedChars.test(ch);
    });
    if (filtered.length < value.length) {
      errors.push('Input contains disallowed characters');
    }
    value = filtered.join('');
  }

  // Max length
  if (value.length > config.maxLength) {
    value = value.substring(0, config.maxLength);
    errors.push('Input exceeded max length of ' + config.maxLength);
  }

  return { valid: errors.length === 0, sanitized: value, errors };
}

/**
 * Sanitize a numeric input.
 * @param {*} input
 * @param {Object} [opts]
 * @param {number} [opts.min=-Infinity]
 * @param {number} [opts.max=Infinity]
 * @param {boolean} [opts.integer=false] - force integer
 * @returns {{valid: boolean, sanitized: number|null, errors: string[]}}
 */
function sanitizeNumber(input, opts) {
  const errors = [];
  const config = Object.assign(
    { min: -Infinity, max: Infinity, integer: false },
    opts || {}
  );

  if (input === null || input === undefined) {
    return { valid: false, sanitized: null, errors: ['Input is null or undefined'] };
  }

  let value;
  if (typeof input === 'number') {
    value = input;
  } else if (typeof input === 'string') {
    // Validate string format first to reject things like '12abc'
    if (config.integer) {
      if (!/^\s*-?\d+\s*$/.test(input)) {
        return { valid: false, sanitized: null, errors: ['Input is not a valid number'] };
      }
      value = parseInt(input, 10);
    } else {
      if (!/^\s*-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(input)) {
        return { valid: false, sanitized: null, errors: ['Input is not a valid number'] };
      }
      value = parseFloat(input);
    }
  } else {
    return { valid: false, sanitized: null, errors: ['Input is not a number'] };
  }

  if (isNaN(value) || !isFinite(value)) {
    return { valid: false, sanitized: null, errors: ['Input is not a valid finite number'] };
  }

  if (config.integer && !Number.isInteger(value)) {
    // If parsed from string and parseInt was used, this shouldn't happen
    // but if a float number was passed directly
    value = Math.trunc(value);
    errors.push('Value was truncated to integer');
  }

  if (value < config.min) {
    errors.push('Value ' + value + ' is below minimum ' + config.min);
  }

  if (value > config.max) {
    errors.push('Value ' + value + ' is above maximum ' + config.max);
  }

  return { valid: errors.length === 0, sanitized: value, errors };
}

/**
 * Sanitize/validate an email address.
 * @param {*} input
 * @returns {{valid: boolean, sanitized: string, errors: string[]}}
 */
function sanitizeEmail(input) {
  const errors = [];

  if (input === null || input === undefined) {
    return { valid: false, sanitized: '', errors: ['Email is null or undefined'] };
  }

  let value = typeof input === 'string' ? input : String(input);
  value = value.trim().toLowerCase();

  if (value === '') {
    return { valid: false, sanitized: '', errors: ['Email is empty'] };
  }

  if (value.length > 254) {
    return { valid: false, sanitized: value, errors: ['Email exceeds 254 characters'] };
  }

  // Basic email format: local@domain.tld
  // Local part: alphanumeric, dots, hyphens, underscores, plus signs
  // Domain: alphanumeric, dots, hyphens
  // Must have exactly one @
  // TLD must be at least 2 chars
  const emailRegex = /^[a-zA-Z0-9.+_-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(value)) {
    errors.push('Invalid email format');
  }

  // Additional checks
  if (value.includes('..')) {
    // consecutive dots are generally invalid in email
    // but some interpretations allow it in local part; be strict here
    errors.push('Email contains consecutive dots');
  }

  if (value.startsWith('.') || value.endsWith('.')) {
    errors.push('Email starts or ends with a dot');
  }

  return { valid: errors.length === 0, sanitized: value, errors };
}

/**
 * Sanitize/validate a URL.
 * @param {*} input
 * @param {string[]} [allowedProtocols=['http','https']]
 * @returns {{valid: boolean, sanitized: string, errors: string[]}}
 */
function sanitizeUrl(input, allowedProtocols) {
  const errors = [];
  const protocols = allowedProtocols || ['http', 'https'];

  if (input === null || input === undefined) {
    return { valid: false, sanitized: '', errors: ['URL is null or undefined'] };
  }

  let value = typeof input === 'string' ? input : String(input);
  value = value.trim();

  if (value === '') {
    return { valid: false, sanitized: '', errors: ['URL is empty'] };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    return { valid: false, sanitized: value, errors: ['Invalid URL format'] };
  }

  const protocol = parsed.protocol.replace(':', '');
  if (!protocols.includes(protocol)) {
    errors.push('Protocol "' + protocol + '" is not allowed. Allowed: ' + protocols.join(', '));
  }

  return { valid: errors.length === 0, sanitized: parsed.href, errors };
}

/**
 * Sanitize HTML by stripping all tags and decoding entities.
 * @param {*} input
 * @returns {{valid: boolean, sanitized: string, errors: string[]}}
 */
function sanitizeHtml(input) {
  const errors = [];

  if (input === null || input === undefined) {
    return { valid: false, sanitized: '', errors: ['Input is null or undefined'] };
  }

  let value = typeof input === 'string' ? input : String(input);

  // Detect if there were HTML tags
  if (/<[^>]+>/.test(value)) {
    errors.push('HTML tags were stripped');
  }

  // Strip all HTML tags
  value = value.replace(/<[^>]*>/g, '');

  // Decode HTML entities
  value = decodeHtmlEntities(value);

  // Trim
  value = value.trim();

  return { valid: errors.length === 0, sanitized: value, errors };
}

/**
 * Sanitize input for safe SQL usage.
 * @param {*} input
 * @returns {{valid: boolean, sanitized: string, errors: string[]}}
 */
function sanitizeSqlInput(input) {
  const errors = [];

  if (input === null || input === undefined) {
    return { valid: false, sanitized: '', errors: ['Input is null or undefined'] };
  }

  let value = typeof input === 'string' ? input : String(input);

  // Detect SQL injection patterns
  if (/--/.test(value)) {
    errors.push('SQL comment marker (--) was removed');
  }
  if (/\/\*/.test(value) || /\*\//.test(value)) {
    errors.push('SQL block comment marker (/* */) was removed');
  }

  // Remove SQL comment markers
  value = value.replace(/--.*$/gm, '');
  value = value.replace(/\/\*[\s\S]*?\*\//g, '');

  // Escape single quotes by doubling them
  value = value.replace(/'/g, "''");

  return { valid: errors.length === 0, sanitized: value, errors };
}

/**
 * Sanitize an object according to a schema.
 * Schema format: { fieldName: { type: 'string'|'number'|'email'|'url'|'html'|'sql', ...opts } }
 *
 * @param {*} obj
 * @param {Object} schema
 * @returns {{valid: boolean, sanitized: Object, errors: string[]}}
 */
function sanitizeObject(obj, schema) {
  const errors = [];
  const sanitized = {};

  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return { valid: false, sanitized: {}, errors: ['Input is not an object'] };
  }

  if (schema === null || schema === undefined || typeof schema !== 'object') {
    return { valid: false, sanitized: {}, errors: ['Schema is not an object'] };
  }

  for (const [field, rules] of Object.entries(schema)) {
    const value = obj[field];
    const type = rules.type || 'string';
    let result;

    switch (type) {
      case 'string':
        result = sanitizeString(value, rules);
        break;
      case 'number':
        result = sanitizeNumber(value, rules);
        break;
      case 'email':
        result = sanitizeEmail(value);
        break;
      case 'url':
        result = sanitizeUrl(value, rules.allowedProtocols);
        break;
      case 'html':
        result = sanitizeHtml(value);
        break;
      case 'sql':
        result = sanitizeSqlInput(value);
        break;
      default:
        result = { valid: false, sanitized: null, errors: ['Unknown type: ' + type] };
    }

    sanitized[field] = result.sanitized;

    if (!result.valid) {
      for (const err of result.errors) {
        errors.push(field + ': ' + err);
      }
    }
  }

  return { valid: errors.length === 0, sanitized, errors };
}

module.exports = {
  sanitizeString,
  sanitizeNumber,
  sanitizeEmail,
  sanitizeUrl,
  sanitizeHtml,
  sanitizeSqlInput,
  sanitizeObject,
};
