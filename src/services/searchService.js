'use strict';

/**
 * Sprint 3 — Browse, Search, and Object Explorer
 * Search utility functions: tokenisation, range parsing, keyword matching, cursor pagination.
 * Used by all six search endpoints.
 */

// ─── Tokenisation ─────────────────────────────────────────────────────────────

/**
 * Tokenise a string for fulltext index matching.
 * Splits on whitespace and punctuation; lowercases each token; filters empty strings.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenise(text) {
  if (!text) return [];
  return text.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
}

/**
 * Check if a query string matches a text field via fulltext tokenisation.
 * Multi-token queries are AND-ed: each query token must be a prefix of at least one stored token.
 *
 * @param {string} text   - Stored field value
 * @param {string} query  - User query string
 * @returns {boolean}
 */
function fulltextMatch(text, query) {
  if (!query) return true;
  if (!text) return false;
  const storedTokens = tokenise(text);
  const queryTokens = tokenise(query);
  if (queryTokens.length === 0) return true;
  return queryTokens.every(qt =>
    storedTokens.some(st => st.startsWith(qt))
  );
}

/**
 * Check if a value matches a keyword prefix query (case-insensitive).
 *
 * @param {string} value
 * @param {string} prefix
 * @returns {boolean}
 */
function keywordPrefixMatch(value, prefix) {
  if (!value || !prefix) return false;
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Check if a value exactly matches a keyword query (case-insensitive).
 *
 * @param {string} value
 * @param {string} query
 * @returns {boolean}
 */
function keywordExactMatch(value, query) {
  if (value == null || !query) return false;
  return String(value).toLowerCase() === query.toLowerCase();
}

// ─── Range parsing ────────────────────────────────────────────────────────────

/**
 * Parse a range filter string into a constraint object.
 * Format: "gte:2026-01-01" or "gte:2026-01-01,lte:2026-04-30".
 * Supported operators: gte, lte, gt, lt.
 *
 * @param {string} rangeStr
 * @returns {{ gte?: Date, lte?: Date, gt?: Date, lt?: Date } | null}
 * @throws {Error} with message 'INVALID_RANGE_FORMAT' on malformed input
 */
function parseRange(rangeStr) {
  if (!rangeStr) return null;
  const parts = rangeStr.split(',');
  const result = {};
  for (const part of parts) {
    const m = part.trim().match(/^(gte|lte|gt|lt):(.+)$/);
    if (!m) throw new Error('INVALID_RANGE_FORMAT');
    const d = new Date(m[2].trim());
    if (isNaN(d.getTime())) throw new Error('INVALID_RANGE_FORMAT');
    result[m[1]] = d;
  }
  if (Object.keys(result).length === 0) throw new Error('INVALID_RANGE_FORMAT');
  return result;
}

/**
 * Check if a date value satisfies a range constraint.
 * Returns false if value is null/undefined when a range is specified.
 *
 * @param {string|null} value - ISO-8601 date string or null
 * @param {{ gte?: Date, lte?: Date, gt?: Date, lt?: Date } | null} range
 * @returns {boolean}
 */
function matchesRange(value, range) {
  if (!range) return true;
  if (!value) return false;
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  if (range.gte && d < range.gte) return false;
  if (range.gt && d <= range.gt) return false;
  if (range.lte && d > range.lte) return false;
  if (range.lt && d >= range.lt) return false;
  return true;
}

// ─── Cursor-based pagination ──────────────────────────────────────────────────

/**
 * Encode a cursor from a sort key and record id.
 *
 * @param {string} sortKey
 * @param {string} id
 * @returns {string} opaque base64 cursor token
 */
function encodeCursor(sortKey, id) {
  return Buffer.from(JSON.stringify({ sortKey, id })).toString('base64');
}

/**
 * Decode a cursor token. Returns null on any parsing error.
 *
 * @param {string} cursor
 * @returns {{ sortKey: string, id: string } | null}
 */
function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Apply cursor-based pagination to a pre-sorted array of items.
 *
 * @param {object[]} items      - Pre-sorted array; each item must have an `id` field.
 * @param {number}   limit      - Page size (1–200).
 * @param {string|undefined} cursor - Opaque cursor from previous response.
 * @param {function} getSortKey - Extracts the primary sort key from an item.
 * @returns {{ items: object[], nextCursor: string|null }}
 */
function paginateResults(items, limit, cursor, getSortKey) {
  let startIdx = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      const idx = items.findIndex(item => item.id === decoded.id);
      if (idx !== -1) startIdx = idx + 1;
    }
  }
  const page = items.slice(startIdx, startIdx + limit);
  let nextCursor = null;
  if (startIdx + limit < items.length && page.length > 0) {
    const last = page[page.length - 1];
    nextCursor = encodeCursor(getSortKey(last), last.id);
  }
  return { items: page, nextCursor };
}

/**
 * Parse and clamp the limit query parameter.
 *
 * @param {string|undefined} limitStr
 * @returns {number}
 */
function parseLimit(limitStr) {
  const n = parseInt(limitStr, 10);
  if (isNaN(n) || n < 1) return 50;
  return Math.min(n, 200);
}

module.exports = {
  tokenise,
  fulltextMatch,
  keywordPrefixMatch,
  keywordExactMatch,
  parseRange,
  matchesRange,
  encodeCursor,
  decodeCursor,
  paginateResults,
  parseLimit,
};
