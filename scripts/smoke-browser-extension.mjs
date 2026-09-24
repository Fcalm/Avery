import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { AgentHost } from '../apps/backend/dist/electron/backend/agent-host.js';
import { BrowserExtensionBridge, BrowserExtensionManifestVersion, BrowserExtensionProtocolRevision } from '../apps/backend/dist/electron/backend/browser-extension-bridge.js';
import { AgentBrowserRuntime } from '../apps/backend/dist/electron/backend/agent-browser-runtime.js';
import { HostSdkVersion } from '@avery/agent-module-host';
import { CreateDefaultModules } from '../packages/agent-modules-defaults/dist/index.js';
import { BuildPb03PreflightEvidence, CanRestorePb03Pairing, ClassifyPb03Preflight, CreatePb03BrowserLaunchGuard, RestorePb03Pairing, WaitForPb03Handshake } from './fixtures/pb03-preflight.mjs';
import {
  NormalizeToolResultEnvelope,
  ParseExpectedToolResult,
  ResolvePb03PrimaryFailure,
  VerifyPb03KernelTurnLimit,
  VerifyNavigationEvidence,
  VerifyPb03ChildIdentity,
  VerifyPb03ConfirmationProposal,
  VerifyPb03ExactlyOneCleanupObservation,
  VerifyPb03PreChildEvidence,
  VerifyPb03PreFinalGate,
  VerifyPb03SwitchResult,
  VerifyPb03UploadOracle,
  VerifyPb03ValidationGate,
} from './fixtures/pb03-tool-result.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const index = item.indexOf('=');
  return index > 2 ? [item.slice(2, index), item.slice(index + 1)] : [item.slice(2), 'true'];
}));
const hostInitOnly = args['host-init-only'] === 'true';
const engine = args.engine === 'edge' ? 'edge' : 'chrome';
const allowBrowserLaunch = args['allow-browser-launch'] === 'true';
const expectedExtensionVersion = BrowserExtensionManifestVersion;
const expectedExtensionProtocolRevision = BrowserExtensionProtocolRevision;
const browserPaths = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};
const projectRoot = resolve(import.meta.dirname, '..');
const extensionPath = resolve(projectRoot, 'apps', 'browser-extension');
const fixturePath = resolve(projectRoot, 'scripts', 'fixtures', 'pb03-browser-application.html');
const childFixturePath = resolve(projectRoot, 'scripts', 'fixtures', 'pb03-browser-child.html');
const uploadPath = resolve(projectRoot, 'scripts', 'fixtures', 'PB-03-synthetic-resume.pdf');
const browserPath = browserPaths[engine];
const execFileAsync = promisify(execFile);
const uploadFileId = 'attachment://pb03/synthetic-resume.pdf';
const uploadName = 'PB-03-synthetic-resume.pdf';
const fixtureValues = { name: 'PB-03 Synthetic Candidate', direction: '研发', province: '广东省', city: '佛山市', date: '2000-01-15' };
const allowedFixtureClickPurposes = new Set([
  'open-province-options', 'choose-province', 'open-city-options', 'choose-city', 'open-target-blank-child',
]);

function ParsePort(value) {
  if (value === undefined || value === 'ephemeral') return 0;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw Object.assign(new Error('Invalid Bridge port. Use an integer from 1 to 65535 or ephemeral.'), { code: 'PB03_INVALID_BRIDGE_PORT' });
  }
  return port;
}

function Sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function SafeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.origin + url.pathname;
  } catch { return null; }
}

function SafeFixtureUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) {
      return url.protocol + '//' + url.hostname + ':<ephemeral>' + url.pathname;
    }
    return url.origin + url.pathname;
  } catch { return null; }
}

function HashedIdentifier(kind, value) {
  if (value === undefined || value === null || value === '') return null;
  return kind + ':' + Sha256(String(value)).slice(0, 16);
}

function AddTimeline(observations, event, details = {}) {
  observations.taskTabTimeline.push({ at: new Date().toISOString(), event, ...details });
}

function RecordTaskTargets(observations, taskId, targets, source) {
  const taskIdHash = HashedIdentifier('task', taskId);
  const sanitized = (Array.isArray(targets) ? targets : []).flatMap((target) => {
    // CDP targetId and extension tabId are distinct raw identities.  Evidence
    // may hash them for the artifact, but must never manufacture one from the
    // other when a bridge record omits a field.
    const targetIdHash = HashedIdentifier('target', target?.targetId);
    if (!targetIdHash) return [];
    return [{
      targetIdHash,
      tabIdHash: HashedIdentifier('tab', target?.tabId),
      windowIdHash: Number.isSafeInteger(target?.windowId) ? HashedIdentifier('window', target.windowId) : null,
      windowIdObserved: Number.isSafeInteger(target?.windowId),
      openerTabIdHash: Number.isSafeInteger(target?.openerTabId) ? HashedIdentifier('tab', target.openerTabId) : null,
      targetIdObserved: typeof target?.targetId === 'string' && target.targetId.length > 0,
      tabIdObserved: Number.isSafeInteger(target?.tabId),
      ownerTaskIdHash: taskIdHash,
      active: target?.active === true,
      attached: typeof target?.attached === 'boolean' ? target.attached : null,
      url: SafeFixtureUrl(target?.url),
    }];
  });
  const record = { at: new Date().toISOString(), source, taskIdHash, targets: sanitized };
  observations.taskTargetSnapshots.push(record);
  return sanitized;
}

function TargetIdentity(target) {
  if (!target || typeof target !== 'object') return null;
  const targetId = typeof target.targetId === 'string' && target.targetId.length > 0 ? target.targetId : null;
  // Chrome's extension tabId is a raw numeric identity.  Never treat a CDP
  // targetId (or URL/title) as a substitute tab selector.
  const tabId = Number.isSafeInteger(target.tabId) ? target.tabId : null;
  const windowId = Number.isSafeInteger(target.windowId) ? target.windowId : null;
  const openerTabId = Number.isSafeInteger(target.openerTabId) ? target.openerTabId : null;
  return { targetId, tabId, windowId, openerTabId };
}

async function WaitForTaskTarget(bridge, taskId, predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  const boundedTimeout = Math.max(100, Math.min(timeoutMs, 10_000));
  const deadline = startedAt + boundedTimeout;
  let attempts = 0;
  let latest = [];
  while (Date.now() < deadline) {
    attempts += 1;
    latest = await ReadTaskTargetInfos(bridge, taskId);
    const match = latest.find((target) => predicate(target));
    if (match) return { target: match, attempts, elapsedMs: Math.max(0, Date.now() - startedAt) };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  }
  const error = new Error('The task-owned target did not appear before the bounded wait expired.');
  error.code = 'PB03_TARGET_APPEAR_TIMEOUT';
  error.attempts = attempts;
  error.targetCount = latest.length;
  throw error;
}

async function ReadTaskTargetInfos(bridge, taskId) {
  if (!bridge || typeof taskId !== 'string' || !taskId) throw new Error('Task-scoped target evidence is unavailable.');
  const response = await bridge.Request(engine, 'cdp', { id: 1, method: 'Target.getTargets', params: {} }, {
    deadline: Date.now() + 10_000,
    browserTaskId: taskId,
  });
  const targets = response?.result?.targetInfos;
  if (!Array.isArray(targets)) throw new Error('Task-scoped Target.getTargets did not return targetInfos.');
  return targets;
}

function ObserveTaskCloseReceipts(bridge, receiptsByTaskHash) {
  const request = bridge.Request.bind(bridge);
  bridge.Request = async (targetEngine, operation, payload, options = {}) => {
    const taskIdHash = HashedIdentifier('task', options?.browserTaskId);
    try {
      const result = await request(targetEngine, operation, payload, options);
      if (operation === 'close_task') {
        const receipts = receiptsByTaskHash.get(taskIdHash) ?? [];
        receipts.push({ at: new Date().toISOString(), taskIdHash, acknowledged: true, closed: result?.closed === true });
        receiptsByTaskHash.set(taskIdHash, receipts);
      }
      return result;
    } catch (error) {
      if (operation === 'close_task') {
        const receipts = receiptsByTaskHash.get(taskIdHash) ?? [];
        receipts.push({ at: new Date().toISOString(), taskIdHash, acknowledged: false, closed: false, error: SafeError(error) });
        receiptsByTaskHash.set(taskIdHash, receipts);
      }
      throw error;
    }
  };
}

function SafeCleanupOutcomes(outcomes) {
  return (Array.isArray(outcomes) ? outcomes : []).map((outcome) => ({
    status: typeof outcome?.status === 'string' ? outcome.status : 'unknown',
    taskIdHash: HashedIdentifier('task', outcome?.browserTaskId),
    ...(typeof outcome?.code === 'string' ? { code: outcome.code } : {}),
    ...(typeof outcome?.message === 'string' ? { message: SafeError(new Error(outcome.message)) } : {}),
    closedTabs: Number.isSafeInteger(outcome?.closedTabs) ? outcome.closedTabs : null,
    unknownTabs: Number.isSafeInteger(outcome?.unknownTabs) ? outcome.unknownTabs : null,
  }));
}

function SafeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^\s)]+/gi, (value) => SafeFixtureUrl(value) ?? '[REDACTED_URL]')
    .replace(/[A-Za-z]:\\[^\r\n ]+/g, '[REDACTED_PATH]')
    .slice(0, 500);
}

function RecordTargetEvidenceError(observations, error, source) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = SafeError(error);
  const retired = code === 'BROWSER_TASK_RETIRED' || /browserTaskId has already been retired/i.test(message);
  // CloseTask 后的旧 task 查询是 checker 自身的越界，不是页面/Provider 首因。
  // 保留证据供审计，但绝不能覆盖 providerFailure 或 Host terminal reason。
  if (retired) {
    (observations.secondaryCheckerErrors ??= []).push({ source, code: code || 'BROWSER_TASK_RETIRED', message });
    return;
  }
  (observations.targetEvidenceErrors ??= []).push(message);
}

function RecordPrimaryObservationFailure(observations, failure) {
  const nextSequence = Number.isSafeInteger(observations.primaryFailureSequence)
    ? observations.primaryFailureSequence + 1 : 1;
  observations.primaryFailureSequence = nextSequence;
  const normalized = {
    primary: true,
    sequence: nextSequence,
    code: typeof failure?.code === 'string' ? failure.code : 'PB03_SMOKE_GATE_FAILED',
    phase: typeof failure?.phase === 'string' ? failure.phase : 'smoke-gate',
    message: typeof failure?.message === 'string' ? failure.message : 'PB03 smoke gate failed.',
    ...(failure?.details && typeof failure.details === 'object' ? { details: failure.details } : {}),
  };
  if (observations.providerFailure?.primary === true) {
    const secondary = { ...normalized, primary: false, secondaryOf: observations.providerFailure.code };
    (observations.primaryFailureSequenceLog ??= []).push(secondary);
    (observations.secondaryCheckerErrors ??= []).push({
      source: normalized.phase, sequence: normalized.sequence, code: normalized.code, message: normalized.message,
      secondaryOf: observations.providerFailure.code,
    });
    return observations.providerFailure;
  }
  (observations.primaryFailureSequenceLog ??= []).push(normalized);
  observations.providerFailure = normalized;
  return normalized;
}

async function WorktreeEvidence() {
  try {
    const [root, commit, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, windowsHide: true }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, windowsHide: true }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot, windowsHide: true }),
    ]);
    return { root: String(root.stdout).trim(), commit: String(commit.stdout).trim(), dirty: Boolean(String(status.stdout).trim()) };
  } catch { return { root: projectRoot, commit: null, dirty: null, available: false }; }
}

async function IsBrowserProcessRunning() {
  if (process.platform !== 'win32') return false;
  const processName = engine === 'chrome' ? 'chrome.exe' : 'msedge.exe';
  try {
    const result = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq ' + processName], { windowsHide: true, timeout: 2_000 });
    return new RegExp('^' + processName.replace('.', '\\.'), 'im').test(String(result.stdout));
  } catch { return false; }
}

let launchAttempted = false;
let browserLaunchError = null;
const launchState = { attempted: false, pairPageOpened: false, launchDenied: false, preflightSucceeded: false, sideEffectPerformed: false, restorePerformed: false };
async function LaunchBrowserWithProjectExtension(_engine, url) {
  if (launchAttempted) return;
  const guard = CreatePb03BrowserLaunchGuard({
    allowBrowserLaunch,
    state: launchState,
    spawnBrowser: async (engineName, pairUrl) => {
      const alreadyRunning = await IsBrowserProcessRunning();
      const browserArgs = alreadyRunning || args['load-extension'] === 'false'
        ? [pairUrl]
        : ['--load-extension=' + extensionPath, pairUrl];
      const child = spawn(browserPaths[engineName], browserArgs, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (error) => { browserLaunchError = SafeError(error); });
      child.unref();
    },
  });
  await guard(_engine, url);
  launchAttempted = true;
}

function ToolCall(id, name, toolArguments = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(toolArguments) } };
}

function FindRef(snapshot, expression, options = {}) {
  const refs = snapshot?.refs && typeof snapshot.refs === 'object' ? Object.entries(snapshot.refs) : [];
  const role = typeof options.role === 'string' ? options.role : null;
  return refs.find(([, ref]) => (role === null || ref?.role === role)
    && expression.test([ref?.name, ref?.description, ref?.role, ref?.type, ref?.value].filter(Boolean).join(' ')))?.[0] ?? null;
}

function CreateBusiness() {
  const view = { browserEngine: engine, resumes: [], jobs: [], applications: [] };
  return {
    async GetStoredSettings() { return { browserEngine: engine }; },
    async GetProfiles() { return { items: [] }; },
    async ResolveAttachmentUri(uri) { return uri === uploadFileId ? uploadPath : null; },
    async ResolveAttachmentMarkdownUri() { return null; },
    async LoadViewModel() { return structuredClone(view); },
    async SaveTrackedJob(input) { return { jobId: String(input.jobId ?? input.id ?? ''), jobRevision: 1 }; },
  };
}

function EmptyObservability(events) {
  let activeRequestId = null;
  return {
    RecordLog(level, event, detail) {
      events.push({
        type: 'observability_log',
        requestId: activeRequestId,
        payload: { level, event, detail },
      });
    },
    StartTrace(requestId, sessionId, model) {
      activeRequestId = requestId;
      events.push({ type: 'trace_started', requestId, payload: { sessionId, model } });
    },
    AppendTraceEvent(requestId, eventType, payload) {
      events.push({ type: eventType, requestId, payload: payload && typeof payload === 'object' ? structuredClone(payload) : {} });
    },
    RecordTraceUsage() {},
    FinishTrace(requestId, state, summary) {
      events.push({ type: 'trace_finished', requestId, payload: { state, summary } });
      if (activeRequestId === requestId) activeRequestId = null;
    },
    async GetLogs() { return []; }, async GetTraces() { return []; }, async GetTraceEvents() { return []; },
    async DeleteTraces() { return { deleted: 0 }; },
    async SetTraceRetention(value) { return { traceRetention: value }; },
    async ClearObservability() { return { cleared: true }; },
  };
}

function SafeToolEvents(events) {
  return events.filter((event) => event?.type === 'tool_call' || event?.type === 'tool_result').map((event) => {
    const value = { type: String(event.type), toolName: String(event.payload?.name ?? event.payload?.toolName ?? '') };
    if (event.type === 'tool_result') {
      value.ok = event.payload?.ok === true || event.ok === true;
      if (typeof event.payload?.code === 'string') value.code = event.payload.code;
      if (typeof event.payload?.message === 'string' && event.payload.message) value.message = SafeError(new Error(event.payload.message));
    }
    return value;
  });
}

function SafeLedger(state) {
  return (Array.isArray(state?.toolLedger) ? state.toolLedger : []).flatMap((entry) => {
    const value = Array.isArray(entry) ? entry[1] : entry;
    if (!value || typeof value !== 'object') return [];
    return [{
      toolName: typeof value.toolName === 'string' ? value.toolName : '',
      status: typeof value.status === 'string' ? value.status : '',
      errorCode: typeof value.errorCode === 'string' ? value.errorCode : undefined,
      hasReceipt: Boolean(value.receipt && typeof value.receipt === 'object'),
    }];
  });
}

function SubmissionMonitorExpression() {
  return '(() => {' +
    'if (window.__pb03SubmissionMonitor && window.__pb03SubmissionMonitor.installed) return { installed: true, source: "fixture" };' +
    'const state = { installed: true, source: "smoke" }; window.__pb03SubmissionMonitor = state;' +
    'window.__pb03SubmitAttempts = 0; window.__pb03NetworkSubmitAttempts = 0;' +
    'const write = (method) => !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());' +
    'const countWrite = () => { window.__pb03NetworkSubmitAttempts += 1; };' +
    'document.addEventListener("submit", () => { window.__pb03SubmitAttempts += 1; }, true);' +
    'const originalFetch = window.fetch.bind(window); window.fetch = function(input, init) {' +
      'const method = init && init.method ? init.method : input instanceof Request ? input.method : "GET";' +
      'if (write(method)) countWrite(); return originalFetch(input, init);' +
    '};' +
    'const originalOpen = XMLHttpRequest.prototype.open; const originalSend = XMLHttpRequest.prototype.send;' +
    'XMLHttpRequest.prototype.open = function(method) { this.__pb03Method = method; return originalOpen.apply(this, arguments); };' +
    'XMLHttpRequest.prototype.send = function() { if (write(this.__pb03Method)) countWrite(); return originalSend.apply(this, arguments); };' +
    'if (navigator.sendBeacon) { const originalBeacon = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function() { countWrite(); return originalBeacon.apply(navigator, arguments); }; }' +
    'return { installed: true, source: "smoke" }; })()';
}

function CreateFixtureProvider(fixtureUrl, observations, runtime, bridge) {
  let phase = 0;
  let currentSnapshot = null;
  let provinceOptionEventCursor = 0;
  let cityOptionEventCursor = 0;
  let cityTriggerEventCursor = 0;
  const confirmedToolResults = new Map();
  let pendingToolCall = null;
  const remember = (toolName, result) => {
    const envelope = NormalizeToolResultEnvelope(result, pendingToolCall?.id);
    const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
    observations.toolResults.push({
      toolName,
      toolCallIdHash: HashedIdentifier('call', envelope.toolCallId),
      ok: envelope.ok,
      ...(typeof envelope.code === 'string' ? { code: envelope.code } : {}),
      ...(typeof envelope.message === 'string' && envelope.message ? { message: SafeError(new Error(envelope.message)) } : {}),
    });
    if (toolName === 'BrowserSnapshot') {
      currentSnapshot = data;
      observations.currentPageRevision = Number.isSafeInteger(data?.pageRevision) ? data.pageRevision : observations.currentPageRevision ?? null;
      observations.snapshotCount += 1;
      if (observations.browserTaskId) {
        RecordTaskTargets(observations, observations.browserTaskId, data?.tabs, 'AgentHost BrowserSnapshot task-scoped tabs');
      }
      const refs = data?.refs && typeof data.refs === 'object' ? Object.values(data.refs) : [];
      observations.finalSubmitCandidates = refs.filter((ref) => /submit|提交|申请/i.test(String(ref?.name || '') + ' ' + String(ref?.description || ''))).length;
    }
    if (toolName === 'BrowserReadPage') observations.readTitle = String(data?.title || '');
    if (toolName === 'BrowserValidateForm') {
      const issues = Array.isArray(data?.issues) ? data.issues.flatMap((issue) => {
        if (!issue || typeof issue !== 'object') return [];
        return [{
          ref: typeof issue.ref === 'string' ? issue.ref : null,
          label: typeof issue.label === 'string' ? issue.label : null,
          // BrowserValidateForm calls this field `code`; expose the same
          // value as reason so the artifact states the exact validation cause.
          reason: typeof issue.code === 'string' ? issue.code : null,
          code: typeof issue.code === 'string' ? issue.code : null,
          ...(typeof issue.message === 'string' && issue.message ? { message: SafeError(new Error(issue.message)) } : {}),
        }];
      }) : [];
      observations.validation = {
        valid: data?.valid === true ? true : data?.valid === false ? false : null,
        issueCount: Array.isArray(data?.issues) ? data.issues.length : null,
        issues,
        inspectedFieldCount: Number.isSafeInteger(data?.inspectedFieldCount) ? data.inspectedFieldCount : null,
        validationMetadataAvailable: data?.validationMetadataAvailable === true,
      };
    }
    if (toolName === 'BrowserUploadFile') {
      observations.uploadResult = {
        ok: envelope.ok === true,
        uploaded: data?.uploaded === true,
        fileId: typeof data?.fileId === 'string' ? data.fileId : null,
        fileName: typeof data?.fileName === 'string' ? data.fileName : null,
        fileSize: Number.isSafeInteger(data?.fileSize) ? data.fileSize : null,
        fileSha256: typeof data?.fileSha256 === 'string' ? data.fileSha256 : null,
        pageRevision: Number.isSafeInteger(data?.pageRevision) ? data.pageRevision : null,
        currentUrl: SafeFixtureUrl(data?.currentUrl),
      };
    }
    return { ...data, ...envelope, data };
  };
  const finish = (content, onDelta) => { onDelta?.({ reasoning: '', content }); return { content, toolCalls: [] }; };
  const failRegion = (label, error, onDelta) => {
    const message = `PB03 fixture region oracle failed at ${label}: ${SafeError(error)}`;
    const hadPrimary = observations.providerFailure?.primary === true;
    const recorded = RecordPrimaryObservationFailure(observations, {
      code: 'PB03_FIXTURE_ORACLE_FAILED', phase: label, message,
    });
    if (hadPrimary) {
      throw Object.assign(new Error(observations.providerFailure.message), { code: observations.providerFailure.code, phase: observations.providerFailure.phase, pb03Primary: true });
    }
    onDelta?.({ reasoning: '', content: recorded.message });
    throw Object.assign(new Error(recorded.message), { code: recorded.code, phase: recorded.phase, pb03Primary: true });
  };
  const failPrimary = (code, phaseName, message, onDelta, details = {}) => {
    const hadPrimary = observations.providerFailure?.primary === true;
    const recorded = RecordPrimaryObservationFailure(observations, { code, phase: phaseName, message, details });
    // A first oracle failure is immutable.  Later restore/retired/checker
    // observations are retained as secondary evidence and cannot turn a
    // failed run into a provider "completed" result.
    if (hadPrimary) {
      throw Object.assign(new Error(observations.providerFailure.message), {
        code: observations.providerFailure.code,
        phase: observations.providerFailure.phase,
        pb03Primary: true,
      });
    }
    onDelta?.({ reasoning: '', content: recorded.message });
    throw Object.assign(new Error(recorded.message), { code: recorded.code, phase: recorded.phase, pb03Primary: true });
  };
  const dispatch = (name, toolArguments, purpose) => {
    const id = 'pb03-fixture-' + phase;
    pendingToolCall = { id, toolName: name, purpose };
    observations.actionIntents.push({
      toolName: name,
      purpose,
      toolCallIdHash: HashedIdentifier('call', id),
      // Keep the exact raw tabId/ref/fileId/pageRevision expected by the
      // confirmation gate.  This is fixture metadata, not model-provided
      // evidence, and is never replaced by URL/title matching.
      arguments: structuredClone(toolArguments ?? {}),
    });
    return { content: '', toolCalls: [ToolCall(id, name, toolArguments)] };
  };
  const revision = () => currentSnapshot?.pageRevision;
  const requireRef = (pattern, purpose, role) => {
    const id = FindRef(currentSnapshot, pattern, { role });
    if (!id || !Number.isSafeInteger(revision())) throw new Error('Fixture did not expose the expected ' + purpose + ' control.');
    return { ref: '@' + id, pageRevision: revision() };
  };
  const useResult = (toolName, history) => {
    if (!pendingToolCall || pendingToolCall.toolName !== toolName) {
      throw Object.assign(new Error('Fixture phase expected a different browser tool result.'), { code: 'PB03_TOOL_RESULT_CALL_MISMATCH' });
    }
    const confirmed = confirmedToolResults.get(pendingToolCall.id);
    const result = confirmed ?? ParseExpectedToolResult(history, pendingToolCall.id);
    confirmedToolResults.delete(pendingToolCall.id);
    const consumed = pendingToolCall;
    pendingToolCall = null;
    try { return remember(toolName, result); }
    catch (error) {
      pendingToolCall = consumed;
      throw error;
    }
  };
  const observeRegion = async (label) => {
    const state = await ReadFixtureRegionState(runtime, label);
    observations.regionTimeline.push({
      at: new Date().toISOString(),
      label,
      pageRevision: Number.isSafeInteger(revision()) ? revision() : null,
      state,
    });
    return state;
  };
  const assertCitySnapshotEnabled = (label) => {
    const state = observations.regionTimeline.at(-1)?.state;
    if (state?.city?.disabled === true || String(state?.city?.ariaDisabled || '').toLowerCase() === 'true') {
      throw new Error(`City remained disabled at ${label}: ${JSON.stringify({ city: state.city, pageRevision: revision() })}`);
    }
    const cityRef = Object.values(currentSnapshot?.refs ?? {}).find((ref) => ref?.role === 'combobox' && /城市/i.test(String(ref?.name || ref?.description || '')));
    if (!cityRef || cityRef.disabled === true) {
      throw new Error(`Fresh snapshot still marks the city control disabled at ${label}: ${JSON.stringify({ cityRef: cityRef ?? null, pageRevision: revision() })}`);
    }
  };

  return {
    packageName: 'avery.pb03-fixture-validation', name: 'pb03-fixture-scripted-provider', version: '0.2.0', sdkVersion: HostSdkVersion,
    slot: 'model-provider', capabilities: ['model:scripted-test'],
    Configure: async () => ({ configured: true, provider: 'Scripted', model: 'pb03-fixture' }),
    TestConnection: async () => ({ connected: true, provider: 'Scripted' }),
    GetBalance: async () => ({ available: false, balances: [] }), GetModels: async () => ({ models: ['pb03-fixture'] }),
    GetStatus: async () => ({ configured: true, provider: 'Scripted', model: 'pb03-fixture' }),
    ResolveRequestModel: () => 'pb03-fixture', BaseUrl: () => 'http://127.0.0.1/pb03-fixture',
    GetRuntimeLimits: () => ({ contextLimit: 64_000, threshold: 80 }),
    EstimateTokens: (value) => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4)),
    CreateSummary: async () => ({ content: 'PB-03 local fixture summary' }),
    StreamCompletion: async ({ history, onDelta }) => {
      observations.providerTurns = (observations.providerTurns ?? 0) + 1;
      const value = (toolName) => useResult(toolName, history);
      switch (phase) {
        case 0:
          phase = 1;
          return dispatch('BrowserNavigate', { url: fixtureUrl }, 'navigate-fixture');
        case 1: {
          const result = value('BrowserNavigate');
          if (result?.ok !== true) {
            observations.navigationResult = {
              ok: false,
              requestedUrl: SafeFixtureUrl(fixtureUrl),
              toolCallIdHash: HashedIdentifier('call', result?.toolCallId),
              code: result?.code || 'PB03_TOOL_RESULT_INVALID_SHAPE',
              message: SafeError(new Error(result?.message || 'BrowserNavigate failed without a diagnostic message.')),
              taskOwnedTargetVerified: false,
              readyState: null,
            };
            return failPrimary(observations.navigationResult.code, 'navigate-tool-result',
              `Fixture BrowserNavigate failed [${observations.navigationResult.code}]: ${observations.navigationResult.message}`, onDelta,
              { navigationResult: observations.navigationResult });
          }
          observations.browserTaskId = runtime.GetBrowserTaskId?.() ?? null;
          observations.browserTaskIdHash = HashedIdentifier('task', observations.browserTaskId);
          if (!observations.browserTaskId) {
            observations.navigationResult = { ok: false, requestedUrl: SafeFixtureUrl(fixtureUrl), code: 'PB03_NAVIGATION_TASK_ID_MISSING', message: 'BrowserNavigate did not expose an active task identity.', taskOwnedTargetVerified: false, readyState: null };
            return failPrimary(observations.navigationResult.code, 'navigate-task-id',
              `Fixture BrowserNavigate could not be verified [${observations.navigationResult.code}].`, onDelta);
          }
          AddTimeline(observations, 'main_task_target_created_observed', { taskIdHash: observations.browserTaskIdHash });
          let targets = [];
          let readiness = null;
          try {
            targets = await ReadTaskTargetInfos(bridge, observations.browserTaskId);
            RecordTaskTargets(observations, observations.browserTaskId, targets, 'read_only_Target.getTargets_after_navigate');
            const expression = '(() => ({ url: location.href, readyState: document.readyState }))()';
            const response = await runtime.RunCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], { deadline: Date.now() + 10_000 });
            readiness = response?.data?.result ?? response?.data;
          } catch (error) {
            RecordTargetEvidenceError(observations, error, 'main_navigate_target_evidence');
            observations.navigationResult = {
              ok: false,
              requestedUrl: SafeFixtureUrl(fixtureUrl),
              code: typeof error?.code === 'string' ? error.code : 'PB03_NAVIGATION_EVIDENCE_FAILED',
              message: SafeError(error),
              taskOwnedTargetVerified: false,
              readyState: null,
            };
            return failPrimary(observations.navigationResult.code, 'navigate-target-evidence',
              `Fixture BrowserNavigate evidence failed [${observations.navigationResult.code}]: ${observations.navigationResult.message}`, onDelta,
              { navigationResult: observations.navigationResult });
          }
          const evidence = VerifyNavigationEvidence({ result, taskTargets: targets, expectedUrl: fixtureUrl, readyState: readiness?.readyState });
          const parent = targets.find((target) => String(target.targetId) === evidence.targetId);
          observations.navigationResult = {
            ok: evidence.ok,
            requestedUrl: SafeFixtureUrl(fixtureUrl),
            toolCallIdHash: HashedIdentifier('call', result.toolCallId),
            code: evidence.code,
            ...(evidence.ok ? { finalUrl: SafeFixtureUrl(evidence.finalUrl) } : { message: SafeError(new Error(evidence.message)) }),
            taskOwnedTargetVerified: evidence.ok,
            ...(evidence.ok ? { targetIdHash: HashedIdentifier('target', evidence.targetId), readyState: evidence.readyState } : { readyState: null }),
          };
          if (!evidence.ok) return failPrimary(evidence.code, 'navigate-evidence-oracle',
            `Fixture BrowserNavigate evidence failed [${evidence.code}]: ${observations.navigationResult.message}`, onDelta,
            { navigationResult: observations.navigationResult });
          observations.navigated = true;
          const parentIdentity = TargetIdentity(parent);
          if (!parentIdentity?.targetId || !Number.isSafeInteger(parentIdentity.tabId) || !Number.isSafeInteger(parentIdentity.windowId)) {
            return failPrimary('PB03_PARENT_RAW_ID_MISSING', 'navigate-parent-target-capture',
              'BrowserNavigate did not expose both the exact raw parent targetId and tabId; no identity fallback is permitted.', onDelta);
          }
          observations.parentTargetId = parentIdentity.targetId;
          observations.parentTabId = parentIdentity.tabId;
          observations.parentWindowId = parentIdentity?.windowId;
          observations.parentOpenerTabId = parentIdentity?.openerTabId;
          observations.parentTargetIdHash = HashedIdentifier('target', observations.parentTargetId);
          observations.parentTabIdHash = HashedIdentifier('tab', observations.parentTabId);
          AddTimeline(observations, 'parent_target_observed', {
            taskIdHash: observations.browserTaskIdHash,
            targetIdHash: observations.parentTargetIdHash,
            tabIdHash: observations.parentTabIdHash,
            active: parent.active === true,
            attached: parent.attached === true,
          });
          try {
            const monitor = await runtime.RunCommand(['eval', '-b', Buffer.from(SubmissionMonitorExpression(), 'utf8').toString('base64')], { deadline: Date.now() + 10_000 });
            observations.submissionMonitorArmed = (monitor?.data?.result ?? monitor?.data)?.installed === true;
          } catch { observations.submissionMonitorArmed = false; }
          phase = 2;
          return dispatch('BrowserSnapshot', {}, 'initial-snapshot');
        }
        case 2:
          if (!value('BrowserSnapshot')?.refs) return failPrimary('PB03_INITIAL_SNAPSHOT_EVIDENCE_MISSING', 'initial-snapshot', 'Initial fixture snapshot did not expose refs.', onDelta);
          phase = 3;
          return dispatch('BrowserReadPage', {}, 'read-page');
        case 3:
          if (value('BrowserReadPage')?.ok !== true) return failPrimary(value('BrowserReadPage')?.code || 'PB03_READ_PAGE_FAILED', 'read-page', 'BrowserReadPage failed.', onDelta);
          phase = 4;
          try { return dispatch('BrowserFill', { ...requireRef(/姓名/i, 'name'), text: fixtureValues.name }, 'fill-name'); }
          catch (error) { return failPrimary(error?.code || 'PB03_FILL_NAME_PREPARE_FAILED', 'fill-name-prepare', String(error.message || error), onDelta); }
        case 4:
          value('BrowserFill');
          phase = 5;
          return dispatch('BrowserSnapshot', {}, 'refresh-before-select');
        case 5:
          value('BrowserSnapshot');
          phase = 6;
          try { return dispatch('BrowserSelect', { ...requireRef(/方向/i, 'direction'), value: fixtureValues.direction }, 'select-direction'); }
          catch (error) { return failPrimary(error?.code || 'PB03_SELECT_DIRECTION_PREPARE_FAILED', 'select-direction-prepare', String(error.message || error), onDelta); }
        case 6:
          value('BrowserSelect');
          phase = 7;
          return dispatch('BrowserSnapshot', {}, 'refresh-before-province');
        case 7:
          value('BrowserSnapshot');
          phase = 8;
          try { return dispatch('BrowserClick', requireRef(/省份/i, 'province', 'combobox'), 'open-province-options'); }
          catch (error) { return failPrimary(error?.code || 'PB03_OPEN_PROVINCE_PREPARE_FAILED', 'open-province-prepare', String(error.message || error), onDelta); }
        case 8:
          value('BrowserClick');
          phase = 9;
          return dispatch('BrowserSnapshot', {}, 'refresh-province-options');
        case 9:
          value('BrowserSnapshot');
          try {
            const state = await observeRegion('province-options-open');
            const provinceOptionExists = (state?.provinceOptions?.values ?? []).some((option) => String(option?.value || '') === fixtureValues.province
              || String(option?.text || '').replace(/\s+/g, ' ').trim() === fixtureValues.province);
            if (state?.province?.expanded !== 'true' || state?.provinceOptions?.hidden !== false || state?.city?.disabled !== true || !provinceOptionExists) {
              throw new Error(`Province options did not open while city stayed disabled: ${JSON.stringify({ state, pageRevision: revision() })}`);
            }
            provinceOptionEventCursor = Number.isSafeInteger(state.eventCount) ? state.eventCount : state.events?.length ?? 0;
            phase = 10;
            return dispatch('BrowserClick', requireRef(/广东省/, 'province option', 'option'), 'choose-province');
          } catch (error) { return failRegion('province-options-open', error, onDelta); }
        case 10:
          value('BrowserClick');
          try {
            const state = await observeRegion('province-selected');
            AssertCustomOptionAction(state, provinceOptionEventCursor, 'province option', fixtureValues.province, 'province');
            const beforeProvinceSelection = observations.regionTimeline.at(-2)?.state;
            AssertCustomControlSelection(state?.province, fixtureValues.province, 'province-selected');
            AssertCustomOptionSelection(state, 'provinceOptions', fixtureValues.province, 'province-selected');
            AssertCustomOptionSelection(state, 'cityOptions', fixtureValues.city, 'province-selected');
            if (beforeProvinceSelection?.city?.disabled !== true || state?.province?.disabled === true
              || state?.provinceOptions?.hidden !== true || state?.city?.disabled !== false) {
              throw new Error(`Province option did not produce the required cascade: ${JSON.stringify({ state, pageRevision: revision() })}`);
            }
            phase = 11;
            return dispatch('BrowserSnapshot', {}, 'refresh-before-city');
          } catch (error) { return failRegion('province-selected', error, onDelta); }
        case 11:
          value('BrowserSnapshot');
          try {
            const state = await observeRegion('city-enabled-before-open');
            assertCitySnapshotEnabled('city-enabled-before-open');
            if (state?.city?.disabled !== false || CustomControlSelectedValue(state?.city) !== '') {
              throw new Error(`City DOM oracle was not enabled before opening: ${JSON.stringify({ state, pageRevision: revision() })}`);
            }
            cityTriggerEventCursor = Number.isSafeInteger(state?.eventCount) ? state.eventCount : 0;
            phase = 12;
            return dispatch('BrowserClick', requireRef(/城市/i, 'city', 'combobox'), 'open-city-options');
          } catch (error) { return failRegion('city-enabled-before-open', error, onDelta); }
        case 12:
          value('BrowserClick');
          try {
            const state = await observeRegion('city-opened');
            AssertCustomTriggerAction(state, cityTriggerEventCursor, 'city');
            AssertCustomOptionSelection(state, 'cityOptions', fixtureValues.city, 'city-opened');
            const enabledState = observations.regionTimeline.find((entry) => entry.label === 'province-selected')?.state;
            const cityDisplayUnchanged = !enabledState?.city?.displayText || state?.city?.displayText === enabledState.city.displayText;
            if (state?.city?.expanded !== 'true' || state?.cityOptions?.hidden !== false || state?.city?.disabled === true
              || !cityDisplayUnchanged || CustomControlSelectedValue(state?.city) !== '') {
              throw new Error(`City options did not open after the enabled province cascade: ${JSON.stringify({ state, pageRevision: revision() })}`);
            }
            cityOptionEventCursor = Number.isSafeInteger(state.eventCount) ? state.eventCount : state.events?.length ?? 0;
            phase = 13;
            return dispatch('BrowserSnapshot', {}, 'refresh-city-options');
          } catch (error) { return failRegion('city-opened', error, onDelta); }
        case 13:
          value('BrowserSnapshot');
          try {
            const state = await observeRegion('city-options-snapshot');
            if (state?.city?.expanded !== 'true' || state?.cityOptions?.hidden !== false || state?.city?.disabled === true) {
              throw new Error(`Fresh city-options snapshot did not expose an enabled city list: ${JSON.stringify({ state, pageRevision: revision() })}`);
            }
            phase = 14;
            return dispatch('BrowserClick', requireRef(/佛山市/, 'city option', 'option'), 'choose-city');
          } catch (error) { return failRegion('city-options-snapshot', error, onDelta); }
        case 14:
          value('BrowserClick');
          try {
            const state = await observeRegion('city-selected');
            AssertCustomOptionAction(state, cityOptionEventCursor, 'city option', fixtureValues.city, 'city');
            AssertCustomControlSelection(state?.city, fixtureValues.city, 'city-selected');
            AssertCustomOptionSelection(state, 'cityOptions', fixtureValues.city, 'city-selected');
            if (state?.city?.disabled === true || state?.cityOptions?.hidden !== true || state?.city?.expanded !== 'false') {
              throw new Error(`City option did not produce the required final DOM value: ${JSON.stringify({ state, pageRevision: revision() })}`);
            }
            phase = 15;
            return dispatch('BrowserSnapshot', {}, 'refresh-before-date');
          } catch (error) { return failRegion('city-selected', error, onDelta); }
        case 15:
          value('BrowserSnapshot');
          phase = 16;
          try { return dispatch('BrowserFill', { ...requireRef(/出生日期/i, 'date'), text: fixtureValues.date }, 'fill-date'); }
          catch (error) { return failPrimary(error?.code || 'PB03_FILL_DATE_PREPARE_FAILED', 'fill-date-prepare', String(error.message || error), onDelta); }
        case 16:
          value('BrowserFill');
          phase = 17;
          return dispatch('BrowserSnapshot', {}, 'refresh-before-terms');
        case 17:
          value('BrowserSnapshot');
          phase = 18;
          try { return dispatch('BrowserSetChecked', { ...requireRef(/同意本地测试条款/i, 'fixture terms'), checked: true }, 'accept-fixture-terms'); }
          catch (error) { return failPrimary(error?.code || 'PB03_TERMS_PREPARE_FAILED', 'terms-prepare', String(error.message || error), onDelta); }
        case 18:
          value('BrowserSetChecked');
          phase = 19;
          return dispatch('BrowserSnapshot', {}, 'refresh-before-upload');
        case 19:
          value('BrowserSnapshot');
          phase = 20;
          try { return dispatch('BrowserUploadFile', { ...requireRef(/简历附件/i, 'resume file'), fileId: uploadFileId }, 'upload-synthetic-pdf'); }
          catch (error) { return failPrimary(error?.code || 'PB03_UPLOAD_PREPARE_FAILED', 'upload-prepare', String(error.message || error), onDelta); }
        case 20:
          observations.uploadResultOk = value('BrowserUploadFile')?.ok === true;
          observations.uploadResultData = observations.uploadResult ?? null;
          phase = 21;
          return dispatch('BrowserValidateForm', {}, 'validate-required-fields');
        case 21:
          {
          const validationResult = value('BrowserValidateForm');
          const validationData = validationResult?.data && typeof validationResult.data === 'object' ? validationResult.data : validationResult;
          const validationGateResult = VerifyPb03ValidationGate({ result: validationResult, expectedInspectedFieldCount: 7 });
          const validationGate = {
            ...(validationGateResult.checks ?? {}),
            ok: validationResult?.ok === true,
            valid: validationData?.valid === true,
            issuesArray: Array.isArray(validationData?.issues),
            issuesSchema: validationGateResult.checks?.issuesSchema === true,
            issueCount: Array.isArray(validationData?.issues) ? validationData.issues.length : null,
            inspectedFieldCount: Number.isSafeInteger(validationData?.inspectedFieldCount) ? validationData.inspectedFieldCount : null,
            validationMetadataAvailable: validationData?.validationMetadataAvailable === true,
            expectedFields: validationGateResult.checks?.expectedFields === true,
            expectedInspectedFieldCount: 7,
            verified: validationGateResult.ok === true,
            failure: validationGateResult.ok ? null : validationGateResult,
          };
          observations.validationGate = validationGate;
          if (!validationGateResult.ok) {
            return failPrimary(validationGateResult.code || 'PB03_VALIDATE_GATE_FAILED', 'validate-required-fields',
              `${validationGateResult.message} ${JSON.stringify({ validation: observations.validation, gate: validationGate })}`, onDelta,
              { gate: validationGate });
          }
          observations.validationDomChecker = await RunFixtureDomChecker(runtime, {
            name: fixtureValues.name, direction: fixtureValues.direction, province: fixtureValues.province,
            city: fixtureValues.city, date: fixtureValues.date, fileName: uploadName, fileSize: uploadSize,
            fileSha256: uploadSha256,
          }).catch((error) => ({ attempted: true, available: false, verified: false, reason: SafeError(error) }));
          const upload = observations.uploadResult ?? {};
          const domEvidence = observations.validationDomChecker;
          const uploadOracle = VerifyPb03UploadOracle({
            result: upload,
            resource: { fileId: uploadFileId, name: uploadName, bytes: uploadSize, sha256: uploadSha256 },
            inputFiles: domEvidence?.file,
          });
          observations.uploadOracle = uploadOracle;
          const uploadMatchesResource = uploadOracle.ok === true;
          observations.preChildEvidence = {
            validation: validationGateResult,
            upload: uploadOracle,
            dom: domEvidence,
            noSubmit: domEvidence?.noSubmitObserved === true,
            verified: VerifyPb03PreChildEvidence({ validation: validationGateResult, upload: uploadOracle, dom: domEvidence }).ok === true,
          };
          if (!uploadMatchesResource) {
            return failPrimary(uploadOracle.code || 'PB03_UPLOAD_ORACLE_FAILED', 'upload-confirmation',
              `${uploadOracle.message} ${JSON.stringify({ result: upload, oracle: uploadOracle })}`, onDelta,
              { uploadOracle });
          }
          const preChildGate = VerifyPb03PreChildEvidence({ validation: validationGateResult, upload: uploadOracle, dom: domEvidence });
          observations.preChildEvidence.gate = preChildGate;
          if (!preChildGate.ok) {
            return failPrimary(preChildGate.code || 'PB03_PRE_CHILD_ORACLE_FAILED', 'pre-child-evidence',
              `${preChildGate.message} ${JSON.stringify(domEvidence)}`, onDelta,
              { preChildGate });
          }
          phase = 22;
          return dispatch('BrowserSnapshot', {}, 'snapshot-before-child-tab');
          }
        case 22: {
          const data = value('BrowserSnapshot');
          const parent = (data?.tabs || []).find((tab) => String(tab?.targetId ?? '') === String(observations.parentTargetId ?? ''));
          const parentIdentity = TargetIdentity(parent);
          if (!parentIdentity?.targetId || !Number.isSafeInteger(parentIdentity.tabId) || !Number.isSafeInteger(parentIdentity.windowId)
            || parentIdentity.targetId !== String(observations.parentTargetId)
            || parentIdentity.tabId !== observations.parentTabId) {
            return failPrimary('PB03_PARENT_ID_NOT_FOUND', 'pre-child-parent-capture',
              'The exact parent targetId/tabId captured before child open was not present in the task-scoped Snapshot.', onDelta);
          }
          observations.parentWindowId = parentIdentity.windowId;
          observations.parentOpenerTabId = parentIdentity.openerTabId;
          observations.parentTargetSnapshot = structuredClone(parent);
          observations.targetsBeforeChildOpen = (Array.isArray(data?.tabs) ? data.tabs : [])
            .map((tab) => TargetIdentity(tab))
            .filter((identity) => identity?.targetId && identity?.tabId);
          observations.parentTargetIdHash ||= HashedIdentifier('target', observations.parentTargetId);
          observations.parentTabIdHash ||= HashedIdentifier('tab', observations.parentTabId);
          AddTimeline(observations, 'target_blank_parent_observed_before_open', {
            taskIdHash: observations.browserTaskIdHash,
            targetIdHash: observations.parentTargetIdHash,
            tabIdHash: observations.parentTabIdHash,
          });
          phase = 23;
          AddTimeline(observations, 'child_open_requested', {
            taskIdHash: observations.browserTaskIdHash,
            openerTargetIdHash: observations.parentTargetIdHash,
          });
          try { return dispatch('BrowserClick', requireRef(/打开招聘详情子页/, 'child link'), 'open-target-blank-child'); }
          catch (error) { return failPrimary(error?.code || 'PB03_CHILD_OPEN_PREPARE_FAILED', 'child-open-prepare', String(error.message || error), onDelta); }
        }
        case 23:
          if (value('BrowserClick')?.ok !== true) return failPrimary(value('BrowserClick')?.code || 'PB03_CHILD_OPEN_FAILED', 'child-open-action', 'Opening the fixture child page failed.', onDelta);
          AddTimeline(observations, 'child_open_action_succeeded', { taskIdHash: observations.browserTaskIdHash });
          try {
            const beforeChildTargetIds = new Set((observations.targetsBeforeChildOpen ?? []).map((target) => target.targetId));
            const childWait = await WaitForTaskTarget(bridge, observations.browserTaskId, (target) => {
              const identity = TargetIdentity(target);
              return Boolean(identity?.targetId && Number.isSafeInteger(identity.tabId)
                && !beforeChildTargetIds.has(identity.targetId)
                && identity.targetId !== String(observations.parentTargetId)
                && identity.openerTabId !== null
                && identity.openerTabId === observations.parentTabId);
            }, 5_000);
            observations.childTargetObserved = childWait.target;
            observations.childDiscoveryAttempts = childWait.attempts;
            observations.childTargetAppearanceWait = {
              ok: true, attempts: childWait.attempts, elapsedMs: childWait.elapsedMs,
              openerTabIdMatchesParent: childWait.target.openerTabId === observations.parentTabId,
            };
          } catch (error) {
            observations.childTargetAppearanceWait = { ok: false, primary: true, code: error?.code || 'PB03_TARGET_APPEAR_TIMEOUT', message: SafeError(error), attempts: error?.attempts ?? null };
            return failPrimary('PB03_TARGET_APPEAR_TIMEOUT', 'child-target-appearance',
              `target=_blank child tab did not appear with the registered opener: ${observations.childTargetAppearanceWait.message}`, onDelta,
              { childTargetAppearanceWait: observations.childTargetAppearanceWait });
          }
          phase = 24;
          return dispatch('BrowserSnapshot', {}, 'verify-child-tab');
        case 24: {
          const data = value('BrowserSnapshot');
          const observedChildIdentity = TargetIdentity(observations.childTargetObserved);
          const child = (data?.tabs || []).find((tab) => String(tab?.targetId ?? '') === String(observedChildIdentity?.targetId ?? ''));
          const childIdentity = TargetIdentity(child);
          observations.childTabObserved = Boolean(childIdentity?.targetId && childIdentity?.tabId);
          const childIdentityGate = VerifyPb03ChildIdentity({
            taskId: observations.browserTaskId,
            parent: {
              ...(observations.parentTargetSnapshot ?? {
                targetId: observations.parentTargetId,
                tabId: Number(observations.parentTabId),
                windowId: observations.parentWindowId,
              }),
              browserTaskId: observations.browserTaskId,
            },
            child: child ? { ...child, browserTaskId: observations.browserTaskId } : child,
            expectedChildUrl: fixtureUrl.replace('/application', '/child'),
          });
          observations.childIdentityGate = childIdentityGate;
          if (!childIdentityGate.ok || !childIdentity?.targetId || childIdentity.targetId !== observedChildIdentity?.targetId
            || childIdentity.tabId !== observedChildIdentity?.tabId) {
            return failPrimary(childIdentityGate.code || 'PB03_CHILD_IDENTITY_MISMATCH', 'child-tab-identity',
              childIdentityGate.message || 'target=_blank child tab was not exposed with a stable raw targetId/tabId pair.', onDelta,
              { childIdentityGate });
          }
          observations.childTargetId = childIdentity.targetId;
          observations.childTabId = childIdentity.tabId;
          observations.childWindowId = childIdentity.windowId;
          observations.childOpenerTabId = childIdentity.openerTabId;
          observations.childTargetIdHash = HashedIdentifier('target', observations.childTargetId);
          observations.childTabIdHash = HashedIdentifier('tab', observations.childTabId);
          AddTimeline(observations, 'child_created_observed_in_current_task', {
            taskIdHash: observations.browserTaskIdHash,
            targetIdHash: observations.childTargetIdHash,
            tabIdHash: observations.childTabIdHash,
            openerTargetIdHash: observations.parentTargetIdHash,
            openerTabIdHash: observations.childOpenerTabId === null ? null : HashedIdentifier('tab', observations.childOpenerTabId),
            openerOwnership: observations.childOpenerTabId !== null && observations.childOpenerTabId === observations.parentTabId
              ? 'same_task_scoped_target_list_and_opener_tab_match' : 'same_task_scoped_target_list_without_opener_tab_match',
            active: child.active === true,
          });
          phase = 25;
          AddTimeline(observations, 'child_activation_requested', {
            taskIdHash: observations.browserTaskIdHash,
            targetIdHash: observations.childTargetIdHash,
          });
          return dispatch('BrowserSwitchTab', { tabId: String(observations.childTabId) }, 'activate-child-tab');
        }
        case 25: {
          const result = value('BrowserSwitchTab');
          if (result?.ok !== true) {
            return failPrimary(result?.code || 'PB03_CHILD_SWITCH_FAILED', 'child-tab-switch',
              `The current task could not switch to its child tab: ${result?.message || result?.code || 'unknown error'}`, onDelta);
          }
          const switchGate = VerifyPb03SwitchResult({ result, expected: {
            tabId: Number(observations.childTabId), targetId: observations.childTargetId,
            windowId: observations.childWindowId, url: fixtureUrl.replace('/application', '/child'),
          } });
          observations.childSwitchGate = switchGate;
          if (!switchGate.ok) {
            return failPrimary(switchGate.code, 'child-tab-switch-oracle', switchGate.message, onDelta, { switchGate });
          }
          try {
            const targets = await ReadTaskTargetInfos(bridge, observations.browserTaskId);
            const safeTargets = RecordTaskTargets(observations, observations.browserTaskId, targets, 'read_only_Target.getTargets_after_child_activation');
            const child = targets.find((target) => String(target.targetId) === observations.childTargetId);
            const parent = targets.find((target) => String(target.targetId) === observations.parentTargetId);
            observations.childAttachActivateVerified = child?.attached === true && child?.active === true;
            observations.parentAndChildPresentAfterChildSwitch = Boolean(parent && child);
            observations.childOpenerVerified = Number.isSafeInteger(child?.openerTabId)
              && child.openerTabId === observations.parentTabId;
            AddTimeline(observations, 'child_attached_and_active_verified', {
              taskIdHash: observations.browserTaskIdHash,
              targetIdHash: observations.childTargetIdHash,
              tabIdHash: observations.childTabIdHash,
              attached: child?.attached === true,
              active: child?.active === true,
              parentPresent: Boolean(parent),
              openerTabIdMatchesParent: observations.childOpenerVerified,
              targetPresent: safeTargets.some((target) => target.targetIdHash === observations.childTargetIdHash),
            });
          } catch (error) {
            RecordTargetEvidenceError(observations, error, 'main_child_activation_target_evidence');
            return failPrimary(typeof error?.code === 'string' ? error.code : 'PB03_CHILD_ACTIVATION_TARGET_EVIDENCE_FAILED',
              'child-activation-target-evidence', SafeError(error), onDelta);
          }
          phase = 26;
          return dispatch('BrowserWait', { kind: 'load', value: 'domcontentloaded' }, 'wait-child-ready-state');
        }
        case 26: {
          const wait = value('BrowserWait');
          observations.childReadyWait = { ok: wait?.ok === true, data: wait?.data ?? null };
          if (wait?.ok !== true) {
            return failPrimary(wait?.code || 'PB03_CHILD_READY_WAIT_FAILED', 'child-ready-state',
              `The child tab did not reach a bounded readyState wait before Snapshot: ${wait?.message || wait?.code || 'unknown error'}`, onDelta);
          }
          phase = 27;
          return dispatch('BrowserSnapshot', {}, 'verify-child-active-tab');
        }
        case 27: {
          const childResult = value('BrowserSnapshot');
          if (childResult?.ok !== true) {
            observations.childSnapshotFailure = {
              code: childResult?.code || 'BROWSER_SNAPSHOT_FAILED',
              message: childResult?.message || 'Child BrowserSnapshot failed before the parent restore attempt.',
              primary: true,
              layer: childResult?.code === 'BROWSER_COMMAND_TIMEOUT' ? 'personal_browser_snapshot_runtime_evaluate_semantic_items' : 'browser_snapshot',
              afterChildSwitch: true,
              readyWaitCompleted: observations.childReadyWait?.ok === true,
            };
            return failPrimary(childResult?.code || 'PB03_CHILD_SNAPSHOT_FAILED', 'child-snapshot',
              `Child BrowserSnapshot failed after bounded readyState wait: ${observations.childSnapshotFailure.message}`, onDelta,
              { childSnapshotFailure: observations.childSnapshotFailure });
          }
          const childData = childResult;
          observations.childCurrentUrlVerified = SafeUrl(childData?.currentUrl) === SafeUrl(fixtureUrl.replace('/application', '/child'));
          AddTimeline(observations, 'child_activation_snapshot_observed', {
            taskIdHash: observations.browserTaskIdHash,
            targetIdHash: observations.childTargetIdHash,
            tabIdHash: observations.childTabIdHash,
            currentUrlMatchesChild: observations.childCurrentUrlVerified,
          });
          phase = 28;
          AddTimeline(observations, 'parent_activation_requested', {
            taskIdHash: observations.browserTaskIdHash,
            targetIdHash: observations.parentTargetIdHash,
            tabIdHash: observations.parentTabIdHash,
          });
          return dispatch('BrowserSwitchTab', { tabId: String(observations.parentTabId) }, 'return-to-form-tab');
        }
        case 28: {
          const result = value('BrowserSwitchTab');
          if (result?.ok !== true) {
            return failPrimary(result?.code || 'PB03_PARENT_RESTORE_FAILED', 'parent-tab-restore',
              `The current task could not restore its parent tab: ${result?.message || result?.code || 'unknown error'}`, onDelta);
          }
          const switchGate = VerifyPb03SwitchResult({ result, expected: {
            tabId: Number(observations.parentTabId), targetId: observations.parentTargetId,
            windowId: observations.parentWindowId, url: fixtureUrl,
          } });
          observations.parentSwitchGate = switchGate;
          if (!switchGate.ok) {
            return failPrimary(switchGate.code, 'parent-tab-restore-oracle', switchGate.message, onDelta, { switchGate });
          }
          try {
            const targets = await ReadTaskTargetInfos(bridge, observations.browserTaskId);
            RecordTaskTargets(observations, observations.browserTaskId, targets, 'read_only_Target.getTargets_after_parent_restore');
            const parent = targets.find((target) => String(target.targetId) === String(observations.parentTargetId));
            const child = targets.find((target) => String(target.targetId) === String(observations.childTargetId));
            observations.parentRestoreVerified = parent?.active === true && parent?.attached === true
              && SafeUrl(parent?.url) === SafeUrl(fixtureUrl);
            observations.parentAndChildPresentAfterParentRestore = Boolean(parent && child);
            AddTimeline(observations, 'parent_restore_verified', {
              taskIdHash: observations.browserTaskIdHash,
              targetIdHash: observations.parentTargetIdHash,
              tabIdHash: observations.parentTabIdHash,
              active: parent?.active === true,
              attached: parent?.attached === true,
              urlMatchesParent: SafeUrl(parent?.url) === SafeUrl(fixtureUrl),
              childStillPresent: Boolean(child),
            });
          } catch (error) {
            RecordTargetEvidenceError(observations, error, 'main_parent_restore_target_evidence');
            observations.restoreFailure = { code: error?.code || 'PB03_PARENT_RESTORE_TARGET_EVIDENCE_FAILED', message: SafeError(error), primary: true };
            return failPrimary(typeof error?.code === 'string' ? error.code : 'PB03_PARENT_RESTORE_TARGET_EVIDENCE_FAILED',
              'parent-restore-target-evidence', SafeError(error), onDelta);
          }
          phase = 29;
          return dispatch('BrowserWait', { kind: 'load', value: 'domcontentloaded' }, 'wait-parent-ready-state');
        }
        case 29: {
          const wait = value('BrowserWait');
          observations.parentReadyWait = { ok: wait?.ok === true, data: wait?.data ?? null };
          if (wait?.ok !== true) {
            return failPrimary(wait?.code || 'PB03_PARENT_READY_WAIT_FAILED', 'parent-ready-state',
              `The parent tab did not reach a bounded readyState wait before final Snapshot: ${wait?.message || wait?.code || 'unknown error'}`, onDelta);
          }
          try {
            const activeTaskId = runtime.GetBrowserTaskId?.() ?? null;
            const targets = await ReadTaskTargetInfos(bridge, observations.browserTaskId);
            const parent = targets.find((target) => String(target?.targetId ?? '') === String(observations.parentTargetId ?? ''));
            const child = targets.find((target) => String(target?.targetId ?? '') === String(observations.childTargetId ?? ''));
            const parentIdentity = TargetIdentity(parent);
            const childIdentity = TargetIdentity(child);
            const verified = activeTaskId === observations.browserTaskId
              && parentIdentity?.targetId === String(observations.parentTargetId)
              && parentIdentity?.tabId === observations.parentTabId
              && parent?.active === true && parent?.attached === true
              && SafeUrl(parent?.url) === SafeUrl(fixtureUrl)
              && childIdentity?.targetId === String(observations.childTargetId)
              && childIdentity?.tabId === observations.childTabId
              && childIdentity?.openerTabId === observations.parentTabId;
            observations.preFinalOracle = {
              verified,
              activeTaskIdHash: HashedIdentifier('task', activeTaskId),
              parentTargetIdHash: HashedIdentifier('target', parentIdentity?.targetId),
              parentTabIdHash: HashedIdentifier('tab', parentIdentity?.tabId),
              parentActive: parent?.active === true,
              parentAttached: parent?.attached === true,
              parentUrlMatches: SafeUrl(parent?.url) === SafeUrl(fixtureUrl),
              childPresent: Boolean(child),
              childOpenerMatchesParent: childIdentity?.openerTabId === observations.parentTabId,
            };
            if (!verified) {
              return failPrimary('PB03_PRE_FINAL_ORACLE_FAILED', 'pre-final-active-task-oracle',
                `The active task/parent oracle was not verified before the final Snapshot: ${JSON.stringify(observations.preFinalOracle)}`, onDelta,
                { preFinalOracle: observations.preFinalOracle });
            }
          } catch (error) {
            return failPrimary('PB03_PRE_FINAL_ORACLE_FAILED', 'pre-final-active-task-oracle',
              `The active task/parent oracle failed before the final Snapshot: ${SafeError(error)}`, onDelta);
          }
          const sentinelHash = observations.isolationContext?.targetIdHash ?? observations.sentinelTargetIdHash ?? null;
          const mainNeverListedSentinel = Boolean(sentinelHash)
            && observations.taskTargetSnapshots.length > 0
            && observations.taskTargetSnapshots
              .filter((snapshot) => snapshot.taskIdHash === observations.browserTaskIdHash)
              .every((snapshot) => !(snapshot.targets || []).some((target) => target.targetIdHash === sentinelHash));
          const childGate = observations.childIdentityGate?.ok === true
            && observations.childSwitchGate?.ok === true
            && observations.childAttachActivateVerified === true
            && observations.childOpenerVerified === true
            && observations.parentAndChildPresentAfterChildSwitch === true
            && observations.childReadyWait?.ok === true
            && observations.childCurrentUrlVerified === true;
          const restoreGate = observations.parentSwitchGate?.ok === true
            && observations.parentRestoreVerified === true
            && observations.parentAndChildPresentAfterParentRestore === true
            && observations.parentReadyWait?.ok === true;
          const isolationGate = observations.isolationContext?.confirmationHeld === true
            && observations.isolationContext?.pendingToolName === 'BrowserUploadFile'
            && String(observations.isolationContext?.browserTaskId ?? '') !== String(observations.browserTaskId ?? '')
            && Boolean(sentinelHash) && mainNeverListedSentinel;
          const noSubmitGate = observations.preChildEvidence?.noSubmit === true
            && observations.actionIntents.every((intent) => intent.purpose !== 'submit');
          const preFinalGate = VerifyPb03PreFinalGate({
            validation: observations.validationGate?.verified === true,
            upload: observations.uploadOracle?.ok === true,
            child: childGate,
            restore: restoreGate,
            isolation: isolationGate,
            noSubmit: noSubmitGate,
          });
          observations.preFinalGate = {
            ...preFinalGate,
            child: childGate,
            restore: restoreGate,
            isolation: isolationGate,
            noSubmit: noSubmitGate,
            mainNeverListedSentinel,
          };
          if (!preFinalGate.ok) {
            observations.preFinalFailure = { ...preFinalGate, primary: true };
            return failPrimary(preFinalGate.code, 'pre-final-gate', preFinalGate.message, onDelta, { preFinalGate });
          }
          phase = 30;
          return dispatch('BrowserSnapshot', {}, 'final-form-snapshot');
        }
        case 30: {
          const finalResult = value('BrowserSnapshot');
          if (finalResult?.ok !== true) {
            return failPrimary(finalResult?.code || 'PB03_FINAL_SNAPSHOT_FAILED', 'final-parent-snapshot',
              `Final parent BrowserSnapshot failed: ${finalResult?.message || finalResult?.code || 'unknown error'}`, onDelta);
          }
          const data = finalResult;
          observations.finalSnapshot = {
            currentUrl: SafeFixtureUrl(data?.currentUrl),
            pageRevision: Number.isSafeInteger(data?.pageRevision) ? data.pageRevision : null,
            exposedTabs: Array.isArray(data?.tabs) ? data.tabs.length : 0,
            finalSubmitCandidates: observations.finalSubmitCandidates,
          };
          observations.parentFormCurrentUrlVerified = SafeUrl(data?.currentUrl) === SafeUrl(fixtureUrl);
          const finalParent = (data?.tabs || []).find((tab) => String(tab?.targetId ?? '') === String(observations.parentTargetId ?? ''));
          const finalParentIdentity = TargetIdentity(finalParent);
          const finalTaskOracle = {
            verified: finalParentIdentity?.targetId === String(observations.parentTargetId)
              && finalParentIdentity?.tabId === observations.parentTabId
              && finalParent?.active === true
              && observations.parentFormCurrentUrlVerified,
            parentTargetIdHash: HashedIdentifier('target', finalParentIdentity?.targetId),
            parentTabIdHash: HashedIdentifier('tab', finalParentIdentity?.tabId),
            active: finalParent?.active === true,
            currentUrlMatchesParent: observations.parentFormCurrentUrlVerified,
          };
          observations.finalTaskOracle = finalTaskOracle;
          if (!finalTaskOracle.verified) {
            return failPrimary('PB03_FINAL_TASK_ORACLE_FAILED', 'final-parent-snapshot-oracle',
              `The final Snapshot did not return the exact active parent target/tab identity: ${JSON.stringify(finalTaskOracle)}`, onDelta,
              { finalTaskOracle });
          }
          observations.domChecker = await RunFixtureDomChecker(runtime, {
            name: fixtureValues.name, direction: fixtureValues.direction, province: fixtureValues.province,
            city: fixtureValues.city, date: fixtureValues.date, fileName: uploadName, fileSize: uploadSize,
            fileSha256: uploadSha256,
          }).catch((error) => ({ attempted: true, available: false, verified: false, reason: SafeError(error) }));
          const finalEvidence = VerifyPb03PreChildEvidence({
            validation: observations.validationGate?.verified === true ? observations.validationGate : null,
            upload: observations.uploadOracle,
            dom: observations.domChecker,
          });
          observations.finalEvidenceGate = finalEvidence;
          if (!finalEvidence.ok) {
            return failPrimary(finalEvidence.code, 'final-dom-file-no-submit-evidence', finalEvidence.message, onDelta, { finalEvidence });
          }
          AddTimeline(observations, 'parent_form_snapshot_observed', {
            taskIdHash: observations.browserTaskIdHash,
            targetIdHash: observations.parentTargetIdHash,
            currentUrlMatchesParent: observations.parentFormCurrentUrlVerified,
          });
          phase = 29;
          return finish('PB-03 local fixture actions complete; submission was not requested.', onDelta);
        }
        default:
          return finish('PB-03 local fixture stopped.', onDelta);
      }
    },
    SetConfirmedToolResult(toolName, result, expectedConfirmationId = null) {
      if (!pendingToolCall || pendingToolCall.toolName !== String(toolName)) {
        throw Object.assign(new Error('Confirmation result does not match the pending fixture tool call.'), { code: 'PB03_TOOL_RESULT_CALL_MISMATCH' });
      }
      if (expectedConfirmationId !== null && String(result?.confirmationId ?? '') !== String(expectedConfirmationId)) {
        throw Object.assign(new Error('Confirmation result id does not match the pending fixture confirmation.'), { code: 'PB03_CONFIRMATION_ID_MISMATCH' });
      }
      confirmedToolResults.set(pendingToolCall.id, {
        ok: result?.status === 'succeeded',
        code: result?.status === 'succeeded' ? undefined : String(result?.code || result?.status || 'CONFIRMATION_FAILED'),
        data: result?.data && typeof result.data === 'object' ? result.data : result,
        toolCallId: pendingToolCall.id,
      });
    },
    observations,
  };
}

function CreateIsolationSentinelProvider(fixtureUrl, observations, runtime, bridge) {
  let phase = 0;
  let currentSnapshot = null;
  const confirmedToolResults = new Map();
  let pendingToolCall = null;
  const useResult = (toolName, history) => {
    if (!pendingToolCall || pendingToolCall.toolName !== toolName) {
      throw Object.assign(new Error('Sentinel phase expected a different browser tool result.'), { code: 'PB03_TOOL_RESULT_CALL_MISMATCH' });
    }
    const confirmed = confirmedToolResults.get(pendingToolCall.id);
    const result = confirmed ?? ParseExpectedToolResult(history, pendingToolCall.id);
    confirmedToolResults.delete(pendingToolCall.id);
    const consumed = pendingToolCall;
    pendingToolCall = null;
    try {
      const envelope = NormalizeToolResultEnvelope(result, consumed.id);
      const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
      return { ...data, ...envelope, data };
    } catch (error) {
      pendingToolCall = consumed;
      throw error;
    }
  };
  const finish = (content, onDelta) => { onDelta?.({ reasoning: '', content }); return { content, toolCalls: [] }; };
  const dispatch = (name, toolArguments, purpose) => {
    const id = 'pb03-sentinel-' + phase;
    pendingToolCall = { id, toolName: name, purpose };
    observations.actionIntents.push({ toolName: name, purpose });
    return { content: '', toolCalls: [ToolCall(id, name, toolArguments)] };
  };
  return {
    packageName: 'avery.pb03-fixture-validation', name: 'pb03-isolation-sentinel-provider', version: '0.2.0', sdkVersion: HostSdkVersion,
    slot: 'model-provider', capabilities: ['model:scripted-test'],
    Configure: async () => ({ configured: true, provider: 'Scripted', model: 'pb03-fixture' }),
    TestConnection: async () => ({ connected: true, provider: 'Scripted' }),
    GetBalance: async () => ({ available: false, balances: [] }), GetModels: async () => ({ models: ['pb03-fixture'] }),
    GetStatus: async () => ({ configured: true, provider: 'Scripted', model: 'pb03-fixture' }),
    ResolveRequestModel: () => 'pb03-fixture', BaseUrl: () => 'http://127.0.0.1/pb03-fixture',
    GetRuntimeLimits: () => ({ contextLimit: 64_000, threshold: 80 }),
    EstimateTokens: (value) => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4)),
    CreateSummary: async () => ({ content: 'PB-03 task-isolation sentinel' }),
    StreamCompletion: async ({ history, onDelta }) => {
      observations.providerTurns = (observations.providerTurns ?? 0) + 1;
      switch (phase) {
        case 0:
          phase = 1;
          return dispatch('BrowserNavigate', { url: fixtureUrl }, 'create-other-task-sentinel');
        case 1: {
          const result = useResult('BrowserNavigate', history);
          if (result?.ok !== true) {
            observations.navigationResult = { ok: false, requestedUrl: SafeFixtureUrl(fixtureUrl), code: result?.code || 'PB03_TOOL_RESULT_INVALID_SHAPE', message: SafeError(new Error(result?.message || 'BrowserNavigate failed without a diagnostic message.')), taskOwnedTargetVerified: false, readyState: null };
            return finish(`Sentinel BrowserNavigate failed [${observations.navigationResult.code}]: ${observations.navigationResult.message}`, onDelta);
          }
          observations.browserTaskId = runtime.GetBrowserTaskId?.() ?? null;
          observations.browserTaskIdHash = HashedIdentifier('task', observations.browserTaskId);
          if (!observations.browserTaskId) {
            observations.navigationResult = { ok: false, requestedUrl: SafeFixtureUrl(fixtureUrl), code: 'PB03_NAVIGATION_TASK_ID_MISSING', message: 'Sentinel BrowserNavigate did not expose an active task identity.', taskOwnedTargetVerified: false, readyState: null };
            return finish(`Sentinel BrowserNavigate could not be verified [${observations.navigationResult.code}].`, onDelta);
          }
          try {
            const targets = await ReadTaskTargetInfos(bridge, observations.browserTaskId);
            RecordTaskTargets(observations, observations.browserTaskId, targets, 'read_only_Target.getTargets_after_sentinel_navigate');
            const expression = '(() => ({ url: location.href, readyState: document.readyState }))()';
            const response = await runtime.RunCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], { deadline: Date.now() + 10_000 });
            const readiness = response?.data?.result ?? response?.data;
            const evidence = VerifyNavigationEvidence({ result, taskTargets: targets, expectedUrl: fixtureUrl, readyState: readiness?.readyState });
            observations.navigationResult = {
              ok: evidence.ok,
              requestedUrl: SafeFixtureUrl(fixtureUrl),
              toolCallIdHash: HashedIdentifier('call', result.toolCallId),
              code: evidence.code,
              ...(evidence.ok ? { finalUrl: SafeFixtureUrl(evidence.finalUrl), targetIdHash: HashedIdentifier('target', evidence.targetId), readyState: evidence.readyState }
                : { message: SafeError(new Error(evidence.message)), readyState: null }),
              taskOwnedTargetVerified: evidence.ok,
            };
            if (evidence.ok) observations.sentinelTargetId = String(evidence.targetId);
            observations.navigated = evidence.ok;
            if (!evidence.ok) return finish(`Sentinel BrowserNavigate evidence failed [${evidence.code}]: ${observations.navigationResult.message}`, onDelta);
          } catch (error) {
            observations.navigationResult = { ok: false, requestedUrl: SafeFixtureUrl(fixtureUrl), code: typeof error?.code === 'string' ? error.code : 'PB03_NAVIGATION_EVIDENCE_FAILED', message: SafeError(error), taskOwnedTargetVerified: false, readyState: null };
            return finish(`Sentinel BrowserNavigate evidence failed [${observations.navigationResult.code}]: ${observations.navigationResult.message}`, onDelta);
          }
          AddTimeline(observations, 'other_task_sentinel_created', { taskIdHash: observations.browserTaskIdHash });
          phase = 2;
          return dispatch('BrowserSnapshot', {}, 'observe-other-task-sentinel');
        }
        case 2: {
          const snapshot = useResult('BrowserSnapshot', history);
          currentSnapshot = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
          const tab = (currentSnapshot?.tabs || []).find((item) => String(item?.targetId ?? '') === String(observations.sentinelTargetId ?? ''));
          const sentinelIdentity = TargetIdentity(tab);
          observations.sentinelTabId = sentinelIdentity?.tabId ?? null;
          observations.sentinelWindowId = sentinelIdentity?.windowId ?? null;
          observations.sentinelTargetIdHash = sentinelIdentity?.targetId ? HashedIdentifier('target', sentinelIdentity.targetId) : null;
          RecordTaskTargets(observations, observations.browserTaskId, currentSnapshot?.tabs, 'AgentHost BrowserSnapshot task-scoped tabs');
          if (!sentinelIdentity?.targetId || !Number.isSafeInteger(sentinelIdentity.tabId) || !Number.isSafeInteger(sentinelIdentity.windowId)) return finish('Sentinel target was not exposed by its own task with raw tab/window identity.', onDelta);
          phase = 3;
          const ref = FindRef(currentSnapshot, /简历附件/i);
          if (!ref || !Number.isSafeInteger(currentSnapshot?.pageRevision)) return finish('Sentinel upload confirmation could not be prepared.', onDelta);
          return dispatch('BrowserUploadFile', { ref: '@' + ref, pageRevision: currentSnapshot.pageRevision, fileId: uploadFileId }, 'hold-other-task-open-pending-confirmation');
        }
        case 3:
          useResult('BrowserUploadFile', history);
          phase = 4;
          return finish('Sentinel task is held only for the isolation check; no upload is accepted.', onDelta);
        default:
          return finish('Sentinel task stopped.', onDelta);
      }
    },
    SetConfirmedToolResult(toolName, result, expectedConfirmationId = null) {
      if (!pendingToolCall || pendingToolCall.toolName !== String(toolName)) {
        throw Object.assign(new Error('Sentinel confirmation does not match the pending fixture tool call.'), { code: 'PB03_TOOL_RESULT_CALL_MISMATCH' });
      }
      if (expectedConfirmationId !== null && String(result?.confirmationId ?? '') !== String(expectedConfirmationId)) {
        throw Object.assign(new Error('Sentinel confirmation result id does not match its pending call.'), { code: 'PB03_CONFIRMATION_ID_MISMATCH' });
      }
      confirmedToolResults.set(pendingToolCall.id, {
        ok: result?.status === 'succeeded',
        code: result?.status === 'succeeded' ? undefined : String(result?.code || result?.status || 'CONFIRMATION_REJECTED'),
        data: result?.data && typeof result.data === 'object' ? result.data : result,
        toolCallId: pendingToolCall.id,
      });
    },
    observations,
  };
}

function BuildTaskTabEvidence(main, sentinel, checks) {
  const mainTaskIdHash = main.browserTaskIdHash ?? null;
  const sentinelTaskIdHash = sentinel.browserTaskIdHash ?? null;
  const uniqueTargets = new Map();
  const rememberTarget = (target) => {
    const prior = uniqueTargets.get(target.targetIdHash) ?? {};
    uniqueTargets.set(target.targetIdHash, {
      ...prior,
      ...target,
      attached: typeof target.attached === 'boolean' ? target.attached : (prior.attached ?? null),
      windowIdHash: target.windowIdHash ?? prior.windowIdHash ?? null,
      windowIdObserved: target.windowIdObserved === true || prior.windowIdObserved === true,
    });
  };
  for (const snapshot of main.taskTargetSnapshots ?? []) {
    if (snapshot.taskIdHash !== mainTaskIdHash) continue;
    for (const target of snapshot.targets ?? []) rememberTarget(target);
  }
  for (const target of main.targetsAfterClose ?? []) rememberTarget(target);
  const sentinelTargets = [...new Map([...(sentinel.taskTargetSnapshots ?? []).filter((snapshot) => snapshot.taskIdHash === sentinelTaskIdHash)
    .flatMap((snapshot) => snapshot.targets ?? [])].map((target) => [target.targetIdHash, target])).values()];
  return {
    status: checks.mainChildLifecycleVerified && checks.otherTaskIsolationVerified ? 'core_verified_with_explicit_limits' : 'partial',
    mainTask: {
      taskIdHash: mainTaskIdHash,
      targets: [...uniqueTargets.values()].map((target) => ({
        ...target,
        opener: target.targetIdHash === main.childTargetIdHash
          ? { targetIdHash: main.parentTargetIdHash ?? null, tabIdHash: target.openerTabIdHash ?? null, ownerTaskIdHash: mainTaskIdHash, attribution: target.openerTabIdHash ? 'extension_reported_openerTabId_and_same_task_parent' : 'opener_not_reported' }
          : { targetIdHash: null, ownerTaskIdHash: mainTaskIdHash, attribution: 'task_root_or_opener_not_exposed' },
      })),
      parentTargetIdHash: main.parentTargetIdHash ?? null,
      parentTabIdHash: main.parentTabIdHash ?? null,
      childTargetIdHash: main.childTargetIdHash ?? null,
      childTabIdHash: main.childTabIdHash ?? null,
      childOpener: {
        openerTargetIdHash: main.parentTargetIdHash ?? null,
        openerTabIdHash: main.childOpenerTabId === null || main.childOpenerTabId === undefined ? null : HashedIdentifier('tab', main.childOpenerTabId),
        ownerTaskIdHash: mainTaskIdHash,
        sameTaskOwnershipObserved: main.childTabObserved === true && main.childOpenerVerified === true,
        attributionBasis: main.childOpenerVerified === true
          ? 'extension Target.getTargets reported openerTabId matching the parent tabId in the same task'
          : 'child openerTabId was not reported as an exact match; ownership is not claimed',
        rawOpenerIdExposed: main.childOpenerTabId !== null && main.childOpenerTabId !== undefined,
      },
      windowId: { observed: Number.isSafeInteger(main.parentWindowId) || Number.isSafeInteger(main.childWindowId), windowIdHash: Number.isSafeInteger(main.parentWindowId) ? HashedIdentifier('window', main.parentWindowId) : Number.isSafeInteger(main.childWindowId) ? HashedIdentifier('window', main.childWindowId) : null },
      hostCloseTaskReceipts: main.closeTaskReceipts ?? [],
      finalTargetsAfterHostClose: main.targetsAfterClose ?? null,
      timeline: main.taskTabTimeline ?? [],
    },
    otherTask: {
      taskIdHash: sentinelTaskIdHash,
      targetIdHash: sentinel.sentinelTargetIdHash ?? null,
      ownTaskTargetsBeforeMainClose: (sentinel.targetsBeforeMainClose ?? []).map((target) => ({
        ...target, opener: { targetIdHash: null, ownerTaskIdHash: sentinelTaskIdHash, attribution: 'task_root_or_opener_not_exposed' },
      })),
      ownTaskTargetsAfterMainClose: (sentinel.targetsAfterMainClose ?? []).map((target) => ({
        ...target, opener: { targetIdHash: null, ownerTaskIdHash: sentinelTaskIdHash, attribution: 'task_root_or_opener_not_exposed' },
      })),
      ownTaskTargetsAfterOwnClose: sentinel.targetsAfterOwnClose === null ? null : (sentinel.targetsAfterOwnClose ?? []).map((target) => ({
        ...target, opener: { targetIdHash: null, ownerTaskIdHash: sentinelTaskIdHash, attribution: 'task_root_or_opener_not_exposed' },
      })),
      targets: sentinelTargets.map((target) => ({
        ...target, opener: { targetIdHash: null, ownerTaskIdHash: sentinelTaskIdHash, attribution: 'task_root_or_opener_not_exposed' },
      })),
      pendingConfirmationHeldWithoutExecution: sentinel.confirmationHeld === true,
      ownHostCloseTaskReceipts: sentinel.closeTaskReceipts ?? [],
      timeline: sentinel.taskTabTimeline ?? [],
    },
    userOriginalTab: {
      status: 'not_independently_identified',
      targetIdHash: null,
      listedByMainTaskScopedGetTargets: null,
      closeOutcomeDirectlyObserved: null,
      evidenceBoundary: 'The harness does not enumerate global Chrome targets or capture a user-tab ID. Task-scoped Target.getTargets contains only this task registry; CloseTask cleanup is checked against its owned target IDs. The separate other-task sentinel is directly verified below.',
    },
    noopener: {
      status: checks.noopenerFixtureControlPresent === true && checks.noopenerTested !== true
        ? 'unsupported_partial_not_exercised' : checks.noopenerFixtureControlPresent === true ? 'attempted_unverified' : 'fixture_control_missing',
      fixtureControlPresent: checks.noopenerFixtureControlPresent === true,
      attempted: checks.noopenerTested === true,
      reason: 'A noopener child has no verifiable opener ownership in this bridge contract; the fixture keeps it as an explicit hidden control and does not create an unattributed tab.',
    },
    checks,
  };
}

function FixtureRegionStateExpression() {
  return '(() => {' +
    'const read = (selector) => {' +
      'const element = document.querySelector(selector);' +
      'if (!element) return null;' +
      'const displayText = String(element.textContent || "").replace(/\\s+/g, " ").trim();' +
      'const dataSelected = element.dataset?.selected ?? null;' +
      'const dataValue = element.dataset?.value ?? null;' +
      'const ariaValueText = element.getAttribute("aria-valuetext");' +
      'const ariaSelected = element.getAttribute("aria-selected");' +
      'const ariaSelectedValue = ariaSelected === "true" ? displayText : null;' +
      'return {' +
        'text: displayText, displayText, nativeValue: typeof element.value === "string" ? element.value : "",' +
        'selected: dataSelected || ariaValueText || dataValue || ariaSelectedValue || "", dataSelected, dataValue, ariaValueText, ariaSelected,' +
        'disabled: Boolean(element.disabled),' +
        'ariaDisabled: element.getAttribute("aria-disabled"),' +
        'dataState: element.getAttribute("data-state"),' +
        'expanded: element.getAttribute("aria-expanded"),' +
        'hidden: Boolean(element.hidden),' +
      '};' +
    '};' +
    'const options = (selector) => [...document.querySelectorAll(selector)].map((element) => ({' +
      'text: String(element.textContent || "").replace(/\\s+/g, " ").trim(),' +
      'value: element.dataset?.value || "",' +
      'role: element.getAttribute("role") || "",' +
      'disabled: Boolean(element.disabled),' +
      'ariaSelected: element.getAttribute("aria-selected"),' +
      'selected: element.getAttribute("aria-selected") === "true",' +
    '}));' +
    'return {' +
      'province: read("#province"),' +
      'city: read("#city"),' +
      'provinceOptions: { hidden: Boolean(document.querySelector("#province-options")?.hidden), values: options("#province-options [role=option]") },' +
      'cityOptions: { hidden: Boolean(document.querySelector("#city-options")?.hidden), values: options("#city-options [role=option]") },' +
      'eventCount: Array.isArray(window.__pb03RegionEvents) ? window.__pb03RegionEvents.length : 0,' +
      'events: Array.isArray(window.__pb03RegionEvents) ? window.__pb03RegionEvents.slice(-80) : [],' +
    '};' +
  '})()';
}

async function ReadFixtureRegionState(runtime, label) {
  const expression = FixtureRegionStateExpression();
  const response = await runtime.RunCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], { deadline: Date.now() + 10_000 });
  const value = response?.data?.result ?? response?.data?.value ?? response?.data;
  if (!value || typeof value !== 'object') throw new Error(`PB03 fixture region oracle returned no state after ${label}.`);
  return value;
}

function CustomControlSelectedValue(control) {
  return [control?.dataSelected, control?.ariaValueText, control?.dataValue,
    control?.ariaSelected === 'true' ? control?.displayText ?? control?.text : null, control?.selected]
    .map((value) => String(value ?? '').trim())
    .find((value) => value.length > 0) ?? '';
}

function AssertCustomControlSelection(control, expected, label) {
  const displayText = String(control?.displayText ?? control?.text ?? '').replace(/\s+/g, ' ').trim();
  const selectedSignals = [control?.dataSelected, control?.ariaValueText, control?.dataValue,
    control?.ariaSelected === 'true' ? displayText : null, control?.selected]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);
  const conflictingSignal = selectedSignals.find((value) => value !== expected);
  // 自定义 button 没有可用的 HTML value；若页面没有稳定的 ARIA/data-selected 字段，
  // 已经通过 AssertCustomOptionAction 的真实 option 事件后，以显示文本作为选中态。
  if (displayText !== expected || conflictingSignal) {
    throw new Error(`PB03 fixture ${label} did not expose the expected custom-control selection: ${JSON.stringify({ displayText, selectedSignals, control })}.`);
  }
}

function AssertCustomOptionSelection(state, listKey, expected, label) {
  const values = Array.isArray(state?.[listKey]?.values) ? state[listKey].values : [];
  const matching = values.find((option) => String(option?.value ?? '').trim() === expected
    || String(option?.text ?? '').replace(/\s+/g, ' ').trim() === expected);
  if (!matching || matching.role !== 'option' || matching.disabled === true) {
    throw new Error(`PB03 fixture ${label} did not expose the expected option in ${listKey}: ${JSON.stringify({ expected, values })}.`);
  }
  const explicitlySelected = values.filter((option) => option?.selected === true || option?.ariaSelected === 'true');
  if ((explicitlySelected.length > 0 && !explicitlySelected.includes(matching)) || explicitlySelected.length > 1) {
    throw new Error(`PB03 fixture ${label} exposed a different selected option: ${JSON.stringify({ expected, matching, explicitlySelected })}.`);
  }
}

function AssertCustomTriggerAction(state, cursor, expectedField) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const eventCount = Number.isSafeInteger(state?.eventCount) ? state.eventCount : events.length;
  const firstEventIndex = Math.max(0, eventCount - events.length);
  const recent = events.slice(Math.max(0, Number(cursor) - firstEventIndex));
  const triggerClick = recent.find((event) => event?.type === 'click' && event?.targetRole === 'combobox' && event?.field === expectedField);
  if (!triggerClick) {
    throw new Error(`PB03 fixture ${expectedField} trigger click was not observed before opening its listbox: ${JSON.stringify({ expectedField, recent })}.`);
  }
}

function AssertCustomOptionAction(state, cursor, label, expectedText, expectedField) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const eventCount = Number.isSafeInteger(state?.eventCount) ? state.eventCount : events.length;
  const firstEventIndex = Math.max(0, eventCount - events.length);
  const recent = events.slice(Math.max(0, Number(cursor) - firstEventIndex));
  const requiredTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  let sequenceIndex = -1;
  const sequence = requiredTypes.map((type) => {
    const index = recent.findIndex((event, candidateIndex) => candidateIndex > sequenceIndex && event?.type === type);
    sequenceIndex = index;
    return index;
  });
  const types = recent.map((event) => String(event?.type || ''));
  if (sequence.some((index) => index < 0)) {
    throw new Error(`PB03 fixture ${label} did not observe the required real mouse/click event sequence: ${types.join(',') || 'none'}.`);
  }
  const relevant = sequence.map((index) => recent[index]);
  const invalidTarget = relevant.find((event) => event?.trusted !== true || event?.targetRole !== 'option' || event?.optionRole !== 'option'
    || event?.optionText !== expectedText || event?.field !== expectedField);
  if (invalidTarget) {
    throw new Error(`PB03 fixture ${label} event did not identify the expected option ${expectedField}/${expectedText}: ${JSON.stringify(invalidTarget)}.`);
  }
}

function FixtureDomCheckerExpression(expected) {
  const config = JSON.stringify(expected);
  return '(async () => {' +
    'const config = ' + config + ';' +
    'const name = document.querySelector("input[name=name]");' +
    'const direction = document.querySelector("select[name=direction]");' +
    'const province = document.querySelector("#province"); const city = document.querySelector("#city");' +
    'const date = document.querySelector("input[name=birthDate]"); const terms = document.querySelector("input[name=terms]");' +
    'const fileInput = document.querySelector("input[name=resume][type=file]");' +
    'const file = fileInput && fileInput.files ? fileInput.files[0] : null;' +
    'let actualFile = { fileName: null, sizeBytes: null, sha256: null, nameMatches: false, sizeMatches: false, sha256Matches: false };' +
    'if (file) {' +
      'const digest = globalThis.crypto && crypto.subtle ? await crypto.subtle.digest("SHA-256", await file.arrayBuffer()) : null;' +
      'const sha256 = digest ? [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") : "";' +
      'actualFile = { fileName: file.name, sizeBytes: file.size, sha256, nameMatches: file.name === config.fileName, sizeMatches: file.size === config.fileSize, sha256Matches: sha256 === config.fileSha256 };' +
    '}' +
    'const monitor = window.__pb03SubmissionMonitor; const submitControl = document.querySelector("[data-pb03-submit]");' +
    'const regionEvents = Array.isArray(window.__pb03RegionEvents) ? window.__pb03RegionEvents.slice(-80) : [];' +
    'const selected = (element) => element?.dataset?.selected || element?.getAttribute("aria-valuetext") || element?.dataset?.value || "";' +
    'const display = (element) => String(element?.textContent || "").replace(/\\s+/g, " ").trim();' +
    'const customSelectionMatches = (element, expected) => { const selectedValue = selected(element); return display(element) === expected && (!selectedValue || selectedValue === expected); };' +
    'const regionAttributes = { provinceDisabled: Boolean(province && province.disabled), provinceAriaDisabled: province?.getAttribute("aria-disabled"), provinceDataState: province?.getAttribute("data-state"), provinceSelected: selected(province), provinceDisplayText: display(province), cityDisabled: Boolean(city && city.disabled), cityAriaDisabled: city?.getAttribute("aria-disabled"), cityDataState: city?.getAttribute("data-state"), citySelected: selected(city), cityDisplayText: display(city), provinceExpanded: province?.getAttribute("aria-expanded"), cityExpanded: city?.getAttribute("aria-expanded") };' +
    'return { fields: {' +
      'name: Boolean(name && name.value === config.name),' +
      'direction: Boolean(direction && direction.value === config.direction),' +
      'regionHierarchy: Boolean(province && city && customSelectionMatches(province, config.province) && customSelectionMatches(city, config.city)),' +
      'date: Boolean(date && date.value === config.date),' +
      'termsChecked: Boolean(terms && terms.checked)' +
    '}, fileSelected: Boolean(file), file: actualFile, regionAttributes, regionEvents,' +
    'submissionMonitorAvailable: Boolean(monitor && monitor.installed && typeof window.__pb03SubmitAttempts === "number" && typeof window.__pb03NetworkSubmitAttempts === "number"),' +
    'submitAttempts: Number(window.__pb03SubmitAttempts || 0), networkSubmissionAttempts: Number(window.__pb03NetworkSubmitAttempts || 0),' +
    'submitControlPresent: Boolean(submitControl) }; })()';
}

async function RunFixtureDomChecker(runtime, expected) {
  const expression = FixtureDomCheckerExpression(expected);
  const response = await runtime.RunCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], { deadline: Date.now() + 10_000 });
  const value = response?.data?.result ?? response?.data?.value ?? response?.data;
  const fields = value?.fields && typeof value.fields === 'object' ? value.fields : {};
  const file = value?.file && typeof value.file === 'object' ? value.file : {};
  const requiredFieldsVerified = ['name', 'direction', 'regionHierarchy', 'date', 'termsChecked'].every((key) => fields[key] === true);
  const fileVerified = value?.fileSelected === true && file.nameMatches === true && file.sizeMatches === true && file.sha256Matches === true;
  const noSubmitObserved = value?.submissionMonitorAvailable === true && value.submitAttempts === 0 && value.networkSubmissionAttempts === 0;
  return {
    checker: 'supplemental_read_only_dom', attempted: true, available: true, requiredFieldsVerified,
    fields: Object.fromEntries(['name', 'direction', 'regionHierarchy', 'date', 'termsChecked'].map((key) => [key, fields[key] === true])),
    fileSelected: value?.fileSelected === true, fileVerified,
    file: {
      fileName: typeof file.fileName === 'string' ? file.fileName : null,
      sizeBytes: Number.isSafeInteger(file.sizeBytes) ? file.sizeBytes : null,
      sha256: typeof file.sha256 === 'string' ? file.sha256 : null,
      nameMatches: file.nameMatches === true, sizeMatches: file.sizeMatches === true, sha256Matches: file.sha256Matches === true,
    },
    submissionMonitorAvailable: value?.submissionMonitorAvailable === true,
    submitAttempts: Number.isSafeInteger(value?.submitAttempts) ? value.submitAttempts : null,
    networkSubmissionAttempts: Number.isSafeInteger(value?.networkSubmissionAttempts) ? value.networkSubmissionAttempts : null,
    submitControlPresent: value?.submitControlPresent === true, noSubmitObserved,
    regionAttributes: value?.regionAttributes && typeof value.regionAttributes === 'object' ? value.regionAttributes : null,
    regionEventCount: Number.isSafeInteger(value?.regionEvents?.length) ? value.regionEvents.length : null,
    regionEventTypes: Array.isArray(value?.regionEvents) ? value.regionEvents.map((event) => String(event?.type || '')) : [],
    regionEvents: Array.isArray(value?.regionEvents) ? value.regionEvents.map((event) => ({
      type: String(event?.type || ''), targetRole: event?.targetRole ?? null, optionRole: event?.optionRole ?? null,
      optionText: event?.optionText ?? null, field: event?.field ?? null, trusted: event?.trusted === true,
    })) : [],
    verified: requiredFieldsVerified && fileVerified && noSubmitObserved,
  };
}

async function IsTcpPortListening(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return false;
  return await new Promise((resolveProbe) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function ReadState(userDataPath) {
  try { return JSON.parse(await readFile(join(userDataPath, 'agent-state.json'), 'utf8')); } catch { return {}; }
}

function HumanReadableSummary(output) {
  return [
    'PB-03 浏览器扩展本地 Fixture 验收',
    '时间: ' + output.generatedAt,
    '状态: ' + output.status,
    '工作树: ' + JSON.stringify(output.worktree),
    'fixture URL(host/path; port/query/hash 已隐藏): ' + output.fixture.url,
    'Bridge: ' + JSON.stringify(output.browser?.bridge ?? {}),
    '浏览器进程: ' + JSON.stringify(output.browser?.browserProcess ?? {}),
    'PB-03 preflight: ' + JSON.stringify({ gate: output.preflightGate ?? output.browser?.preflightGate ?? 'not_evaluated', browserProcess: { launched: output.browser?.browserProcess?.launched === true }, pairPageOpened: output.browser?.pairPageOpened === true, preflightNoSideEffects: output.browser?.preflightNoSideEffects === true, handshakeReceived: output.handshakeReceived ?? output.browser?.handshakeReceived ?? false, handshakeSource: output.handshakeSource ?? output.browser?.handshakeSource ?? 'skipped_test_mode' }),
    '恢复配对: ' + String(output.restorePairing ?? 'not_requested'),
    '扩展 hello/version: ' + JSON.stringify(output.browser?.extension ?? {}),
    '扩展 protocolRevision expected/actual: ' + JSON.stringify({ expected: output.browser?.extension?.expectedProtocolRevision ?? expectedExtensionProtocolRevision, actual: output.browser?.extension?.protocolRevision ?? null, state: output.browser?.extension?.state ?? 'offline' }),
    '合成 PDF: ' + JSON.stringify(output.resource),
    '确认回执: ' + JSON.stringify(output.confirmations ?? []),
    '确认 proposal gate/primary failure: ' + JSON.stringify({ gate: output.observations?.confirmationGate ?? null, primary: output.primaryFailure ?? null }),
    'Host Run 状态: ' + JSON.stringify(output.hostRunState ?? {}),
    'Host/provider 首因: ' + JSON.stringify({ errorCode: output.errorCode ?? null, error: output.error ?? null, providerFailure: output.observations?.providerFailure ?? null, hostSendError: output.observations?.hostSendError ?? null, secondaryCheckerErrors: output.observations?.secondaryCheckerErrors ?? [] }),
    'BrowserNavigate 结果/证据: ' + JSON.stringify(output.observations?.navigationResult ?? {}),
    'Validate 精确 issue/ref/reason: ' + JSON.stringify(output.observations?.validation ?? {}),
    '继续门与 pre-child DOM/file/no-submit evidence: ' + JSON.stringify({ gate: output.observations?.validationGate ?? null, evidence: output.observations?.preChildEvidence ?? null }),
    '上传确认与文件 DOM 元数据: ' + JSON.stringify({ result: output.observations?.uploadResult ?? null, dom: output.observations?.validationDomChecker?.file ?? null }),
    '子页切换/readyState/Snapshot 首因: ' + JSON.stringify({ childIdentityGate: output.observations?.childIdentityGate ?? null, childSwitchGate: output.observations?.childSwitchGate ?? null, parentSwitchGate: output.observations?.parentSwitchGate ?? null, childTargetAppearanceWait: output.observations?.childTargetAppearanceWait ?? null, childReadyWait: output.observations?.childReadyWait ?? null, childSnapshotFailure: output.observations?.childSnapshotFailure ?? null }),
    '强制 pre-final gate/cleanup count: ' + JSON.stringify({ preFinal: output.observations?.preFinalGate ?? null, finalEvidence: output.observations?.finalEvidenceGate ?? null, cleanup: output.observations?.cleanupObservationGate ?? null }),
    'Provider 回合/工具结果: ' + JSON.stringify({ turns: output.observations?.providerTurns ?? 0, results: output.observations?.toolResults ?? [] }),
    '省份/城市级联时序与页面属性: ' + JSON.stringify(output.observations?.regionTimeline ?? []),
    'Host 工具回执: ' + JSON.stringify(output.toolEvents),
    '工具 Ledger: ' + JSON.stringify(output.ledger),
    'DOM checker: ' + JSON.stringify(output.domChecker ?? {}),
    '无提交证据: ' + JSON.stringify(output.noSubmitEvidence ?? {}),
    '任务/标签页归属证据: ' + JSON.stringify(output.taskTabEvidence ?? {}),
    ...(output.connectionGuidance ? ['后续操作: ' + output.connectionGuidance] : []),
  ].join('\n');
}

// PB-03正式 smoke 默认是 attach-only：没有现成浏览器时应进入可行动的
// preflight block，而不是在入口处为了检查可执行文件就启动/配对 Chrome。
if (!hostInitOnly && allowBrowserLaunch && !existsSync(browserPath)) throw new Error(engine + ' executable is unavailable.');
if (!existsSync(extensionPath)) throw new Error('The project browser extension is unavailable.');
if (!existsSync(fixturePath) || !existsSync(childFixturePath)) throw new Error('PB-03 local fixture pages are unavailable.');
if (!existsSync(uploadPath)) throw new Error('PB-03 synthetic PDF fixture is unavailable.');
const fixtureMarkup = await readFile(fixturePath, 'utf8');
const noopenerFixtureControlPresent = /id="noopener-child-control"[^>]*rel="noopener"[^>]*hidden/.test(fixtureMarkup);

const bridgePort = ParsePort(args['bridge-port']);
const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-extension-smoke-'));
const artifactStamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const artifactDir = join(projectRoot, 'artifacts', 'browser-extension', artifactStamp + '-' + process.pid);
await mkdir(artifactDir, { recursive: true });
const uploadBytes = await readFile(uploadPath);
if (!uploadBytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) throw new Error('PB-03 synthetic resume fixture is not a PDF.');
const uploadSha256 = Sha256(uploadBytes);
const uploadSize = uploadBytes.length;
const fixtureRequests = [];
const fixture = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  fixtureRequests.push({ method: String(request.method || 'GET').toUpperCase(), pathname });
  const filePath = pathname === '/child' ? childFixturePath : pathname === '/application' || pathname === '/sentinel' || pathname === '/' ? fixturePath : null;
  if (pathname === '/submit' && request.method !== 'GET') {
    response.writeHead(204); response.end(); return;
  }
  if (!filePath) { response.writeHead(404); response.end('not found'); return; }
  const body = await readFile(filePath);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(body);
});
await new Promise((resolveServer, reject) => {
  fixture.once('error', reject);
  fixture.listen(0, '127.0.0.1', resolveServer);
});
const fixturePort = fixture.address().port;
const fixtureUrl = 'http://127.0.0.1:' + fixturePort + '/application';
const bridgeStatePath = hostInitOnly
  ? join(runtimeRoot, 'browser-extension', 'bridge.json')
  : process.env.APPDATA
    ? join(process.env.APPDATA, 'avery', 'browser-extension', 'bridge.json')
    : join(runtimeRoot, 'browser-extension', 'bridge.json');
const restorePort = Number(args['restore-port'] || 0);
const events = [];
const observations = {
  navigated: false, readTitle: '', submissionMonitorArmed: false, snapshotCount: 0, finalSubmitCandidates: 0, providerTurns: 0,
  navigationResult: null,
  toolResults: [], actionIntents: [], validation: null, validationGate: null, validationDomChecker: null, preChildEvidence: null, uploadResult: null, uploadResultData: null,
  currentPageRevision: null, confirmationGate: null, uploadOracle: null, preFinalGate: null, finalEvidenceGate: null,
  parentTabId: null, parentTargetId: null, parentTabIdHash: null, parentWindowId: null, parentOpenerTabId: null,
  childTargetId: null, childTabId: null, childTabIdHash: null, childWindowId: null, childOpenerTabId: null,
  childTargetObserved: null, childTargetAppearanceWait: null, childReadyWait: null, parentReadyWait: null, childSnapshotFailure: null, targetsBeforeChildOpen: [],
  childTabObserved: false, finalSnapshot: null, primaryFailureSequence: 0, primaryFailureSequenceLog: [],
  taskTargetSnapshots: [], taskTabTimeline: [], targetEvidenceErrors: [], secondaryCheckerErrors: [], childDiscoveryAttempts: 0, regionTimeline: [],
};
const output = {
  schemaVersion: 1, mode: hostInitOnly ? 'host-init-only' : 'local-fixture', engine, status: 'blocked', generatedAt: new Date().toISOString(),
  worktree: await WorktreeEvidence(),
  commandArguments: { mode: hostInitOnly ? 'host-init-only' : 'local-fixture', engine, bridgePort: args['bridge-port'] ?? 'ephemeral', submitRequested: false, allowBrowserLaunch },
  extension: { projectPath: 'apps/browser-extension', expectedVersion: expectedExtensionVersion, expectedProtocolRevision: expectedExtensionProtocolRevision },
  fixture: { url: 'http://127.0.0.1:<ephemeral>/application' },
  resource: { fileId: uploadFileId, name: uploadName, bytes: uploadSize, sha256: uploadSha256, source: 'repo-fixture', personalMaterial: false },
  browser: BuildPb03PreflightEvidence({ launchState, browserProcessRunning: false, browser: { browserProcess: { engine, running: false } } }),
  browserProcess: { engine, running: false, launched: false }, pairPageOpened: false, preflightNoSideEffects: true,
  hostInitialization: null, toolEvents: [], ledger: [], domChecker: null, noSubmitEvidence: null, taskTabEvidence: null,
};

// 任何 Host/provider/tool 之前先落一次最小 artifact，离线/stale 也必须留有
// 明确的 attach-only 证据。finally 会用最终 summary 覆盖同一文件。
const WritePreflightArtifact = async () => {
  await writeFile(join(artifactDir, 'summary.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
  await writeFile(join(artifactDir, 'summary.log'), HumanReadableSummary(output) + '\n', 'utf8');
};
await WritePreflightArtifact();

let bridge;
let runtime;
let host;
let hostClosedEarly = false;
let sentinelRuntime;
let sentinelHost;
let userDataPath;
let sentinelUserDataPath;
let sentinelEvents = [];
let sentinelObservations = null;
let sentinelProvider = null;
let sentinelConfirmation = null;
const taskCloseReceipts = new Map();
try {
  smoke: {
  bridge = new BrowserExtensionBridge({ statePath: bridgeStatePath, port: bridgePort, browserPaths: { [engine]: browserPath }, launchBrowser: LaunchBrowserWithProjectExtension });
  ObserveTaskCloseReceipts(bridge, taskCloseReceipts);
   runtime = new AgentBrowserRuntime({
    runtimeRoot: join(runtimeRoot, 'browser-runtime'), externalBrowserPaths: { [engine]: browserPath },
    browserExtensionBridge: bridge, resolveUploadFile: async (fileId) => fileId === uploadFileId ? uploadPath : null,
    recordLog: () => undefined,
   });
   await runtime.SetEngine(engine);
   if (hostInitOnly) await bridge.Start();
   // Attach-only preflight uses this same Bridge/Runtime instance. While the
   // handshake is pending it only observes Bridge status: no Host/provider,
   // Request, browser launch, pairing page, or tab action is allowed.
   const handshake = hostInitOnly
     ? { ready: false, status: 'not_evaluated', blocked: false, handshakeReceived: false, source: 'skipped_test_mode', actualVersion: null, actualProtocolRevision: null, versionMatches: false, protocolRevisionMatches: false, online: false, state: 'host_init_only_not_pb03', waitedMs: 0, waitDurationMs: 0, attempts: 0, preflightGate: 'not_evaluated' }
     : await WaitForPb03Handshake({
       bridge,
       expectedVersion: expectedExtensionVersion,
       expectedProtocolRevision: expectedExtensionProtocolRevision,
       timeoutMs: 20_000,
       intervalMs: 100,
     });
   userDataPath = join(runtimeRoot, 'user-data');
   if (hostInitOnly) {
      const status = bridge.Status();
     const listening = await IsTcpPortListening(status.port);
      const provider = CreateFixtureProvider(fixtureUrl, observations, runtime, bridge);
      host = new AgentHost({
        userDataPath, workspacePath: runtimeRoot, Emit: (event) => events.push(event),
        business: CreateBusiness(), observability: EmptyObservability(events),
        credentialPort: { async Load() { return null; }, async Save() {} },
        browserRuntime: runtime, externalBrowserPaths: { [engine]: browserPath },
        createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }),
      });
      const providerSdkVersion = host.GetModuleConfiguration()?.modules?.find((module) => module.slot === 'model-provider')?.sdkVersion ?? null;
    output.hostInitialization = { initialized: providerSdkVersion === HostSdkVersion, modelProviderSdkVersion: providerSdkVersion, hostSdkVersion: HostSdkVersion };
    output.browser = BuildPb03PreflightEvidence({ browserProcessRunning: await IsBrowserProcessRunning(), launchState, browser: {
      bridge: { listening, port: status.port, listenerState: listening ? 'listening' : 'not_listening' },
       extension: { helloReceived: false, handshakeReceived: false, handshakeSource: 'skipped_test_mode', online: false, state: 'host_init_only_not_pb03', version: null, actualVersion: null, expectedVersion: expectedExtensionVersion, versionMatches: false, protocolRevision: null, actualProtocolRevision: null, expectedProtocolRevision: expectedExtensionProtocolRevision, protocolRevisionMatches: false },
       handshakeReceived: false, handshakeSource: 'skipped_test_mode', actualVersion: null, actualProtocolRevision: null, handshakeWaitedMs: 0, handshakeWaitDurationMs: 0, handshakeAttempts: 0, handshakeState: 'not_evaluated', preflightGate: 'not_evaluated', pb03Eligible: false, evidenceTier: 'test_only', testMode: 'host-init-only',
     } });
    output.browserProcess = output.browser.browserProcess;
    output.pairPageOpened = output.browser.pairPageOpened;
    output.preflightNoSideEffects = output.browser.preflightNoSideEffects;
    output.handshakeReceived = false;
    output.handshakeSource = 'skipped_test_mode';
    output.actualVersion = null;
    output.actualProtocolRevision = null;
    output.handshakeWaitedMs = 0;
    output.handshakeWaitDurationMs = 0;
    output.handshakeAttempts = 0;
    output.handshakeState = 'not_evaluated';
     output.status = listening && output.hostInitialization.initialized ? 'host_init_only_not_pb03' : 'host_init_only_failed';
     output.preflightGate = 'not_evaluated';
     output.pb03Eligible = false;
     output.evidenceTier = 'test_only';
    if (output.status !== 'host_init_only_not_pb03') output.errorCode = 'PB03_HOST_INIT_CHECK_FAILED';
    break smoke;
  }
   // 先只启动/附着 Bridge 并等待同一 Bridge 的权威 hello/poll 握手；
   // GetStatus(true) 会在断线时走 EnsureConnected 的 launch 分支，所以只能
   // 在 preflight 已确认在线后调用。
   const before = await runtime.GetStatus(false);
   const bridgeStatus = bridge.Status();
  const listening = await IsTcpPortListening(bridgeStatus.port);
  const initialBrowser = {
    bridge: { listening, port: bridgeStatus.port, listenerState: listening ? 'listening' : 'not_listening' },
    browserProcess: { engine, running: await IsBrowserProcessRunning() },
    extension: {
       helloReceived: handshake.source === 'hello', handshakeReceived: handshake.handshakeReceived, handshakeSource: handshake.source, online: handshake.online,
       state: handshake.state,
       version: handshake.actualVersion, actualVersion: handshake.actualVersion, expectedVersion: expectedExtensionVersion,
       versionMatches: handshake.versionMatches,
       protocolRevision: handshake.actualProtocolRevision, actualProtocolRevision: handshake.actualProtocolRevision,
       expectedProtocolRevision: bridgeStatus.expectedProtocolRevision ?? expectedExtensionProtocolRevision,
       protocolRevisionMatches: handshake.protocolRevisionMatches,
     },
     handshakeReceived: handshake.handshakeReceived, handshakeSource: handshake.source, actualVersion: handshake.actualVersion, actualProtocolRevision: handshake.actualProtocolRevision, handshakeWaitedMs: handshake.waitedMs, handshakeAttempts: handshake.attempts, handshakeState: handshake.status,
    runtime: { available: before.available, running: before.running, state: before.state, engine: before.engine },
  };
  const initialPreflight = ClassifyPb03Preflight({ bridge: { listening }, extension: initialBrowser.extension });
  output.browser = BuildPb03PreflightEvidence({ browserProcessRunning: initialBrowser.browserProcess.running, launchState, browser: initialBrowser });
  output.browserProcess = output.browser.browserProcess;
  output.pairPageOpened = output.browser.pairPageOpened;
  output.preflightNoSideEffects = output.browser.preflightNoSideEffects;
  if (initialPreflight.blocked) {
    output.status = initialPreflight.status;
    output.errorCode = 'PB03_PREFLIGHT_BLOCKED';
    output.error = initialPreflight.action;
    output.connectionGuidance = initialPreflight.action;
    break smoke;
  }
  let beforeAttached;
  try {
    // Keep the launcher guard closed until the already-running extension has
    // completed this probe; a race to offline must not open Chrome or /pair.
    beforeAttached = await runtime.GetStatus(true);
  } catch {
    output.status = 'blocked_extension_not_connected';
    output.errorCode = 'PB03_PREFLIGHT_BLOCKED';
    output.error = 'The existing browser/extension became unavailable during attach-only preflight; reload Avery in chrome://extensions and rerun.';
    output.connectionGuidance = output.error;
    break smoke;
  }
  output.browser.runtime = { available: beforeAttached.available, running: beforeAttached.running, state: beforeAttached.state, engine: beforeAttached.engine };
  if (output.browser.extension.versionMatches !== true) {
    output.status = 'historical_extension_version';
    output.errorCode = 'PB03_EXTENSION_VERSION_MISMATCH';
    output.error = 'The attached Avery extension version does not match the PB-03 fixture contract.';
    output.connectionGuidance = 'Reload the Avery extension in chrome://extensions, then rerun the attach-only smoke.';
    break smoke;
  }
  launchState.preflightSucceeded = true;
  {
    const provider = CreateFixtureProvider(fixtureUrl, observations, runtime, bridge);
    host = new AgentHost({
      userDataPath, workspacePath: runtimeRoot, Emit: (event) => events.push(event),
      business: CreateBusiness(), observability: EmptyObservability(events),
      credentialPort: { async Load() { return null; }, async Save() {} },
      browserRuntime: runtime, externalBrowserPaths: { [engine]: browserPath },
      createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }),
    });
    sentinelEvents = [];
    sentinelObservations = { taskTargetSnapshots: [], taskTabTimeline: [], actionIntents: [], targetEvidenceErrors: [], secondaryCheckerErrors: [], providerTurns: 0 };
    sentinelRuntime = new AgentBrowserRuntime({
      runtimeRoot: join(runtimeRoot, 'sentinel-browser-runtime'), externalBrowserPaths: { [engine]: browserPath },
      browserExtensionBridge: bridge, resolveUploadFile: async (fileId) => fileId === uploadFileId ? uploadPath : null,
      recordLog: () => undefined,
    });
    await sentinelRuntime.SetEngine(engine);
    sentinelUserDataPath = join(runtimeRoot, 'sentinel-user-data');
    sentinelProvider = CreateIsolationSentinelProvider(fixtureUrl.replace('/application', '/sentinel'), sentinelObservations, sentinelRuntime, bridge);
    sentinelHost = new AgentHost({
      userDataPath: sentinelUserDataPath, workspacePath: runtimeRoot, Emit: (event) => sentinelEvents.push(event),
      business: CreateBusiness(), observability: EmptyObservability(sentinelEvents),
      credentialPort: { async Load() { return null; }, async Save() {} },
      browserRuntime: sentinelRuntime, externalBrowserPaths: { [engine]: browserPath },
      createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: sentinelProvider }),
    });
    const sentinelSend = await sentinelHost.Send({
      requestId: 'pb03-sentinel-hold', sessionId: 'pb03-sentinel-session', scenarioId: 'application',
      confirmationMode: 'fully_trusted', attachments: [{ name: uploadName, path: uploadFileId }],
      content: 'Establish a separate task-scoped local fixture tab for an isolation check. Stop at the unaccepted synthetic upload confirmation; do not confirm or upload.',
    });
    const sentinelPendingEvent = [...sentinelEvents].reverse().find((event) => event?.type === 'browser_confirmation'
      && event.requestId === 'pb03-sentinel-hold'
      && typeof (event.confirmationId ?? event.proposalId ?? event.browserAction?.confirmationId) === 'string');
    sentinelConfirmation = sentinelPendingEvent ? String(sentinelPendingEvent.confirmationId ?? sentinelPendingEvent.proposalId ?? sentinelPendingEvent.browserAction?.confirmationId) : null;
    sentinelObservations.browserTaskId = sentinelRuntime.GetBrowserTaskId?.() ?? sentinelObservations.browserTaskId ?? null;
    sentinelObservations.browserTaskIdHash = HashedIdentifier('task', sentinelObservations.browserTaskId);
    sentinelObservations.confirmationHeld = sentinelSend?.accepted === true && Boolean(sentinelConfirmation);
    sentinelObservations.pendingToolName = String(sentinelPendingEvent?.browserAction?.toolName || '');
    sentinelObservations.toolEvents = SafeToolEvents(sentinelEvents);
    if (sentinelObservations.confirmationHeld && sentinelObservations.pendingToolName === 'BrowserUploadFile') {
      try {
        const targets = await ReadTaskTargetInfos(bridge, sentinelObservations.browserTaskId);
        sentinelObservations.targetsBeforeMainClose = RecordTaskTargets(sentinelObservations, sentinelObservations.browserTaskId, targets, 'read_only_Target.getTargets_before_main_task');
        const target = targets.find((item) => {
          const identity = TargetIdentity(item);
          return identity?.targetId === sentinelObservations.sentinelTargetId
            && identity.tabId === sentinelObservations.sentinelTabId
            && identity.windowId === sentinelObservations.sentinelWindowId;
        });
        sentinelObservations.sentinelTargetIdHash = HashedIdentifier('target', target?.targetId);
        AddTimeline(sentinelObservations, 'other_task_target_visible_before_main_task', {
          taskIdHash: sentinelObservations.browserTaskIdHash,
          targetIdHash: sentinelObservations.sentinelTargetIdHash,
          tabIdHash: HashedIdentifier('tab', target?.tabId),
          attached: target?.attached === true,
          active: target?.active === true,
        });
      } catch (error) { RecordTargetEvidenceError(sentinelObservations, error, 'sentinel_before_main_close_target_evidence'); }
    }
    observations.sentinelTaskIdHash = sentinelObservations.browserTaskIdHash;
    observations.sentinelTargetIdHash = sentinelObservations.sentinelTargetIdHash ?? null;
    observations.isolationContext = {
      browserTaskId: sentinelObservations.browserTaskId ?? null,
      browserTaskIdHash: sentinelObservations.browserTaskIdHash ?? null,
      targetIdHash: sentinelObservations.sentinelTargetIdHash ?? null,
      confirmationHeld: sentinelObservations.confirmationHeld === true,
      pendingToolName: sentinelObservations.pendingToolName ?? null,
      confirmationId: sentinelConfirmation,
    };
    const confirmations = [];
    const handledConfirmations = new Set();
    let sendResult = null;
    let flowError = null;
    let lastRequestId = null;
    for (let turn = 0; turn < 48; turn += 1) {
      const requestId = 'pb03-fixture-run-' + turn;
      lastRequestId = requestId;
      try {
        sendResult = await host.Send({
          requestId, sessionId: 'pb03-fixture-session', scenarioId: 'application',
          confirmationMode: 'fully_trusted',
          attachments: [{ name: uploadName, path: uploadFileId }],
          content: 'Fill and validate only the local synthetic PB-03 fixture. Upload its synthetic PDF through Host confirmation. Open the target blank child page, return to the form, and never submit.',
        });
      } catch (error) {
        const message = SafeError(error);
        observations.hostSendError = {
          requestId,
          code: typeof error?.code === 'string' ? error.code : 'PB03_HOST_SEND_FAILED',
          message,
          ...(observations.providerFailure ? { secondaryOf: observations.providerFailure.code } : {}),
        };
        flowError = observations.providerFailure?.message ?? message;
        break;
      }
      const pending = [...events].reverse().find((event) => event?.type === 'browser_confirmation'
        && event.requestId === requestId
        && typeof (event.confirmationId ?? event.proposalId ?? event.browserAction?.confirmationId) === 'string'
        && !handledConfirmations.has(String(event.confirmationId ?? event.proposalId ?? event.browserAction?.confirmationId)));
      if (!pending) break;
      const confirmationId = String(pending.confirmationId ?? pending.proposalId ?? pending.browserAction?.confirmationId);
      handledConfirmations.add(confirmationId);
      const toolName = String(pending.browserAction?.toolName || 'unknown');
      const lastIntent = observations.actionIntents[observations.actionIntents.length - 1];
      const expectedArguments = lastIntent?.arguments && typeof lastIntent.arguments === 'object' ? lastIntent.arguments : {};
      const inspection = typeof host.InspectPendingBrowserAction === 'function'
        ? host.InspectPendingBrowserAction(confirmationId)
        : null;
      // 确认身份来自检查到的 pending 记录；浏览器事件只是通知，不能修补稀疏或过期 binding。
      const expectedProposalId = inspection?.binding?.proposalId ?? null;
      const expectedProposalHash = inspection?.binding?.proposalHash ?? null;
      const requiresRefBinding = toolName === 'BrowserUploadFile' || typeof expectedArguments.ref === 'string';
      const proposalGate = VerifyPb03ConfirmationProposal({
        event: { ...pending, requestId: pending.requestId ?? requestId },
        inspection,
        expected: {
          proposalId: expectedProposalId,
          proposalHash: expectedProposalHash,
          toolName,
          requestId,
          sessionId: 'pb03-fixture-session',
          runId: requestId,
          browserTaskId: observations.browserTaskId,
          sentinelBrowserTaskId: sentinelObservations?.browserTaskId ?? null,
          pageRevision: Number.isSafeInteger(expectedArguments.pageRevision)
            ? expectedArguments.pageRevision : observations.currentPageRevision,
          requireRef: requiresRefBinding,
          ...(typeof expectedArguments.ref === 'string' ? { ref: expectedArguments.ref } : {}),
          ...(toolName === 'BrowserUploadFile' ? { fileId: uploadFileId } : {}),
        },
      });
      observations.confirmationGate = {
        confirmationIdHash: HashedIdentifier('confirmation', confirmationId),
        toolName,
        requestId,
        proposalIdHash: HashedIdentifier('proposal', proposalGate.proposalId ?? expectedProposalId),
        verified: proposalGate.ok === true,
        ...(proposalGate.ok ? { checks: proposalGate.checks } : { failure: proposalGate }),
      };
      if (!proposalGate.ok) {
        const failure = RecordPrimaryObservationFailure(observations, {
          code: proposalGate.code,
          phase: 'confirmation-proposal-gate',
          message: proposalGate.message,
          details: proposalGate,
        });
        flowError = failure.message;
        break;
      }
      const safeIntent = lastIntent && lastIntent.toolName === toolName && (
        ['BrowserFill', 'BrowserSelect', 'BrowserSetChecked', 'BrowserUploadFile', 'BrowserSwitchTab'].includes(toolName)
        || (toolName === 'BrowserClick' && allowedFixtureClickPurposes.has(lastIntent.purpose))
      );
      const allowed = toolName === 'BrowserUploadFile'
        || (toolName === 'BrowserSetChecked' && lastIntent?.purpose === 'accept-fixture-terms')
        || (toolName === 'BrowserClick' && allowedFixtureClickPurposes.has(lastIntent?.purpose))
        || (safeIntent && ['BrowserFill', 'BrowserSelect', 'BrowserSwitchTab'].includes(toolName));
      const completed = await host.ConfirmBrowserAction(confirmationId, allowed, { sessionId: 'pb03-fixture-session' });
      confirmations.push({
        toolName,
        accepted: allowed,
        status: String(completed?.status || 'unknown'),
        confirmationIdHash: HashedIdentifier('confirmation', confirmationId),
        proposalIdHash: HashedIdentifier('proposal', proposalGate.proposalId),
        browserTaskIdHash: observations.browserTaskIdHash,
        pageRevision: Number.isSafeInteger(expectedArguments.pageRevision) ? expectedArguments.pageRevision : observations.currentPageRevision,
      });
      if (!allowed || completed?.status !== 'succeeded') {
        const failure = RecordPrimaryObservationFailure(observations, {
          code: completed?.code || 'PB03_CONFIRMATION_FAILED',
          phase: 'confirmation-execution',
          message: 'A confirmed PB03 proposal was rejected or failed through AgentHost.',
          details: { toolName, completed },
        });
        flowError = failure.message;
        break;
      }
      provider.SetConfirmedToolResult(toolName, completed, confirmationId);
    }
    const lastMainTerminalEvent = [...events].reverse().find((event) => event?.requestId === lastRequestId
      && ['completed', 'waiting_user_input', 'waiting_confirmation', 'paused', 'cancelled', 'error'].includes(String(event.type)));
    // Kernel budget exhaustion is a terminal error, not a continuation cap
    // inferred from the last waiting_confirmation.  AgentHost currently only
    // returns `accepted`; VerifyPb03KernelTurnLimit combines any future
    // structured Send result with the error event and this smoke Host's exact
    // trace/log records (outcome=circuit_open, reason=iteration_limit or
    // tool_call_limit).
    const kernelTurnLimit = VerifyPb03KernelTurnLimit({
      terminalEvent: lastMainTerminalEvent,
      sendResult,
      traceEvents: events,
    });
    if (kernelTurnLimit.ok) {
      observations.turnLimitExceeded = {
        code: kernelTurnLimit.code,
        outcome: kernelTurnLimit.outcome,
        reason: kernelTurnLimit.reason,
        requestId: lastRequestId,
        terminalEventType: lastMainTerminalEvent?.type ?? null,
        source: kernelTurnLimit.source,
        checks: kernelTurnLimit.checks,
      };
      observations.turnLimitExceeded.message = `Kernel circuit_open terminal: ${kernelTurnLimit.reason}.`;
      RecordPrimaryObservationFailure(observations, {
        code: observations.turnLimitExceeded.code,
        phase: 'kernel-turn-limit',
        message: observations.turnLimitExceeded.message,
        details: observations.turnLimitExceeded,
      });
      flowError = observations.turnLimitExceeded.message;
    }
    const mainRunReleasedBeforeTerminalCleanup = [...events].some((event) => event?.requestId === lastRequestId && event?.type === 'run_released');
    if (observations.turnLimitExceeded && host && !hostClosedEarly && !mainRunReleasedBeforeTerminalCleanup) {
      try {
        // A real circuit_open normally reaches Host's single finally cleanup
        // before Send resolves.  Only if no release receipt exists yet may the
        // harness close the Host to finish that same terminal cleanup path.
        await host.Close();
        hostClosedEarly = true;
      } catch (error) {
        const cleanupError = SafeError(error);
        RecordPrimaryObservationFailure(observations, {
          code: 'PB03_TURN_LIMIT_CLEANUP_FAILED', phase: 'turn-limit-cleanup',
          message: `Turn-limit terminal cleanup failed: ${cleanupError}`,
          details: { error: cleanupError },
        });
      }
    }
    if (observations.browserTaskId) {
      AddTimeline(observations, 'main_task_terminal_returned_host_close_expected', { taskIdHash: observations.browserTaskIdHash });
      const mainReleaseEvents = events.filter((event) => event?.requestId === lastRequestId && event?.type === 'run_released');
      const mainReleaseEvent = mainReleaseEvents.at(-1) ?? null;
      observations.mainRunReleasedCount = mainReleaseEvents.length;
      const lockReleased = mainReleaseEvents.length === 1 && mainReleaseEvent?.type === 'run_released';
      if (observations.turnLimitExceeded && mainReleaseEvents.length !== 1) {
        RecordPrimaryObservationFailure(observations, {
          code: 'PB03_RUN_RELEASED_OBSERVATION_COUNT_FAILED',
          phase: 'turn-limit-run-release',
          message: `Expected exactly one run_released event for the Kernel terminal, observed ${mainReleaseEvents.length}.`,
          details: { count: mainReleaseEvents.length },
        });
      }
      observations.closeTaskReceipts = (taskCloseReceipts.get(observations.browserTaskIdHash) ?? [])
        .map((receipt) => ({ ...receipt, lockReleased }));
      // Host 只有在运行锁与 browser task 清理完成后才发出 run_released；观察到释放后再核验唯一 close 回执，避免迟到 checker 竞态。
      observations.cleanupObservationGate = VerifyPb03ExactlyOneCleanupObservation(observations.closeTaskReceipts);
      observations.hostCloseTaskAcknowledged = observations.closeTaskReceipts.some((receipt) => receipt.acknowledged === true && receipt.closed === true);
      const mainCleanupOutcome = (mainReleaseEvent?.cleanupOutcomes ?? []).find((outcome) => outcome?.browserTaskId === observations.browserTaskId)
        ?? mainReleaseEvent?.cleanupOutcomes?.[0]
        ?? null;
      const lastMainTargetSnapshot = [...observations.taskTargetSnapshots].reverse().find((snapshot) => snapshot.taskIdHash === observations.browserTaskIdHash);
      observations.mainTaskOwnedTargetCountBeforeClose = Array.isArray(lastMainTargetSnapshot?.targets) ? lastMainTargetSnapshot.targets.length : null;
      observations.mainTaskCleanupOutcome = mainCleanupOutcome ? {
        status: mainCleanupOutcome.status,
        closedTabs: Number.isSafeInteger(mainCleanupOutcome.closedTabs) ? mainCleanupOutcome.closedTabs : null,
        unknownTabs: Number.isSafeInteger(mainCleanupOutcome.unknownTabs) ? mainCleanupOutcome.unknownTabs : null,
      } : null;
      observations.mainTaskTargetsClosedByCleanup = observations.hostCloseTaskAcknowledged
        && observations.cleanupObservationGate?.ok === true
        && mainCleanupOutcome?.status === 'confirmed'
        && mainCleanupOutcome?.unknownTabs === 0
        && Number.isSafeInteger(mainCleanupOutcome?.closedTabs)
        && Number.isSafeInteger(observations.mainTaskOwnedTargetCountBeforeClose)
        && mainCleanupOutcome.closedTabs >= observations.mainTaskOwnedTargetCountBeforeClose;
      if (!observations.cleanupObservationGate.ok) {
        RecordPrimaryObservationFailure(observations, {
          code: observations.cleanupObservationGate.code,
          phase: 'main-task-cleanup-observation',
          message: observations.cleanupObservationGate.message,
          details: observations.cleanupObservationGate,
        });
      }
      // CloseTask retires the task registry. Do not issue a task-scoped query after
      // Host has returned; the cleanup receipt is the authoritative terminal evidence.
      observations.targetsAfterClose = null;
      observations.mainTaskTargetsEmptyAfterClose = null;
      observations.mainTaskCloseVerified = observations.hostCloseTaskAcknowledged && observations.cleanupObservationGate?.ok === true;
      observations.parentAbsentAfterClose = null;
      observations.childAbsentAfterClose = null;
      AddTimeline(observations, 'main_task_close_receipt_verified', {
        taskIdHash: observations.browserTaskIdHash,
        targetInspectionAfterClose: 'not_performed_retired_task_protected',
        hostCloseTaskAcknowledged: observations.hostCloseTaskAcknowledged,
        targetClosureFromCleanupReceipt: observations.mainTaskTargetsClosedByCleanup === true,
        ownedTargetCountBeforeClose: observations.mainTaskOwnedTargetCountBeforeClose,
        cleanupOutcome: observations.mainTaskCleanupOutcome,
        cleanupReceipts: observations.closeTaskReceipts,
      });
    }
    if (sentinelObservations?.browserTaskId) {
      try {
        const targets = await ReadTaskTargetInfos(bridge, sentinelObservations.browserTaskId);
        sentinelObservations.targetsAfterMainClose = RecordTaskTargets(sentinelObservations, sentinelObservations.browserTaskId, targets, 'read_only_other_task_Target.getTargets_after_main_close');
        sentinelObservations.otherTaskSurvivedMainClose = targets.some((target) => {
          const identity = TargetIdentity(target);
          return identity?.targetId === sentinelObservations.sentinelTargetId
            && identity.tabId === sentinelObservations.sentinelTabId
            && identity.windowId === sentinelObservations.sentinelWindowId;
        });
        AddTimeline(sentinelObservations, 'other_task_survived_main_task_close', {
          taskIdHash: sentinelObservations.browserTaskIdHash,
          targetIdHash: sentinelObservations.sentinelTargetIdHash,
          stillPresent: sentinelObservations.otherTaskSurvivedMainClose,
        });
      } catch (error) { RecordTargetEvidenceError(sentinelObservations, error, 'sentinel_after_main_close_target_evidence'); }
    }
    if (sentinelHost && sentinelConfirmation) {
      const rejected = await sentinelHost.ConfirmBrowserAction(sentinelConfirmation, false, { sessionId: 'pb03-sentinel-session' }).catch((error) => ({ status: 'failed', message: SafeError(error) }));
      sentinelObservations.pendingConfirmationRejected = rejected?.status !== 'succeeded';
      sentinelObservations.pendingConfirmationCleanupStatus = String(rejected?.status || 'unknown');
      sentinelProvider?.SetConfirmedToolResult('BrowserUploadFile', rejected, sentinelConfirmation);
      const cleanupSend = await sentinelHost.Send({
        requestId: 'pb03-sentinel-cleanup', sessionId: 'pb03-sentinel-session', scenarioId: 'application',
        confirmationMode: 'fully_trusted', attachments: [{ name: uploadName, path: uploadFileId }],
        content: 'End the local task-isolation check after rejecting the synthetic upload confirmation. Do not perform another browser action.',
      }).catch((error) => ({ accepted: false, error: SafeError(error) }));
      sentinelObservations.ownCleanupCompleted = cleanupSend?.accepted === true;
      sentinelObservations.closeTaskReceipts = taskCloseReceipts.get(sentinelObservations.browserTaskIdHash) ?? [];
      AddTimeline(sentinelObservations, 'other_task_closed_by_its_own_host_after_isolation_check', {
        taskIdHash: sentinelObservations.browserTaskIdHash,
        cleanupRunAccepted: sentinelObservations.ownCleanupCompleted,
        closeTaskAcknowledged: sentinelObservations.closeTaskReceipts.some((receipt) => receipt.acknowledged === true && receipt.closed === true),
      });
    }
    if (sentinelObservations?.browserTaskId) {
      sentinelObservations.targetsAfterOwnClose = null;
      sentinelObservations.ownCloseVerified = (sentinelObservations.closeTaskReceipts ?? []).some((receipt) => receipt.acknowledged === true && receipt.closed === true);
      AddTimeline(sentinelObservations, 'other_task_close_receipt_verified_after_its_own_host_finish', {
        taskIdHash: sentinelObservations.browserTaskIdHash,
        targetInspectionAfterClose: 'not_performed_retired_task_protected',
        hostCloseTaskAcknowledged: sentinelObservations.ownCloseVerified,
        cleanupReceipts: sentinelObservations.closeTaskReceipts,
      });
    }
    const mainSnapshots = observations.taskTargetSnapshots.filter((snapshot) => snapshot.taskIdHash === observations.browserTaskIdHash);
    const mainNeverListedOtherTask = Boolean(sentinelObservations?.sentinelTargetIdHash)
      && mainSnapshots.length > 0
      && mainSnapshots.every((snapshot) => !(snapshot.targets || []).some((target) => target.targetIdHash === sentinelObservations.sentinelTargetIdHash));
    const otherTaskIsolationVerified = sentinelObservations?.confirmationHeld === true
      && sentinelObservations.pendingToolName === 'BrowserUploadFile'
      && Boolean(sentinelObservations.sentinelTargetIdHash)
      && observations.mainTaskCloseVerified === true
      && mainNeverListedOtherTask
      && sentinelObservations.otherTaskSurvivedMainClose === true;
    const mainChildLifecycleVerified = Boolean(observations.browserTaskIdHash && observations.parentTargetIdHash && observations.childTargetIdHash
      && observations.parentTabIdHash && observations.childTabIdHash
      && observations.childTabObserved && observations.childAttachActivateVerified && observations.childOpenerVerified
      && observations.parentAndChildPresentAfterChildSwitch && observations.childReadyWait?.ok === true
      && observations.childCurrentUrlVerified && observations.parentRestoreVerified
      && observations.parentAndChildPresentAfterParentRestore && observations.parentReadyWait?.ok === true
      && observations.mainTaskCloseVerified && observations.mainTaskTargetsClosedByCleanup);
    output.taskTabEvidence = BuildTaskTabEvidence(observations, sentinelObservations ?? {}, {
      mainChildLifecycleVerified,
        childSameTaskOwnershipVerified: observations.childTabObserved === true && observations.childTargetIdHash !== null,
         childAttachActivateVerified: observations.childAttachActivateVerified === true,
         parentRestoreVerified: observations.parentRestoreVerified === true,
         mainCloseRemovedOwnedTargets: observations.mainTaskTargetsClosedByCleanup === true,
         parentTargetClosedByTask: observations.mainTaskTargetsClosedByCleanup === true,
         childTargetClosedByTask: observations.mainTaskTargetsClosedByCleanup === true,
         targetClosureEvidence: 'Host run_released cleanup receipt; retired task was not queried after CloseTask',
      otherTaskIsolationVerified,
      otherTaskAbsentFromEveryMainTargetSnapshot: mainNeverListedOtherTask,
      otherTaskSurvivedMainClose: sentinelObservations?.otherTaskSurvivedMainClose === true,
      userOriginalTabDirectlyVerified: false,
      noopenerFixtureControlPresent,
      noopenerTested: observations.actionIntents.some((item) => item.purpose === 'open-noopener-child'),
    });
    output.taskTabEvidence.otherTask.toolEvents = sentinelObservations?.toolEvents ?? SafeToolEvents(sentinelEvents);
    output.taskTabEvidence.otherTask.pendingToolName = sentinelObservations?.pendingToolName ?? null;
    output.taskTabEvidence.otherTask.pendingConfirmationRejectedAfterCheck = sentinelObservations?.pendingConfirmationRejected === true;
    output.taskTabEvidence.otherTask.closedByOwnHostAfterCheck = sentinelObservations?.ownCleanupCompleted === true;
    output.taskTabEvidence.otherTask.closeAfterOwnFinishVerified = sentinelObservations?.ownCloseVerified === true;
    output.taskTabEvidence.otherTask.ledger = SafeLedger(await ReadState(sentinelUserDataPath));
    output.taskTabEvidence.errors = [...(observations.targetEvidenceErrors ?? []), ...(sentinelObservations?.targetEvidenceErrors ?? [])];
    output.taskTabEvidence.secondaryCheckerErrors = [...(observations.secondaryCheckerErrors ?? []), ...(sentinelObservations?.secondaryCheckerErrors ?? [])];
    const finalConnection = bridge.Status();
    const finalListening = await IsTcpPortListening(finalConnection.port);
    output.browser.bridge = { listening: finalListening, port: finalConnection.port, listenerState: finalListening ? 'listening' : 'not_listening' };
    output.browser.extension = {
      helloReceived: finalConnection.handshakeSource === 'hello', handshakeReceived: finalConnection.handshakeReceived === true, handshakeSource: finalConnection.handshakeSource ?? null, online: finalConnection.connected === true,
      state: finalConnection.state ?? (finalConnection.connected === true ? 'online' : 'offline'),
      version: finalConnection.actualVersion ?? finalConnection.version ?? null, actualVersion: finalConnection.actualVersion ?? finalConnection.version ?? null, expectedVersion: finalConnection.expectedVersion ?? expectedExtensionVersion,
      versionMatches: (finalConnection.actualVersion ?? finalConnection.version) === (finalConnection.expectedVersion ?? expectedExtensionVersion),
      protocolRevision: finalConnection.actualProtocolRevision ?? finalConnection.protocolRevision ?? null, actualProtocolRevision: finalConnection.actualProtocolRevision ?? finalConnection.protocolRevision ?? null,
      expectedProtocolRevision: finalConnection.expectedProtocolRevision ?? expectedExtensionProtocolRevision,
      protocolRevisionMatches: (finalConnection.actualProtocolRevision ?? finalConnection.protocolRevision) === (finalConnection.expectedProtocolRevision ?? expectedExtensionProtocolRevision) && finalConnection.state !== 'stale',
    };
    output.confirmations = confirmations;
    output.hostAccepted = sendResult?.accepted === true;
    const terminalRunEvent = [...events].reverse().find((event) => event?.requestId === lastRequestId
      && ['completed', 'waiting_user_input', 'waiting_confirmation', 'paused', 'cancelled', 'error'].includes(String(event.type)));
    const releasedRunEvent = [...events].reverse().find((event) => event?.requestId === lastRequestId && event?.type === 'run_released');
    const terminalMessage = typeof terminalRunEvent?.message === 'string' ? SafeError(new Error(terminalRunEvent.message))
      : typeof terminalRunEvent?.content === 'string' ? SafeError(new Error(terminalRunEvent.content))
        : observations.providerFailure?.message ?? observations.hostSendError?.message ?? flowError ?? null;
    output.hostRunState = {
      requestId: lastRequestId,
      accepted: output.hostAccepted,
      status: String(terminalRunEvent?.type ?? (output.hostAccepted ? 'accepted_without_terminal_event' : 'not_accepted')),
      providerTurns: observations.providerTurns,
      confirmationCount: confirmations.length,
      terminalReason: terminalMessage,
      kernelOutcome: observations.turnLimitExceeded?.outcome ?? null,
      kernelReason: observations.turnLimitExceeded?.reason ?? null,
      cleanupOutcomes: SafeCleanupOutcomes(releasedRunEvent?.cleanupOutcomes ?? []),
    };
    output.observations = {
      navigated: observations.navigated,
      providerTurns: observations.providerTurns,
      toolResults: observations.toolResults,
      navigationResult: observations.navigationResult,
      readPageSucceeded: observations.toolResults.some((item) => item.toolName === 'BrowserReadPage' && item.ok),
      submissionMonitorArmed: observations.submissionMonitorArmed,
      childTabObserved: observations.childTabObserved,
      browserTaskIdHash: observations.browserTaskIdHash,
      parentTargetIdHash: observations.parentTargetIdHash,
      parentTabIdHash: observations.parentTabIdHash,
      currentPageRevision: observations.currentPageRevision,
      confirmationGate: observations.confirmationGate ?? null,
      childTargetIdHash: observations.childTargetIdHash,
      childTabIdHash: observations.childTabIdHash,
      childIdentityGate: observations.childIdentityGate ?? null,
      childSwitchGate: observations.childSwitchGate ?? null,
      parentSwitchGate: observations.parentSwitchGate ?? null,
      childAttachActivateVerified: observations.childAttachActivateVerified === true,
      childOpenerVerified: observations.childOpenerVerified === true,
      parentAndChildPresentAfterChildSwitch: observations.parentAndChildPresentAfterChildSwitch === true,
      parentAndChildPresentAfterParentRestore: observations.parentAndChildPresentAfterParentRestore === true,
      childCurrentUrlVerified: observations.childCurrentUrlVerified === true,
      parentRestoreVerified: observations.parentRestoreVerified === true,
      childTargetAppearanceWait: observations.childTargetAppearanceWait ?? null,
      childReadyWait: observations.childReadyWait ?? null,
      parentReadyWait: observations.parentReadyWait ?? null,
      childSnapshotFailure: observations.childSnapshotFailure ?? null,
      finalSnapshot: observations.finalSnapshot,
      validation: observations.validation,
      validationGate: observations.validationGate ?? null,
      validationDomChecker: observations.validationDomChecker ?? null,
      preChildEvidence: observations.preChildEvidence ?? null,
      uploadOracle: observations.uploadOracle ?? null,
      preFinalGate: observations.preFinalGate ?? null,
      finalEvidenceGate: observations.finalEvidenceGate ?? null,
      isolationContext: observations.isolationContext ?? null,
      uploadResult: observations.uploadResultData ?? observations.uploadResult ?? null,
      actionIntents: observations.actionIntents,
      regionTimeline: observations.regionTimeline,
      providerFailure: observations.providerFailure ?? null,
      primaryFailureSequence: observations.primaryFailureSequenceLog ?? [],
      turnLimitExceeded: observations.turnLimitExceeded ?? null,
      hostSendError: observations.hostSendError ?? null,
      secondaryCheckerErrors: [...(observations.secondaryCheckerErrors ?? []), ...(sentinelObservations?.secondaryCheckerErrors ?? [])],
      closeTaskReceipts: observations.closeTaskReceipts ?? [],
      mainRunReleasedCount: Number.isSafeInteger(observations.mainRunReleasedCount) ? observations.mainRunReleasedCount : null,
      cleanupObservationGate: observations.cleanupObservationGate ?? null,
      hostCloseTaskAcknowledged: observations.hostCloseTaskAcknowledged === true,
      mainTaskCloseVerified: observations.mainTaskCloseVerified === true,
      mainTaskCleanupOutcome: observations.mainTaskCleanupOutcome ?? null,
      mainTaskTargetsClosedByCleanup: observations.mainTaskTargetsClosedByCleanup === true,
    };
    output.toolEvents = SafeToolEvents(events);
    output.ledger = SafeLedger(await ReadState(userDataPath));
    output.domChecker = observations.domChecker ?? { attempted: false, available: false, verified: false, reason: 'DOM checker did not run before AgentHost task close.' };
    const finalUrlMatches = observations.parentFormCurrentUrlVerified === true;
    const submissionLedgerEntries = output.ledger.filter((entry) => ['BrowserSubmit', 'SubmitApplication', 'ContactBossJobs'].includes(entry.toolName));
    const submitIntents = observations.actionIntents.filter((item) => item.purpose === 'submit');
    const submitRequests = fixtureRequests.filter((request) => request.pathname === '/submit' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
    output.noSubmitEvidence = {
      submitIntentCount: submitIntents.length,
      submissionLedgerEntries: submissionLedgerEntries.length,
      submitEvents: output.domChecker.submitAttempts,
      networkSubmissionAttempts: output.domChecker.networkSubmissionAttempts,
      fixtureSubmitRequests: submitRequests.length,
      finalUrlMatchesForm: finalUrlMatches,
      submitControlStillPresent: output.domChecker.submitControlPresent === true,
      observedNotSubmitted: output.domChecker.noSubmitObserved === true && submitIntents.length === 0
        && submissionLedgerEntries.length === 0 && submitRequests.length === 0 && finalUrlMatches,
    };
    const requiredTools = ['BrowserNavigate', 'BrowserSnapshot', 'BrowserReadPage', 'BrowserFill', 'BrowserSelect', 'BrowserClick', 'BrowserSetChecked', 'BrowserUploadFile', 'BrowserValidateForm', 'BrowserWait', 'BrowserSwitchTab'];
    output.requiredToolCoverage = Object.fromEntries(requiredTools.map((name) => [name, observations.toolResults.some((item) => item.toolName === name && item.ok)]));
    const selectedPrimaryFailure = ResolvePb03PrimaryFailure({
      childSnapshotFailure: observations.childSnapshotFailure,
      restoreFailure: observations.restoreFailure,
      preFinalFailure: observations.preFinalFailure,
      oracleFailure: observations.providerFailure,
      providerFailure: observations.providerFailure,
    }) ?? observations.providerFailure ?? null;
    output.primaryFailure = selectedPrimaryFailure;
    if (selectedPrimaryFailure) {
      // A model/provider throw or a post-terminal cleanup oracle must remain a
      // failed run in the artifact even if AgentHost already emitted a
      // generic completed event for the last provider turn.
      output.hostRunState.status = 'error';
      output.hostRunState.terminalReason = SafeError(new Error(selectedPrimaryFailure.message));
    }
    const validationPassed = observations.validation?.validationMetadataAvailable === true
      && observations.validation.valid === true && observations.validation.issueCount === 0;
    output.fixtureCoreStatus = observations.turnLimitExceeded ? 'failed_turn_limit'
      : output.domChecker?.verified === true && validationPassed
      && mainChildLifecycleVerified && otherTaskIsolationVerified && output.noSubmitEvidence.observedNotSubmitted
      ? 'passed_fixture_core_only' : 'partial_fixture_core_checks';
    output.status = observations.turnLimitExceeded ? 'failed_turn_limit'
      : selectedPrimaryFailure ? 'failed_fixture_oracle'
      : observations.hostSendError ? 'failed_host_run'
      : flowError ? 'failed_confirmation_path'
      : sendResult?.accepted !== true ? 'failed_host_rejected'
      : observations.navigationResult?.code === 'STATUS_UNKNOWN' ? 'fixture_navigation_status_unknown'
        : observations.navigationResult?.ok === false ? 'failed_fixture_navigation'
        : Object.values(output.requiredToolCoverage).some((passed) => !passed) ? 'partial_fixture_tool_coverage'
          : !validationPassed ? 'partial_fixture_validation'
            : output.domChecker?.verified === true && mainChildLifecycleVerified && otherTaskIsolationVerified
              && output.browser.extension.versionMatches && output.browser.bridge.listening && output.noSubmitEvidence.observedNotSubmitted
                ? 'partial_fixture_noopener_and_user_tab_limits' : 'partial_fixture_checks';
    if (selectedPrimaryFailure) {
      output.errorCode = selectedPrimaryFailure.code;
      output.error = selectedPrimaryFailure.message;
    } else if (observations.hostSendError) {
      output.errorCode = observations.hostSendError.code;
      output.error = observations.hostSendError.message;
    } else if (flowError) output.error = flowError;
    if (!observations.providerFailure && !observations.hostSendError && observations.navigationResult?.ok === false) {
      output.errorCode = observations.navigationResult.code || 'PB03_NAVIGATION_EVIDENCE_FAILED';
      output.error = observations.navigationResult.message || 'BrowserNavigate result did not verify against its task-owned target and document readiness.';
    }
  }
  }
} catch (error) {
  output.status = 'failed';
  output.errorCode = typeof error?.code === 'string' ? error.code : 'PB03_EXTENSION_SMOKE_FAILED';
  output.error = SafeError(error);
  if (browserLaunchError) output.browserLaunchError = browserLaunchError;
} finally {
  const state = userDataPath ? await ReadState(userDataPath) : {};
  if (!output.toolEvents.length) output.toolEvents = SafeToolEvents(events);
  if (!output.ledger.length) output.ledger = SafeLedger(state);
  if (bridge) {
    const status = bridge.Status();
    output.extensionVersion = hostInitOnly ? null : status.version ?? null;
    const listening = status.port > 0 ? await IsTcpPortListening(status.port) : false;
    const finalExtension = hostInitOnly
      ? { helloReceived: false, handshakeReceived: false, handshakeSource: 'skipped_test_mode', online: false, state: 'host_init_only_not_pb03', version: null, actualVersion: null, expectedVersion: status.expectedVersion ?? expectedExtensionVersion, versionMatches: false, protocolRevision: null, actualProtocolRevision: null, expectedProtocolRevision: status.expectedProtocolRevision ?? expectedExtensionProtocolRevision, protocolRevisionMatches: false }
      : { helloReceived: status.handshakeSource === 'hello', handshakeReceived: status.handshakeReceived === true, handshakeSource: status.handshakeSource ?? null, online: status.connected === true, state: status.state ?? (status.connected === true ? 'online' : 'offline'), version: status.actualVersion ?? status.version ?? null, actualVersion: status.actualVersion ?? status.version ?? null, expectedVersion: status.expectedVersion ?? expectedExtensionVersion, versionMatches: (status.actualVersion ?? status.version) === (status.expectedVersion ?? expectedExtensionVersion), protocolRevision: status.actualProtocolRevision ?? status.protocolRevision ?? null, actualProtocolRevision: status.actualProtocolRevision ?? status.protocolRevision ?? null, expectedProtocolRevision: status.expectedProtocolRevision ?? expectedExtensionProtocolRevision, protocolRevisionMatches: (status.actualProtocolRevision ?? status.protocolRevision) === (status.expectedProtocolRevision ?? expectedExtensionProtocolRevision) && status.state !== 'stale' };
    output.browser = BuildPb03PreflightEvidence({ browserProcessRunning: await IsBrowserProcessRunning(), launchState, browser: {
      ...(output.browser ?? {}),
      bridge: { listening, port: status.port, listenerState: listening ? 'listening' : 'not_listening' },
      extension: finalExtension,
    } });
    output.browserProcess = output.browser.browserProcess;
    output.pairPageOpened = output.browser.pairPageOpened;
    output.preflightNoSideEffects = output.browser.preflightNoSideEffects;
    const finalPreflight = hostInitOnly ? null : ClassifyPb03Preflight({ bridge: { listening }, extension: finalExtension });
    output.connectionGuidance = output.connectionGuidance ?? finalPreflight?.action;
    if (!output.connectionGuidance && status.connected && status.version !== expectedExtensionVersion) {
      output.connectionGuidance = 'The Bridge received an old extension version. In ' + (engine === 'edge' ? 'Edge' : 'Chrome') + ', open chrome://extensions, reload Avery Browser from ' + extensionPath + ', then rerun.';
    }
  }
  if (host) {
    if (!hostClosedEarly) await host.Close().catch(() => undefined);
  }
  else if (runtime) await runtime.Close().catch(() => undefined);
  if (sentinelHost) await sentinelHost.Close().catch(() => undefined);
  else if (sentinelRuntime) await sentinelRuntime.Close().catch(() => undefined);
  if (!hostInitOnly && Number.isSafeInteger(restorePort) && restorePort > 0 && restorePort <= 65_535) {
    const restoreOptions = {
      restorePort,
      allowBrowserLaunch,
      preflightSucceeded: launchState.preflightSucceeded === true,
      sideEffectPerformed: launchState.sideEffectPerformed === true,
      restorePerformed: launchState.restorePerformed === true,
      restoreClaimed: launchState.restoreClaimed === true,
      restoreFailed: launchState.restoreFailed === true,
    };
    if (!CanRestorePb03Pairing(restoreOptions)) {
      output.restorePairing = launchState.preflightSucceeded !== true
        ? 'skipped_preflight_failed'
        : launchState.sideEffectPerformed !== true
          ? 'skipped_no_side_effect_performed'
            : allowBrowserLaunch !== true
              ? 'skipped_browser_launch_disabled'
            : launchState.restoreFailed === true
              ? 'skipped_restore_failed_no_retry'
              : 'skipped_already_performed';
    } else {
      try {
        const token = String(JSON.parse(await readFile(bridgeStatePath, 'utf8')).token ?? '');
        const restore = await RestorePb03Pairing({
          ...restoreOptions,
          token,
          state: launchState,
          spawnBrowser: async (pairUrl) => {
            const browser = spawn(browserPath, [pairUrl], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
            browser.unref();
          },
        });
        output.restorePairing = restore.performed ? 'performed' : 'skipped_' + restore.reason;
      } catch { output.restorePairing = 'failed'; }
    }
  }
  await new Promise((resolveClose) => {
    fixture.close(resolveClose);
    fixture.closeAllConnections();
  });
  await rm(runtimeRoot, { recursive: true, force: true });
  await writeFile(join(artifactDir, 'summary.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
  await writeFile(join(artifactDir, 'summary.log'), HumanReadableSummary(output) + '\n', 'utf8');
}

console.log(JSON.stringify({ ...output, artifactPath: join(artifactDir, 'summary.json') }));
if (output.status !== 'passed_fixture_only' && output.status !== 'host_init_only_not_pb03') process.exitCode = 1;
