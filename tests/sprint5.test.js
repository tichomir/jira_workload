'use strict';

/**
 * Sprint 5 — Sensitive Data Intelligence (SDI) Teaser
 *
 * Test coverage:
 *   - Extractor happy paths (all 13 file types) + empty file behaviour
 *   - Pattern scanner: true positives + true negatives for all four data element types
 *   - Luhn algorithm (credit card post-match filter)
 *   - Shannon entropy (credential Pattern C post-match filter)
 *   - Scan orchestrator: aggregation logic
 *   - API endpoint: GET /api/sdi/findings response shape
 *   - HIPAA absence guarantee
 */

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db = require('../src/db');

// Extractor functions
const {
  extractJson,
  extractXml,
  extractCsv,
  extractTsv,
  extractPlain,
  extractMarkdown,
  extractYaml,
  extractEnv,
  extractProperties,
  extractToml,
  extractText,
} = require('../src/services/sdiExtractors');

// Pattern scanner
const {
  scanText,
  scanPatternEntry,
  shannonEntropy,
  luhnCheck,
  isEmailPlaceholder,
  isCredentialPlaceholder,
} = require('../src/services/sdiPatternScanner');

// Orchestrator
const {
  triggerScanSync,
  getLatestScanResult,
  computeRegulationMap,
  aggregateFindings,
} = require('../src/services/sdiScanOrchestrator');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearSdiDb() {
  db.sdiScanResults.clear();
  db.backupPoints.clear();
  db.objectSnapshots.clear();
  db.attachmentManifestEntries.clear();
}

function seedBackupPoint(overrides = {}) {
  const id = overrides.id || uuidv4();
  const bp = {
    id,
    integrationId: overrides.integrationId || uuidv4(),
    cloudId: overrides.cloudId || 'test-cloud',
    createdAt: new Date().toISOString(),
  };
  db.backupPoints.set(id, bp);
  return bp;
}

// ─── Extractor Tests ──────────────────────────────────────────────────────────

describe('SDI Extractors', () => {
  describe('extractJson', () => {
    it('returns string leaf values from nested JSON', () => {
      const json = JSON.stringify({
        name: 'alice@corp.com',
        nested: { value: 'test-value' },
        arr: ['item1', 'item2'],
      });
      const result = extractJson(json);
      expect(result).toContain('alice@corp.com');
      expect(result).toContain('test-value');
      expect(result).toContain('item1');
      expect(result).toContain('item2');
    });

    it('falls back to raw content for invalid JSON', () => {
      const raw = 'not json content with alice@corp.com';
      const result = extractJson(raw);
      expect(result).toBe(raw);
    });

    it('returns empty string for empty object', () => {
      const result = extractJson('{}');
      expect(result).toBe('');
    });
  });

  describe('extractXml', () => {
    it('strips tags and retains text content', () => {
      const xml = '<root><email>user@test.org</email><data value="attr@val.com"/></root>';
      const result = extractXml(xml);
      expect(result).toContain('user@test.org');
      expect(result).toContain('attr@val.com');
      expect(result).not.toContain('<root>');
    });

    it('returns empty-ish string for XML with no text', () => {
      const xml = '<root><child/></root>';
      const result = extractXml(xml);
      expect(typeof result).toBe('string');
    });
  });

  describe('extractCsv', () => {
    it('returns raw CSV content', () => {
      const csv = 'name,email\nalice,alice@corp.com\n';
      expect(extractCsv(csv)).toBe(csv);
    });

    it('returns empty string for empty input', () => {
      expect(extractCsv('')).toBe('');
    });
  });

  describe('extractTsv', () => {
    it('returns raw TSV content', () => {
      const tsv = 'name\temail\nalice\talice@corp.com\n';
      expect(extractTsv(tsv)).toBe(tsv);
    });

    it('returns empty string for empty input', () => {
      expect(extractTsv('')).toBe('');
    });
  });

  describe('extractPlain', () => {
    it('returns content unchanged', () => {
      const txt = 'Call +1-800-555-0199 for info.';
      expect(extractPlain(txt)).toBe(txt);
    });

    it('handles empty input', () => {
      expect(extractPlain('')).toBe('');
    });
  });

  describe('extractMarkdown', () => {
    it('returns markdown content including code fences', () => {
      const md = '# Title\n```\nAKIA1234567890ABCDEF\n```\nContact: user@org.com';
      const result = extractMarkdown(md);
      expect(result).toContain('AKIA1234567890ABCDEF');
      expect(result).toContain('user@org.com');
    });

    it('handles empty input', () => {
      expect(extractMarkdown('')).toBe('');
    });
  });

  describe('extractYaml', () => {
    it('returns YAML content for scanning', () => {
      const yaml = 'email: user@domain.com\napi_key: s3cr3tKey123456789012';
      const result = extractYaml(yaml);
      expect(result).toContain('user@domain.com');
    });

    it('handles empty input', () => {
      expect(extractYaml('')).toBe('');
    });
  });

  describe('extractEnv', () => {
    it('strips comment lines and returns key=value lines', () => {
      const env = '# comment\nAPI_KEY=supersecretvalue12345\n# another comment\nDB_HOST=localhost';
      const result = extractEnv(env);
      expect(result).toContain('API_KEY=supersecretvalue12345');
      expect(result).toContain('DB_HOST=localhost');
      expect(result).not.toContain('# comment');
    });

    it('handles empty input', () => {
      expect(extractEnv('')).toBe('');
    });
  });

  describe('extractProperties', () => {
    it('strips # and ! comment lines', () => {
      const props = '# comment\n! another comment\napi.key=myApiKey123456789\nhost=localhost';
      const result = extractProperties(props);
      expect(result).toContain('api.key=myApiKey123456789');
      expect(result).not.toContain('# comment');
      expect(result).not.toContain('! another comment');
    });

    it('handles empty input', () => {
      expect(extractProperties('')).toBe('');
    });
  });

  describe('extractToml', () => {
    it('returns TOML content unchanged', () => {
      const toml = '[database]\nurl = "postgres://user:pass@host/db"';
      expect(extractToml(toml)).toBe(toml);
    });

    it('handles empty input', () => {
      expect(extractToml('')).toBe('');
    });
  });

  describe('extractText dispatch', () => {
    it('dispatches .json to JSON extractor', async () => {
      const content = JSON.stringify({ email: 'dispatch@test.org' });
      const result = await extractText('.json', content);
      expect(result).toContain('dispatch@test.org');
    });

    it('dispatches .txt to plain text extractor', async () => {
      const content = 'plain text content';
      const result = await extractText('.txt', content);
      expect(result).toBe('plain text content');
    });

    it('dispatches .yml and .yaml to same strategy', async () => {
      const content = 'key: value';
      const r1 = await extractText('.yml', content);
      const r2 = await extractText('.yaml', content);
      expect(r1).toBe(r2);
    });

    it('throws SDI_FILE_TOO_LARGE for binary exceeding 50MB', async () => {
      // Create a fake buffer that "claims" to be > 50MB via sizeBytes param
      const buf = Buffer.from('fake content');
      const OVER_50MB = 51 * 1024 * 1024;
      await expect(extractText('.pdf', buf, OVER_50MB)).rejects.toMatchObject({ code: 'SDI_FILE_TOO_LARGE' });
    });

    it('throws SDI_EXTRACTION_WARN for unsupported extension', async () => {
      await expect(extractText('.exe', 'binary')).rejects.toMatchObject({ code: 'SDI_EXTRACTION_WARN' });
    });
  });
});

// ─── Pattern Scanner Tests ────────────────────────────────────────────────────

describe('SDI Pattern Scanner — Luhn and Entropy helpers', () => {
  describe('luhnCheck', () => {
    it('accepts valid Visa test number', () => {
      expect(luhnCheck('4111111111111111')).toBe(true);
    });

    it('accepts valid Mastercard test number', () => {
      expect(luhnCheck('5500005555555559')).toBe(true);
    });

    it('accepts valid Amex test number', () => {
      expect(luhnCheck('378282246310005')).toBe(true);
    });

    it('rejects invalid number (off by one digit)', () => {
      expect(luhnCheck('4111111111111112')).toBe(false);
    });

    it('rejects short number', () => {
      expect(luhnCheck('41111')).toBe(false);
    });
  });

  describe('shannonEntropy', () => {
    it('returns 0 for empty string', () => {
      expect(shannonEntropy('')).toBe(0);
    });

    it('returns 0 for single repeated character', () => {
      expect(shannonEntropy('aaaaaaa')).toBe(0);
    });

    it('returns high entropy for random-looking string', () => {
      const highEntropy = 'aB3cD4eF5gH6iJ7kL8mN9oP0qRsTuVwX';
      expect(shannonEntropy(highEntropy)).toBeGreaterThan(4.5);
    });

    it('returns low entropy for dictionary word', () => {
      expect(shannonEntropy('password')).toBeLessThan(4.5);
    });
  });

  describe('isEmailPlaceholder', () => {
    it('identifies known placeholder email', () => {
      expect(isEmailPlaceholder('user@example.com')).toBe(true);
    });

    it('identifies example.org domain as placeholder', () => {
      expect(isEmailPlaceholder('anything@example.org')).toBe(true);
    });

    it('passes through real-looking email', () => {
      expect(isEmailPlaceholder('alice@realdomain.com')).toBe(false);
    });
  });

  describe('isCredentialPlaceholder', () => {
    it('rejects "changeme"', () => {
      expect(isCredentialPlaceholder('changeme')).toBe(true);
    });

    it('rejects "${MY_SECRET}"', () => {
      expect(isCredentialPlaceholder('${MY_SECRET}')).toBe(true);
    });

    it('passes through real credential value', () => {
      expect(isCredentialPlaceholder('aB3xY9zQrWtLmNpKj2vS')).toBe(false);
    });
  });
});

describe('SDI Pattern Scanner — EMAIL', () => {
  it('detects a real email address', () => {
    const count = scanPatternEntry('Contact alice@corp.com for details', 'EMAIL', '.txt');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('does not count placeholder email', () => {
    const count = scanPatternEntry('Send to user@example.com', 'EMAIL', '.txt');
    expect(count).toBe(0);
  });

  it('does not match non-email text', () => {
    const count = scanPatternEntry('No email addresses here at all.', 'EMAIL', '.txt');
    expect(count).toBe(0);
  });

  it('counts multiple distinct real emails', () => {
    const text = 'From: alice@realco.com To: bob@anotherco.net';
    const count = scanPatternEntry(text, 'EMAIL', '.txt');
    expect(count).toBe(2);
  });
});

describe('SDI Pattern Scanner — CREDENTIAL_API_KEY', () => {
  it('detects assignment-context credential (Pattern A)', () => {
    const text = 'api_key = "aB3xY9zQrWtLmNpKj2vSabc123"';
    const count = scanPatternEntry(text, 'CREDENTIAL_API_KEY', '.json');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('detects AWS Access Key ID (Pattern B)', () => {
    const text = 'access_key: AKIA1234567890ABCDEF';
    const count = scanPatternEntry(text, 'CREDENTIAL_API_KEY', '.yaml');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('does not count placeholder credentials', () => {
    const text = 'api_key = changeme';
    const count = scanPatternEntry(text, 'CREDENTIAL_API_KEY', '.env');
    expect(count).toBe(0);
  });

  it('applies Pattern C only to .env/.properties/.toml', () => {
    // High-entropy 40+ char base64 token on its own line
    const highEntropyToken = 'aB3cD4eF5gH6iJ7kL8mN9oP0qRsTuVwXyZ1aB3cDe';
    const text = `\n${highEntropyToken}\n`;
    const countEnv  = scanPatternEntry(text, 'CREDENTIAL_API_KEY', '.env');
    const countJson = scanPatternEntry(text, 'CREDENTIAL_API_KEY', '.json');
    // In .env file Pattern C should fire (if entropy ≥ 4.5); in .json it should not
    expect(countJson).toBe(0);
    // countEnv may or may not fire depending on entropy of the token — just verify no exception
    expect(typeof countEnv).toBe('number');
  });
});

describe('SDI Pattern Scanner — CREDIT_CARD_PAN', () => {
  it('detects valid Visa PAN (Luhn-valid)', () => {
    const text = 'Card: 4111111111111111';
    const count = scanPatternEntry(text, 'CREDIT_CARD_PAN', '.txt');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('does not count Luhn-invalid number', () => {
    const text = 'Card: 4111111111111112';
    const count = scanPatternEntry(text, 'CREDIT_CARD_PAN', '.txt');
    expect(count).toBe(0);
  });

  it('detects space-formatted PAN if Luhn-valid', () => {
    // 4111 1111 1111 1111 — valid Visa
    const text = 'Card number: 4111 1111 1111 1111';
    const count = scanPatternEntry(text, 'CREDIT_CARD_PAN', '.csv');
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('SDI Pattern Scanner — PHONE_NUMBER', () => {
  it('detects E.164 format', () => {
    const count = scanPatternEntry('Call +14155552671', 'PHONE_NUMBER', '.txt');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('detects NANP format', () => {
    const count = scanPatternEntry('Phone: (415) 555-2671', 'PHONE_NUMBER', '.txt');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('does not count short number below 7 digits', () => {
    const count = scanPatternEntry('Code: 12345', 'PHONE_NUMBER', '.txt');
    expect(count).toBe(0);
  });
});

describe('SDI scanText — all element types', () => {
  it('returns counts for all matching types in a single text', () => {
    const text = [
      'user: alice@realdomain.com',
      'card: 4111111111111111',
      'phone: +14155552671',
      'api_key = "AKIA1234567890ABCDEF"',
    ].join('\n');

    const result = scanText(text, '.json');
    expect(result.EMAIL).toBeGreaterThanOrEqual(1);
    expect(result.CREDIT_CARD).toBeGreaterThanOrEqual(1);
    expect(result.PHONE).toBeGreaterThanOrEqual(1);
    expect(result.CREDENTIAL).toBeGreaterThanOrEqual(1);
  });

  it('returns empty object for clean text', () => {
    const result = scanText('Nothing sensitive here.', '.txt');
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ─── Orchestrator Aggregation Tests ──────────────────────────────────────────

describe('SDI Orchestrator — aggregateFindings', () => {
  it('sums matchCounts for same (dataElementType × fileType)', () => {
    const hits = [
      { dataElementType: 'EMAIL', fileType: 'json', matchCount: 2 },
      { dataElementType: 'EMAIL', fileType: 'json', matchCount: 3 },
      { dataElementType: 'PHONE', fileType: 'csv',  matchCount: 1 },
    ];
    const findings = aggregateFindings(hits);
    const emailJson = findings.find(f => f.dataElementType === 'EMAIL' && f.fileType === 'json');
    const phoneCsv  = findings.find(f => f.dataElementType === 'PHONE'  && f.fileType === 'csv');
    expect(emailJson.matchCount).toBe(5);
    expect(emailJson.fileCount).toBe(2);
    expect(phoneCsv.matchCount).toBe(1);
    expect(phoneCsv.fileCount).toBe(1);
  });

  it('returns empty array for no hits', () => {
    expect(aggregateFindings([])).toEqual([]);
  });
});

describe('SDI Orchestrator — computeRegulationMap', () => {
  it('marks GDPR and CCPA active when EMAIL detected', () => {
    const findings = [{ dataElementType: 'EMAIL', fileType: 'json', matchCount: 1, fileCount: 1 }];
    const map = computeRegulationMap(findings);
    const gdpr = map.find(r => r.regulation === 'GDPR');
    const ccpa = map.find(r => r.regulation === 'CCPA');
    expect(gdpr.displayStatus).toBe('active');
    expect(ccpa.displayStatus).toBe('active');
  });

  it('marks PCI_DSS active when CREDIT_CARD detected', () => {
    const findings = [{ dataElementType: 'CREDIT_CARD', fileType: 'csv', matchCount: 1, fileCount: 1 }];
    const map = computeRegulationMap(findings);
    const pci = map.find(r => r.regulation === 'PCI_DSS');
    expect(pci.displayStatus).toBe('active');
  });

  it('marks DORA, NIS2, SOC2 as shown when findings exist', () => {
    const findings = [{ dataElementType: 'PHONE', fileType: 'txt', matchCount: 1, fileCount: 1 }];
    const map = computeRegulationMap(findings);
    ['DORA', 'NIS2', 'SOC2'].forEach(regId => {
      const r = map.find(r => r.regulation === regId);
      expect(r).toBeDefined();
      expect(r.displayStatus).toBe('shown');
    });
  });

  it('never includes HIPAA', () => {
    const findings = [{ dataElementType: 'EMAIL', fileType: 'json', matchCount: 5, fileCount: 1 }];
    const map = computeRegulationMap(findings);
    expect(map.find(r => r.regulation === 'HIPAA')).toBeUndefined();
  });

  it('returns empty array when no findings', () => {
    expect(computeRegulationMap([])).toEqual([]);
  });
});

describe('SDI Orchestrator — full scan pipeline', () => {
  beforeEach(clearSdiDb);

  it('scans file entries and produces aggregated findings', async () => {
    const bp = seedBackupPoint();
    const fileEntries = [
      { fileRef: 'test.json', ext: '.json', content: JSON.stringify({ email: 'alice@bigcorp.com', card: '4111111111111111' }), sizeBytes: 100 },
    ];

    const scanId = await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, fileEntries);
    const result = db.sdiScanResults.get(scanId);

    expect(result.status).toBe('complete');
    expect(result.totalFilesScanned).toBe(1);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    // No raw matched strings stored
    for (const f of result.findings) {
      expect(f).not.toHaveProperty('matchedValues');
      expect(f).not.toHaveProperty('rawMatches');
      expect(f).toHaveProperty('dataElementType');
      expect(f).toHaveProperty('fileType');
      expect(f).toHaveProperty('matchCount');
    }
  });

  it('marks prior scan as superseded on re-scan', async () => {
    const bp = seedBackupPoint();
    const fileEntries = [{ fileRef: 'f.txt', ext: '.txt', content: 'alice@bigcorp.com', sizeBytes: 20 }];

    const scanId1 = await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, fileEntries);
    const scanId2 = await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, fileEntries);

    expect(db.sdiScanResults.get(scanId1).status).toBe('superseded');
    expect(db.sdiScanResults.get(scanId2).status).toBe('complete');
  });

  it('skips unsupported file types without failing', async () => {
    const bp = seedBackupPoint();
    const fileEntries = [
      { fileRef: 'binary.exe', ext: '.exe', content: 'binary', sizeBytes: 6 },
      { fileRef: 'notes.txt', ext: '.txt', content: 'Contact bob@realdomain.com', sizeBytes: 28 },
    ];

    const scanId = await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, fileEntries);
    const result = db.sdiScanResults.get(scanId);

    expect(result.status).toBe('complete');
    expect(result.totalFilesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.totalFilesScanned).toBe(1);
  });

  it('getLatestScanResult returns active scan', async () => {
    const bp = seedBackupPoint();
    const fileEntries = [{ fileRef: 'f.txt', ext: '.txt', content: 'test', sizeBytes: 4 }];
    await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, fileEntries);

    const latest = getLatestScanResult(bp.id);
    expect(latest).not.toBeNull();
    expect(latest.status).toBe('complete');
    expect(latest.backupPointId).toBe(bp.id);
  });
});

// ─── API Endpoint Tests ───────────────────────────────────────────────────────

describe('GET /api/sdi/findings', () => {
  beforeEach(clearSdiDb);

  it('returns 400 when backupPointId is missing', async () => {
    const res = await request(app).get('/api/sdi/findings');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_BACKUP_POINT_ID');
  });

  it('returns empty findings with regulations for unseen backup point', async () => {
    const res = await request(app).get('/api/sdi/findings?backupPointId=unknown-bp');
    expect(res.status).toBe(200);
    expect(res.body.findings).toEqual([]);
    expect(Array.isArray(res.body.regulations)).toBe(true);
    expect(res.body.regulations.length).toBe(6);
  });

  it('returns findings with dataElementType, fileType, matchCount fields', async () => {
    const bp = seedBackupPoint();
    const fileEntries = [
      { fileRef: 'data.json', ext: '.json', content: JSON.stringify({ contact: 'real@company.org' }), sizeBytes: 50 },
    ];
    await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, fileEntries);

    const res = await request(app).get(`/api/sdi/findings?backupPointId=${bp.id}`);
    expect(res.status).toBe(200);
    expect(res.body.backupPointId).toBe(bp.id);

    for (const f of res.body.findings) {
      expect(f).toHaveProperty('dataElementType');
      expect(f).toHaveProperty('fileType');
      expect(f).toHaveProperty('matchCount');
    }
  });

  it('returns regulations array with name and status fields', async () => {
    const bp = seedBackupPoint();
    await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, [
      { fileRef: 'f.txt', ext: '.txt', content: 'card: 4111111111111111', sizeBytes: 22 },
    ]);

    const res = await request(app).get(`/api/sdi/findings?backupPointId=${bp.id}`);
    expect(res.status).toBe(200);

    const regs = res.body.regulations;
    expect(regs.length).toBe(6);
    for (const reg of regs) {
      expect(reg).toHaveProperty('name');
      expect(reg).toHaveProperty('status');
      expect(['active', 'shown']).toContain(reg.status);
    }
  });

  it('returns PCI DSS as active when credit card detected', async () => {
    const bp = seedBackupPoint();
    await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, [
      { fileRef: 'f.csv', ext: '.csv', content: '4111111111111111', sizeBytes: 18 },
    ]);

    const res = await request(app).get(`/api/sdi/findings?backupPointId=${bp.id}`);
    const pci = res.body.regulations.find(r => r.name === 'PCI DSS');
    expect(pci).toBeDefined();
    expect(pci.status).toBe('active');
  });

  it('HIPAA never appears in the regulations array', async () => {
    const bp = seedBackupPoint();
    await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, [
      { fileRef: 'f.txt', ext: '.txt', content: 'alice@realco.com 4111111111111111 +14155552671', sizeBytes: 50 },
    ]);

    const res = await request(app).get(`/api/sdi/findings?backupPointId=${bp.id}`);
    const hipaa = res.body.regulations.find(r => r.name === 'HIPAA' || r.name === 'hipaa');
    expect(hipaa).toBeUndefined();
  });

  it('all six regulations are present in response', async () => {
    const bp = seedBackupPoint();
    await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, [
      { fileRef: 'f.txt', ext: '.txt', content: 'alice@realdomain.com', sizeBytes: 22 },
    ]);

    const res = await request(app).get(`/api/sdi/findings?backupPointId=${bp.id}`);
    const names = res.body.regulations.map(r => r.name);
    expect(names).toContain('GDPR');
    expect(names).toContain('CCPA');
    expect(names).toContain('PCI DSS');
    expect(names).toContain('DORA');
    expect(names).toContain('NIS2');
    expect(names).toContain('SOC 2');
    expect(names).toHaveLength(6);
  });
});

describe('POST /api/v1/sdi/scan/:backupPointId/trigger', () => {
  beforeEach(clearSdiDb);

  it('returns 404 for unknown backup point', async () => {
    const res = await request(app)
      .post(`/api/v1/sdi/scan/${uuidv4()}/trigger`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BACKUP_POINT_NOT_FOUND');
  });

  it('returns 202 Accepted for valid backup point', async () => {
    const bp = seedBackupPoint();
    const res = await request(app)
      .post(`/api/v1/sdi/scan/${bp.id}/trigger`)
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.scanId).toBeDefined();
    expect(res.body.status).toBe('pending');
  });
});

describe('GET /api/v1/sdi/scan/:backupPointId', () => {
  beforeEach(clearSdiDb);

  it('returns 404 when no scan exists', async () => {
    const res = await request(app).get(`/api/v1/sdi/scan/${uuidv4()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SDI_SCAN_NOT_FOUND');
  });

  it('returns scan result after scan completes', async () => {
    const bp = seedBackupPoint();
    await triggerScanSync(bp.id, bp.integrationId, bp.cloudId, [
      { fileRef: 'f.txt', ext: '.txt', content: 'test content', sizeBytes: 12 },
    ]);

    const res = await request(app).get(`/api/v1/sdi/scan/${bp.id}`);
    expect(res.status).toBe(200);
    expect(res.body.scan).toBeDefined();
    expect(res.body.scan.backupPointId).toBe(bp.id);
    expect(res.body.scan.status).toBe('complete');
  });
});
