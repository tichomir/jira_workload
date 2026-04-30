"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChangeIndicator = void 0;
/**
 * Indicates how a Jira object changed between the prior and current backup points.
 * Computed by comparing BackupManifest entries (see architecture §4.2).
 */
var ChangeIndicator;
(function (ChangeIndicator) {
    /** Object id present in current manifest, absent in prior manifest (or first backup point). */
    ChangeIndicator["Added"] = "Added";
    /** Object id present in both manifests; contentHash differs. */
    ChangeIndicator["Modified"] = "Modified";
    /** Object id present in both manifests; contentHash identical. */
    ChangeIndicator["Unchanged"] = "Unchanged";
    /** Object id absent in current manifest, present in prior manifest. */
    ChangeIndicator["Deleted"] = "Deleted";
})(ChangeIndicator || (exports.ChangeIndicator = ChangeIndicator = {}));
//# sourceMappingURL=changeIndicator.js.map