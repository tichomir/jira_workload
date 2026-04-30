'use strict';

/**
 * Sprint 5 — SDI Teaser: Pattern Scanner
 *
 * Runs detection regexes against extracted text and emits match counts.
 *
 * Design constraints (ADR-SDI-001, ADR-SDI-002):
 *   - Raw matched strings are NEVER returned or stored — only counts.
 *   - Post-match filters (Luhn, entropy, placeholder allowlist) are applied here.
 *   - Pattern C for CREDENTIAL is restricted to .env/.properties/.toml by this module.
 */

const { SDI_PATTERN_REGISTRY } = require('../config/sdiPatterns');
const { SDI_PATTERN_C_EXTENSIONS } = require('../config/sdiFileTypes');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SDI_MIN_CREDENTIAL_ENTROPY = 4.5;
const SDI_MIN_PHONE_DIGITS = 7;

// ---------------------------------------------------------------------------
// Post-match filter helpers
// ---------------------------------------------------------------------------

/** Email placeholder allowlist — well-known dummy addresses. */
const EMAIL_PLACEHOLDER_SET = new Set([
  'user@example.com',
  'test@test.com',
  'foo@bar.com',
  'admin@example.com',
  'info@example.com',
  'support@example.com',
  'no-reply@example.com',
  'noreply@example.com',
  'email@example.com',
  'name@example.com',
  'noreply@github.com',
  'notifications@github.com',
]);

/** Email domains that indicate placeholders. */
const EMAIL_PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'example.net', 'test.com', 'localhost'];

/** Credential placeholder patterns. */
const CREDENTIAL_PLACEHOLDER_PATTERNS = [
  /^changeme$/i,
  /your[_\-]?(api[_\-]?)?key/i,
  /replace[_\-]?me/i,
  /^<[^>]+>$/,           // <placeholder>
  /^\$\{[^}]+\}$/,       // ${ENV_VAR}
  /^\{\{[^}]+\}\}$/,     // {{template}}
  /^[*x]{3,}$/i,         // *** or xxx (masked)
  /^(todo|fixme|tbd|null|none|undefined|empty)$/i,
];

/**
 * Compute Shannon entropy (bits/char) for a string.
 * Used for Pattern C high-entropy token check.
 * @param {string} str
 * @returns {number}
 */
function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  const len = str.length;
  let h = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Luhn algorithm validity check for a PAN candidate.
 * @param {string} raw - Raw match string (may contain spaces/hyphens)
 * @returns {boolean}
 */
function luhnCheck(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleIt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (doubleIt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

/**
 * Count significant (non-formatting) digits in a phone match.
 * @param {string} raw
 * @returns {number}
 */
function countSignificantPhoneDigits(raw) {
  return raw.replace(/\D/g, '').length;
}

/**
 * Heuristic: return true if the phone match appears in a version/ID context
 * that makes it a false positive.
 * @param {string} text     - Full extracted text
 * @param {number} idx      - Match start index
 * @param {string} matchStr
 * @returns {boolean}
 */
function isVersionContext(text, idx, matchStr) {
  const before = text.slice(Math.max(0, idx - 15), idx);
  const after  = text.slice(idx + matchStr.length, idx + matchStr.length + 5);
  // Version prefix: v1.2, ver 3, version
  if (/(?:v|ver(?:sion)?)\s*\d*\s*$/i.test(before)) return true;
  // ID context
  if (/(?:id|#)\s*=?\s*$/i.test(before)) return true;
  // Surrounded by dots on both sides (dotted notation like 1.2.3.4.5)
  if (/\.\s*$/.test(before) && /^\s*\./.test(after)) return true;
  return false;
}

/**
 * Determine whether an email address is a placeholder/dummy.
 * @param {string} email - Lowercased email string
 * @returns {boolean}
 */
function isEmailPlaceholder(email) {
  if (EMAIL_PLACEHOLDER_SET.has(email)) return true;
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 0) return false;
  const domain = email.slice(atIdx + 1);
  return EMAIL_PLACEHOLDER_DOMAINS.includes(domain);
}

/**
 * Determine whether a credential value is a placeholder.
 * @param {string} value
 * @returns {boolean}
 */
function isCredentialPlaceholder(value) {
  const trimmed = value.trim();
  return CREDENTIAL_PLACEHOLDER_PATTERNS.some(p => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Data element type constants (SdiDataElementType values used in API)
// ---------------------------------------------------------------------------

const DE_EMAIL      = 'EMAIL';
const DE_CREDENTIAL = 'CREDENTIAL';
const DE_CREDIT_CARD = 'CREDIT_CARD';
const DE_PHONE      = 'PHONE';

// Pattern registry keys map to SdiDataElementType values
const REGISTRY_KEY_TO_DE_TYPE = {
  EMAIL:            DE_EMAIL,
  CREDENTIAL_API_KEY: DE_CREDENTIAL,
  CREDIT_CARD_PAN:  DE_CREDIT_CARD,
  PHONE_NUMBER:     DE_PHONE,
};

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan extracted text for a specific pattern registry entry.
 * Returns match count only; no raw strings.
 *
 * @param {string} text         - Extracted text
 * @param {string} registryKey  - Key in SDI_PATTERN_REGISTRY (e.g. 'EMAIL')
 * @param {string} ext          - Dot-prefixed extension (e.g. '.json') for Pattern C guard
 * @returns {number}
 */
function scanPatternEntry(text, registryKey, ext) {
  const config = SDI_PATTERN_REGISTRY[registryKey];
  if (!config || !text) return 0;

  let count = 0;
  const patternCSource = (registryKey === 'CREDENTIAL_API_KEY')
    ? SDI_PATTERN_REGISTRY.CREDENTIAL_API_KEY.patterns[2].source
    : null;

  for (const srcPattern of config.patterns) {
    // Pattern C restriction: only .env/.properties/.toml
    if (patternCSource && srcPattern.source === patternCSource) {
      if (!SDI_PATTERN_C_EXTENSIONS.has(ext.toLowerCase())) {
        continue;
      }
    }

    // Clone pattern with reset lastIndex (global patterns are stateful)
    const pattern = new RegExp(srcPattern.source, srcPattern.flags);

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const matchStr = match[0];

      if (registryKey === 'EMAIL') {
        if (isEmailPlaceholder(matchStr.toLowerCase())) continue;
        count++;

      } else if (registryKey === 'CREDENTIAL_API_KEY') {
        // Pattern A captures value in group 1; Patterns B/C use full match
        const value = match[1] != null ? match[1] : matchStr;
        if (isCredentialPlaceholder(value)) continue;
        // Pattern C: entropy check
        if (patternCSource && srcPattern.source === patternCSource) {
          if (shannonEntropy(value.trim()) < SDI_MIN_CREDENTIAL_ENTROPY) continue;
        }
        count++;

      } else if (registryKey === 'CREDIT_CARD_PAN') {
        if (!luhnCheck(matchStr)) continue;
        count++;

      } else if (registryKey === 'PHONE_NUMBER') {
        if (countSignificantPhoneDigits(matchStr) < SDI_MIN_PHONE_DIGITS) continue;
        if (isVersionContext(text, match.index, matchStr)) continue;
        count++;
      }

      // Guard against zero-length match infinite loops
      if (match[0].length === 0) {
        pattern.lastIndex++;
      }
    }
  }

  return count;
}

/**
 * Scan text for all four data element types.
 * Returns a map of SdiDataElementType → matchCount (0 entries omitted).
 *
 * @param {string} text - Extracted text content
 * @param {string} ext  - Dot-prefixed extension
 * @returns {Object.<string, number>} e.g. { EMAIL: 3, CREDIT_CARD: 1 }
 */
function scanText(text, ext) {
  const results = {};
  for (const [registryKey, deType] of Object.entries(REGISTRY_KEY_TO_DE_TYPE)) {
    const cnt = scanPatternEntry(text, registryKey, ext);
    if (cnt > 0) {
      results[deType] = cnt;
    }
  }
  return results;
}

module.exports = {
  scanText,
  scanPatternEntry,
  // Helpers exported for unit tests
  shannonEntropy,
  luhnCheck,
  isEmailPlaceholder,
  isCredentialPlaceholder,
  countSignificantPhoneDigits,
  isVersionContext,
  REGISTRY_KEY_TO_DE_TYPE,
};
