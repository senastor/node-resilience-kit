'use strict';

const assert = require('assert');
const {
  sanitizeString,
  sanitizeNumber,
  sanitizeEmail,
  sanitizeUrl,
  sanitizeHtml,
  sanitizeSqlInput,
  sanitizeObject,
} = require('./impl.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + e.message);
  }
}

console.log('\n--- sanitizeString ---');

test('trims whitespace', function () {
  const r = sanitizeString('  hello  ');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 'hello');
});

test('enforces maxLength', function () {
  const r = sanitizeString('hello world', { maxLength: 5 });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.sanitized, 'hello');
  assert.ok(r.errors[0].includes('max length'));
});

test('strips control characters', function () {
  const r = sanitizeString('he\x00llo\x07');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 'hello');
});

test('preserves newlines and tabs', function () {
  const r = sanitizeString('a\tb\nc');
  assert.strictEqual(r.sanitized, 'a\tb\nc');
});

test('filters by allowedChars regex', function () {
  const r = sanitizeString('abc123!@#', { allowedChars: /[a-z]/ });
  assert.strictEqual(r.sanitized, 'abc');
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('disallowed'));
});

test('handles null', function () {
  const r = sanitizeString(null);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.sanitized, '');
});

test('handles undefined', function () {
  const r = sanitizeString(undefined);
  assert.strictEqual(r.valid, false);
});

test('coerces number to string', function () {
  const r = sanitizeString(12345);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, '12345');
});

test('empty string after trim', function () {
  const r = sanitizeString('   ');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, '');
});

test('default maxLength is 10000', function () {
  const long = 'a'.repeat(10001);
  const r = sanitizeString(long);
  assert.strictEqual(r.sanitized.length, 10000);
  assert.strictEqual(r.valid, false);
});

console.log('\n--- sanitizeNumber ---');

test('parses integer from string', function () {
  const r = sanitizeNumber('42', { integer: true });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 42);
});

test('parses float from string', function () {
  const r = sanitizeNumber('3.14');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 3.14);
});

test('rejects NaN', function () {
  const r = sanitizeNumber('abc');
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('not a valid number'));
});

test('rejects empty string', function () {
  const r = sanitizeNumber('');
  assert.strictEqual(r.valid, false);
});

test('enforces min bound', function () {
  const r = sanitizeNumber(5, { min: 10 });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('below minimum'));
});

test('enforces max bound', function () {
  const r = sanitizeNumber(100, { max: 50 });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('above maximum'));
});

test('accepts number within bounds', function () {
  const r = sanitizeNumber(25, { min: 0, max: 50 });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 25);
});

test('handles negative numbers', function () {
  const r = sanitizeNumber('-7.5');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, -7.5);
});

test('rejects Infinity', function () {
  const r = sanitizeNumber(Infinity);
  assert.strictEqual(r.valid, false);
});

test('handles null', function () {
  const r = sanitizeNumber(null);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.sanitized, null);
});

test('handles undefined', function () {
  const r = sanitizeNumber(undefined);
  assert.strictEqual(r.valid, false);
});

test('rejects mixed alphanumeric string', function () {
  const r = sanitizeNumber('12abc');
  assert.strictEqual(r.valid, false);
});

test('accepts number 0', function () {
  const r = sanitizeNumber(0);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 0);
});

test('handles scientific notation string', function () {
  const r = sanitizeNumber('1e3');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 1000);
});

console.log('\n--- sanitizeEmail ---');

test('valid email lowercase', function () {
  const r = sanitizeEmail('User@Example.COM');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 'user@example.com');
});

test('valid email with plus', function () {
  const r = sanitizeEmail('user+tag@example.com');
  assert.strictEqual(r.valid, true);
});

test('invalid email - no domain', function () {
  const r = sanitizeEmail('user@');
  assert.strictEqual(r.valid, false);
});

test('invalid email - no @', function () {
  const r = sanitizeEmail('userexample.com');
  assert.strictEqual(r.valid, false);
});

test('invalid email - no TLD', function () {
  const r = sanitizeEmail('user@localhost');
  assert.strictEqual(r.valid, false);
});

test('email > 254 chars rejected', function () {
  const long = 'a'.repeat(250) + '@b.co';
  const r = sanitizeEmail(long);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('254'));
});

test('empty email', function () {
  const r = sanitizeEmail('');
  assert.strictEqual(r.valid, false);
});

test('null email', function () {
  const r = sanitizeEmail(null);
  assert.strictEqual(r.valid, false);
});

test('email with spaces trimmed', function () {
  const r = sanitizeEmail('  user@test.com  ');
  assert.strictEqual(r.sanitized, 'user@test.com');
  assert.strictEqual(r.valid, true);
});

console.log('\n--- sanitizeUrl ---');

test('valid https url', function () {
  const r = sanitizeUrl('https://example.com/path?q=1');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 'https://example.com/path?q=1');
});

test('valid http url', function () {
  const r = sanitizeUrl('http://example.com');
  assert.strictEqual(r.valid, true);
});

test('rejects javascript: protocol', function () {
  const r = sanitizeUrl('javascript:alert(1)');
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('not allowed'));
});

test('rejects ftp when only http/https allowed', function () {
  const r = sanitizeUrl('ftp://files.example.com');
  assert.strictEqual(r.valid, false);
});

test('allows custom protocols', function () {
  const r = sanitizeUrl('ftp://files.example.com', ['ftp']);
  assert.strictEqual(r.valid, true);
});

test('rejects invalid url', function () {
  const r = sanitizeUrl('not a url');
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('Invalid URL'));
});

test('handles null', function () {
  const r = sanitizeUrl(null);
  assert.strictEqual(r.valid, false);
});

test('handles empty string', function () {
  const r = sanitizeUrl('');
  assert.strictEqual(r.valid, false);
});

console.log('\n--- sanitizeHtml ---');

test('strips HTML tags', function () {
  const r = sanitizeHtml('<b>bold</b> &amp; <i>italic</i>');
  assert.strictEqual(r.valid, false); // tags were stripped
  assert.strictEqual(r.sanitized, 'bold & italic');
  assert.ok(r.errors[0].includes('stripped'));
});

test('decodes HTML entities without tags', function () {
  const r = sanitizeHtml('hello &amp; world');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 'hello & world');
});

test('strips script tags', function () {
  const r = sanitizeHtml('<script>alert("xss")</script>safe');
  assert.strictEqual(r.sanitized, 'alert("xss")safe');
  assert.strictEqual(r.valid, false);
});

test('handles nested tags', function () {
  const r = sanitizeHtml('<div><span><a href="#">link</a></span></div>');
  assert.strictEqual(r.sanitized, 'link');
});

test('handles null', function () {
  const r = sanitizeHtml(null);
  assert.strictEqual(r.valid, false);
});

test('decodes numeric entities', function () {
  const r = sanitizeHtml('&#65;&#x42;');
  assert.strictEqual(r.sanitized, 'AB');
});

test('no tags returns valid true', function () {
  const r = sanitizeHtml('just plain text');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 'just plain text');
});

console.log('\n--- sanitizeSqlInput ---');

test('escapes single quotes', function () {
  const r = sanitizeSqlInput("it's a test");
  assert.strictEqual(r.sanitized, "it''s a test");
});

test('removes -- comment markers', function () {
  const r = sanitizeSqlInput("admin'-- ");
  assert.strictEqual(r.valid, false);
  assert.ok(r.sanitized.indexOf('--') === -1);
});

test('removes block comments', function () {
  const r = sanitizeSqlInput('SELECT * /* comment */ FROM users');
  assert.strictEqual(r.valid, false);
  assert.ok(r.sanitized.indexOf('/*') === -1);
  assert.ok(r.sanitized.indexOf('*/') === -1);
});

test('no injection returns valid', function () {
  const r = sanitizeSqlInput('hello world');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, 'hello world');
});

test('handles null', function () {
  const r = sanitizeSqlInput(null);
  assert.strictEqual(r.valid, false);
});

test('coerces number to string', function () {
  const r = sanitizeSqlInput(42);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized, '42');
});

test('handles combined injection attempt', function () {
  const r = sanitizeSqlInput("' OR 1=1 --");
  assert.strictEqual(r.valid, false);
  // single quotes escaped, -- removed
  assert.ok(r.sanitized.indexOf("''") !== -1);
});

console.log('\n--- sanitizeObject ---');

test('validates object with schema', function () {
  const schema = {
    name: { type: 'string', maxLength: 50 },
    age: { type: 'number', min: 0, max: 150, integer: true },
    email: { type: 'email' },
  };
  const obj = { name: '  Alice  ', age: '30', email: 'Alice@Example.COM' };
  const r = sanitizeObject(obj, schema);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sanitized.name, 'Alice');
  assert.strictEqual(r.sanitized.age, 30);
  assert.strictEqual(r.sanitized.email, 'alice@example.com');
});

test('reports per-field errors', function () {
  const schema = {
    name: { type: 'string', maxLength: 3 },
    age: { type: 'number', min: 0 },
  };
  const obj = { name: 'LongName', age: -5 };
  const r = sanitizeObject(obj, schema);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.errors.length, 2);
});

test('handles url field type', function () {
  const schema = { site: { type: 'url' } };
  const r = sanitizeObject({ site: 'https://example.com' }, schema);
  assert.strictEqual(r.valid, true);
});

test('handles html field type', function () {
  const schema = { bio: { type: 'html' } };
  const r = sanitizeObject({ bio: '<b>bold</b>' }, schema);
  assert.strictEqual(r.sanitized.bio, 'bold');
  assert.strictEqual(r.valid, false); // tags were stripped
});

test('handles sql field type', function () {
  const schema = { query: { type: 'sql' } };
  const r = sanitizeObject({ query: "test'value" }, schema);
  assert.strictEqual(r.sanitized.query, "test''value");
});

test('rejects null object', function () {
  const r = sanitizeObject(null, {});
  assert.strictEqual(r.valid, false);
});

test('rejects non-object input', function () {
  const r = sanitizeObject('string', {});
  assert.strictEqual(r.valid, false);
});

test('rejects null schema', function () {
  const r = sanitizeObject({}, null);
  assert.strictEqual(r.valid, false);
});

test('handles unknown field type', function () {
  const r = sanitizeObject({ x: 1 }, { x: { type: 'unknown' } });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('Unknown type'));
});

console.log('\n=== Results ===');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
console.log('Total:  ' + (passed + failed));

if (failed > 0) {
  process.exit(1);
}
