# Sensitive Data Intelligence (SDI) Teaser — Architecture

_Sprint 5 | 2026-04-30 | Author: software_architect_

---

## 1. Overview

The SDI Teaser module scans backed-up Jira data (structured JSON manifests and binary
attachments) for four sensitive data element types and surfaces applicable regulations
alongside per-backup-point findings summaries. It is a **read-only, non-destructive**
layer that operates against the existing backup storage produced by the Sprint 2 backup
engine; it does not modify backup data.

**In scope:** Email Address, Credential/API Key, Credit Card Number (PAN), Phone Number.  
**Out of scope:** Health/medical identifiers (HIPAA excluded by product decision — see §6).

---

## 2. Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          SDI Scan Pipeline                                      │
│                                                                                 │
│  ┌────────────┐    ┌──────────────┐    ┌───────────────┐    ┌───────────────┐  │
│  │  Backup    │    │   File       │    │   Pattern     │    │  Findings     │  │
│  │  Storage   │───▶│  Enumerator  │───▶│   Scanner     │───▶│  Aggregator   │  │
│  │            │    │              │    │               │    │               │  │
│  │ JSON blobs │    │ Walk manifest│    │ Apply 4 regex │    │ Group by      │  │
│  │ Attachments│    │ Filter 13    │    │ pattern sets  │    │ backupPointId │  │
│  └────────────┘    │ file types   │    │ per extracted │    │ × fileType    │  │
│                    └──────┬───────┘    │ text chunk    │    │ × elementType │  │
│                           │            └───────────────┘    └──────┬────────┘  │
│                    ┌──────▼───────┐                                │           │
│                    │   File       │                        ┌───────▼────────┐  │
│                    │  Extractor   │                        │  Regulation    │  │
│                    │              │                        │  Mapper        │  │
│                    │ Text-native: │                        │                │  │
│                    │  direct read │                        │ Tag GDPR/CCPA/ │  │
│                    │ Binary:      │                        │ PCI DSS Active │  │
│                    │  pdf-parse / │                        │ DORA/NIS2/SOC2 │  │
│                    │  OOXML unzip │                        │ Shown          │  │
│                    └──────────────┘                        └──────┬─────────┘  │
└──────────────────────────────────────────────────────────────────┼─────────────┘
                                                                    │
                                                            ┌───────▼────────┐
                                                            │   Results API  │
                                                            │                │
                                                            │ GET /sdi/scan  │
                                                            │ GET /sdi/scan/ │
                                                            │  :backupPointId│
                                                            └────────────────┘
```

### Pipeline Sequence

```mermaid
sequenceDiagram
    participant Trigger as Scan Trigger
    participant Enum as File Enumerator
    participant Extractor as File Extractor
    participant Scanner as Pattern Scanner
    participant Agg as Findings Aggregator
    participant RegMap as Regulation Mapper
    participant Store as Results Store

    Trigger->>Enum: startScan(backupPointId)
    Enum->>Enum: walkManifest(backupPointId)
    Enum->>Enum: filterBySupportedExtension(13 types)
    loop For each eligible file
        Enum->>Extractor: extractText(fileRef, fileType)
        Extractor-->>Scanner: textChunks[]
        Scanner->>Scanner: applyPatterns(textChunks, EMAIL | CRED | PAN | PHONE)
        Scanner-->>Agg: ScanHit[]{ fileRef, fileType, dataElementType, matchCount }
    end
    Agg->>Agg: aggregateByDimensions(backupPointId × fileType × dataElementType)
    Agg->>RegMap: computeRegulationMap(aggregatedFindings)
    RegMap-->>Agg: SdiRegulationEntry[]
    Agg->>Store: persistSdiScanResult(result)
    Store-->>Trigger: SdiScanResult{ status: 'complete', ... }
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **File Enumerator** | Walk the backup point file manifest; return list of `{ fileRef, fileType }` for the 13 supported extensions. No file reads. |
| **File Extractor** | Given a `fileRef` and `fileType`, return an array of plain-text chunks. Handles binary extraction for `.pdf` and `.docx`. Returns empty array on extraction failure (non-blocking). |
| **Pattern Scanner** | Accept text chunks; apply the four pattern sets; return `ScanHit[]` with match counts. Never returns raw matched strings. |
| **Findings Aggregator** | Accumulate `ScanHit[]` across all files in the backup point; group into `SdiFindingSummary[]` dimensions; compute totals. |
| **Regulation Mapper** | Given the set of triggered `dataElementType` values, produce the `SdiRegulationEntry[]` array per the regulation mapping table (§6). |
| **Results Store** | Persist `SdiScanResult` to the backing store; keyed by `(backupPointId, scanTimestamp)`. |
| **Results API** | Expose REST endpoints for scan initiation and results retrieval. |

---

## 3. Detection Patterns

All patterns are applied case-insensitively where specified. The **Pattern Scanner** applies
each set independently to each extracted text chunk. Raw matched strings are **never** stored,
logged, or returned via API — only match counts are recorded (see ADR-SDI-002).

### 3.1 Email Address

**Pattern (primary):**
```
\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b
```

**Constraints / false-positive filters:**
- Minimum 2-char TLD, maximum 63-char local part.
- Exclude well-known placeholder values: `user@example.com`, `test@test.com`,
  `noreply@github.com` (configurable allowlist, default 12 entries).

| # | Input | Expected | Note |
|---|-------|----------|------|
| + | `contact: alice@acme.co.uk` | MATCH | Valid RFC-5321 address |
| + | `admin+ops@internal.example.org` | MATCH | Plus-tagged local part |
| − | `@domain.com` | NO MATCH | Missing local part |
| − | `user@` | NO MATCH | Missing domain |
| − | `not-an-email` | NO MATCH | No `@` separator |
| − | `price: $2.99` | NO MATCH | No `@` |

---

### 3.2 Credential / API Key

Three sub-patterns applied as a union:

**Pattern A — Key/Secret assignment context:**
```regex
(?i)(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token|auth[_\-]?token|
       client[_\-]?secret|private[_\-]?key|password|passwd|pwd|
       bearer|authorization)\s*[:=]\s*['"]?([A-Za-z0-9+/\-_\.]{20,})['"]?
```
_(Captures the value portion; value stored as hit count, not raw string.)_

**Pattern B — AWS Access Key ID:**
```regex
\bAKIA[0-9A-Z]{16}\b
```

**Pattern C — Generic high-entropy Base64/hex token (standalone line):**
```regex
(?m)^\s*[A-Za-z0-9+/]{40,}={0,2}\s*$
```
_(Applied only to `.env`, `.properties`, `.toml` file types to limit false positives.)_

**False-positive filters:**
- For Pattern A: skip if value matches common placeholder patterns
  (`changeme`, `your.*key`, `replace.*me`, `<.*>`, `\$\{.*\}`, `{{.*}}`).
- For Pattern C: require entropy > 4.5 bits/char (Shannon entropy check).

| # | Input | Expected | Note |
|---|-------|----------|------|
| + | `api_key=sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567` | MATCH | Pattern A |
| + | `AKIAIOSFODNN7EXAMPLE` | MATCH | Pattern B (AWS) |
| + | `secret: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9` | MATCH | Pattern A, JWT header |
| − | `api_key=your_key_here` | NO MATCH | Placeholder filter |
| − | `password=changeme` | NO MATCH | Placeholder filter |
| − | `description: AKIA stands for access key` | NO MATCH | Not followed by 16 uppercase alphanum |

---

### 3.3 Credit Card Number (PAN)

**Pattern A — Raw digits (major card types):**
```regex
\b(?:
  4[0-9]{12}(?:[0-9]{3})?          |  (?# Visa: 13 or 16 digits)
  5[1-5][0-9]{14}                   |  (?# Mastercard: 16 digits)
  2(?:2[2-9][1-9]|[3-6]\d\d|7(?:[01]\d|20))\d{12} |  (?# Mastercard 2-series)
  3[47][0-9]{13}                    |  (?# Amex: 15 digits)
  6(?:011|5[0-9]{2})[0-9]{12}       |  (?# Discover: 16 digits)
  (?:2131|1800|35\d{3})\d{11}          (?# JCB)
)\b
```

**Pattern B — Space/hyphen formatted:**
```regex
\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b
```

**Post-match filter:** Luhn algorithm check applied to all candidates. Candidates
failing Luhn are discarded and not counted as findings.

| # | Input | Expected | Note |
|---|-------|----------|------|
| + | `card: 4111111111111111` | MATCH | Visa test number, passes Luhn |
| + | `pan=4111-1111-1111-1111` | MATCH | Formatted Visa, passes Luhn |
| + | `3782-822463-10005` | MATCH | Amex test, passes Luhn |
| − | `1234567890123456` | NO MATCH | Fails Luhn |
| − | `0000-0000-0000-0000` | NO MATCH | Fails Luhn |
| − | `version: 4.11.1111111` | NO MATCH | Not a digit-only block |

---

### 3.4 Phone Number

Three sub-patterns applied as a union:

**Pattern A — E.164 international:**
```regex
\+[1-9]\d{6,14}\b
```

**Pattern B — North American (NANP):**
```regex
\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}\b
```

**Pattern C — UK landline/mobile:**
```regex
\b(?:\+44\s?|0)(?:7\d{3}|\d{2,4})\s?\d{3,4}\s?\d{3,4}\b
```

**False-positive filters:**
- Minimum 7 significant digits (excluding country code and formatting chars).
- Exclude pure numeric sequences that match version/date/ID patterns (e.g., surrounded
  by `.` or `-` on both sides in a semver-like context).
- Context exclusion: skip if immediately preceded by `v`, `ver`, `version`, `#`, `id=`.

| # | Input | Expected | Note |
|---|-------|----------|------|
| + | `call us: +1 (555) 234-5678` | MATCH | NANP with country code |
| + | `mobile: +44 7911 123456` | MATCH | UK mobile |
| + | `fax: +49 30 12345678` | MATCH | E.164 international |
| − | `12345` | NO MATCH | Too short |
| − | `error code: 404-500-1234` | NO MATCH | Context exclusion heuristic |
| − | `version: 1.20.304.5678` | NO MATCH | Semver context filter |

---

## 4. File-Type Extraction Strategy

### 4.1 Text-Native Types (direct read)

No binary decoding required; read raw bytes as UTF-8 (with BOM stripping).

| File Type | Extraction Approach | Notes |
|-----------|--------------------|---------| 
| `.json` | Parse as JSON; recursively walk all string-type leaf values; concatenate with newline separator | String values in all nesting levels, including arrays. Keys excluded (patterns target data, not field names). |
| `.xml` | Strip all XML/HTML tags via regex `<[^>]+>`; extract text content nodes | Also extract attribute values (e.g., `value="..."` attributes). |
| `.csv` | Read raw; split on commas/newlines; scan each cell as a text token | Header row treated same as data rows. |
| `.tsv` | Read raw; split on tabs/newlines; scan each cell | Same as CSV. |
| `.txt` | Read raw as plain text | No transformation. |
| `.md` | Read raw; optionally strip Markdown syntax (headings `#`, bold `**`, etc.) before scanning | Code fences (` ``` `) still scanned — credentials often appear in Markdown code examples. |
| `.yaml` / `.yml` | Parse YAML; recursively extract all scalar string values | Multi-document YAML (` --- `) supported. On parse error, fall back to raw text scan. |
| `.env` | Read raw; scan both keys and values of `KEY=VALUE` lines | Comments (`# ...`) stripped before scanning. |
| `.properties` | Read raw; scan values from `key=value` and `key: value` lines | Java `.properties` format; skip blank lines and `#`/`!` comments. |
| `.toml` | Parse TOML; recursively extract string scalar values | On parse error, fall back to raw text scan. |

### 4.2 Binary Types (text extraction)

#### `.pdf`
- **Library:** `pdf-parse` (npm) — wraps `pdfjs-dist`; extracts text content from all pages.
- **Approach:**
  1. Load raw buffer from backup storage.
  2. Call `pdfParse(buffer)` → `data.text` (full concatenated text).
  3. Pass `data.text` to pattern scanner.
- **Failure handling:** If extraction throws (encrypted PDF, corrupted file), log a
  non-blocking `SDI_EXTRACTION_WARN` event; skip file; do not increment `totalFilesScanned`.
- **Size limit:** Files > 50 MB skipped with `SDI_FILE_TOO_LARGE` warning.

#### `.docx`
- **Library:** `unzipper` (npm) — OOXML `.docx` files are ZIP archives.
- **Approach:**
  1. Unzip the `.docx` buffer in-memory.
  2. Extract `word/document.xml` entry.
  3. Strip XML tags; extract text runs from `<w:t>` elements.
  4. Also extract `word/comments.xml` if present (comments may contain PII).
  5. Pass concatenated text to pattern scanner.
- **Failure handling:** Same as `.pdf` — non-blocking skip on error.
- **Embedded images:** Not decoded; image content out of scope for text-pattern SDI teaser.
- **Size limit:** Files > 50 MB skipped with `SDI_FILE_TOO_LARGE` warning.

---

## 5. Findings Data Model

### 5.1 Core Types

```typescript
/** Supported file extension categories */
type SdiFileType =
  | 'json' | 'xml' | 'csv' | 'tsv' | 'pdf' | 'docx'
  | 'txt' | 'md' | 'yaml' | 'yml' | 'env' | 'properties' | 'toml';

/** The four supported sensitive data element categories */
type SdiDataElementType = 'EMAIL' | 'CREDENTIAL' | 'CREDIT_CARD' | 'PHONE';

/** Regulations surfaced by the SDI module */
type SdiRegulationId = 'GDPR' | 'CCPA' | 'PCI_DSS' | 'DORA' | 'NIS2' | 'SOC2';

/** Whether the regulation is actively triggered or passively shown */
type SdiRegulationDisplayStatus = 'active' | 'shown';

/** Scan lifecycle states */
type SdiScanStatus = 'pending' | 'running' | 'complete' | 'failed';
```

### 5.2 Finding Record (per-file grain, internal only)

```typescript
/**
 * Internal per-file scan hit — written to the scan job buffer during scanning.
 * NEVER persisted directly to the results store; rolled up to SdiFindingSummary.
 * Raw matched strings are NEVER present on this record.
 */
interface SdiScanHit {
  fileRef: string;            // Relative path or attachment ID within the backup point
  fileType: SdiFileType;
  dataElementType: SdiDataElementType;
  matchCount: number;         // Count of pattern matches in this file; ≥1
}
```

### 5.3 Aggregated Finding Summary (persisted)

```typescript
/**
 * Aggregated finding summary: one record per (dataElementType × fileType) dimension
 * within a scan result. This is the unit of persistence and API response.
 */
interface SdiFindingSummary {
  dataElementType: SdiDataElementType;
  fileType: SdiFileType;
  matchCount: number;   // Sum of match counts across all files in this dimension
  fileCount: number;    // Number of distinct files contributing to this dimension
}
```

### 5.4 Regulation Entry

```typescript
/**
 * One regulation entry in a scan result.
 * displayStatus drives UI badge colour: active = orange/red, shown = grey.
 */
interface SdiRegulationEntry {
  regulation: SdiRegulationId;
  displayStatus: SdiRegulationDisplayStatus;
  /** Data element types that triggered this regulation's Active status (empty for 'shown') */
  triggerDataElements: SdiDataElementType[];
}
```

### 5.5 Scan Result (top-level persisted document)

```typescript
/**
 * Top-level scan result keyed by backupPointId.
 * One SdiScanResult per (backupPointId, scan run).
 * Only the most recent completed scan is surfaced by the Results API.
 */
interface SdiScanResult {
  id: string;                         // UUID — scan run ID
  backupPointId: string;              // FK → BackupPoint.id
  integrationId: string;              // FK → OAuthConnection.id
  cloudId: string;                    // Jira site cloud ID
  status: SdiScanStatus;
  startedAt: string;                  // ISO-8601
  completedAt: string | null;         // ISO-8601; null while pending/running
  errorMessage: string | null;        // Set on status='failed'

  totalFilesScanned: number;          // Files successfully extracted and scanned
  totalFilesSkipped: number;          // Files skipped due to extraction error or size limit
  totalMatchCount: number;            // Sum of all matchCounts across all findings

  findings: SdiFindingSummary[];      // Aggregated findings; empty array if no matches
  regulationMap: SdiRegulationEntry[]; // Regulation surface; always populated if findings non-empty
}
```

### 5.6 API Response Shapes

#### GET /api/v1/sdi/scan/:backupPointId
```typescript
// 200 OK
interface SdiScanResultResponse {
  scan: SdiScanResult;
}

// 404 Not Found
interface SdiScanNotFoundResponse {
  error: 'SDI_SCAN_NOT_FOUND';
  backupPointId: string;
}
```

#### POST /api/v1/sdi/scan/:backupPointId/trigger
```typescript
// 202 Accepted
interface SdiScanTriggerResponse {
  scanId: string;
  backupPointId: string;
  status: 'pending';
  message: string;
}

// 409 Conflict — scan already running
interface SdiScanConflictResponse {
  error: 'SDI_SCAN_ALREADY_RUNNING';
  scanId: string;
}
```

---

## 6. Regulation Mapping Schema

### 6.1 Mapping Table

| Regulation | Display Status | Trigger Condition | Rationale |
|------------|---------------|------------------|-----------|
| **GDPR** | `active` | Any finding of `EMAIL` or `PHONE` | Personal data identifiers subject to GDPR Art. 4(1) |
| **CCPA** | `active` | Any finding of `EMAIL` or `PHONE` | California personal information under CCPA §1798.140(o) |
| **PCI DSS** | `active` | Any finding of `CREDIT_CARD` | Primary Account Numbers in scope under PCI DSS Req. 3 |
| **DORA** | `shown` | Any finding exists (any element type) | Digital operational resilience; data handling context |
| **NIS2** | `shown` | Any finding exists (any element type) | Network and information security; incident reporting context |
| **SOC 2** | `shown` | Any finding exists (any element type) | Trust service criteria; data handling relevance |
| **HIPAA** | **excluded** | — | See §6.2 |

**Display Status semantics:**
- `active` — Regulation is directly implicated by the detected data type; rendered with
  a high-visibility badge (orange/red). Tooltip references the specific data element type.
- `shown` — Regulation is contextually relevant to data handling but not directly triggered
  by the detected pattern type; rendered with a muted badge (grey). Shown as awareness context.

### 6.2 HIPAA Exclusion Rationale

HIPAA Protected Health Information (PHI) detection requires health/medical identifiers:
diagnosis codes, prescription data, insurance member IDs, medical record numbers, etc.
None of these pattern types are in scope for the SDI teaser's four data element types.
Including HIPAA in the regulation surface without a matching detection capability would
be misleading and constitute a false positive at the regulation level. HIPAA is therefore
explicitly excluded and **must not** appear in `SdiRegulationEntry` records.

### 6.3 Regulation Map Construction Algorithm

```
function computeRegulationMap(findings: SdiFindingSummary[]): SdiRegulationEntry[] {
  const triggeredTypes = new Set(findings.map(f => f.dataElementType));
  const anyFindings = triggeredTypes.size > 0;
  const map: SdiRegulationEntry[] = [];

  if (triggeredTypes.has('EMAIL') || triggeredTypes.has('PHONE')) {
    map.push({ regulation: 'GDPR', displayStatus: 'active', triggerDataElements: [...triggeredTypes].filter(t => t === 'EMAIL' || t === 'PHONE') });
    map.push({ regulation: 'CCPA', displayStatus: 'active', triggerDataElements: [...triggeredTypes].filter(t => t === 'EMAIL' || t === 'PHONE') });
  }

  if (triggeredTypes.has('CREDIT_CARD')) {
    map.push({ regulation: 'PCI_DSS', displayStatus: 'active', triggerDataElements: ['CREDIT_CARD'] });
  }

  if (anyFindings) {
    map.push({ regulation: 'DORA', displayStatus: 'shown', triggerDataElements: [] });
    map.push({ regulation: 'NIS2', displayStatus: 'shown', triggerDataElements: [] });
    map.push({ regulation: 'SOC2', displayStatus: 'shown', triggerDataElements: [] });
  }

  return map;
  // HIPAA: never added
}
```

---

## 7. Architectural Decision Records

### ADR-SDI-001: Pattern Library Approach

**Status:** Accepted

**Context:**
The SDI teaser must detect four data element types across 13 file types. Approaches
considered:
1. In-process regex patterns (no external NLP/ML model)
2. External NLP library (e.g., Presidio, spaCy-based service)
3. Third-party cloud PII detection API

**Decision:** Use inline regex patterns with post-match heuristic filters (Luhn check,
entropy check, placeholder allowlist). No external model or API dependency.

**Rationale:**
- **Scope alignment:** Teaser module; four well-defined element types do not require
  statistical ML classification.
- **Determinism:** Regex patterns produce deterministic, auditable results. NLP models
  introduce non-determinism and version-drift risk.
- **Latency:** Regex scanning is O(file_size × pattern_count), predictable.
  Model inference adds unpredictable latency and requires GPU/CPU infrastructure.
- **Data residency:** In-process scanning means backed-up Jira data never leaves the
  customer's deployment boundary. Cloud PII API would require exporting customer data
  to a third-party endpoint — unacceptable for backup data.
- **False-positive mitigation** (built into the inline approach):
  - PAN candidates validated with Luhn algorithm before being counted.
  - Credential candidates checked against entropy threshold and placeholder allowlist.
  - Phone candidates filtered by minimum digit count and context exclusion heuristics.
  - Email candidates filtered against a configurable placeholder allowlist.

**Consequences:**
- Regex patterns require maintenance as credential formats evolve (e.g., new cloud
  provider key prefixes). Accept this as a known operational cost.
- False-negative rate for obfuscated or split tokens accepted for teaser scope.

---

### ADR-SDI-002: PII Masking in Stored Findings

**Status:** Accepted

**Context:**
The pattern scanner necessarily reads raw file content to match patterns. A design
choice exists between:
A. Storing raw matched strings in the findings record for later display/audit.
B. Storing only match counts; never persisting raw matched strings.

**Decision:** Option B — store match counts only. Raw matched strings are
**never** written to the results store, logs, API responses, or any persistence layer.

**Rationale:**
- Storing detected PII values would create a **second-order PII exposure risk**: the
  SDI results store would itself become a repository of sensitive data, subject to the
  same regulations the module is surfacing.
- The teaser UI requirement is to show findings summaries (counts, file types, regulation
  tags) — not to reproduce actual PII values. Match count is sufficient.
- Eliminating raw storage simplifies the data classification boundary: the results store
  is non-sensitive; the backup storage (where raw data lives) retains its existing
  classification.
- Logging: the pattern scanner must not log matched strings at any log level. Log
  messages may include `fileRef`, `fileType`, `dataElementType`, and `matchCount` only.

**Consequences:**
- Operators cannot drill down from a finding to the specific matched string without
  accessing the original backup file. This is by design.
- Future "full SDI" feature (post-teaser) that exposes redacted previews will require
  a separate, purpose-built secure viewer with access control — not a relaxation of
  this constraint.

---

### ADR-SDI-003: Scan Result Storage Contract

**Status:** Accepted

**Context:**
Findings could be stored at three granularity levels:
1. **Per-match grain:** One record per individual regex match (includes line number,
   character offset, surrounding context).
2. **Per-file grain:** One record per (file × dataElementType) with match count.
3. **Per-dimension grain:** One record per (backupPointId × fileType × dataElementType)
   with match count and file count aggregated.

**Decision:** Persist at **per-dimension grain** (Option 3). Per-file `SdiScanHit`
records are in-memory only (scan job buffer); they are never written to persistent storage.

**Rationale:**
- Per-match storage (Option 1) would balloon storage proportionally to the volume of
  sensitive data found, potentially creating gigabyte-scale result sets for large Jira
  instances. It also increases the risk of PII reconstruction from surrounding context.
- Per-file storage (Option 2) provides more granularity than the teaser UI requires.
  For a teaser, knowing "23 email addresses found across 7 JSON files" is sufficient;
  listing all 7 file paths leaks backup structure detail unnecessarily.
- Per-dimension storage (Option 3) exactly matches the SDI teaser UI breakdown
  (data element type × file type chart) while minimising storage and PII surface area.
- Storage is O(backupPoints × 13_file_types × 4_element_types) = O(52 × backupPoints)
  maximum records — bounded and predictable.

**Storage contract:**
- Primary key: `(backupPointId, dataElementType, fileType)` — unique per scan.
- On re-scan: existing `SdiScanResult` for the backup point is superseded by the new
  result; previous result retained with `status='superseded'` for audit trail.
- Retention: `SdiScanResult` records follow the same retention policy as their parent
  `BackupPoint`; purged together on backup point deletion.
- `SdiScanResult` is excluded from the purge cascade boundary (same rationale as
  `JiraWorkflowNode` — it is metadata about backup content, not content itself).

---

## 8. API Contract

### 8.1 Trigger Scan

```
POST /api/v1/sdi/scan/:backupPointId/trigger

Request body: {} (empty)

Response 202 Accepted:
{
  "scanId": "uuid",
  "backupPointId": "string",
  "status": "pending",
  "message": "SDI scan queued"
}

Response 404 Not Found:
{ "error": "BACKUP_POINT_NOT_FOUND", "backupPointId": "string" }

Response 409 Conflict:
{ "error": "SDI_SCAN_ALREADY_RUNNING", "scanId": "uuid" }
```

### 8.2 Get Scan Result

```
GET /api/v1/sdi/scan/:backupPointId

Response 200 OK:
{
  "scan": {
    "id": "uuid",
    "backupPointId": "string",
    "integrationId": "string",
    "cloudId": "string",
    "status": "complete",
    "startedAt": "ISO-8601",
    "completedAt": "ISO-8601",
    "errorMessage": null,
    "totalFilesScanned": 142,
    "totalFilesSkipped": 3,
    "totalMatchCount": 87,
    "findings": [
      {
        "dataElementType": "EMAIL",
        "fileType": "json",
        "matchCount": 45,
        "fileCount": 12
      },
      {
        "dataElementType": "CREDIT_CARD",
        "fileType": "csv",
        "matchCount": 2,
        "fileCount": 1
      }
    ],
    "regulationMap": [
      {
        "regulation": "GDPR",
        "displayStatus": "active",
        "triggerDataElements": ["EMAIL"]
      },
      {
        "regulation": "CCPA",
        "displayStatus": "active",
        "triggerDataElements": ["EMAIL"]
      },
      {
        "regulation": "PCI_DSS",
        "displayStatus": "active",
        "triggerDataElements": ["CREDIT_CARD"]
      },
      {
        "regulation": "DORA",
        "displayStatus": "shown",
        "triggerDataElements": []
      },
      {
        "regulation": "NIS2",
        "displayStatus": "shown",
        "triggerDataElements": []
      },
      {
        "regulation": "SOC2",
        "displayStatus": "shown",
        "triggerDataElements": []
      }
    ]
  }
}

Response 404 Not Found:
{ "error": "SDI_SCAN_NOT_FOUND", "backupPointId": "string" }
```

### 8.3 List Scans for Integration

```
GET /api/v1/sdi/scans?integrationId=:integrationId

Response 200 OK:
{
  "scans": [
    {
      "id": "uuid",
      "backupPointId": "string",
      "status": "complete",
      "startedAt": "ISO-8601",
      "completedAt": "ISO-8601",
      "totalMatchCount": 87
    }
  ]
}
```

---

## 9. Non-Functional Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Max file size scanned | 50 MB | Prevent memory exhaustion for large PDFs/DOCXs |
| Max scan duration | 30 min per backup point | Timeout guard for very large backup sets |
| Scan parallelism | 4 files concurrent per scan job | Balance throughput vs. memory pressure |
| Raw string retention | 0 ms (never persisted) | ADR-SDI-002 |
| Findings storage per backup point | ≤ 52 dimension records | O(13 file types × 4 element types) bound |
| Pattern scanner log output | fileRef, fileType, dataElementType, matchCount only | No PII in logs |
