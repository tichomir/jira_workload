/**
 * Search DTOs for Attachment Search (architecture §3.4).
 * Searches attachments within a backup point.
 */

/** Request parameters for GET /backups/:backupPointId/attachments */
export interface AttachmentSearchRequest {
  /**
   * Tokenised and prefix match on filename (fulltext + keyword prefix index).
   */
  q?: string;
  /**
   * Comma-separated MIME type list. Exact match (keyword).
   * e.g. "image/png,application/pdf"
   */
  mimeType?: string;
  /**
   * ISO-8601 range on created timestamp.
   * Format: "gte:2026-01-01" or "gte:2026-01-01,lte:2026-04-30".
   */
  created?: string;
  /** Filter to attachments belonging to a specific issue. */
  issueId?: string;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Opaque pagination cursor from previous response. */
  cursor?: string;
}

export interface AttachmentSearchResultItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  created: string;
  issueId: string;
  issueKey: string;
  storageKey: string;
}

/** Success response shape for GET /backups/:backupPointId/attachments */
export interface AttachmentSearchResponse {
  results: AttachmentSearchResultItem[];
  total: number;
  nextCursor: string | null;
}
