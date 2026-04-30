/**
 * Search DTOs for Board Search (architecture §3.5).
 * Endpoint requires read:board-scope:jira-software; returns 403 BOARD_SCOPE_UNAVAILABLE if absent.
 */

export type BoardType = 'scrum' | 'kanban';

/** Request parameters for GET /backups/:backupPointId/boards */
export interface BoardSearchRequest {
  /** Tokenised match on board name (fulltext index). */
  q?: string;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Opaque pagination cursor from previous response. */
  cursor?: string;
}

export interface BoardSearchResultItem {
  id: string;
  name: string;
  type: BoardType;
  projectKey: string;
  sprintCount: number;
}

/** Success response shape for GET /backups/:backupPointId/boards */
export interface BoardSearchResponse {
  results: BoardSearchResultItem[];
  total: number;
  nextCursor: string | null;
}
