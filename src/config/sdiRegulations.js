'use strict';

/**
 * Sprint 5 — SDI Teaser: Regulation Configuration
 *
 * Declares all six regulations surfaced by the SDI module with their display
 * status and trigger conditions.
 *
 * HIPAA is intentionally absent — health/medical identifiers are not in scope
 * for the teaser's four data element types. Including HIPAA without a matching
 * detection capability would be a false positive at the regulation level.
 * See §6.2 of sdi-architecture.md.
 *
 * displayStatus values:
 *   'active'  — Regulation directly implicated by a detected data element type.
 *               Rendered with high-visibility badge (orange/red).
 *   'shown'   — Regulation contextually relevant but not directly triggered.
 *               Rendered with muted badge (grey). Awareness context only.
 */

/**
 * @typedef {'active'|'shown'} SdiRegulationDisplayStatus
 *
 * @typedef {Object} SdiRegulationConfig
 * @property {string}                      id            - SdiRegulationId value.
 * @property {string}                      displayName   - Human-readable regulation name.
 * @property {SdiRegulationDisplayStatus}  status        - Display status in the SDI UI.
 * @property {string[]}                    triggerDataElementTypes
 *   Data element types that activate 'active' status for this regulation.
 *   Empty array for regulations with status='shown' (shown unconditionally when any finding exists).
 * @property {string}                      rationale     - One-line rationale for inclusion and status.
 */

/** @type {SdiRegulationConfig[]} */
const SDI_REGULATION_CONFIG = Object.freeze([
  {
    id: 'GDPR',
    displayName: 'GDPR',
    status: 'active',
    triggerDataElementTypes: ['EMAIL', 'PHONE'],
    rationale:
      'Personal data identifiers (email, phone) subject to GDPR Art. 4(1).',
  },
  {
    id: 'CCPA',
    displayName: 'CCPA',
    status: 'active',
    triggerDataElementTypes: ['EMAIL', 'PHONE'],
    rationale:
      'California personal information (email, phone) under CCPA §1798.140(o).',
  },
  {
    id: 'PCI_DSS',
    displayName: 'PCI DSS',
    status: 'active',
    triggerDataElementTypes: ['CREDIT_CARD'],
    rationale:
      'Primary Account Numbers (credit card) in scope under PCI DSS Req. 3.',
  },
  {
    id: 'DORA',
    displayName: 'DORA',
    status: 'shown',
    triggerDataElementTypes: [],
    rationale:
      'Digital operational resilience; shown for data handling awareness when any finding exists.',
  },
  {
    id: 'NIS2',
    displayName: 'NIS2',
    status: 'shown',
    triggerDataElementTypes: [],
    rationale:
      'Network and information security; shown for incident reporting awareness when any finding exists.',
  },
  {
    id: 'SOC2',
    displayName: 'SOC 2',
    status: 'shown',
    triggerDataElementTypes: [],
    rationale:
      'Trust service criteria; shown for data handling awareness when any finding exists.',
  },
  // HIPAA: intentionally absent.
  // Health/medical identifiers are not in scope for the SDI teaser.
]);

/**
 * Convenience lookup: regulation config keyed by SdiRegulationId.
 */
const SDI_REGULATION_BY_ID = Object.freeze(
  SDI_REGULATION_CONFIG.reduce((acc, reg) => {
    acc[reg.id] = reg;
    return acc;
  }, {})
);

module.exports = {
  SDI_REGULATION_CONFIG,
  SDI_REGULATION_BY_ID,
};
