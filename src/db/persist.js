'use strict';

/**
 * persist.js — File-based persistence for the in-memory database.
 *
 * All Maps in db/index.js are serialised to $DATA_DIR/db.json on save and
 * deserialised back on load.  An atomic write (write-then-rename) prevents a
 * partial file on crash.
 *
 * DATA_DIR resolution order:
 *   1. DATA_DIR environment variable (explicit)
 *   2. ~/.dcc-jira   (local development default)
 *   3. /data          (container default when DATA_DIR=/data is set via compose)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDataDir() {
  return process.env.DATA_DIR || path.join(os.homedir(), '.dcc-jira');
}

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function dbPath() {
  return path.join(getDataDir(), 'db.json');
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Populate Maps in `db` from the persisted db.json file.
 * Safe to call when the file does not yet exist (first run).
 *
 * @param {Object} db - Object whose values are Maps (from db/index.js exports).
 */
function loadDb(db) {
  const filePath = dbPath();
  if (!fs.existsSync(filePath)) {
    process.stdout.write(
      `[persist] No db.json found at ${filePath} — starting with empty store\n`
    );
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[persist] Cannot read db.json: ${err.message}\n`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[persist] db.json is not valid JSON: ${err.message}\n`);
    return;
  }

  let loaded = 0;
  let total  = 0;
  for (const [key, entries] of Object.entries(parsed)) {
    if (!(db[key] instanceof Map)) continue;
    if (!Array.isArray(entries)) continue;
    for (const [k, v] of entries) {
      db[key].set(k, v);
      total++;
    }
    loaded++;
  }

  process.stdout.write(
    `[persist] Loaded db.json — ${loaded} collections, ${total} records\n`
  );
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Serialise all Maps in `db` to $DATA_DIR/db.json using an atomic
 * write-then-rename to prevent partial files on crash.
 *
 * @param {Object} db - Object whose values are Maps (from db/index.js exports).
 */
function saveDb(db) {
  let dir;
  try {
    dir = ensureDataDir();
  } catch (err) {
    process.stderr.write(`[persist] Cannot create DATA_DIR: ${err.message}\n`);
    return;
  }

  const serialised = {};
  for (const [key, value] of Object.entries(db)) {
    if (value instanceof Map) {
      serialised[key] = Array.from(value.entries());
    }
  }

  const tmpPath  = path.join(dir, 'db.json.tmp');
  const destPath = path.join(dir, 'db.json');

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(serialised, null, 2), 'utf8');
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    process.stderr.write(`[persist] Failed to save db.json: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { loadDb, saveDb, getDataDir };
