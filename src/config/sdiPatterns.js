'use strict';

/**
 * Sprint 5 — SDI Teaser: Detection Pattern Registry
 *
 * Compiled regex patterns for the four sensitive data element types.
 * Each entry has:
 *   - label       {string}   Human-readable data element type name.
 *   - patterns    {RegExp[]} One or more compiled patterns applied as a union.
 *                            Patterns are applied per-chunk by the Pattern Scanner.
 *   - notes       {string}   Post-match filter reminders (enforced by scanner, not here).
 *
 * Design constraints (ADR-SDI-001):
 *   - Raw matched strings are NEVER stored or returned — only match counts.
 *   - Post-match filters (Luhn, entropy check, placeholder allowlist) are the
 *     responsibility of the Pattern Scanner; they are NOT encoded as regex here.
 *   - Pattern C for CREDENTIAL_API_KEY is restricted to .env/.properties/.toml file
 *     types by the scanner, not by the regex itself.
 */

// ---------------------------------------------------------------------------
// EMAIL ADDRESS
// ---------------------------------------------------------------------------

/**
 * Email Address pattern.
 *
 * Primary pattern: RFC-5321-compatible local-part @ domain.
 * Post-match filter (scanner): strip placeholder allowlist entries
 *   (e.g. user@example.com, test@test.com, noreply@github.com).
 */
const EMAIL = Object.freeze({
  label: 'Email Address',
  patterns: [
    /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  ],
  notes: 'Scanner must apply placeholder allowlist filter after matching.',
});

// ---------------------------------------------------------------------------
// CREDENTIAL / API KEY
// ---------------------------------------------------------------------------

/**
 * Credential / API Key patterns — three sub-patterns applied as a union.
 *
 * Pattern A — Key/secret assignment context (case-insensitive).
 *   Captures the value portion; only the count of captures is recorded.
 *   Post-match filter: skip if value matches placeholder patterns
 *   (changeme, your.*key, replace.*me, <...>, ${...}, {{...}}).
 *
 * Pattern B — AWS Access Key ID.
 *   Fixed-format AKIA-prefixed 20-character string.
 *
 * Pattern C — Generic high-entropy Base64/hex token (standalone line).
 *   Applied ONLY to .env, .properties, .toml file types (scanner enforcement).
 *   Post-match filter: require Shannon entropy > 4.5 bits/char.
 */
const CREDENTIAL_API_KEY = Object.freeze({
  label: 'Credential / API Key',
  patterns: [
    // Pattern A — assignment context
    /(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token|auth[_\-]?token|client[_\-]?secret|private[_\-]?key|password|passwd|pwd|bearer|authorization)\s*[:=]\s*['"]?([A-Za-z0-9+/\-_.]{20,})['"]?/gi,
    // Pattern B — AWS Access Key ID
    /\bAKIA[0-9A-Z]{16}\b/g,
    // Pattern C — standalone high-entropy token (env/properties/toml only)
    /^\s*[A-Za-z0-9+/]{40,}={0,2}\s*$/gm,
  ],
  notes:
    'Pattern A: apply placeholder allowlist (changeme, your.*key, etc.). ' +
    'Pattern C: apply Shannon entropy check (threshold: SDI_MIN_CREDENTIAL_ENTROPY). ' +
    'Pattern C: scanner must restrict to .env/.properties/.toml file types only.',
});

// ---------------------------------------------------------------------------
// CREDIT CARD NUMBER (PAN)
// ---------------------------------------------------------------------------

/**
 * Credit Card Number / PAN patterns — two sub-patterns applied as a union.
 *
 * Pattern A — Raw digits for major card types (Visa, Mastercard, Amex, Discover, JCB).
 * Pattern B — Space/hyphen-formatted 16-digit groups.
 *
 * Post-match filter (scanner): Luhn algorithm check.
 *   All candidates failing Luhn are discarded; not counted as findings.
 */
const CREDIT_CARD_PAN = Object.freeze({
  label: 'Credit Card Number (PAN)',
  patterns: [
    // Pattern A — raw digit blocks by card type
    /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|2(?:2[2-9][1-9]|[3-6]\d\d|7(?:[01]\d|20))\d{12}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
    // Pattern B — space/hyphen formatted
    /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,
  ],
  notes: 'Scanner must apply Luhn algorithm check; discard non-Luhn candidates.',
});

// ---------------------------------------------------------------------------
// PHONE NUMBER
// ---------------------------------------------------------------------------

/**
 * Phone Number patterns — three sub-patterns applied as a union.
 *
 * Pattern A — E.164 international format.
 * Pattern B — North American Numbering Plan (NANP).
 * Pattern C — UK landline / mobile.
 *
 * Post-match filters (scanner):
 *   - Minimum 7 significant digits (SDI_MIN_PHONE_DIGITS).
 *   - Exclude pure numeric sequences in semver/version/date/ID contexts
 *     (e.g. preceded by v, ver, version, #, id=, or surrounded by . on both sides).
 */
const PHONE_NUMBER = Object.freeze({
  label: 'Phone Number',
  patterns: [
    // Pattern A — E.164 international
    /\+[1-9]\d{6,14}\b/g,
    // Pattern B — NANP (North American)
    /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}\b/g,
    // Pattern C — UK landline / mobile
    /\b(?:\+44\s?|0)(?:7\d{3}|\d{2,4})\s?\d{3,4}\s?\d{3,4}\b/g,
  ],
  notes:
    'Scanner must enforce SDI_MIN_PHONE_DIGITS minimum digit count and apply ' +
    'context exclusion heuristics (semver, version, id= prefixes).',
});

// ---------------------------------------------------------------------------
// Registry export
// ---------------------------------------------------------------------------

/**
 * Canonical detection pattern registry.
 * Keyed by SdiDataElementType value for direct lookup by the Pattern Scanner.
 */
const SDI_PATTERN_REGISTRY = Object.freeze({
  EMAIL,
  CREDENTIAL_API_KEY,
  CREDIT_CARD_PAN,
  PHONE_NUMBER,
});

module.exports = {
  SDI_PATTERN_REGISTRY,
  EMAIL,
  CREDENTIAL_API_KEY,
  CREDIT_CARD_PAN,
  PHONE_NUMBER,
};
