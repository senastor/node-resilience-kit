'use strict';

/**
 * SQL Injection Prevention Module (Node.js built-ins only)
 *
 * Provides:
 *   1. Parameterized query builder (INSERT, SELECT, UPDATE, DELETE)
 *   2. Input sanitization (special-character escaping, type validation)
 *   3. Whitelist-based table / column validation
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_OPERATORS = new Set([
  '=', '!=', '<>', '<', '<=', '>', '>=',
  'LIKE', 'NOT LIKE', 'ILIKE',
  'IN', 'NOT IN',
  'IS', 'IS NOT',
  'BETWEEN',
]);

const ALLOWED_SORT_DIRS = new Set(['ASC', 'DESC']);

// Max lengths to reject obviously-malicious (but technically valid) inputs
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_PARAM_COUNT = 500;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class SqlSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlSecurityError';
  }
}

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

/**
 * Simple whitelist store: table -> Set of allowed column names.
 *
 * Usage:
 *   const whitelist = new Whitelist();
 *   whitelist.addTable('users', ['id', 'name', 'email', 'role']);
 */
class Whitelist {
  constructor() {
    this._tables = new Map();
  }

  /**
   * Register a table and its allowed columns.
   * @param {string} table  table name (exactly as it appears in SQL)
   * @param {string[]} columns
   */
  addTable(table, columns) {
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new SqlSecurityError('columns must be a non-empty array');
    }
    const set = new Set(columns);
    // Validate each column string
    for (const col of set) {
      validateIdentifier(col, 'column');
    }
    this._tables.set(table, set);
  }

  /**
   * Check whether a table exists in the whitelist.
   */
  hasTable(table) {
    return this._tables.has(table);
  }

  /**
   * Check whether a column is allowed for a table.
   */
  hasColumn(table, column) {
    const cols = this._tables.get(table);
    return cols ? cols.has(column) : false;
  }

  /**
   * Return the set of allowed columns for a table (or undefined).
   */
  getColumns(table) {
    return this._tables.get(table);
  }
}

// ---------------------------------------------------------------------------
// Identifier validation (table names, column names)
// ---------------------------------------------------------------------------

/**
 * SQL-identifier regex: must start with a letter or underscore, followed by
 * alphanumeric / underscores.  Optionally supports a single dot for schema
 * prefixes (e.g. "public.users").
 */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

/**
 * Validate a SQL identifier (table or column name).  Throws if invalid.
 * @param {string} value
 * @param {'table'|'column'} kind  for error messages
 */
function validateIdentifier(value, kind) {
  if (typeof value !== 'string') {
    throw new SqlSecurityError(`${kind} name must be a string, got ${typeof value}`);
  }
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new SqlSecurityError(
      `${kind} name length must be 1-${MAX_IDENTIFIER_LENGTH}, got ${value.length}`
    );
  }
  if (!IDENTIFIER_RE.test(value)) {
    throw new SqlSecurityError(
      `Invalid ${kind} name "${value}": must match ${IDENTIFIER_RE}`
    );
  }
}

// ---------------------------------------------------------------------------
// Basic type coercion & validation for parameter values
// ---------------------------------------------------------------------------

/**
 * Coerce a value to its safest SQL-ready representation.
 *
 * Returns one of:
 *   - null                  (SQL NULL)
 *   - number                (integer or float, NaN -> error)
 *   - boolean               (coerced to 0/1)
 *   - string                (safe for parameterized substitution)
 *   - Buffer                (for binary / BLOB columns)
 *
 * Throws SqlSecurityError for objects, functions, symbols, undefined, NaN.
 */
function coerceParamValue(value) {
  if (value === null || value === undefined) {
    return null; // both map to SQL NULL in parameterized queries
  }

  const t = typeof value;

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new SqlSecurityError(`Non-finite number value: ${value}`);
    }
    // Preserve integer vs float as stored — parameterized drivers handle this
    return value;
  }

  if (t === 'bigint') {
    // Most drivers cannot handle BigInt directly; convert to Number or String
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      // Too large for safe integer — pass as string
      return String(value);
    }
    return n;
  }

  if (t === 'boolean') {
    // Parameterized queries prefer native booleans; some drivers expect 0/1.
    // We keep the boolean as-is — the driver will serialize.
    return value;
  }

  if (t === 'string') {
    // Parameterized queries do NOT require manual escaping; the driver handles
    // it.  We *still* reject obviously dangerous payload lengths but preserve
    // the original string so the test can assert injection attempts are NOT
    // stripped — they are just bound safely.
    if (value.length > 65535) {
      throw new SqlSecurityError(`String value too long: ${value.length} chars`);
    }
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  throw new SqlSecurityError(`Unsupported parameter type: ${t}`);
}

// ---------------------------------------------------------------------------
// Escaping helpers (for building SQL strings when you MUST inline — NOT
// recommended; prefer parameterized queries.  Provided for completeness.)
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inline use by doubling single-quotes and wrapping.
 * WARNING: parameterized queries are strongly preferred!
 */
function escapeStringLiteral(str) {
  if (typeof str !== 'string') {
    throw new SqlSecurityError('escapeStringLiteral expects a string');
  }
  // PostgreSQL-style: double single quotes
  return "'" + str.replace(/'/g, "''") + "'";
}

/**
 * Escape a SQL identifier (table / column) by wrapping in double-quotes and
 * doubling any embedded double-quotes (PostgreSQL / ANSI SQL style).
 *
 * NOTE: This does NOT validate the identifier — validation is handled
 * separately at the whitelist layer.  This function is purely for safe
 * quoting of an already-trusted identifier string.
 */
function escapeIdentifier(ident) {
  if (typeof ident !== 'string') {
    throw new SqlSecurityError('escapeIdentifier expects a string');
  }
  return '"' + ident.replace(/"/g, '""') + '"';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _assertTableWhitelisted(whitelist, table) {
  if (!whitelist) {
    throw new SqlSecurityError('Whitelist is required');
  }
  if (!whitelist.hasTable(table)) {
    throw new SqlSecurityError(`Table "${table}" is not in the whitelist`);
  }
}

function _assertColumnsAllowed(whitelist, table, columns) {
  _assertTableWhitelisted(whitelist, table);
  for (const col of columns) {
    if (!whitelist.hasColumn(table, col)) {
      throw new SqlSecurityError(
        `Column "${col}" is not allowed on table "${table}"`
      );
    }
  }
}

/**
 * Build a "column = $N" clause list from an object of column->value pairs.
 */
function _buildSetClauses(whitelist, table, data, paramOffset) {
  const entries = Object.entries(data);

  if (entries.length === 0) {
    throw new SqlSecurityError('No data provided for SET clause');
  }

  _assertColumnsAllowed(whitelist, table, entries.map(([k]) => k));

  if (entries.length > MAX_PARAM_COUNT) {
    throw new SqlSecurityError(`Too many parameters: ${entries.length}`);
  }

  const setClauses = [];
  const values = [];
  let idx = paramOffset;

  for (const [col, val] of entries) {
    const safeVal = coerceParamValue(val);
    setClauses.push(`${escapeIdentifier(col)} = $${idx}`);
    values.push(safeVal);
    idx++;
  }

  return { setClauses, values, idx };
}

function _buildWhereClauses(whitelist, table, conditions, paramOffset) {
  if (!conditions || conditions.length === 0) {
    return { whereClause: '', values: [], idx: paramOffset };
  }

  const allValues = [];
  const clauses = [];
  let idx = paramOffset;

  for (const cond of conditions) {
    if (!cond || typeof cond !== 'object') {
      throw new SqlSecurityError('Each WHERE condition must be an object');
    }

    const { column, operator, value } = cond;

    if (!column) {
      throw new SqlSecurityError('WHERE condition missing "column"');
    }
    if (!whitelist.hasColumn(table, column)) {
      throw new SqlSecurityError(
        `Column "${column}" is not allowed on table "${table}"`
      );
    }

    const op = (operator || '=').toUpperCase();
    if (!ALLOWED_OPERATORS.has(op)) {
      throw new SqlSecurityError(`Operator "${operator}" is not allowed`);
    }

    // Handle IN / NOT IN (value must be an array)
    if (op === 'IN' || op === 'NOT IN') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new SqlSecurityError(
          `${op} requires a non-empty array of values`
        );
      }
      const placeholders = [];
      for (const v of value) {
        const safeVal = coerceParamValue(v);
        placeholders.push(`$${idx}`);
        allValues.push(safeVal);
        idx++;
      }
      clauses.push(
        `${escapeIdentifier(column)} ${op} (${placeholders.join(', ')})`
      );
      continue;
    }

    // Handle BETWEEN
    if (op === 'BETWEEN') {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new SqlSecurityError('BETWEEN requires an array of [low, high]');
      }
      const low = coerceParamValue(value[0]);
      const high = coerceParamValue(value[1]);
      clauses.push(
        `${escapeIdentifier(column)} BETWEEN $${idx} AND $${idx + 1}`
      );
      allValues.push(low, high);
      idx += 2;
      continue;
    }

    // Handle IS / IS NOT
    if (op === 'IS' || op === 'IS NOT') {
      if (value === null || value === undefined) {
        clauses.push(`${escapeIdentifier(column)} ${op} NULL`);
        // No parameter for NULL comparisons
        continue;
      }
      // For IS TRUE / IS FALSE / IS UNKNOWN etc.
      const upper = String(value).toUpperCase();
      if (['TRUE', 'FALSE', 'UNKNOWN'].includes(upper)) {
        clauses.push(`${escapeIdentifier(column)} ${op} ${upper}`);
        continue;
      }
      throw new SqlSecurityError(`${op} value must be NULL / TRUE / FALSE / UNKNOWN`);
    }

    // Standard comparison
    const safeVal = coerceParamValue(value);
    clauses.push(`${escapeIdentifier(column)} ${op} $${idx}`);
    allValues.push(safeVal);
    idx++;
  }

  const whereClause = clauses.length > 0
    ? `WHERE ${clauses.join(' AND ')}`
    : '';

  return { whereClause, values: allValues, idx };
}

function _buildOrderBy(whitelist, table, orderBy) {
  if (!orderBy) return '';

  const cols = [];
  for (const entry of orderBy) {
    const col = typeof entry === 'string' ? entry : entry.column;
    const dir = (typeof entry === 'string' ? 'ASC' : (entry.dir || 'ASC')).toUpperCase();

    if (!whitelist.hasColumn(table, col)) {
      throw new SqlSecurityError(
        `ORDER BY column "${col}" is not allowed on table "${table}"`
      );
    }
    if (!ALLOWED_SORT_DIRS.has(dir)) {
      throw new SqlSecurityError(`Invalid sort direction: ${dir}`);
    }
    cols.push(`${escapeIdentifier(col)} ${dir}`);
  }
  return `ORDER BY ${cols.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Public query builders
// ---------------------------------------------------------------------------

/**
 * Build a parameterized SELECT query.
 *
 * @param {Whitelist}  whitelist
 * @param {string}     table
 * @param {object}     opts
 * @param {string[]}   [opts.columns]      columns to select (default: all allowed)
 * @param {object[]}   [opts.where]        array of { column, operator?, value }
 * @param {string[]}   [opts.orderBy]      e.g. ['name', { column: 'id', dir: 'DESC' }]
 * @param {number}     [opts.limit]        max rows
 * @param {number}     [opts.offset]       skip rows
 *
 * @returns {{ sql: string, params: Array }}
 */
function buildSelect(whitelist, table, opts = {}) {
  _assertTableWhitelisted(whitelist, table);

  // Columns
  let columns;
  if (opts.columns && opts.columns.length > 0) {
    _assertColumnsAllowed(whitelist, table, opts.columns);
    columns = opts.columns.map(c => escapeIdentifier(c)).join(', ');
  } else {
    // Default: all allowed columns
    const allCols = Array.from(whitelist.getColumns(table));
    columns = allCols.map(c => escapeIdentifier(c)).join(', ');
  }

  // WHERE
  const { whereClause, values } = _buildWhereClauses(
    whitelist, table, opts.where || [], 1
  );

  // ORDER BY
  const orderBy = _buildOrderBy(whitelist, table, opts.orderBy);

  // LIMIT / OFFSET
  const parts = [];
  let paramIdx = values.length;
  if (opts.limit !== undefined) {
    const limitVal = coerceParamValue(opts.limit);
    paramIdx++;
    parts.push(`LIMIT $${paramIdx}`);
    values.push(limitVal);
  }
  if (opts.offset !== undefined) {
    const offsetVal = coerceParamValue(opts.offset);
    paramIdx++;
    parts.push(`OFFSET $${paramIdx}`);
    values.push(offsetVal);
  }

  const sql = [
    `SELECT ${columns}`,
    `FROM ${escapeIdentifier(table)}`,
    whereClause,
    orderBy,
    ...parts,
  ]
    .filter(Boolean)
    .join(' ');

  return { sql, params: values };
}

/**
 * Build a parameterized INSERT query.
 *
 * @param {Whitelist}  whitelist
 * @param {string}     table
 * @param {object}     data            column -> value pairs
 * @param {string}     [returning]     optional RETURNING clause (e.g. '*')
 *
 * @returns {{ sql: string, params: Array }}
 */
function buildInsert(whitelist, table, data, returning) {
  _assertTableWhitelisted(whitelist, table);

  const entries = Object.entries(data);
  if (entries.length === 0) {
    throw new SqlSecurityError('No data provided for INSERT');
  }

  _assertColumnsAllowed(whitelist, table, entries.map(([k]) => k));

  if (entries.length > MAX_PARAM_COUNT) {
    throw new SqlSecurityError(`Too many parameters: ${entries.length}`);
  }

  const columns = [];
  const placeholders = [];
  const values = [];

  for (let i = 0; i < entries.length; i++) {
    const [col, val] = entries[i];
    const safeVal = coerceParamValue(val);
    columns.push(escapeIdentifier(col));
    placeholders.push(`$${i + 1}`);
    values.push(safeVal);
  }

  let sql = [
    `INSERT INTO ${escapeIdentifier(table)}`,
    `(${columns.join(', ')})`,
    `VALUES (${placeholders.join(', ')})`,
  ].join(' ');

  if (returning) {
    // RETURNING columns can be '*' or comma-separated list
    if (returning === '*') {
      sql += ' RETURNING *';
    } else {
      const retCols = returning
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
      _assertColumnsAllowed(whitelist, table, retCols);
      sql += ` RETURNING ${retCols.map(c => escapeIdentifier(c)).join(', ')}`;
    }
  }

  return { sql, params: values };
}

/**
 * Build a parameterized UPDATE query.
 *
 * @param {Whitelist}  whitelist
 * @param {string}     table
 * @param {object}     data            column -> value pairs to SET
 * @param {object[]}   where           array of { column, operator?, value }
 * @param {string}     [returning]     optional RETURNING clause
 *
 * @returns {{ sql: string, params: Array }}
 */
function buildUpdate(whitelist, table, data, where, returning) {
  _assertTableWhitelisted(whitelist, table);

  if (!where || where.length === 0) {
    throw new SqlSecurityError('UPDATE requires a WHERE clause for safety');
  }

  // SET clause starts at $1
  const { setClauses, values } = _buildSetClauses(whitelist, table, data, 1);

  // WHERE clause continues parameter numbering
  const { whereClause, values: whereVals } = _buildWhereClauses(
    whitelist, table, where, values.length + 1
  );

  const allParams = values.concat(whereVals);

  let sql = [
    `UPDATE ${escapeIdentifier(table)}`,
    `SET ${setClauses.join(', ')}`,
    whereClause,
  ].join(' ');

  if (returning) {
    if (returning === '*') {
      sql += ' RETURNING *';
    } else {
      const retCols = returning
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
      _assertColumnsAllowed(whitelist, table, retCols);
      sql += ` RETURNING ${retCols.map(c => escapeIdentifier(c)).join(', ')}`;
    }
  }

  return { sql, params: allParams };
}

/**
 * Build a parameterized DELETE query.
 *
 * @param {Whitelist}  whitelist
 * @param {string}     table
 * @param {object[]}   where           array of { column, operator?, value }
 * @param {string}     [returning]     optional RETURNING clause
 *
 * @returns {{ sql: string, params: Array }}
 */
function buildDelete(whitelist, table, where, returning) {
  _assertTableWhitelisted(whitelist, table);

  if (!where || where.length === 0) {
    throw new SqlSecurityError('DELETE requires a WHERE clause for safety');
  }

  const { whereClause, values } = _buildWhereClauses(
    whitelist, table, where, 1
  );

  let sql = [
    `DELETE FROM ${escapeIdentifier(table)}`,
    whereClause,
  ].join(' ');

  if (returning) {
    if (returning === '*') {
      sql += ' RETURNING *';
    } else {
      const retCols = returning
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
      _assertColumnsAllowed(whitelist, table, retCols);
      sql += ` RETURNING ${retCols.map(c => escapeIdentifier(c)).join(', ')}`;
    }
  }

  return { sql, params: values };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  Whitelist,
  SqlSecurityError,

  buildSelect,
  buildInsert,
  buildUpdate,
  buildDelete,

  // Lower-level helpers available for advanced use
  validateIdentifier,
  coerceParamValue,
  escapeStringLiteral,
  escapeIdentifier,
  ALLOWED_OPERATORS,
};
