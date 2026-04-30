'use strict';

/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0 S256 challenge.
 * code_verifier: 43–128 char Base64URL-encoded random string (no padding)
 * code_challenge: SHA-256(code_verifier), Base64URL-encoded (no padding)
 */

const crypto = require('crypto');

/**
 * Generate a cryptographically random PKCE code verifier.
 * Produces a Base64URL string (no padding), length 43–128 chars.
 * We use 32 random bytes → 43 Base64URL chars (within spec).
 * @returns {string}
 */
function generateCodeVerifier() {
  // 32 bytes → 43 Base64URL chars (no padding)
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Derive the S256 code challenge from a code verifier.
 * @param {string} codeVerifier
 * @returns {string} Base64URL-encoded SHA-256 hash (no padding)
 */
function generateCodeChallenge(codeVerifier) {
  return crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
}

module.exports = { generateCodeVerifier, generateCodeChallenge };
