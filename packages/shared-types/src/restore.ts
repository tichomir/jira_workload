// ─── Restore Engine — Shared Types ──────────────────────────────────────────
// Consumed by backend (task-002) and frontend (task-003).

// ── Jira Object Types ────────────────────────────────────────────────────────

export type JiraObjectType =
  | 'workflow'
  | 'customFieldDefinition'
  | 'customFieldContext'
  | 'project'
  | 'issue'
  | 'comment'
  | 'attachment'
  | 'board'
  | 'sprint';

// ── Conflict Mode ─────────────────────────────────────────────────────────────

/** 'merge' is permanently excluded — any request specifying it returns 400. */
export type ConflictMode = 'skip' | 'override' | 'ask';

export type ConflictModeDowngradeReason = 'BASKET_SIZE_EXCEEDED';

// ── Restore Destination ───────────────────────────────────────────────────────

export type RestoreDestinationType = 'original' | 'alternate' | 'export';

export interface RestoreDestination {
  type: RestoreDestinationType;
  /** Populated for 'original' destination */
  originalSiteId?: string;
  originalProjectKey?: string;
  /** Populated for 'alternate' destination */
  targetSiteId?: string;
  targetProjectKey?: string;
  /** true when targetSiteId !== sourceSiteId */
  isCrossSite?: boolean;
  /** Populated for 'export' destination */
  exportFormat?: 'json' | 'json+zip';
}

// ── Object Selection ──────────────────────────────────────────────────────────

export interface ObjectSelection {
  includeAll: boolean;
  objectTypes?: JiraObjectType[];
  projectKeys?: string[];
  issueKeys?: string[];
}

// ── Restore Request ───────────────────────────────────────────────────────────

export interface RestoreRequest {
  backupPointId: string;
  sourceSiteId: string;
  destination: RestoreDestination;
  /** Defaults to 'skip' when omitted */
  conflictMode?: ConflictMode;
  objectSelection: ObjectSelection;
}

// ── Execution Graph ───────────────────────────────────────────────────────────

export type StageNumber = 1 | 2 | 3 | 4 | 5;

export type ItemStatus = 'pending' | 'success' | 'skipped' | 'failed' | 'blocked';

export interface RestoreItemResult {
  id: string;
  objectType: JiraObjectType;
  status: ItemStatus;
  /** Jira ID of the restored object on success */
  targetId?: string;
  skipReason?: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface StageResult {
  stageNumber: StageNumber;
  succeeded: number;
  skipped: number;
  failed: number;
  blocked: number;
  items: RestoreItemResult[];
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationCheckResult {
  /** 1=OAuth, 2=ProjectExists, 3=ProjectArchive, 4=JiraSoftware, 5=WorkflowStatus, 6=CustomField, 7=AttachmentSize */
  checkId: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  checkName: string;
  passed: boolean;
  blocking: boolean;
  errorCode?: string;
  detail?: string;
  affectedItems?: string[];
}

export interface ValidationPipelineResult {
  passed: boolean;
  blockingError?: ValidationCheckResult;
  warnings: ValidationCheckResult[];
}

// ── Custom Field Mapping ──────────────────────────────────────────────────────

export interface CustomFieldMappingInput {
  sourceSiteId: string;
  targetSiteId: string;
  sourceFieldIds: string[];
}

export interface CustomFieldMappingOutput {
  /** sourceFieldId → targetFieldId */
  fieldMap: Record<string, string>;
  /** Required fields absent on target — blocks restore when non-empty */
  missingRequired: string[];
  /** Optional fields absent on target — emits warnings */
  missingOptional: string[];
  status: 'ok' | 'blocked' | 'warn';
}

// ── Basket Summary ────────────────────────────────────────────────────────────

export interface BasketSummary {
  totalItems: number;
  byType: Partial<Record<JiraObjectType, number>>;
  conflictModeEffective: ConflictMode;
  conflictModeDowngradeReason?: ConflictModeDowngradeReason;
}

// ── Restore Response ──────────────────────────────────────────────────────────

export type RestoreJobStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface RestoreResponse {
  restoreJobId: string;
  status: RestoreJobStatus;
  conflictModeEffective: ConflictMode;
  conflictModeDowngradeReason?: ConflictModeDowngradeReason;
  destination: RestoreDestination;
  validationWarnings: ValidationCheckResult[];
  stageResults?: StageResult[];
  exportDownloadUrl?: string;
}

// ── Job Status Response ───────────────────────────────────────────────────────

export interface RestoreJobStatusResponse {
  restoreJobId: string;
  status: RestoreJobStatus;
  currentStage?: StageNumber;
  stageResults: StageResult[];
  validationWarnings: ValidationCheckResult[];
  exportDownloadUrl?: string;
}

// ── Conflict Decision ─────────────────────────────────────────────────────────

export interface ConflictDecisionRequest {
  itemId: string;
  decision: 'skip' | 'override';
}

export interface ConflictDecisionResponse {
  itemId: string;
  decision: 'skip' | 'override';
  restoreJobStatus: RestoreJobStatus;
}

// ── Validation-Only Response ──────────────────────────────────────────────────

export interface ValidationOnlyResponse {
  passed: boolean;
  blockingError?: ValidationCheckResult;
  warnings: ValidationCheckResult[];
  customFieldMapping?: CustomFieldMappingOutput;
  basketSummary: BasketSummary;
}

// ── ADF Types (minimal, for constraint handlers) ──────────────────────────────

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}
