'use strict';

/**
 * Test suite for sql-injection/sanitizer.js
 *
 * Verifies:
 *   1. Parameterized queries prevent injection
 *   2. Invalid table names are rejected
 *   3. Special characters are escaped
 *   4. Type coercion works correctly
 */

const assert = require('assert');
const {
  Whitelist,
  SqlSecurityError,
  buildSelect,
  buildInsert,
  buildUpdate,
  buildDelete,
  validateIdentifier,
  coerceParamValue,
  escapeStringLiteral,
  escapeIdentifier,
} = require('./impl.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const whitelist = new Whitelist();
whitelist.addTable('users', [
  'id', 'name', 'email', 'role', 'active', 'created_at', 'score',
]);
whitelist.addTable('products', [
  'id', 'title', 'price', 'category', 'stock',
]);
whitelist.addTable('orders', [
  'id', 'user_id', 'product_id', 'quantity', 'status',
]);

// ---------------------------------------------------------------------------
// 1. Parameterized queries prevent injection
// ---------------------------------------------------------------------------
console.log('\n--- 1. Parameterized queries prevent injection ---');

test('SELECT with malicious input stored in params, not inlined', () => {
  const { sql, params } = buildSelect(whitelist, 'users', {
    where: [{ column: 'name', value: "Robert'); DROP TABLE students;--" }],
  });
  // The SQL string MUST NOT contain the DROP TABLE payload inline
  assert.ok(!sql.includes('DROP TABLE'), 'SQL should not contain DROP TABLE');
  assert.ok(!sql.includes("Robert'"), 'SQL should not contain unescaped quote');
  // The payload should be in params, exactly as provided
  assert.ok(params.includes("Robert'); DROP TABLE students;--"),
    'Payload should be in params array exactly');
  assert.ok(sql.includes('$1'), 'SQL should use parameter placeholder $1');
});

test('INSERT with malicious input kept in params', () => {
  const { sql, params } = buildInsert(whitelist, 'users', {
    name: "'; DELETE FROM users; --",
    email: 'attacker@evil.com',
    role: 'user',
  });
  assert.ok(!sql.includes('DELETE FROM'), 'SQL must not contain DELETE');
  assert.ok(!sql.includes("';"), 'SQL must not contain injection fragment');
  assert.ok(params.includes("'; DELETE FROM users; --"),
    'Malicious payload stored in params');
});

test('UPDATE with injection attempt neutralized', () => {
  const { sql, params } = buildUpdate(whitelist, 'users',
    { role: "' OR '1'='1" },
    [{ column: 'id', value: 1 }]
  );
  assert.ok(!sql.includes("' OR '1'='1"), 'Injection not in SQL');
  assert.ok(params.includes("' OR '1'='1"), 'Injection tucked into params');
});

test('DELETE with injected WHERE clause suppressed', () => {
  // Attacker tries to delete user #5 but also passes a crafted value
  const { sql, params } = buildDelete(whitelist, 'users', [
    { column: 'id', value: "5 OR 1=1" },
  ]);
  assert.ok(!sql.includes('OR 1=1'), 'SQL should not contain OR 1=1');
  assert.ok(params.includes("5 OR 1=1"), 'Injection in params only');
  // Still has the parameterized placeholder
  assert.ok(sql.includes('$1'), 'SQL should use $1 placeholder');
});

test('All SELECT param numbers are sequential starting from $1', () => {
  const { sql } = buildSelect(whitelist, 'users', {
    where: [
      { column: 'name', value: 'test' },
      { column: 'role', value: 'admin' },
    ],
    limit: 10,
    offset: 0,
  });
  assert.ok(sql.includes('$1'), 'First param $1 present');
  assert.ok(sql.includes('$2'), 'Second param $2 present');
  assert.ok(sql.includes('$3'), 'Limit param $3 present');
  assert.ok(sql.includes('$4'), 'Offset param $4 present');
});

// ---------------------------------------------------------------------------
// 2. Invalid table names rejected
// ---------------------------------------------------------------------------
console.log('\n--- 2. Invalid table names rejected ---');

test('Non-whitelisted table throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'secrets'),
    SqlSecurityError,
    'Should reject "secrets" table'
  );
});

test('Table name with semicolon throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users; DROP TABLE users;'),
    SqlSecurityError,
    'Should reject table with semicolon'
  );
});

test('Table name with hyphen throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'user-data'),
    SqlSecurityError,
    'Should reject "user-data"'
  );
});

test('Table name with spaces throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users xx'),
    SqlSecurityError,
    'Should reject table name with spaces'
  );
});

test('Empty table name throws', () => {
  assert.throws(
    () => buildSelect(whitelist, ''),
    SqlSecurityError,
    'Should reject empty table name'
  );
});

test('Schema-qualified whitelisted table works', () => {
  const wl = new Whitelist();
  wl.addTable('public.users', ['id', 'name']);
  const { sql } = buildSelect(wl, 'public.users');
  assert.ok(sql.includes('"public.users"'), 'Schema-qualified table quoted correctly');
});

// ---------------------------------------------------------------------------
// 3. Invalid column names rejected
// ---------------------------------------------------------------------------
console.log('\n--- 3. Invalid column names rejected ---');

test('Non-whitelisted column in SELECT throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users', { columns: ['password_hash'] }),
    SqlSecurityError,
    'Should reject "password_hash" column'
  );
});

test('Non-whitelisted column in INSERT throws', () => {
  assert.throws(
    () => buildInsert(whitelist, 'users', { admin: true }),
    SqlSecurityError,
    'Should reject "admin" column'
  );
});

test('Non-whitelisted column in WHERE throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users', {
      where: [{ column: 'password_hash', value: 'x' }],
    }),
    SqlSecurityError,
    'Should reject "password_hash" in WHERE'
  );
});

test('Non-whitelisted column in ORDER BY throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users', { orderBy: ['secret_api_key'] }),
    SqlSecurityError,
    'Should reject "secret_api_key" in ORDER BY'
  );
});

test('Valid column names pass', () => {
  const { sql } = buildSelect(whitelist, 'users', { columns: ['id', 'name', 'email'] });
  assert.ok(sql.includes('"id"'));
  assert.ok(sql.includes('"name"'));
  assert.ok(sql.includes('"email"'));
});

// ---------------------------------------------------------------------------
// 4. Special characters escaped (identifier & string escaping helpers)
// ---------------------------------------------------------------------------
console.log('\n--- 4. Special characters escaped ---');

test('escapeIdentifier wraps in double quotes', () => {
  const result = escapeIdentifier('users');
  assert.strictEqual(result, '"users"');
});

test('escapeIdentifier doubles embedded double-quotes', () => {
  const result = escapeIdentifier('ta"ble');
  assert.strictEqual(result, '"ta""ble"');
});

test('escapeStringLiteral wraps in single quotes', () => {
  const result = escapeStringLiteral('hello');
  assert.strictEqual(result, "'hello'");
});

test('escapeStringLiteral escapes single quotes', () => {
  const result = escapeStringLiteral("it's");
  assert.strictEqual(result, "'it''s'");
});

test('escapeStringLiteral handles empty string', () => {
  const result = escapeStringLiteral('');
  assert.strictEqual(result, "''");
});

test('escapeStringLiteral rejects non-strings', () => {
  assert.throws(
    () => escapeStringLiteral(123),
    SqlSecurityError
  );
});

test('validateIdentifier rejects identifiers with special chars', () => {
  assert.throws(() => validateIdentifier('col;DROP', 'column'), SqlSecurityError);
  assert.throws(() => validateIdentifier('col--', 'column'), SqlSecurityError);
  assert.throws(() => validateIdentifier('col/*', 'column'), SqlSecurityError);
  assert.throws(() => validateIdentifier("col'x", 'column'), SqlSecurityError);
});

test('validateIdentifier rejects identifier with spaces', () => {
  assert.throws(() => validateIdentifier('my column', 'column'), SqlSecurityError);
});

test('validateIdentifier rejects non-string', () => {
  assert.throws(() => validateIdentifier(null, 'column'), SqlSecurityError);
  assert.throws(() => validateIdentifier(42, 'column'), SqlSecurityError);
});

// ---------------------------------------------------------------------------
// 5. Type coercion
// ---------------------------------------------------------------------------
console.log('\n--- 5. Type coercion ---');

test('coerceParamValue returns null for null/undefined', () => {
  assert.strictEqual(coerceParamValue(null), null);
  assert.strictEqual(coerceParamValue(undefined), null);
});

test('coerceParamValue returns numbers as-is', () => {
  assert.strictEqual(coerceParamValue(42), 42);
  assert.strictEqual(coerceParamValue(3.14), 3.14);
  assert.strictEqual(coerceParamValue(0), 0);
  assert.strictEqual(coerceParamValue(-100), -100);
});

test('coerceParamValue rejects NaN and Infinity', () => {
  assert.throws(() => coerceParamValue(NaN), SqlSecurityError);
  assert.throws(() => coerceParamValue(Infinity), SqlSecurityError);
  assert.throws(() => coerceParamValue(-Infinity), SqlSecurityError);
});

test('coerceParamValue returns booleans as-is', () => {
  assert.strictEqual(coerceParamValue(true), true);
  assert.strictEqual(coerceParamValue(false), false);
});

test('coerceParamValue returns strings as-is', () => {
  assert.strictEqual(coerceParamValue('hello'), 'hello');
  assert.strictEqual(coerceParamValue(''), '');
});

test('coerceParamValue returns Buffer as-is', () => {
  const buf = Buffer.from('binary data');
  assert.ok(Buffer.isBuffer(coerceParamValue(buf)));
  assert.deepStrictEqual(coerceParamValue(buf), buf);
});

test('coerceParamValue rejects objects', () => {
  assert.throws(() => coerceParamValue({}), SqlSecurityError);
  assert.throws(() => coerceParamValue([]), SqlSecurityError);
  assert.throws(() => coerceParamValue(() => {}), SqlSecurityError);
  assert.throws(() => coerceParamValue(Symbol('x')), SqlSecurityError);
});

test('coerceParamValue handles BigInt (safe)', () => {
  const result = coerceParamValue(BigInt(42));
  assert.strictEqual(typeof result, 'number');
  assert.strictEqual(result, 42);
});

test('coerceParamValue handles BigInt (unsafe -> string)', () => {
  const huge = BigInt('99999999999999999999');
  const result = coerceParamValue(huge);
  assert.strictEqual(typeof result, 'string');
  assert.strictEqual(result, '99999999999999999999');
});

test('String longer than 65535 chars is rejected', () => {
  const long = 'x'.repeat(65536);
  assert.throws(() => coerceParamValue(long), SqlSecurityError);
});

// ---------------------------------------------------------------------------
// 6. All four query types produce valid SQL shapes
// ---------------------------------------------------------------------------
console.log('\n--- 6. Query builder output shapes ---');

test('INSERT returns correct SQL structure', () => {
  const { sql, params } = buildInsert(whitelist, 'users', {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'user',
  });
  assert.ok(sql.startsWith('INSERT INTO "users"'));
  assert.ok(sql.includes('("name", "email", "role")'));
  assert.ok(sql.includes('($1, $2, $3)'));
  assert.deepStrictEqual(params, ['Alice', 'alice@example.com', 'user']);
});

test('INSERT with RETURNING * works', () => {
  const { sql } = buildInsert(whitelist, 'users', { name: 'Bob', email: 'bob@x.com', role: 'user' }, '*');
  assert.ok(sql.endsWith(' RETURNING *'));
});

test('UPDATE returns correct SQL structure', () => {
  const { sql, params } = buildUpdate(whitelist, 'users',
    { email: 'new@example.com', role: 'admin' },
    [{ column: 'id', value: 42 }]
  );
  assert.ok(sql.startsWith('UPDATE "users" SET'));
  assert.ok(sql.includes('"email" = $1'));
  assert.ok(sql.includes('"role" = $2'));
  assert.ok(sql.includes('WHERE "id" = $3'));
  assert.deepStrictEqual(params, ['new@example.com', 'admin', 42]);
});

test('UPDATE without WHERE throws', () => {
  assert.throws(
    () => buildUpdate(whitelist, 'users', { name: 'x' }, []),
    SqlSecurityError,
    'UPDATE without WHERE must throw'
  );
});

test('DELETE returns correct SQL structure', () => {
  const { sql, params } = buildDelete(whitelist, 'users', [
    { column: 'id', value: 99 },
  ]);
  assert.ok(sql.startsWith('DELETE FROM "users" WHERE'));
  assert.ok(sql.includes('"id" = $1'));
  assert.deepStrictEqual(params, [99]);
});

test('DELETE without WHERE throws', () => {
  assert.throws(
    () => buildDelete(whitelist, 'users', []),
    SqlSecurityError,
    'DELETE without WHERE must throw'
  );
});

test('SELECT with explicit columns', () => {
  const { sql, params } = buildSelect(whitelist, 'users', {
    columns: ['id', 'name'],
  });
  assert.ok(sql.startsWith('SELECT "id", "name" FROM "users"'));
  assert.strictEqual(params.length, 0);
});

test('SELECT with WHERE, ORDER BY, LIMIT, OFFSET', () => {
  const { sql, params } = buildSelect(whitelist, 'users', {
    where: [{ column: 'role', value: 'user' }],
    orderBy: [{ column: 'created_at', dir: 'DESC' }],
    limit: 10,
    offset: 20,
  });
  assert.ok(sql.includes('WHERE "role" = $1'));
  assert.ok(sql.includes('ORDER BY "created_at" DESC'));
  assert.ok(sql.includes('LIMIT $2'));
  assert.ok(sql.includes('OFFSET $3'));
  assert.strictEqual(params.length, 3);
  assert.deepStrictEqual(params, ['user', 10, 20]);
});

test('SELECT with IN operator', () => {
  const { sql, params } = buildSelect(whitelist, 'users', {
    where: [{ column: 'role', operator: 'IN', value: ['admin', 'moderator'] }],
  });
  assert.ok(sql.includes('"role" IN ($1, $2)'));
  assert.deepStrictEqual(params, ['admin', 'moderator']);
});

test('SELECT with BETWEEN operator', () => {
  const { sql, params } = buildSelect(whitelist, 'products', {
    where: [{ column: 'price', operator: 'BETWEEN', value: [10, 100] }],
  });
  assert.ok(sql.includes('"price" BETWEEN $1 AND $2'));
  assert.deepStrictEqual(params, [10, 100]);
});

test('SELECT with IS NULL', () => {
  const { sql, params } = buildSelect(whitelist, 'users', {
    where: [{ column: 'email', operator: 'IS', value: null }],
  });
  assert.ok(sql.includes('"email" IS NULL'));
  assert.strictEqual(params.length, 0, 'IS NULL should not add a parameter');
});

test('SELECT with IS NOT NULL', () => {
  const { sql, params } = buildSelect(whitelist, 'users', {
    where: [{ column: 'email', operator: 'IS NOT', value: null }],
  });
  assert.ok(sql.includes('"email" IS NOT NULL'));
  assert.strictEqual(params.length, 0);
});

test('SELECT with IS TRUE', () => {
  const { sql, params } = buildSelect(whitelist, 'users', {
    where: [{ column: 'active', operator: 'IS', value: 'TRUE' }],
  });
  assert.ok(sql.includes('"active" IS TRUE'));
  assert.strictEqual(params.length, 0);
});

test('Default columns selected when none specified', () => {
  const { sql } = buildSelect(whitelist, 'users');
  // All 7 columns from 'users' table should be listed
  const cols = ['id', 'name', 'email', 'role', 'active', 'created_at', 'score'];
  for (const c of cols) {
    assert.ok(sql.includes(`"${c}"`), `Should include column ${c}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------
console.log('\n--- 7. Edge cases ---');

test('Whitelist.addTable rejects empty columns array', () => {
  const wl = new Whitelist();
  assert.throws(() => wl.addTable('t', []), SqlSecurityError);
});

test('Whitelist.addTable rejects non-array columns', () => {
  const wl = new Whitelist();
  assert.throws(() => wl.addTable('t', 'col'), SqlSecurityError);
});

test('INSERT with empty data throws', () => {
  assert.throws(
    () => buildInsert(whitelist, 'users', {}),
    SqlSecurityError
  );
});

test('SELECT with invalid operator throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users', {
      where: [{ column: 'name', operator: 'EXEC', value: 'x' }],
    }),
    SqlSecurityError
  );
});

test('IN with empty array throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users', {
      where: [{ column: 'role', operator: 'IN', value: [] }],
    }),
    SqlSecurityError
  );
});

test('BETWEEN with wrong array length throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'products', {
      where: [{ column: 'price', operator: 'BETWEEN', value: [10] }],
    }),
    SqlSecurityError
  );
});

test('ORDER BY with wrong direction throws', () => {
  assert.throws(
    () => buildSelect(whitelist, 'users', {
      orderBy: [{ column: 'id', dir: 'BACKWARDS' }],
    }),
    SqlSecurityError
  );
});

test('ORDER BY with string shorthand works', () => {
  const { sql } = buildSelect(whitelist, 'users', {
    orderBy: ['name'],
  });
  assert.ok(sql.includes('ORDER BY "name" ASC'));
});

// ---------------------------------------------------------------------------
// 8. INSERT bulk-safety (no more than MAX_PARAM_COUNT)
// (Implicit — each INSERT call handles a single row's columns.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
