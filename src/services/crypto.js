'use strict';

/**
 * AES-256-GCM encryption for OAuth tokens and credentials.
 * Storage format: base64(salt) + "." + base64(iv) + "." + base64(ciphertext + authTag)
 * Master key sourced from OAUTH_TOKEN_ENCRYPTION_KEY env var (32-byte hex string).
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes
const SALT_LENGTH = 16; // bytes
const IV_LENGTH = 12;   // bytes (96 bits, recommended for GCM)
const AUTH_TAG_LENGTH = 16; // bytes

function getMasterKey() {
  const hexKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!hexKey) {
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY environment variable is not set');
  }
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`OAUTH_TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars), got ${key.length} bytes`);
  }
  return key;
}

/**
 * Derive a per-token key using HKDF-SHA256 with a random salt.
 */
function deriveKey(masterKey, salt) {
  return crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('oauth-token'), KEY_LENGTH);
}

/**
 * Encrypt plaintext string.
 * @param {string} plaintext
 * @returns {string} Encrypted token in format: base64(salt).base64(iv).base64(ciphertext+authTag)
 */
function encrypt(plaintext) {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty value');
  }

  const masterKey = getMasterKey();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const derivedKey = deriveKey(masterKey, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const ciphertextWithTag = Buffer.concat([encrypted, authTag]);

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    ciphertextWithTag.toString('base64'),
  ].join('.');
}

/**
 * Decrypt an encrypted token string.
 * @param {string} encryptedValue
 * @returns {string} Plaintext
 */
function decrypt(encryptedValue) {
  if (!encryptedValue) {
    throw new Error('Cannot decrypt empty value');
  }

  const parts = encryptedValue.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const masterKey = getMasterKey();
  const salt = Buffer.from(parts[0], 'base64');
  const iv = Buffer.from(parts[1], 'base64');
  const ciphertextWithTag = Buffer.from(parts[2], 'base64');

  const ciphertext = ciphertextWithTag.slice(0, -AUTH_TAG_LENGTH);
  const authTag = ciphertextWithTag.slice(-AUTH_TAG_LENGTH);

  const derivedKey = deriveKey(masterKey, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
