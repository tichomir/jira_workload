/**
 * Search DTOs for Project Inventory Search (architecture §3.2).
 * Searches projects within a specific backup point.
 */

export type ProjectTypeKey = 'software' | 'business' | 'service_desk';

/** Request parameters for GET /backups/:backupPointId/projects */
export interface ProjectSearchRequest {
  /** Tokenised keyword match on name. */
  q?: string;
  /** Prefix or exact match on project key (keyword index). */
  key?: string;
  /** Exact match on projectTypeKey. */
  projectTypeKey?: ProjectTypeKey;
  /** Filter by archived status. Omit for both archived and non-archived. */
  archived?: boolean;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Opaque pagination cursor from previous response. */
  cursor?: string;
}

export interface ProjectSearchResultItem {
  id: string;
  key: string;
  name: string;
  projectTypeKey: ProjectTypeKey;
  archived: boolean;
  issueCount: number;
  lastUpdated: string;
}

/** Success response shape for GET /backups/:backupPointId/projects */
export interface ProjectSearchResponse {
  results: ProjectSearchResultItem[];
  total: number;
  nextCursor: string | null;
}
