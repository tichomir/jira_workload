import { ChangeIndicator } from './changeIndicator';
/**
 * Supported node types in the Object Explorer (architecture §4.4).
 */
export type ObjectExplorerNodeType = 'JiraProjectNode' | 'JiraIssueNode' | 'JiraAttachmentNode' | 'JiraWorkflowNode' | 'JiraCustomFieldDefinitionNode' | 'JiraCustomFieldContextNode' | 'JiraBoardNode' | 'JiraSprintNode';
/**
 * Wraps any Jira node with its change indicator and affected field list.
 *
 * @template T - The shape of the underlying Jira node's fields.
 *
 * - `fields`:       Current field values. For Deleted objects, last-known state from prior backup.
 * - `priorFields`:  Prior field values. null for Added and Unchanged objects.
 * - `changedFields`: Names of fields that differ between priorFields and fields.
 *                   Empty array for Added, Deleted, and Unchanged objects.
 */
export interface ObjectExplorerNode<T extends Record<string, unknown>> {
    id: string;
    nodeType: ObjectExplorerNodeType;
    changeIndicator: ChangeIndicator;
    fields: T;
    priorFields: T | null;
    changedFields: string[];
}
/**
 * Request parameters for GET /backups/:backupPointId/objects
 */
export interface ObjectExplorerRequest {
    /** Required. One of the node types in ObjectExplorerNodeType. */
    nodeType: ObjectExplorerNodeType;
    /** Optional. Scope to child objects of a parent (e.g. issues under a project). */
    parentId?: string;
    /**
     * Comma-separated change indicators to include.
     * Default: "Added,Modified,Deleted" (Unchanged hidden by default).
     */
    changeIndicator?: string;
    /** Page size. Default 50, max 200. */
    limit?: number;
    /** Opaque pagination cursor from previous response. */
    cursor?: string;
}
/**
 * Success response shape for GET /backups/:backupPointId/objects
 */
export interface ObjectExplorerResponse<T extends Record<string, unknown>> {
    backupPointId: string;
    priorBackupPointId: string | null;
    results: ObjectExplorerNode<T>[];
    total: number;
    nextCursor: string | null;
}
//# sourceMappingURL=objectExplorer.d.ts.map