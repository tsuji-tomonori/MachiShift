import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This gate checks preservation and evidence integrity. It does NOT promote
// unexecuted acceptance criteria to PASS just because software tests passed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledger = JSON.parse(readFileSync(resolve(root, 'docs/requirements-ledger.json'), 'utf8'));
const errors = [];
const statuses = new Set(['NOT_STARTED', 'IN_PROGRESS', 'PASS', 'FAIL', 'BLOCKED', 'NEEDS_DECISION']);
const expected = { GEO: 8, GAME: 13, DEST: 10, PAINT: 9, AT: 13 };
const ids = new Map();
const assert = (condition, message) => { if (!condition) errors.push(message); };
const safePath = value => typeof value === 'string' && !isAbsolute(value) && !relative(root, resolve(root, value)).startsWith('..');
const sourceLines = new Map();

for (const [path, hash] of Object.entries(ledger.sourceDigests ?? {})) {
  assert(safePath(path), `Unsafe source path: ${path}`);
  if (!safePath(path)) continue;
  const location = resolve(root, path);
  assert(existsSync(location), `Missing preserved source: ${path}`);
  if (!existsSync(location)) continue;
  const content = readFileSync(location);
  assert(createHash('sha256').update(content).digest('hex') === hash, `Immutable source hash mismatch: ${path}`);
  sourceLines.set(path, content.toString('utf8').split(/\r?\n/));
}
for (const filename of ['requirements.md', 'sources.json', 'asset_manifest_template.csv', 'implementation_prompt.md']) {
  assert(sourceLines.has(`source_materials/${filename}`), `Missing mandatory source digest: ${filename}`);
}

for (const row of ledger.rows ?? []) {
  assert(typeof row.id === 'string' && !ids.has(row.id), `Duplicate or absent ID: ${row.id}`);
  ids.set(row.id, row);
  assert(row.mandatory === true, `${row.id}: requirement scope must not be silently waived`);
  for (const key of ['originalText', 'acceptanceCriteria']) {
    assert(typeof row[key] === 'string' && row[key].length > 0, `${row.id}: missing ${key}`);
  }
  assert(statuses.has(row.status), `${row.id}: invalid status ${row.status}`);
  assert(Array.isArray(row.implementation) && row.implementation.length > 0, `${row.id}: missing implementation mapping`);
  assert(Array.isArray(row.testIds) && row.testIds.length > 0, `${row.id}: missing test mapping`);
  assert(Array.isArray(row.evidence), `${row.id}: evidence must be an array`);
  const original = sourceLines.get(row.source?.path)?.[row.source?.line - 1];
  assert(original === row.originalText, `${row.id}: original text does not match immutable source line`);
  const group = row.id?.split('-')[0];
  if (Object.hasOwn(expected, group)) {
    assert(row.classification === (group === 'AT' ? 'original_acceptance' : 'original_requirement'), `${row.id}: original classification changed`);
    assert(original?.split('|')[1]?.trim() === row.id, `${row.id}: source row has another ID`);
  } else {
    assert(row.classification === 'execution_management_addition', `${row.id}: added management rows must be labeled`);
  }
  if (row.status !== 'PASS') {
    assert(typeof row.unmetReason === 'string' && row.unmetReason.trim(), `${row.id}: non-PASS needs unmet reason`);
    assert(typeof row.nextAction === 'string' && row.nextAction.trim(), `${row.id}: non-PASS needs next action`);
  }
  for (const evidence of row.evidence ?? []) {
    for (const key of ['id', 'kind', 'path', 'executedAt', 'commit', 'environment', 'observations', 'scope']) {
      assert(typeof evidence[key] === 'string' && evidence[key].trim(), `${row.id}: evidence missing ${key}`);
    }
    assert(['PASS', 'FAIL', 'BLOCKED'].includes(evidence.result), `${row.id}: evidence needs an executed/blocked outcome`);
    assert(Number.isFinite(Date.parse(evidence.executedAt)), `${row.id}: evidence execution date invalid`);
    assert(safePath(evidence.path) && existsSync(resolve(root, evidence.path ?? '')), `${row.id}: evidence file missing or unsafe: ${evidence.path}`);
    assert(typeof evidence.fullRequirement === 'boolean', `${row.id}: evidence must declare its scope coverage`);
  }
  if (row.status === 'PASS') {
    assert((row.evidence ?? []).some(e => e.result === 'PASS' && e.fullRequirement === true), `${row.id}: PASS needs executed evidence covering the full requirement`);
    for (const path of row.implementation ?? []) assert(safePath(path) && existsSync(resolve(root, path)), `${row.id}: PASS implementation absent: ${path}`);
  }
}
for (const [group, count] of Object.entries(expected)) {
  for (let n = 1; n <= count; n++) assert(ids.has(`${group}-${String(n).padStart(2, '0')}`), `Original requirement omitted: ${group}-${String(n).padStart(2, '0')}`);
  assert([...ids.keys()].filter(id => id.startsWith(`${group}-`)).length === count, `${group}: original ID range changed`);
}
assert(ledger.originalRequirementCount === 53, 'Canonical original count must be 53');
for (const row of ids.values()) for (const id of row.relatedRequirementIds ?? []) assert(ids.has(id), `${row.id}: related requirement missing: ${id}`);
const counts = Object.fromEntries([...statuses].map(status => [status, [...ids.values()].filter(r => r.status === status).length]));
const acceptanceComplete = ids.size > 0 && [...ids.values()].every(row => row.status === 'PASS');
assert(ledger.overallStatus === (acceptanceComplete ? 'ACCEPTANCE_COMPLETE' : 'ACCEPTANCE_INCOMPLETE'), 'Overall status does not match all mandatory rows');
const integrityPassed = errors.length === 0;
if (process.argv.includes('--require-acceptance')) assert(acceptanceComplete, 'Full acceptance is incomplete; see non-PASS requirement rows');
const report = {
  checkedAt: new Date().toISOString(),
  integrityPassed,
  requestedGatePassed: errors.length === 0,
  acceptanceComplete,
  originalRequirementCount: 53,
  totalRequirementCount: ids.size,
  counts,
  nonPassingIds: [...ids.values()].filter(row => row.status !== 'PASS').map(row => row.id),
  errors,
};
const reportArgument = process.argv.indexOf('--report');
if (reportArgument >= 0) {
  const reportPath = process.argv[reportArgument + 1];
  if (!safePath(reportPath)) throw new Error('Report must be a relative project path');
  mkdirSync(dirname(resolve(root, reportPath)), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = errors.length ? 1 : 0;
