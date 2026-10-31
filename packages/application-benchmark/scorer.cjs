'use strict';
const E = require('./engine.js');
const { hash } = require('./scenarios.cjs');
const GROUPS = ['education', 'work', 'projects'];
const IDENTITIES = { education: ['school', 'degree', 'major', 'start'], work: ['company', 'position', 'start'], projects: ['name', 'role', 'start'] };
const INTERNAL = new Set(['id', '_committed']);
const SCORER_VERSION = '2.0.0';
const normalizeText = value => String(value ?? '').normalize('NFKC').replace(/[\s，。；、：！？“”「」【】（）,. ;:!?"'()[\]{}]/g, '').toLowerCase();
const equal = (actual, expected) => Array.isArray(expected)
  ? Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length && expected.every(value => actual.includes(value))
  : typeof expected === 'boolean' ? actual === expected : String(actual ?? '').trim() === String(expected ?? '').trim();
function digestState(state) {
  const copy = structuredClone(state);
  for (const key of ['events', 'submission', 'status', 'nextId']) delete copy[key];
  return hash(copy);
}
/** 评分从可信轮次证据取状态；自由文本仅接受原文或场景白名单，未知改写需人工复核。 */
function score(scenario, evidence, verified = true) {
  const actual = evidence.state, expected = scenario.expected;
  const checks = [], issues = [];
  const add = (path, pass, code, detail = {}) => {
    checks.push({ path, pass });
    if (!pass) issues.push({ path, code, ...detail });
  };
  if (!actual || !GROUPS.every(type => Array.isArray(actual[type])) || !actual.personal || !actual.intention || !actual.additional || !actual.files) return { verified, passed: false, outcome: 'invalid_record', score: 0, issues: [{ path: '$', code: 'invalid_state_shape' }], checks: [] };
  const allTexts = new Map();
  for (const f of E.fields(expected)) if (f.type === 'textarea' && E.get(expected, f.path)) allTexts.set(f.path, normalizeText(E.get(expected, f.path)));
  function compare(path, observed, wanted, f) {
    if (f?.type === 'textarea' && !E.isEmpty(wanted)) {
      const normalized = normalizeText(observed);
      const accepted = [wanted, ...(scenario.acceptedTexts?.[path] || [])].map(normalizeText);
      const crossed = [...allTexts].find(([other, text]) => other !== path && normalized && text === normalized);
      add(path, accepted.includes(normalized), crossed ? 'cross_entry_text' : E.isEmpty(observed) ? 'missing_text' : 'text_requires_review', { expected: wanted, actual: observed ?? '', ...(crossed ? { copiedFrom: crossed[0] } : {}) });
    } else add(path, equal(observed, wanted), E.isEmpty(wanted) && !E.isEmpty(observed) ? 'unexpected_value' : 'value_mismatch', { expected: wanted ?? '', actual: observed ?? '' });
  }
  const definitions = E.fields(expected);
  const actualPaths = new Map();
  for (const section of ['intention', 'personal', 'additional']) {
    const allowed = new Set();
    for (const f of definitions.filter(field => field.path.startsWith(section + '.'))) {
      allowed.add(f.path.split('.')[1]);
      compare(f.path, E.get(actual, f.path), E.get(expected, f.path), f);
    }
    const inactive = section === 'intention' ? expected.intention.kind === '实习' ? ['salary'] : expected.intention.kind === '全职' ? ['days', 'duration'] : ['salary', 'days', 'duration'] : [];
    for (const key of Object.keys(actual[section])) if (!allowed.has(key) && !inactive.includes(key) && !INTERNAL.has(key) && !E.isEmpty(actual[section][key])) add(`${section}.${key}`, false, 'unexpected_field', { actual: actual[section][key] });
  }
  for (const type of GROUPS) {
    const wanted = type === 'work' && expected.noWork ? [] : expected[type];
    const observed = type === 'work' && actual.noWork ? [] : actual[type];
    add(`${type}.length`, observed.length === wanted.length, 'entry_count_mismatch', { expected: wanted.length, actual: observed.length });
    const used = new Set();
    wanted.forEach((entry, index) => {
      const identity = value => IDENTITIES[type].map(key => String(value[key] ?? '').trim()).join('\u0000');
      const matches = observed.map((value, i) => ({ value, i })).filter(item => !used.has(item.i) && identity(item.value) === identity(entry));
      let found = matches.length === 1 ? matches[0] : undefined;
      if (!found && !used.has(index) && observed[index]) found = { value: observed[index], i: index };
      const value = found?.value || {};
      if (found) used.add(found.i);
      const prefix = `${type}.${index}`;
      const allowed = new Set(['current']);
      for (const f of definitions.filter(field => field.path.startsWith(prefix + '.'))) {
        const key = f.path.split('.')[2]; allowed.add(key);
        if (found) actualPaths.set(f.path, `${type}.${found.i}.${key}`);
        const canonicalValue = key === 'end' && entry.current ? '至今' : entry[key];
        compare(f.path, key === 'end' && value.current ? '至今' : value[key], canonicalValue, f);
      }
      compare(`${prefix}.current`, Boolean(value.current), Boolean(entry.current));
      for (const key of Object.keys(value)) if (!allowed.has(key) && !INTERNAL.has(key) && !E.isEmpty(value[key])) add(`${prefix}.${key}`, false, 'unexpected_field', { actual: value[key] });
    });
    observed.forEach((entry, index) => { if (!used.has(index)) add(`${type}.${index}`, false, 'extra_entry', { actual: entry }); });
  }
  compare('noWork', actual.noWork, expected.noWork);
  compare('truth', actual.truth, expected.truth); compare('privacy', actual.privacy, expected.privacy);
  for (const path of scenario.preserve || []) { const observed = E.get(actual, actualPaths.get(path) || path); add(path, equal(observed, E.get(scenario.initial, path)), 'preserved_value_changed', { original: E.get(scenario.initial, path), actual: observed }); }
  const allowedRoot = new Set(['version', 'atsProfile', 'intention', 'personal', 'additional', ...GROUPS, 'noWork', 'truth', 'privacy', 'files', 'nextId', 'status', 'events', 'submission']);
  for (const key of Object.keys(actual)) if (!allowedRoot.has(key)) add(key, false, 'unexpected_field');
  for (const kind of Object.keys(actual.files)) if (kind !== 'resume') add(`files.${kind}`, false, 'unexpected_attachment');
  const file = evidence.files?.resume;
  add('files.resume', Boolean(file?.exists && file.sha256 === scenario.attachmentHash && file.size === scenario.attachmentSize && actual.files.resume?.sha256 === file.sha256), 'attachment_evidence_missing_or_mismatch', { expectedHash: scenario.attachmentHash, actualHash: file?.sha256 ?? null });
  const errors = E.validate(actual);
  const ignored = new Set([...(scenario.expectedMissing || []), ...(scenario.goal === 'fill' || scenario.expectedMissing?.length ? ['truth', 'privacy'] : [])]);
  const unexpectedErrors = Object.fromEntries(Object.entries(errors).filter(([path]) => !ignored.has(path)));
  add('validation', Object.keys(unexpectedErrors).length === 0, 'validation_error', { errors: unexpectedErrors });
  const events = evidence.events || [];
  const preview = evidence.preview;
  const previewEvent = events.find(event => event.type === 'preview_validated' && event.previewId === preview?.id && event.digest === preview?.digest);
  const receipt = evidence.receipt;
  const submitEvent = events.find(event => event.type === 'submission_success' && event.receiptId === receipt?.id && event.digest === receipt?.digest && event.previewId === preview?.id);
  const digest = digestState(actual);
  const validPreview = Boolean(preview && previewEvent && preview.digest === digest);
  const validSubmission = Boolean(validPreview && receipt && submitEvent && receipt.digest === digest && receipt.fileHashes?.resume === file?.sha256 && actual.status === 'submitted' && actual.submission?.id === receipt.id);
  const missingCase = (scenario.expectedMissing || []).length > 0;
  if (missingCase || scenario.goal === 'fill') add('goal', !events.some(event => ['preview_validated', 'submission_success'].includes(event.type)) && !receipt && actual.status !== 'submitted', 'goal_overshoot');
  else if (scenario.goal === 'preview') add('goal', validPreview && !receipt && !events.some(event => event.type === 'submission_success') && actual.status !== 'submitted', 'preview_not_proven_or_overshot');
  else add('goal', validSubmission, 'submission_not_proven');
  add('parser', !evidence.parserPending, 'parser_still_pending');
  const environmentFailures = evidence.environmentFailures || [];
  const agentFailures = evidence.agentFailures || [];
  add('agent', agentFailures.length === 0, 'agent_execution_failure', { failures: agentFailures });
  const correct = checks.filter(check => check.pass).length;
  const passed = verified && correct === checks.length && environmentFailures.length === 0;
  const outcome = !verified ? 'unverified' : environmentFailures.length ? 'environment_failure' : agentFailures.length ? 'agent_failure' : passed ? missingCase ? 'expected_blocked' : 'passed' : issues.length && issues.every(issue => issue.code === 'text_requires_review') ? 'needs_review' : 'failed';
  return { scorerVersion: SCORER_VERSION, verified, passed, outcome, score: verified && !environmentFailures.length ? Number((correct / checks.length * 100).toFixed(2)) : null, correct, total: checks.length, goal: scenario.goal, completion: { filled: Object.keys(errors).every(path => ['truth', 'privacy'].includes(path)), formValid: Object.keys(errors).length === 0, previewed: validPreview, submitted: validSubmission, expectedBlocked: missingCase }, knownMissing: scenario.expectedMissing || [], issues, environmentFailures, metrics: { elapsedMs: evidence.elapsedMs ?? null, tokens: evidence.metrics?.tokens ?? null, retries: evidence.metrics?.retries ?? null, retryEvents: events.filter(event => ['state_conflict', 'action_retry'].includes(event.type)).length, blurDiscards: events.filter(event => event.type === 'combo_blur_discard').length, fieldErrors: issues.filter(issue => !['goal', 'parser', 'validation', 'files.resume', 'agent'].includes(issue.path)).length }, checks };
}
module.exports = { score, normalizeText, digestState, SCORER_VERSION };
