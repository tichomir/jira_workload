/**
 * Sensitive Data Intelligence (SDI) Teaser — Shared Types
 * Sprint 5 | 2026-04-30
 *
 * These types are consumed by both the backend scan engine and the frontend
 * SDI teaser results UI.
 *
 * Design constraints (see ADR-SDI-002):
 *   - Raw matched strings are NEVER stored or returned. Only match counts.
 *   - HIPAA is explicitly absent from SdiRegulationId (see ADR rationale).
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** All supported file extension categories for SDI scanning. */
export type SdiFileType =
  | 'json'
  | 'xml'
  | 'csv'
  | 'tsv'
  | 'pdf'
  | 'docx'
  | 'txt'
  | 'md'
  | 'yaml'
  | 'yml'
  | 'env'
  | 'properties'
  | 'toml';

/** Canonical set of file extensions mapped to SdiFileType (for normalisation). */
export const SDI_SUPPORTED_EXTENSIONS: Record<string, SdiFileType> = {
  '.json': 'json',
  '.xml': 'xml',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'txt',
  '.md': 'md',
  '.yaml': 'yaml',
  '.yml': 'yml',
  '.env': 'env',
  '.properties': 'properties',
  '.toml': 'toml',
} as const;

/** The four sensitive data element categories the SDI teaser detects. */
export type SdiDataElementType = 'EMAIL' | 'CREDENTIAL' | 'CREDIT_CARD' | 'PHONE';

/**
 * Regulations surfaced by the SDI module.
 * HIPAA is intentionally absent — health/medical identifiers are not in scope
 * for the teaser's four data element types. Including HIPAA without a matching
 * detection capability would constitute a false positive at the regulation level.
 */
export type SdiRegulationId = 'GDPR' | 'CCPA' | 'PCI_DSS' | 'DORA' | 'NIS2' | 'SOC2';

/**
 * Display status for a regulation in the SDI results UI.
 * - `active`  — Regulation is directly implicated by a detected data element type.
 *               Rendered with high-visibility badge (orange/red).
 * - `shown`   — Regulation is contextually relevant but not directly triggered.
 *               Rendered with muted badge (grey). Awareness context only.
 */
export type SdiRegulationDisplayStatus = 'active' | 'shown';

/** SDI scan lifecycle states. */
export type SdiScanStatus = 'pending' | 'running' | 'complete' | 'failed' | 'superseded';

// ---------------------------------------------------------------------------
// Internal scan types (never persisted)
// ---------------------------------------------------------------------------

/**
 * In-memory per-file scan hit produced by the Pattern Scanner.
 * Rolled up into SdiFindingSummary before persistence.
 * Raw matched strings are NEVER present on this record.
 */
export interface SdiScanHit {
  /** Relative path within the backup point or attachment ID. */
  fileRef: string;
  fileType: SdiFileType;
  dataElementType: SdiDataElementType;
  /** Number of pattern matches found in this file. Always ≥ 1. */
  matchCount: number;
}

// ---------------------------------------------------------------------------
// Persisted / API-exposed types
// ---------------------------------------------------------------------------

/**
 * Aggregated finding summary: one record per (dataElementType × fileType)
 * dimension within a scan result.
 *
 * This is the unit of persistence and API response. Per-file detail is
 * intentionally discarded after aggregation (see ADR-SDI-003).
 */
export interface SdiFindingSummary {
  dataElementType: SdiDataElementType;
  fileType: SdiFileType;
  /** Sum of pattern match counts across all files in this dimension. */
  matchCount: number;
  /** Number of distinct files that contributed at least one match. */
  fileCount: number;
}

/**
 * Regulation entry within a scan result.
 * Drives the regulation badge display in the SDI teaser UI.
 */
export interface SdiRegulationEntry {
  regulation: SdiRegulationId;
  displayStatus: SdiRegulationDisplayStatus;
  /**
   * Data element types that triggered Active status for this regulation.
   * Empty array for regulations with displayStatus='shown'.
   */
  triggerDataElements: SdiDataElementType[];
}

/**
 * Top-level SDI scan result keyed by backupPointId.
 *
 * Storage contract (ADR-SDI-003):
 *   - One SdiScanResult per (backupPointId, scan run).
 *   - On re-scan: previous result marked status='superseded'; new result is 'complete'.
 *   - Retained until parent BackupPoint is purged.
 *   - Excluded from purge cascade (same rationale as JiraWorkflowNode).
 */
export interface SdiScanResult {
  /** UUID — unique scan run identifier. */
  id: string;
  /** FK → BackupPoint.id */
  backupPointId: string;
  /** FK → OAuthConnection.id */
  integrationId: string;
  /** Jira site cloud ID for display context. */
  cloudId: string;

  status: SdiScanStatus;
  /** ISO-8601 timestamp when the scan was enqueued. */
  startedAt: string;
  /** ISO-8601 timestamp when the scan completed. Null while pending/running. */
  completedAt: string | null;
  /** Human-readable error description. Set only when status='failed'. */
  errorMessage: string | null;

  /** Number of files successfully extracted and scanned. */
  totalFilesScanned: number;
  /** Number of files skipped due to extraction error or size limit. */
  totalFilesSkipped: number;
  /** Sum of all matchCounts across all SdiFindingSummary records. */
  totalMatchCount: number;

  /**
   * Aggregated findings grouped by (dataElementType × fileType).
   * Empty array when no matches were found.
   */
  findings: SdiFindingSummary[];

  /**
   * Regulation surface computed from findings.
   * Empty array when findings is empty.
   * HIPAA is never present in this array.
   */
  regulationMap: SdiRegulationEntry[];
}

// ---------------------------------------------------------------------------
// API request / response shapes
// ---------------------------------------------------------------------------

/** POST /api/v1/sdi/scan/:backupPointId/trigger — 202 Accepted */
export interface SdiScanTriggerResponse {
  scanId: string;
  backupPointId: string;
  status: 'pending';
  message: string;
}

/** GET /api/v1/sdi/scan/:backupPointId — 200 OK */
export interface SdiScanResultResponse {
  scan: SdiScanResult;
}

/** GET /api/v1/sdi/scans?integrationId=:id — list item shape */
export interface SdiScanListItem {
  id: string;
  backupPointId: string;
  status: SdiScanStatus;
  startedAt: string;
  completedAt: string | null;
  totalMatchCount: number;
}

/** GET /api/v1/sdi/scans?integrationId=:id — 200 OK */
export interface SdiScanListResponse {
  scans: SdiScanListItem[];
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type SdiErrorCode =
  | 'SDI_SCAN_NOT_FOUND'
  | 'SDI_SCAN_ALREADY_RUNNING'
  | 'SDI_EXTRACTION_WARN'
  | 'SDI_FILE_TOO_LARGE'
  | 'BACKUP_POINT_NOT_FOUND';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size (bytes) the File Extractor will attempt to process. */
export const SDI_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Maximum duration (ms) allowed for a single backup-point scan job. */
export const SDI_SCAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Number of files processed concurrently within a single scan job. */
export const SDI_SCAN_PARALLELISM = 4;

/**
 * Minimum Shannon entropy (bits/char) required for a high-entropy
 * credential candidate (Pattern C) to be counted as a finding.
 */
export const SDI_MIN_CREDENTIAL_ENTROPY = 4.5;

/**
 * Minimum number of significant digits (excluding country code and
 * formatting characters) required for a phone number candidate to be counted.
 */
export const SDI_MIN_PHONE_DIGITS = 7;
