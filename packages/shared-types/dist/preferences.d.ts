/**
 * Platform preference constants for the Object Explorer (architecture §5).
 */
/**
 * Platform-level preference key for the unchanged-objects toggle.
 * Scope: per-user, per-integration.
 */
export declare const SHOW_UNCHANGED_OBJECTS_KEY: "platform.objectExplorer.showUnchangedObjects";
/**
 * Default value for the SHOW_UNCHANGED_OBJECTS preference.
 * Unchanged objects are hidden by default.
 */
export declare const SHOW_UNCHANGED_OBJECTS_DEFAULT: false;
/** Union of all valid platform preference keys. */
export type PlatformPreferenceKey = typeof SHOW_UNCHANGED_OBJECTS_KEY;
/** Map of preference key → value type. */
export interface PlatformPreferenceValueMap {
    [SHOW_UNCHANGED_OBJECTS_KEY]: boolean;
}
/** Request body for PUT /preferences */
export interface UpdatePreferenceRequest {
    key: PlatformPreferenceKey;
    value: PlatformPreferenceValueMap[PlatformPreferenceKey];
}
/** Success response for PUT /preferences */
export interface UpdatePreferenceResponse {
    key: PlatformPreferenceKey;
    value: PlatformPreferenceValueMap[PlatformPreferenceKey];
    updatedAt: string;
}
/** Success response for GET /preferences */
export interface GetPreferencesResponse {
    preferences: Partial<PlatformPreferenceValueMap>;
}
//# sourceMappingURL=preferences.d.ts.map