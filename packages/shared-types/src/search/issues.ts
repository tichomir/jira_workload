/**
 * Search DTOs for Issue Search (architecture §3.3).
 * Searches issues within a backup point with tokenised text and a structured filter panel.
 * Supports 11 structured filter predicates.
 */

export type StatusCategory = 'To Do' | 'In Progress' | 'Done';

/** Request parameters for GET /backups/:backupPointId/issues */
export interface IssueSearchRequest {
  /** Tokenised keyword match on summary and key (fulltext index). */
  q?: string;

  // --- Structured filter panel (11 predicates) ---

  /** Predicate 1: Comma-separated issue type names. Exact match (keyword). OR semantics. */
  issuetype?: string;
  /** Predicate 2: Comma-separated status names. Exact match (keyword). OR semantics. */
  status?: string;
  /** Predicate 3: Comma-separated status categories. Values: "To Do", "In Progress", "Done". OR semantics. */
  statusCategory?: string;
  /** Predicate 4: Comma-separated priority names. Exact match (keyword). OR semantics. */
  priority?: string;
  /**
   * Predicate 5: Comma-separated accountIds. OR semantics.
   * Use sentinel value "unassigned" to match issues with no assignee.
   */
  assignee?: string;
  /** Predicate 6: Comma-separated reporter accountIds. Exact match (keyword). OR semantics. */
  reporter?: string;
  /**
   * Predicate 7: Comma-separated label values. AND semantics — issue must carry ALL specified labels.
   * Issues with no labels excluded when this filter is present.
   */
  labels?: string;
  /**
   * Predicate 8: ISO-8601 range on created timestamp.
   * Format: "gte:2026-01-01" or "gte:2026-01-01,lte:2026-04-30".
   */
  created?: string;
  /**
   * Predicate 9: ISO-8601 range on updated timestamp.
   * Same format as created.
   */
  updated?: string;
  /**
   * Predicate 10: ISO-8601 range on resolved timestamp.
   * Issues with null resolved excluded when this filter is present.
   */
  resolved?: string;
  /** Predicate 11: Comma-separated project keys. Exact match (keyword). OR semantics. */
  projectKey?: string;

  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Opaque pagination cursor from previous response. */
  cursor?: string;
}

export interface IssueAssignee {
  accountId: string;
  displayName: string;
}

export interface IssueReporter {
  accountId: string;
  displayName: string;
}

export interface IssueSearchResultItem {
  id: string;
  key: string;
  summary: string;
  issuetype: string;
  status: string;
  statusCategory: StatusCategory;
  priority: string | null;
  assignee: IssueAssignee | null;
  reporter: IssueReporter;
  labels: string[];
  created: string;
  updated: string;
  resolved: string | null;
  projectKey: string;
}

/** Success response shape for GET /backups/:backupPointId/issues */
export interface IssueSearchResponse {
  results: IssueSearchResultItem[];
  total: number;
  nextCursor: string | null;
}
