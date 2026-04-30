/**
 * Indicates how a Jira object changed between the prior and current backup points.
 * Computed by comparing BackupManifest entries (see architecture §4.2).
 */
export enum ChangeIndicator {
  /** Object id present in current manifest, absent in prior manifest (or first backup point). */
  Added = 'Added',
  /** Object id present in both manifests; contentHash differs. */
  Modified = 'Modified',
  /** Object id present in both manifests; contentHash identical. */
  Unchanged = 'Unchanged',
  /** Object id absent in current manifest, present in prior manifest. */
  Deleted = 'Deleted',
}
