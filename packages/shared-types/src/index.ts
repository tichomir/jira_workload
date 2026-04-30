// Change indicator enum
export { ChangeIndicator } from './changeIndicator';

// Object Explorer types
export type {
  ObjectExplorerNodeType,
  ObjectExplorerNode,
  ObjectExplorerRequest,
  ObjectExplorerResponse,
} from './objectExplorer';

// Search DTOs — Global
export type {
  GlobalSearchNodeType,
  GlobalSearchRequest,
  GlobalSearchResultItem,
  GlobalSearchResponse,
} from './search/global';

// Search DTOs — Project Inventory
export type {
  ProjectTypeKey,
  ProjectSearchRequest,
  ProjectSearchResultItem,
  ProjectSearchResponse,
} from './search/projects';

// Search DTOs — Issues
export type {
  StatusCategory,
  IssueAssignee,
  IssueReporter,
  IssueSearchRequest,
  IssueSearchResultItem,
  IssueSearchResponse,
} from './search/issues';

// Search DTOs — Attachments
export type {
  AttachmentSearchRequest,
  AttachmentSearchResultItem,
  AttachmentSearchResponse,
} from './search/attachments';

// Search DTOs — Boards
export type {
  BoardType,
  BoardSearchRequest,
  BoardSearchResultItem,
  BoardSearchResponse,
} from './search/boards';

// Search DTOs — Sprints
export type {
  SprintState,
  SprintSearchRequest,
  SprintSearchResultItem,
  SprintSearchResponse,
} from './search/sprints';

// Restore Engine constants
export {
  RESTORE_STAGE_ORDER,
  CONFLICT_MODE,
  ASK_BASKET_THRESHOLD,
  RESTORE_DESTINATION,
  VALIDATION_CHECK_TYPE,
  VALIDATION_CHECK_BLOCKING,
  ATTACHMENT_SIZE_LIMIT_BYTES,
  ISSUE_KEY_LABEL_PREFIX,
  REPORTER_ATTRIBUTION_HEADER,
  COMMENT_AUTHOR_ADF_NODE,
} from './restoreConstants';

// Restore Engine types
export type {
  JiraObjectType,
  ConflictMode,
  ConflictModeDowngradeReason,
  RestoreDestinationType,
  RestoreDestination,
  ObjectSelection,
  RestoreRequest,
  StageNumber,
  ItemStatus,
  RestoreItemResult,
  StageResult,
  ValidationCheckResult,
  ValidationPipelineResult,
  CustomFieldMappingInput,
  CustomFieldMappingOutput,
  BasketSummary,
  RestoreJobStatus,
  RestoreResponse,
  RestoreJobStatusResponse,
  ConflictDecisionRequest,
  ConflictDecisionResponse,
  ValidationOnlyResponse,
  AdfNode,
  AdfDocument,
} from './restore';

// SDI Teaser types
export {
  SDI_SUPPORTED_EXTENSIONS,
  SDI_MAX_FILE_SIZE_BYTES,
  SDI_SCAN_TIMEOUT_MS,
  SDI_SCAN_PARALLELISM,
  SDI_MIN_CREDENTIAL_ENTROPY,
  SDI_MIN_PHONE_DIGITS,
} from './sdi';
export type {
  SdiFileType,
  SdiDataElementType,
  SdiRegulationId,
  SdiRegulationDisplayStatus,
  SdiScanStatus,
  SdiScanHit,
  SdiFindingSummary,
  SdiRegulationEntry,
  SdiScanResult,
  SdiScanTriggerResponse,
  SdiScanResultResponse,
  SdiScanListItem,
  SdiScanListResponse,
  SdiErrorCode,
} from './sdi';

// Platform preferences
export {
  SHOW_UNCHANGED_OBJECTS_KEY,
  SHOW_UNCHANGED_OBJECTS_DEFAULT,
} from './preferences';
export type {
  PlatformPreferenceKey,
  PlatformPreferenceValueMap,
  UpdatePreferenceRequest,
  UpdatePreferenceResponse,
  GetPreferencesResponse,
} from './preferences';
