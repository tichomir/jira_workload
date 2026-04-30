/**
 * Search DTOs for Sprint Search (architecture §3.5).
 * Endpoint requires read:board-scope:jira-software; returns 403 BOARD_SCOPE_UNAVAILABLE if absent.
 */
export type SprintState = 'active' | 'closed' | 'future';
/** Request parameters for GET /backups/:backupPointId/sprints */
export interface SprintSearchRequest {
    /** Tokenised match on sprint name (fulltext index). */
    q?: string;
    /**
     * Comma-separated sprint states. Values: "active", "closed", "future".
     * OR semantics.
     */
    state?: string;
    /**
     * ISO-8601 range on sprint startDate.
     * Format: "gte:2026-01-01" or "gte:2026-01-01,lte:2026-04-30".
     */
    startDate?: string;
    /**
     * ISO-8601 range on sprint endDate.
     * Same format as startDate.
     */
    endDate?: string;
    /** Filter to sprints belonging to a specific board. */
    boardId?: string;
    /** Page size. Default 50, max 200. */
    limit?: number;
    /** Opaque pagination cursor from previous response. */
    cursor?: string;
}
export interface SprintSearchResultItem {
    id: string;
    name: string;
    state: SprintState;
    boardId: string;
    startDate: string | null;
    endDate: string | null;
    completeDate: string | null;
    issueCount: number;
}
/** Success response shape for GET /backups/:backupPointId/sprints */
export interface SprintSearchResponse {
    results: SprintSearchResultItem[];
    total: number;
    nextCursor: string | null;
}
//# sourceMappingURL=sprints.d.ts.map