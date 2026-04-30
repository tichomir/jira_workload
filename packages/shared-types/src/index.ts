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
