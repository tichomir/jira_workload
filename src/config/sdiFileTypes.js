'use strict';

/**
 * Sprint 5 — SDI Teaser: Supported File Types
 *
 * Maps all 13 supported file extensions to their assigned extractor strategy key.
 * Consumed by the File Enumerator (extension filtering) and File Extractor
 * (strategy dispatch).
 *
 * Extractor strategy keys:
 *   TEXT_JSON        — Parse as JSON; walk all string leaf values recursively.
 *   TEXT_XML         — Strip XML/HTML tags; extract text content and attribute values.
 *   TEXT_CSV         — Read raw; split on commas/newlines; scan each cell token.
 *   TEXT_TSV         — Read raw; split on tabs/newlines; scan each cell token.
 *   TEXT_PLAIN       — Read raw as UTF-8 plain text; no transformation.
 *   TEXT_MARKDOWN    — Read raw; optionally strip Markdown syntax; code fences included.
 *   TEXT_YAML        — Parse YAML; extract all scalar string values; fall back to raw on error.
 *   TEXT_ENV         — Read raw; scan KEY=VALUE pairs; strip # comments before scanning.
 *   TEXT_PROPERTIES  — Read raw; scan values from key=value / key: value lines.
 *   TEXT_TOML        — Parse TOML; extract string scalar values; fall back to raw on error.
 *   BINARY_PDF       — Extract text via pdf-parse (pdfjs-dist); 50 MB size limit.
 *   BINARY_DOCX      — Extract text from OOXML ZIP (word/document.xml, word/comments.xml);
 *                      50 MB size limit.
 */

/**
 * Extractor strategy key constants.
 * Decoupled from SdiFileType to allow multiple extensions to share a strategy
 * (e.g. .yaml and .yml both use TEXT_YAML).
 */
const SDI_EXTRACTOR_STRATEGY = Object.freeze({
  TEXT_JSON: 'TEXT_JSON',
  TEXT_XML: 'TEXT_XML',
  TEXT_CSV: 'TEXT_CSV',
  TEXT_TSV: 'TEXT_TSV',
  TEXT_PLAIN: 'TEXT_PLAIN',
  TEXT_MARKDOWN: 'TEXT_MARKDOWN',
  TEXT_YAML: 'TEXT_YAML',
  TEXT_ENV: 'TEXT_ENV',
  TEXT_PROPERTIES: 'TEXT_PROPERTIES',
  TEXT_TOML: 'TEXT_TOML',
  BINARY_PDF: 'BINARY_PDF',
  BINARY_DOCX: 'BINARY_DOCX',
});

/**
 * All 13 supported file extensions mapped to their extractor strategy key.
 * Keys are the canonical dot-prefixed extension strings (lower-case).
 *
 * @type {Record<string, string>}
 */
const SDI_FILE_TYPE_EXTRACTOR_MAP = Object.freeze({
  '.json':       SDI_EXTRACTOR_STRATEGY.TEXT_JSON,
  '.xml':        SDI_EXTRACTOR_STRATEGY.TEXT_XML,
  '.csv':        SDI_EXTRACTOR_STRATEGY.TEXT_CSV,
  '.tsv':        SDI_EXTRACTOR_STRATEGY.TEXT_TSV,
  '.pdf':        SDI_EXTRACTOR_STRATEGY.BINARY_PDF,
  '.docx':       SDI_EXTRACTOR_STRATEGY.BINARY_DOCX,
  '.txt':        SDI_EXTRACTOR_STRATEGY.TEXT_PLAIN,
  '.md':         SDI_EXTRACTOR_STRATEGY.TEXT_MARKDOWN,
  '.yaml':       SDI_EXTRACTOR_STRATEGY.TEXT_YAML,
  '.yml':        SDI_EXTRACTOR_STRATEGY.TEXT_YAML,
  '.env':        SDI_EXTRACTOR_STRATEGY.TEXT_ENV,
  '.properties': SDI_EXTRACTOR_STRATEGY.TEXT_PROPERTIES,
  '.toml':       SDI_EXTRACTOR_STRATEGY.TEXT_TOML,
});

/**
 * Set of file extensions that use binary extraction (size-limited, non-blocking on error).
 * Used by the File Extractor to apply the 50 MB cap and SDI_FILE_TOO_LARGE guard.
 */
const SDI_BINARY_EXTENSIONS = Object.freeze(
  new Set(
    Object.entries(SDI_FILE_TYPE_EXTRACTOR_MAP)
      .filter(([, strategy]) =>
        strategy === SDI_EXTRACTOR_STRATEGY.BINARY_PDF ||
        strategy === SDI_EXTRACTOR_STRATEGY.BINARY_DOCX
      )
      .map(([ext]) => ext)
  )
);

/**
 * Set of file extensions where Pattern C (high-entropy standalone token) is applied.
 * Restricted to config-like file types to limit false positives (ADR-SDI-001).
 */
const SDI_PATTERN_C_EXTENSIONS = Object.freeze(
  new Set(['.env', '.properties', '.toml'])
);

module.exports = {
  SDI_EXTRACTOR_STRATEGY,
  SDI_FILE_TYPE_EXTRACTOR_MAP,
  SDI_BINARY_EXTENSIONS,
  SDI_PATTERN_C_EXTENSIONS,
};
