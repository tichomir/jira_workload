/**
 * Search DTOs for Global Search (architecture §3.1).
 * Searches across JiraProjectNode, JiraWorkflowNode, and JiraCustomFieldNode
 * by name and key across all connected Jira sites.
 */

export type GlobalSearchNodeType =
  | 'JiraProjectNode'
  | 'JiraWorkflowNode'
  | 'JiraCustomFieldNode';

/** Request parameters for GET /search/global */
export interface GlobalSearchRequest {
  /** Query string. Matched against name (fulltext) and key (keyword prefix). Min 1 char. Required. */
  q: string;
  /** Filter to a single connected site (cloudId). Omit for all sites. */
  siteId?: string;
  /** Limit to a specific node type. Omit for all. */
  nodeType?: GlobalSearchNodeType;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Opaque pagination cursor from previous response. */
  cursor?: string;
}

export interface GlobalSearchResultItem {
  id: string;
  nodeType: GlobalSearchNodeType;
  siteId: string;
  siteName: string;
  key: string | null;
  name: string;
  matchedOn: 'name' | 'key';
}

/** Success response shape for GET /search/global */
export interface GlobalSearchResponse {
  results: GlobalSearchResultItem[];
  total: number;
  nextCursor: string | null;
}
