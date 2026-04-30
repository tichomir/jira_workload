'use strict';

/**
 * Sprint 5 — SDI Teaser: File Content Extractors
 *
 * Extractor functions for all 13 supported file types.
 * Each extractor returns plain UTF-8 text suitable for pattern scanning.
 * Binary extractors (.pdf, .docx) are async; all others are sync.
 */

const { SDI_FILE_TYPE_EXTRACTOR_MAP, SDI_BINARY_EXTENSIONS, SDI_EXTRACTOR_STRATEGY } = require('../config/sdiFileTypes');

const SDI_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Text-native extractors (synchronous)
// ---------------------------------------------------------------------------

/**
 * JSON extractor — walks all string leaf values recursively.
 * Concatenates strings with newline delimiters for pattern scanning.
 */
function extractJson(content) {
  try {
    const obj = JSON.parse(content);
    return collectJsonStrings(obj).join('\n');
  } catch {
    return content; // fallback: raw text
  }
}

function collectJsonStrings(node) {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) {
    const acc = [];
    for (const item of node) acc.push(...collectJsonStrings(item));
    return acc;
  }
  if (node !== null && typeof node === 'object') {
    const acc = [];
    for (const val of Object.values(node)) acc.push(...collectJsonStrings(val));
    return acc;
  }
  if (node !== null && node !== undefined) return [String(node)];
  return [];
}

/**
 * XML extractor — strips tags; retains text content and attribute values.
 */
function extractXml(content) {
  // Extract attribute values (quoted strings)
  const attrValues = [];
  const attrRe = /\w+\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(content)) !== null) {
    attrValues.push(m[1]);
  }
  // Strip all tags; collapse whitespace
  const textContent = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return attrValues.join('\n') + '\n' + textContent;
}

/**
 * CSV extractor — raw content; commas/newlines are natural delimiters.
 */
function extractCsv(content) {
  return content;
}

/**
 * TSV extractor — raw content; tabs/newlines are natural delimiters.
 */
function extractTsv(content) {
  return content;
}

/**
 * Plain text extractor — read raw as UTF-8.
 */
function extractPlain(content) {
  return content;
}

/**
 * Markdown extractor — raw content including code fences.
 */
function extractMarkdown(content) {
  return content;
}

/**
 * YAML extractor — raw content (no parser dependency required;
 * plain regex scanning handles quoted/unquoted scalar values).
 */
function extractYaml(content) {
  return content;
}

/**
 * .env extractor — strips comment lines before returning content.
 */
function extractEnv(content) {
  return content
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * .properties extractor — strips comment lines (# and !) before returning content.
 */
function extractProperties(content) {
  return content
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('#') && !t.startsWith('!');
    })
    .join('\n');
}

/**
 * TOML extractor — raw content.
 */
function extractToml(content) {
  return content;
}

// ---------------------------------------------------------------------------
// Binary extractors (asynchronous)
// ---------------------------------------------------------------------------

/**
 * PDF extractor — uses pdf-parse (dynamic require for graceful fallback).
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractPdf(buffer) {
  let pdfParse;
  try {
    // eslint-disable-next-line global-require
    pdfParse = require('pdf-parse');
  } catch {
    const err = new Error('pdf-parse is not installed; PDF extraction unavailable');
    err.code = 'SDI_EXTRACTION_WARN';
    throw err;
  }
  try {
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (innerErr) {
    const err = new Error(`PDF extraction failed: ${innerErr.message}`);
    err.code = 'SDI_EXTRACTION_WARN';
    throw err;
  }
}

/**
 * DOCX extractor — uses mammoth (dynamic require for graceful fallback).
 * Extracts text from word/document.xml and word/comments.xml via mammoth.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractDocx(buffer) {
  let mammoth;
  try {
    // eslint-disable-next-line global-require
    mammoth = require('mammoth');
  } catch {
    const err = new Error('mammoth is not installed; DOCX extraction unavailable');
    err.code = 'SDI_EXTRACTION_WARN';
    throw err;
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch (innerErr) {
    const err = new Error(`DOCX extraction failed: ${innerErr.message}`);
    err.code = 'SDI_EXTRACTION_WARN';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Strategy dispatch table
// ---------------------------------------------------------------------------

const SYNC_EXTRACTORS = {
  [SDI_EXTRACTOR_STRATEGY.TEXT_JSON]:       extractJson,
  [SDI_EXTRACTOR_STRATEGY.TEXT_XML]:        extractXml,
  [SDI_EXTRACTOR_STRATEGY.TEXT_CSV]:        extractCsv,
  [SDI_EXTRACTOR_STRATEGY.TEXT_TSV]:        extractTsv,
  [SDI_EXTRACTOR_STRATEGY.TEXT_PLAIN]:      extractPlain,
  [SDI_EXTRACTOR_STRATEGY.TEXT_MARKDOWN]:   extractMarkdown,
  [SDI_EXTRACTOR_STRATEGY.TEXT_YAML]:       extractYaml,
  [SDI_EXTRACTOR_STRATEGY.TEXT_ENV]:        extractEnv,
  [SDI_EXTRACTOR_STRATEGY.TEXT_PROPERTIES]: extractProperties,
  [SDI_EXTRACTOR_STRATEGY.TEXT_TOML]:       extractToml,
};

const ASYNC_EXTRACTORS = {
  [SDI_EXTRACTOR_STRATEGY.BINARY_PDF]:  extractPdf,
  [SDI_EXTRACTOR_STRATEGY.BINARY_DOCX]: extractDocx,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract text from file content using the appropriate strategy for the extension.
 *
 * @param {string}        ext       - Dot-prefixed extension, e.g. '.json'
 * @param {Buffer|string} content   - File content (Buffer for binary, string for text)
 * @param {number}        sizeBytes - File size in bytes (used for binary cap check)
 * @returns {Promise<string>} Plain UTF-8 text ready for pattern scanning
 * @throws {Error} with .code = 'SDI_FILE_TOO_LARGE' if binary exceeds 50 MB
 * @throws {Error} with .code = 'SDI_EXTRACTION_WARN' if extraction fails (non-blocking)
 */
async function extractText(ext, content, sizeBytes) {
  const normalised = ext.toLowerCase();
  const strategy = SDI_FILE_TYPE_EXTRACTOR_MAP[normalised];
  if (!strategy) {
    const err = new Error(`Unsupported file extension: ${ext}`);
    err.code = 'SDI_EXTRACTION_WARN';
    throw err;
  }

  const isBinary = SDI_BINARY_EXTENSIONS.has(normalised);

  if (isBinary) {
    const size = sizeBytes != null ? sizeBytes : (Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content));
    if (size > SDI_MAX_FILE_SIZE_BYTES) {
      const err = new Error(`File size ${size} bytes exceeds 50 MB limit`);
      err.code = 'SDI_FILE_TOO_LARGE';
      throw err;
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return ASYNC_EXTRACTORS[strategy](buf);
  }

  // Text-native: convert buffer to string if needed
  const text = Buffer.isBuffer(content) ? content.toString('utf-8') : content;
  return SYNC_EXTRACTORS[strategy](text);
}

module.exports = {
  extractText,
  // Named exports for unit testing
  extractJson,
  extractXml,
  extractCsv,
  extractTsv,
  extractPlain,
  extractMarkdown,
  extractYaml,
  extractEnv,
  extractProperties,
  extractToml,
  extractPdf,
  extractDocx,
};
