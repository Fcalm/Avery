import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, createServer as createTcpServer } from 'node:net';
import { promisify } from 'node:util';

import { AgentBrowserRuntime } from '../apps/backend/dist/electron/backend/agent-browser-runtime.js';
import { AgentHost } from '../apps/backend/dist/electron/backend/agent-host.js';
import { BrowserExtensionBridge, BrowserExtensionManifestVersion, BrowserExtensionProtocolRevision } from '../apps/backend/dist/electron/backend/browser-extension-bridge.js';
import { FormFields } from '../apps/backend/dist/electron/backend/browser-form-service.js';
import { CreateDefaultModules } from '../packages/agent-modules-defaults/dist/index.js';
import { BuildPb03PreflightEvidence, CanRestorePb03Pairing, ClassifyPb03Preflight, CreatePb03BrowserLaunchGuard, RestorePb03Pairing, WaitForPb03Handshake } from './fixtures/pb03-preflight.mjs';

/**
 * PB-03 个人浏览器迁移验收入口。
 *
 * 默认只做状态探测、岗位采集/保存和 ContactBossJobs 冻结提案；
 * 真实外发必须同时满足显式目标、显式文案和 --execute-contact=true，避免旧目标被误重发。
 * 该脚本只使用扩展 Bridge，不创建独立浏览器 Profile。
 */

const projectRoot = resolve(import.meta.dirname, '..');
const browserPaths = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};
const projectExtensionPath = resolve(projectRoot, 'apps', 'browser-extension');
const syntheticResumeFixturePath = resolve(projectRoot, 'scripts', 'fixtures', 'PB-03-synthetic-resume.pdf');
const execFileAsync = promisify(execFile);
const PB03SchemaVersion = 1;
const DefaultBridgePort = 17653;
const ExpectedExtensionVersion = BrowserExtensionManifestVersion;
const ExpectedExtensionProtocolRevision = BrowserExtensionProtocolRevision;
const SyntheticResumeId = 'pb03-synthetic-resume';
const SyntheticImageId = 'attachment://pb03/synthetic-image.png';
const SyntheticResumeAttachmentId = 'attachment://pb03/synthetic-resume.pdf';

function ParseArguments(argv) {
  return Object.fromEntries(argv.map((item) => {
    const index = item.indexOf('=');
    return index > 2 ? [item.slice(2, index), item.slice(index + 1)] : [item.slice(2), 'true'];
  }));
}

function BooleanArgument(args, name, fallback = false) {
  if (args[name] === undefined) return fallback;
  return args[name] === 'true' || args[name] === '1' || args[name] === 'yes';
}

/** 解析 Bridge 端口；临时验收必须显式使用 0，不能把非数字静默转成 NaN。 */
function ParseBridgePort(value, { allowEphemeral = false, fallback = DefaultBridgePort } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (allowEphemeral && value === 'ephemeral') return 0;
  const port = Number(value);
  const minimum = allowEphemeral ? 0 : 1;
  if (!Number.isSafeInteger(port) || port < minimum || port > 65_535) {
    throw Object.assign(new Error(`Invalid Bridge port: ${String(value)}. Use an integer from ${minimum} to 65535${allowEphemeral ? ' or ephemeral' : ''}.`), { code: 'PB03_INVALID_BRIDGE_PORT' });
  }
  return port;
}

/** 保留 query/hash 的实际导航 URL；只做协议、主机和凭据校验。 */
function ValidatedHttpsUrl(value, allowedHostPattern) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || (allowedHostPattern && !allowedHostPattern.test(url.hostname))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 仅用于 summary/证据的脱敏 URL；不得把返回值再次用于导航。 */
function SafeUrl(value, allowedHostPattern) {
  const validated = ValidatedHttpsUrl(value, allowedHostPattern);
  if (!validated) return null;
  const url = new URL(validated);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function BossUrl(value) {
  // zhipin.com 与其单层子域都允许；反斜线只写一次，避免把点当成字面量反斜线。
  return ValidatedHttpsUrl(value, /^(?:[^.]+\.)?zhipin\.com$/i);
}

function SafeErrorText(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https:\/\/[^\s)]+/gi, (value) => SafeUrl(value, /./) ?? '[REDACTED_URL]')
    .replace(/[A-Za-z]:\\[^\r\n ]+/g, '[REDACTED_PATH]')
    .slice(0, 500);
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

async function IsTcpPortBindable(port) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) return false;
  return await new Promise((resolveProbe) => {
    const server = createTcpServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (server.listening) server.close(() => resolveProbe(value));
      else resolveProbe(value);
    };
    server.once('error', () => finish(false));
    server.listen(port, '127.0.0.1', () => finish(true));
  });
}

async function IsBrowserProcessRunning(engine) {
  const processName = engine === 'chrome' ? 'chrome.exe' : 'msedge.exe';
  if (process.platform !== 'win32') return false;
  try {
    const result = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${processName}`], { windowsHide: true, timeout: 2_000 });
    return new RegExp(`^${processName.replace('.', '\\.')}`, 'im').test(String(result.stdout));
  } catch {
    return false;
  }
}

function Digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function Sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function NormalizeFieldExpectations(value) {
  const entries = Array.isArray(value) ? value : [];
  if (entries.length > 20) throw new Error('--field-expectations may contain at most 20 fields.');
  return entries.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Field expectation ${index + 1} must be an object.`);
    const label = String(item.label ?? '').trim();
    const expectedValue = String(item.expectedValue ?? item.value ?? '');
    const semantic = typeof item.semantic === 'string' ? item.semantic.trim().slice(0, 120) : '';
    const comparison = ['contains', 'exact', 'date'].includes(item.comparison) ? item.comparison : 'contains';
    if (!label || label.length > 160 || !expectedValue || expectedValue.length > 500) {
      throw new Error(`Field expectation ${index + 1} requires a label and an expected value (maximum 500 characters).`);
    }
    return { label, ...(semantic ? { semantic } : {}), expectedValue, comparison };
  });
}

async function LoadFieldExpectations(args, hostName) {
  const raw = String(args['field-expectations'] ?? '').trim();
  const filePath = String(args['field-expectations-file'] ?? '').trim();
  if (raw && filePath) throw new Error('Use either --field-expectations or --field-expectations-file, not both.');
  if (raw) {
    const contents = raw.startsWith('@') ? await readFile(resolve(raw.slice(1)), 'utf8') : raw;
    return NormalizeFieldExpectations(JSON.parse(contents));
  }
  if (filePath) return NormalizeFieldExpectations(JSON.parse(await readFile(resolve(filePath), 'utf8')));
  if (hostName === 'iflytek.zhiye.com') {
    return Object.entries(EnterpriseExpectedFields).map(([label, semanticPath]) => ({
      label,
      semantic: semanticPath,
      expectedValue: {
        '学校名称': '南昌大学',
        '专业名称': '工商管理',
        '出生日期': '2000-01-15',
        '民族': '汉族',
        // 页面可能只展示“佛山”；只核验城市语义，省份控件仍由 DOM checker 独立检查。
        '现居住地': '佛山',
        '开始时间': '2020-09',
        '结束时间': '2024-06',
        '学历': '本科',
      }[label],
      comparison: 'contains',
    }));
  }
  return [];
}

function ToolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function ParseToolMessage(history) {
  const message = [...history].reverse().find((item) => item?.role === 'tool');
  if (!message) return null;
  try { return JSON.parse(String(message.content || '{}')); } catch { return null; }
}

function SafeToolEvents(events) {
  return events
    .filter((event) => event?.type === 'tool_call' || event?.type === 'tool_result')
    .map((event) => {
      const message = typeof event.payload?.message === 'string'
        ? event.payload.message
        : typeof event.message === 'string' ? event.message : '';
      return {
        type: String(event.type),
        toolName: String(event.toolName ?? event.name ?? event.payload?.toolName ?? event.payload?.name ?? ''),
        ok: event.payload?.ok === true || event.ok === true,
        code: typeof event.payload?.code === 'string' ? event.payload.code : typeof event.code === 'string' ? event.code : undefined,
        ...(message ? { message: SafeErrorText(message) } : {}),
      };
    });
}

function SafeLedger(state) {
  const entries = Array.isArray(state?.toolLedger) ? state.toolLedger : [];
  return entries.flatMap((entry) => {
    const value = Array.isArray(entry) ? entry[1] : entry;
    if (!value || typeof value !== 'object') return [];
    return [{
      toolName: typeof value.toolName === 'string' ? value.toolName : '',
      status: typeof value.status === 'string' ? value.status : '',
      errorCode: typeof value.errorCode === 'string' ? value.errorCode : undefined,
      hasReceipt: Boolean(value.receipt && typeof value.receipt === 'object'),
      resourceCount: Array.isArray(value.resourceIds) ? value.resourceIds.length : 0,
    }];
  });
}

function EmptyObservability(events) {
  const traces = new Map();
  return {
    RecordLog() {},
    StartTrace() {},
    AppendTraceEvent(requestId, eventType, payload) {
      const safePayload = payload && typeof payload === 'object' ? structuredClone(payload) : {};
      const event = { type: eventType, requestId, toolName: safePayload.name, payload: safePayload };
      events?.push(event);
      const list = traces.get(requestId) ?? [];
      list.push(event);
      traces.set(requestId, list);
    },
    RecordTraceUsage() {},
    FinishTrace() {},
    async GetLogs() { return []; },
    async GetTraces() { return []; },
    async GetTraceEvents(requestId) { return traces.get(requestId) ?? []; },
    async DeleteTraces() { return { deleted: 0 }; }, async SetTraceRetention(value) { return { traceRetention: value }; },
    async ClearObservability() { return { cleared: true }; },
  };
}

function CreateProjectBrowserLauncher(engine, extensionLoadRequested, launchState, allowBrowserLaunch = false) {
  return async (_engine, url) => {
    if (launchState.attempted) return;
    const guard = CreatePb03BrowserLaunchGuard({
      allowBrowserLaunch,
      state: launchState,
      spawnBrowser: async (engineName, pairUrl) => {
        if (await IsBrowserProcessRunning(engineName)) {
          // 只有显式 developer opt-in 才允许打开配对页；正式 attach-only
          // 路径不会触发这个回调，因此不会新增 renderer/tab。
          const child = spawn(browserPaths[engineName], [pairUrl], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
          child.unref();
          return;
        }
        const launchArgs = extensionLoadRequested ? [`--load-extension=${projectExtensionPath}`, pairUrl] : [pairUrl];
        const child = spawn(browserPaths[engineName], launchArgs, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
      },
    });
    await guard(_engine, url);
  };
}

function ToolResultData(value) {
  return value?.data && typeof value.data === 'object' ? value.data : value;
}

function CreateScriptedProvider(mode, input) {
  let step = 0;
  let candidate = null;
  let resumeId = null;
  let contactConfirmed = false;
  const confirmedToolResults = new Map();
  const observations = {
    toolResults: [],
    gate: { loginRequired: false, captchaPresent: false },
    fill: null,
    validation: null,
    initialSnapshot: null,
    finalSnapshot: null,
    snapshotCount: 0,
  };
  const message = input.message || 'PB-03 测试消息：仅用于已明确授权的测试目标。';
  const query = input.query || '产品经理';
  const city = input.city || '佛山';

  const RememberToolResult = (toolName, result) => {
    if (!result) return;
    const data = ToolResultData(result);
    observations.toolResults.push({
      toolName,
      ok: result.ok === true,
      code: typeof result.code === 'string' ? result.code : undefined,
    });
    if (toolName === 'BrowserReadPage') {
      const gate = DetectEnterpriseGate(JSON.stringify(data));
      observations.gate = {
        loginRequired: observations.gate.loginRequired || gate.loginRequired,
        captchaPresent: observations.gate.captchaPresent || gate.captchaPresent,
      };
    }
    if (toolName === 'BrowserFillForm') {
      const filled = Array.isArray(data?.filled) ? data.filled : [];
      observations.fill = {
        done: data?.done === true,
        filledCount: Number.isSafeInteger(data?.filledCount) ? data.filledCount : filled.length,
        filledLabels: [...new Set(filled.map((field) => String(field?.label || '').slice(0, 180)).filter(Boolean))],
        skippedCount: Array.isArray(data?.skipped) ? data.skipped.length : 0,
        ambiguousCount: Array.isArray(data?.ambiguous) ? data.ambiguous.length : 0,
        remainingCount: Number.isSafeInteger(data?.remainingCount) ? data.remainingCount : null,
      };
    }
    if (toolName === 'BrowserValidateForm') {
      observations.validation = {
        valid: data?.valid === true ? true : data?.valid === false ? false : null,
        issueCount: Array.isArray(data?.issues) ? data.issues.length : null,
        inspectedFieldCount: Number.isSafeInteger(data?.inspectedFieldCount) ? data.inspectedFieldCount : null,
        validationMetadataAvailable: data?.validationMetadataAvailable === true,
      };
    }
    if (toolName === 'BrowserSnapshot') {
      const snapshotCount = observations.snapshotCount;
      observations.snapshotCount += 1;
      const refs = data?.refs && typeof data.refs === 'object' ? Object.values(data.refs) : [];
      const finalSubmitCandidates = refs.filter((ref) => /submit|apply|提交|申请|投递/i.test(`${ref?.name || ''} ${ref?.description || ''}`)).length;
      const snapshotEvidence = {
        finalUrl: SafeUrl(data?.currentUrl, /./),
        pageRevision: Number.isSafeInteger(data?.pageRevision) ? data.pageRevision : null,
        exposedTabs: Array.isArray(data?.tabs) ? data.tabs.length : null,
        finalSubmitCandidates,
      };
      if (snapshotCount === 0) observations.initialSnapshot = snapshotEvidence;
      observations.finalSnapshot = snapshotEvidence;
    }
  };

  const finish = (content, onDelta) => {
    onDelta?.({ reasoning: '', content });
    return { content, toolCalls: [] };
  };

  return {
    packageName: 'avery.pb03-live-validation', name: 'pb03-scripted-provider', version: '0.1.0', sdkVersion: '0.1.0',
    slot: 'model-provider', capabilities: ['model:scripted-test'],
    Configure: async () => ({ configured: true, provider: 'Scripted', model: 'pb03-live' }),
    TestConnection: async () => ({ connected: true, provider: 'Scripted' }),
    GetBalance: async () => ({ available: false, balances: [] }), GetModels: async () => ({ models: ['pb03-live'] }),
    GetStatus: async () => ({ configured: true, provider: 'Scripted', model: 'pb03-live' }),
    ResolveRequestModel: () => 'pb03-live', BaseUrl: () => 'http://127.0.0.1/pb03-scripted',
    GetRuntimeLimits: () => ({ contextLimit: 128000, threshold: 80 }), EstimateTokens: (value) => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4)),
    CreateSummary: async () => ({ content: 'PB-03 scripted summary' }),
    StreamCompletion: async ({ history, onDelta }) => {
      const last = ParseToolMessage(history);
      if (mode === 'collect') {
        if (step === 0) {
          step = 1;
          return { content: '', toolCalls: [ToolCall('pb03-collect', 'CollectJobs', {
            platforms: ['boss_zhipin'], queries: [{ keyword: query, city }], sort: 'newest', maxResults: 10,
          })] };
        }
        if (step === 1) {
          if (last?.ok !== true || !last.collectionId || !Array.isArray(last.candidates) || !last.candidates.length) {
            return finish('CollectJobs 未返回可保存的岗位候选；本次验收在采集结果处停止。', onDelta);
          }
          candidate = last.candidates[0];
          step = 2;
          return { content: '', toolCalls: [ToolCall('pb03-save', 'SaveJob', { collectionId: last.collectionId, candidateId: candidate.candidateId, matchScore: 100 })] };
        }
        return finish('CollectJobs 与 SaveJob 已完成，等待验收脚本核对岗位与 Ledger。', onDelta);
      }

      if (mode === 'contact') {
        if (step === 0) {
          step = 1;
          return { content: '', toolCalls: [ToolCall('pb03-resume-index', 'ReadResume')] };
        }
        if (step === 1) {
          const resumes = Array.isArray(last?.resumes) ? last.resumes : [];
          resumeId = resumes[0]?.id || SyntheticResumeId;
          step = 2;
          return { content: '', toolCalls: [ToolCall('pb03-resume-bind', 'ReadResume', { resumeId })] };
        }
        if (step === 2) {
          if (last?.ok !== true || last.bound !== true) return finish('ReadResume 未能绑定合成测试简历，ContactBossJobs 已停止。', onDelta);
          const item = { jobId: input.jobId, message: { mode: 'custom', text: message } };
          step = 3;
          return { content: '', toolCalls: [ToolCall('pb03-contact', 'ContactBossJobs', {
            items: [item], ...(input.imageAssetId ? { imageAssetId: input.imageAssetId } : {}),
          })] };
        }
        if (contactConfirmed) return finish('ContactBossJobs 已由 Host 确认并执行；此续跑只结束验收，不会重复发送。', onDelta);
        if (last?.code === 'CONFIRMATION_REQUIRED') return finish('ContactBossJobs 已冻结提案并停在确认门前。', onDelta);
        return finish('ContactBossJobs 已返回结果，等待验收脚本核对外部回执与 Ledger。', onDelta);
      }

      if (mode === 'enterprise') {
        if (step === 0) {
          step = 1;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-navigate', 'BrowserNavigate', { url: input.enterpriseUrl })] };
        }
        if (step === 1) {
          RememberToolResult('BrowserNavigate', last);
          step = 2;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-snapshot', 'BrowserSnapshot')] };
        }
        if (step === 2) {
          RememberToolResult('BrowserSnapshot', last);
          step = 3;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-read', 'BrowserReadPage')] };
        }
        if (step === 3) {
          RememberToolResult('BrowserReadPage', last);
          if (input.fillData) {
            step = 4;
            return { content: '', toolCalls: [ToolCall('pb03-enterprise-fill', 'BrowserFillForm', { profileIds: ['pb03-personal', 'pb03-education'] })] };
          }
          step = 5;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-form-snapshot', 'BrowserSnapshot')] };
        }
        if (step === 4) {
          const fillResult = confirmedToolResults.get('BrowserFillForm') ?? last;
          confirmedToolResults.delete('BrowserFillForm');
          RememberToolResult('BrowserFillForm', fillResult);
          const data = ToolResultData(fillResult);
          if (fillResult?.ok !== true) return finish('BrowserFillForm 未完成，提交前验收停止。', onDelta);
          if (data?.done !== true && data?.continuationId && Number(data.remainingCount) > 0) {
            return { content: '', toolCalls: [ToolCall(`pb03-enterprise-fill-${step}`, 'BrowserFillForm', { continuationId: data.continuationId })] };
          }
          step = 5;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-form-snapshot', 'BrowserSnapshot')] };
        }
        if (step === 5) {
          RememberToolResult('BrowserSnapshot', last);
          const data = ToolResultData(last);
          const refs = data?.refs && typeof data.refs === 'object' ? Object.entries(data.refs) : [];
          const fileRef = refs.find(([, value]) => String(value?.type || '').toLowerCase() === 'file')?.[0];
          if (input.uploadTestFile) {
            if (!fileRef || !Number.isSafeInteger(data?.pageRevision)) return finish('提交前验收未找到可用的简历文件控件，未上传文件。', onDelta);
            observations.uploadRef = fileRef;
            step = 6;
            return { content: '', toolCalls: [ToolCall('pb03-enterprise-upload', 'BrowserUploadFile', { ref: `@${fileRef}`, pageRevision: data.pageRevision, fileId: SyntheticResumeAttachmentId })] };
          }
          step = 7;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-validate', 'BrowserValidateForm')] };
        }
        if (step === 6) {
          const uploadResult = confirmedToolResults.get('BrowserUploadFile') ?? last;
          confirmedToolResults.delete('BrowserUploadFile');
          RememberToolResult('BrowserUploadFile', uploadResult);
          step = 7;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-validate', 'BrowserValidateForm')] };
        }
        if (step === 7) {
          RememberToolResult('BrowserValidateForm', last);
          step = 8;
          return { content: '', toolCalls: [ToolCall('pb03-enterprise-final-snapshot', 'BrowserSnapshot')] };
        }
        if (step === 8) {
          RememberToolResult('BrowserSnapshot', last);
          return finish('企业招聘官网提交前验收已完成；未点击提交。', onDelta);
        }
        return finish('企业招聘官网提交前验收已停止。', onDelta);
      }

      return finish('PB-03 script mode is not implemented.', onDelta);
    },
    observations,
    SetConfirmedToolResult(toolName, result) {
      confirmedToolResults.set(String(toolName), {
        ok: result?.status === 'succeeded',
        code: result?.status === 'succeeded' ? undefined : String(result?.code || result?.status || 'CONFIRMATION_FAILED'),
        data: result?.data && typeof result.data === 'object' ? result.data : result,
      });
    },
    MarkContactConfirmed() { contactConfirmed = true; },
  };
}

function CreateBusiness(view, attachments, batchEvents, profiles = []) {
  const snapshots = new Map();
  return {
    async GetStoredSettings() { return { browserEngine: view.browserEngine }; },
    async GetProfiles() { return { items: structuredClone(profiles) }; },
    async ResolveAttachmentUri(value) {
      return attachments.get(value) ?? null;
    },
    async LoadViewModel() { return structuredClone(view); },
    async SaveTrackedJob(input) {
      const jobId = String(input.jobId || input.id || '');
      const previous = view.jobs.find((item) => item.id === jobId);
      const revision = Number(previous?.revision || 0) + 1;
      const next = { ...(previous || {}), ...structuredClone(input), id: jobId, jobId, revision };
      if (previous) Object.assign(previous, next);
      else view.jobs.push(next);
      return { jobId, jobRevision: revision };
    },
    async CreateBossContactBatch(input) { batchEvents.push({ type: 'created', batchId: String(input.id), itemCount: input.items.length }); },
    async CheckpointBossContactBatch(batchId, jobId, step) { batchEvents.push({ type: 'checkpoint', batchId: String(batchId), jobId: String(jobId), step: String(step) }); },
    async FinishBossContactBatch(batchId, status, result) { batchEvents.push({ type: 'finished', batchId: String(batchId), status: String(status), ok: result?.ok === true }); },
    async GetConversationSnapshots(sessionId) { return snapshots.get(sessionId) ?? null; },
    async SetConversationSnapshots(sessionId, value) { snapshots.set(sessionId, value); },
  };
}

async function CreateLiveBrowser({ engine, runtimeRoot, bridgeStatePath, bridgePort, extensionLoadRequested, launchState, attachments, events, allowBrowserLaunch = false }) {
  const bridge = new BrowserExtensionBridge({
    statePath: bridgeStatePath,
    port: bridgePort,
    browserPaths: { [engine]: browserPaths[engine] },
    launchBrowser: CreateProjectBrowserLauncher(engine, extensionLoadRequested, launchState, allowBrowserLaunch),
  });
  const browserRuntime = new AgentBrowserRuntime({
    runtimeRoot: join(runtimeRoot, 'browser-runtime'),
    resolveUploadFile: async (fileId) => attachments.get(fileId)?.physicalPath ?? null,
    browserExtensionBridge: bridge,
    externalBrowserPaths: { [engine]: browserPaths[engine] },
    recordLog: (_level, event) => events.push({ type: 'runtime_log', event: String(event) }),
  });
  await browserRuntime.SetEngine(engine);
  return { bridge, browserRuntime };
}

async function RunLivePreflight(browserParts, { engine, allowBrowserLaunch = false, launchState } = {}) {
  const { bridge, browserRuntime } = browserParts;
  // Bridge 是整个 preflight 与后续 Runtime 的同一实例；先启动监听，再只
  // 观察握手状态。此期间不创建 Host/provider，不调用 Request/Launch/tab。
  const handshake = await WaitForPb03Handshake({
    bridge,
    expectedVersion: ExpectedExtensionVersion,
    expectedProtocolRevision: ExpectedExtensionProtocolRevision,
    timeoutMs: 20_000,
    intervalMs: 100,
  });
  const before = await browserRuntime.GetStatus(false);
  const initial = await BrowserConnectionEvidence(bridge, engine);
  initial.extension = {
    ...initial.extension,
    handshakeReceived: handshake.handshakeReceived,
    handshakeSource: handshake.source,
    helloReceived: handshake.source === 'hello',
    version: handshake.actualVersion,
    actualVersion: handshake.actualVersion,
    protocolRevision: handshake.actualProtocolRevision,
    actualProtocolRevision: handshake.actualProtocolRevision,
    versionMatches: handshake.versionMatches,
    protocolRevisionMatches: handshake.protocolRevisionMatches,
    online: handshake.online,
    state: handshake.state,
  };
  initial.handshakeReceived = handshake.handshakeReceived;
  initial.handshakeSource = handshake.source;
  initial.actualVersion = handshake.actualVersion;
  initial.actualProtocolRevision = handshake.actualProtocolRevision;
  initial.handshakeWaitedMs = handshake.waitedMs;
  initial.handshakeAttempts = handshake.attempts;
  initial.handshakeState = handshake.status;
  const initialBrowser = {
    ...initial,
    before: { available: before.available, running: before.running, state: before.state, engine: before.engine },
  };
  const initialPreflight = handshake.status === 'stale'
    ? { blocked: true, status: 'blocked_extension_stale', action: 'Open chrome://extensions, reload the Avery extension, and rerun the attach-only smoke.' }
    : ClassifyPb03Preflight(initial);
  // Every blocked initial preflight is terminal for the formal PB-03 path,
  // including explicit developer opt-in: do not turn an offline/stale check
  // into a launch or pairing side effect.
  if (initialPreflight.blocked) {
    return {
      blocked: true,
      status: initialPreflight.status,
      action: initialPreflight.action,
      browser: BuildPb03PreflightEvidence({ browserProcessRunning: initial.browserProcess?.running === true, launchState, browser: initialBrowser }),
    };
  }
  let probed;
  try {
    // The launcher guard remains closed until this existing-browser preflight
    // succeeds, so a race to offline cannot open Chrome or /pair.
    probed = await RunStatus(browserRuntime, bridge, true, engine);
  } catch {
    return {
      blocked: true,
      status: 'blocked_extension_not_connected',
      action: 'The existing browser/extension became unavailable during attach-only preflight; reload Avery in chrome://extensions and rerun.',
      browser: BuildPb03PreflightEvidence({ browserProcessRunning: initial.browserProcess?.running === true, launchState, browser: initialBrowser }),
    };
  }
  const finalPreflight = ClassifyPb03Preflight(probed);
  const browser = BuildPb03PreflightEvidence({ browserProcessRunning: probed.browserProcess?.running === true, launchState, browser: probed });
  if (finalPreflight.blocked) return { blocked: true, status: finalPreflight.status, action: finalPreflight.action, browser };
  if (browser.extension?.versionMatches !== true) {
    return {
      blocked: true,
      status: 'historical_extension_version',
      action: 'Reload the Avery extension in chrome://extensions, then rerun the attach-only smoke.',
      browser,
    };
  }
  launchState.preflightSucceeded = true;
  return { blocked: false, status: 'ready', action: null, browser };
}

async function CreateLiveHarness({ engine, runtimeRoot, bridgeStatePath, bridgePort, view, attachments, batchEvents, events, mode, input, extensionLoadRequested, launchState, allowBrowserLaunch = false, browserParts, profiles = [] }) {
  if (!browserParts) {
    throw Object.assign(new Error('PB-03 live Host/provider construction requires a completed attach-only browser preflight.'), { code: 'PB03_PREFLIGHT_REQUIRED' });
  }
  const liveBrowser = browserParts;
  const { bridge, browserRuntime } = liveBrowser;
  const provider = CreateScriptedProvider(mode, input);
  const business = CreateBusiness(view, attachments, batchEvents, profiles);
  const host = new AgentHost({
    userDataPath: join(runtimeRoot, 'user-data'), workspacePath: runtimeRoot, Emit: (event) => events.push(event), business,
    observability: EmptyObservability(events), credentialPort: { async Load() { return null; }, async Save() {} }, browserRuntime,
    createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }),
  });
  return { bridge, browserRuntime, host, provider, business, userDataPath: join(runtimeRoot, 'user-data') };
}

async function ReadState(userDataPath) {
  try { return JSON.parse(await readFile(join(userDataPath, 'agent-state.json'), 'utf8')); } catch { return {}; }
}

async function WorktreeEvidence() {
  try {
    const [root, commit, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, windowsHide: true }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, windowsHide: true }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot, windowsHide: true }),
    ]);
    return { root: String(root.stdout).trim(), commit: String(commit.stdout).trim(), dirty: Boolean(String(status.stdout).trim()) };
  } catch {
    return { root: projectRoot, commit: null, dirty: null, available: false };
  }
}

function HumanReadableSummary(summary) {
  const browser = summary.browser ?? {};
  const enterprise = summary.enterprise ?? null;
  const target = summary.commandArguments?.target ?? null;
  return [
    `PB-03 ${summary.mode} 验收记录`,
    `时间: ${summary.generatedAt}`,
    `状态: ${summary.status}`,
    `工作树: ${summary.worktree?.root ?? 'unknown'} (${summary.worktree?.commit ?? 'commit unknown'}; dirty=${String(summary.worktree?.dirty)})`,
    `Bridge: listening=${String(browser.bridge?.listening)}, bindAvailable=${String(browser.bridge?.bindAvailable)}, port=${String(browser.bridge?.port ?? 'unknown')}`,
    `Chrome/Edge 进程: ${String(browser.browserProcess?.running)} (${browser.browserProcess?.engine ?? summary.engine})`,
    `PB-03 preflight: ${JSON.stringify({ browserProcess: { launched: browser.browserProcess?.launched === true }, pairPageOpened: browser.pairPageOpened === true, preflightNoSideEffects: browser.preflightNoSideEffects === true })}`,
    `恢复配对: ${String(summary.restorePairing ?? 'not_requested')}`,
    `扩展 handshake: ${JSON.stringify({ received: browser.extension?.handshakeReceived ?? browser.handshakeReceived ?? false, source: browser.extension?.handshakeSource ?? browser.handshakeSource ?? null, state: browser.extension?.state ?? 'offline', actualVersion: browser.extension?.actualVersion ?? browser.extension?.version ?? null, expectedVersion: browser.extension?.expectedVersion ?? ExpectedExtensionVersion, actualProtocolRevision: browser.extension?.actualProtocolRevision ?? browser.extension?.protocolRevision ?? null, expectedProtocolRevision: browser.extension?.expectedProtocolRevision ?? ExpectedExtensionProtocolRevision, waitedMs: browser.handshakeWaitedMs ?? 0, attempts: browser.handshakeAttempts ?? 0 })}`,
    `扩展 protocolRevision: actual=${browser.extension?.protocolRevision ?? 'missing'}, expected=${browser.extension?.expectedProtocolRevision ?? ExpectedExtensionProtocolRevision}, exact=${String(browser.extension?.protocolRevisionMatches)}`,
    `命令参数摘要: ${JSON.stringify(summary.commandArguments ?? {})}`,
    `目标 URL(host/path, query/hash 已移除): ${target ?? '无'}`,
    `合成 PDF: ${summary.resource?.name ?? 'unknown'}, bytes=${summary.resource?.bytes ?? 'unknown'}, sha256=${summary.resource?.sha256 ?? 'unknown'}`,
    ...(enterprise ? [
      `表单工具覆盖: ${JSON.stringify(enterprise.requiredToolCoverage ?? {})}`,
      `DOM 核验: ${JSON.stringify({ verified: enterprise.domChecker?.verified, fieldValuesVerified: enterprise.domChecker?.fieldValuesVerified, fileSelected: enterprise.domChecker?.fileSelected, fileVerified: enterprise.domChecker?.fileVerified })}`,
      `提交前证据: ${JSON.stringify(enterprise.noSubmitEvidence ?? {})}`,
    ] : []),
    ...(summary.connectionGuidance ? [`后续操作: ${summary.connectionGuidance}`] : []),
  ].join('\n');
}

async function BrowserConnectionEvidence(bridge, engine) {
  const reported = bridge.Status();
  const port = Number.isSafeInteger(reported?.port) ? reported.port : 0;
  const listening = port > 0 ? await IsTcpPortListening(port) : false;
  const bindAvailable = listening ? false : await IsTcpPortBindable(port);
  const browserProcessRunning = await IsBrowserProcessRunning(engine);
  const extensionVersion = typeof reported?.actualVersion === 'string'
    ? reported.actualVersion
    : typeof reported?.version === 'string' ? reported.version : null;
  const extensionProtocolRevision = typeof reported?.actualProtocolRevision === 'string'
    ? reported.actualProtocolRevision
    : typeof reported?.protocolRevision === 'string' ? reported.protocolRevision : null;
  const expectedProtocolRevision = typeof reported?.expectedProtocolRevision === 'string'
    ? reported.expectedProtocolRevision
    : ExpectedExtensionProtocolRevision;
  return {
    bridge: { listening, bindAvailable, state: listening ? 'listening' : bindAvailable ? 'available_to_bind' : 'unavailable_or_unknown', connected: reported?.connected === true, port: port || null },
    browserProcess: { engine, running: browserProcessRunning },
    extension: {
      helloReceived: (reported?.handshakeSource ?? reported?.source) === 'hello',
      handshakeReceived: reported?.handshakeReceived === true,
      handshakeSource: reported?.handshakeSource ?? reported?.source ?? null,
      online: reported?.connected === true,
      state: reported?.state === 'stale' ? 'stale' : reported?.connected === true ? 'online' : 'offline',
      version: extensionVersion,
      expectedVersion: ExpectedExtensionVersion,
      versionMatches: extensionVersion === ExpectedExtensionVersion,
      protocolRevision: extensionProtocolRevision,
      expectedProtocolRevision,
      protocolRevisionMatches: extensionProtocolRevision === expectedProtocolRevision && reported?.state !== 'stale',
    },
  };
}

function ConnectionGuidance(connection, launchState, engine) {
  if (connection?.extension?.state === 'stale' || connection?.extension?.protocolRevisionMatches === false && connection?.extension?.handshakeReceived) {
    return `The Bridge rejected a stale Avery Service Worker handshake (actual=${connection.extension.actualProtocolRevision ?? connection.extension.protocolRevision ?? 'missing'}, expected=${connection.extension.expectedProtocolRevision ?? ExpectedExtensionProtocolRevision}); open chrome://extensions in ${engine === 'edge' ? 'Edge' : 'Chrome'}, reload Avery Browser from ${projectExtensionPath}, then rerun the smoke.`;
  }
  if (connection?.extension?.handshakeReceived && !connection.extension.versionMatches) {
    return `The Bridge received extension version ${connection.extension.version}; open chrome://extensions in ${engine === 'edge' ? 'Edge' : 'Chrome'}, reload Avery Browser from ${projectExtensionPath}, and confirm version ${ExpectedExtensionVersion}.`;
  }
  if (connection?.bridge?.listening && connection.browserProcess?.running && !connection.extension?.handshakeReceived && launchState?.attempted) {
    return `The Bridge is listening but has not received an authoritative hello/poll handshake. Open chrome://extensions in ${engine === 'edge' ? 'Edge' : 'Chrome'}, load or reload the unpacked extension at ${projectExtensionPath}, confirm version ${ExpectedExtensionVersion}, then rerun the smoke.`;
  }
  if (connection?.bridge?.listening && !connection.browserProcess?.running && launchState?.attempted) {
    return `${engine === 'edge' ? 'Edge' : 'Chrome'} did not remain running after the pairing page was opened; check the browser launch before changing extension state.`;
  }
  if (!connection?.bridge?.listening) {
    return 'No Bridge listener was confirmed. This does not establish that the extension needs reloading; retry a live smoke after the Bridge can bind its configured port.';
  }
  return null;
}

async function RunStatus(runtime, bridge, probe, engine) {
  const before = await runtime.GetStatus(false);
  const after = probe ? await runtime.GetStatus(true) : null;
  const connection = await BrowserConnectionEvidence(bridge, engine);
  return {
    ...connection,
    before: { available: before.available, running: before.running, state: before.state, engine: before.engine },
    ...(after ? { probed: { available: after.available, running: after.running, state: after.state, engine: after.engine, message: after.message } } : {}),
  };
}

function ConnectionBlockStatus(browser) {
  if (browser?.bridge?.listening !== true) return 'blocked_bridge_not_listening';
  if (browser?.extension?.state === 'stale') return 'blocked_extension_stale';
  if (browser?.extension?.handshakeReceived !== true && browser?.extension?.helloReceived !== true) return 'blocked_extension_not_connected';
  if (browser?.extension?.protocolRevisionMatches !== true) return 'blocked_extension_stale';
  if (browser?.extension?.online !== true) return 'blocked_extension_not_connected';
  if (browser?.extension?.versionMatches !== true) return 'historical_extension_version';
  return null;
}

async function RunStatusOnly(engine, port) {
  const listening = await IsTcpPortListening(port);
  const bindAvailable = listening ? false : await IsTcpPortBindable(port);
  const browserProcessRunning = await IsBrowserProcessRunning(engine);
  return {
    bridge: { listening, bindAvailable, state: listening ? 'listening_existing_owner' : bindAvailable ? 'available_to_bind' : 'unavailable_or_unknown', port },
    browserProcess: { engine, running: browserProcessRunning },
    extension: {
      helloReceived: null,
      handshakeReceived: false,
      handshakeSource: null,
      online: null,
      state: 'offline',
      version: null,
      actualVersion: null,
      expectedVersion: ExpectedExtensionVersion,
      versionMatches: false,
      protocolRevision: null,
      actualProtocolRevision: null,
      expectedProtocolRevision: ExpectedExtensionProtocolRevision,
      protocolRevisionMatches: false,
      observation: listening ? 'existing_bridge_owner_not_attached' : 'no_bridge_listener_status_only_does_not_start_bridge',
    },
    nextAction: listening
      ? 'An existing process owns the Bridge port; this read-only status run cannot inspect its hello version.'
      : 'No Bridge listener was observed. Status mode does not start a Bridge or infer that the extension needs reloading; run a live smoke to test the handshake.',
  };
}

async function RunCollect(harness, input) {
  const result = await harness.host.Send({
    requestId: 'pb03-collect-run', sessionId: 'pb03-collect-session', scenarioId: 'application', confirmationMode: 'fully_trusted',
    content: `PB-03 只读采集验收：搜索 ${input.query} / ${input.city}，保存第一条候选供后续核对。`,
  });
  const state = await ReadState(join(input.runtimeRoot, 'user-data'));
  const ledger = SafeLedger(state);
  const saved = harness.business && (await harness.business.LoadViewModel()).jobs;
  const outcome = {
    hostAccepted: result?.accepted === true,
    toolEvents: SafeToolEvents(harness.events ?? []),
    savedJobCount: Array.isArray(saved) ? saved.length : 0,
    ledger,
  };
  const collectOk = outcome.toolEvents.some((event) => event.toolName === 'CollectJobs' && event.ok);
  const saveOk = outcome.ledger.some((entry) => entry.toolName === 'SaveJob' && entry.status === 'succeeded' && entry.hasReceipt);
  if (!collectOk) outcome.status = 'blocked_or_failed_at_collection';
  else if (!saveOk || outcome.savedJobCount < 1) outcome.status = 'failed_savejob_ledger';
  else outcome.status = 'passed';
  return outcome;
}

async function RunContact(harness, input, execute) {
  const sessionId = 'pb03-contact-session';
  const sendResult = await harness.host.Send({
    requestId: 'pb03-contact-run', sessionId, scenarioId: 'application',
    confirmationMode: execute ? 'fully_trusted' : 'always_confirm',
    content: `PB-03 ContactBossJobs 验收：准备联系已明确指定的测试岗位 ${input.jobId}。`,
  });
  const confirmation = [...(harness.events ?? [])].reverse().find((event) => event.type === 'browser_confirmation' && event.browserAction?.toolName === 'ContactBossJobs');
  let confirmationResult = null;
  let continuationAccepted = null;
  const confirmationId = confirmation?.confirmationId ?? confirmation?.proposalId ?? confirmation?.browserAction?.confirmationId;
  const contactResult = {
    hostAccepted: sendResult?.accepted === true,
    confirmationPending: Boolean(confirmation),
    confirmationIdPresent: typeof confirmationId === 'string' && confirmationId.length > 0,
    confirmation: null,
    continuationAccepted: null,
    toolEvents: SafeToolEvents(harness.events ?? []),
    ledger: [],
    batchEvents: [],
  };
  if (!execute) {
    contactResult.status = contactResult.confirmationPending ? 'prepared_waiting_confirmation' : 'blocked_or_failed_before_confirmation';
  } else if (confirmation) {
    const toolName = String(confirmation.browserAction?.toolName || 'unknown');
    if (!contactResult.confirmationIdPresent || toolName !== 'ContactBossJobs') {
      try {
        const rejected = contactResult.confirmationIdPresent
          ? await harness.host.ConfirmBrowserAction(String(confirmationId), false, { sessionId })
          : null;
        contactResult.confirmation = { toolName, accepted: false, status: String(rejected?.status || 'not_attempted') };
      } catch (error) {
        contactResult.confirmation = { toolName, accepted: false, status: 'rejection_failed', error: SafeErrorText(error) };
      }
      contactResult.status = 'blocked_unexpected_confirmation';
    } else {
      try {
        confirmationResult = await harness.host.ConfirmBrowserAction(String(confirmationId), true, { sessionId });
        contactResult.confirmation = { toolName, accepted: true, status: String(confirmationResult?.status || 'unknown') };
        if (confirmationResult?.status === 'succeeded') {
          harness.provider?.MarkContactConfirmed?.();
          const continuation = await harness.host.Send({
            requestId: 'pb03-contact-continuation', sessionId, scenarioId: 'application', confirmationMode: 'fully_trusted',
            content: 'Continue after the Host-confirmed ContactBossJobs action. Do not call ContactBossJobs again; only report completion.',
          });
          continuationAccepted = continuation?.accepted === true;
        }
      } catch (error) {
        contactResult.confirmation = { toolName, accepted: true, status: 'failed', error: SafeErrorText(error) };
      }
    }
  }
  const state = await ReadState(join(input.runtimeRoot, 'user-data'));
  contactResult.ledger = SafeLedger(state);
  contactResult.batchEvents = harness.batchEvents;
  contactResult.toolEvents = SafeToolEvents(harness.events ?? []);
  contactResult.continuationAccepted = continuationAccepted;
  if (contactResult.status) return contactResult;
  if (confirmation && contactResult.confirmation?.status !== 'succeeded') {
    contactResult.status = 'failed_confirmation_continuation';
    return contactResult;
  }
  if (confirmation && continuationAccepted !== true) {
    contactResult.status = 'failed_host_continuation';
    return contactResult;
  }
  contactResult.status = contactResult.ledger.some((entry) => entry.toolName === 'ContactBossJobs' && entry.status === 'succeeded' && entry.hasReceipt)
    ? 'passed' : 'failed_missing_contact_receipt';
  return contactResult;
}

const EnterpriseFillSources = {
  profiles: [
    {
      id: 'pb03-personal', category: 'application', title: 'PB-03 synthetic personal facts',
      content: '[个人信息]\n出生日期：2000-01-15\n民族：汉族\n现居住地：广东省佛山市',
    },
    {
      id: 'pb03-education', category: 'education', title: 'PB-03 synthetic education facts',
      content: '[教育经历]\n学校：南昌大学\n专业：工商管理\n学历：本科\n入学时间：2020-09\n毕业时间：2024-06',
    },
  ],
};

const EnterpriseExpectedFields = {
  '学校名称': 'education.school',
  '专业名称': 'education.major',
  '出生日期': 'personal.birthDate',
  '民族': 'personal.ethnicity',
  '现居住地': 'personal.currentRegion',
  '开始时间': 'education.startDate',
  '结束时间': 'education.endDate',
  '学历': 'education.degreeLevel',
};

function DetectEnterpriseGate(text) {
  const normalized = String(text || '').slice(0, 20_000);
  return {
    loginRequired: /(?:登录|登陆|log\s*in|sign\s*in|请先登录|account required)/i.test(normalized),
    captchaPresent: /(?:验证码|滑动验证|安全验证|captcha|verify you are human|robot check)/i.test(normalized),
  };
}

function MapObject(value) {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function EvidenceLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s*_·:：/\\()（）[\]【】—–-]/g, '');
}

function FindEnterpriseField(fields, label, concept) {
  const wanted = EvidenceLabel(label);
  return fields.find((field) => EvidenceLabel(field?.label) === wanted)
    ?? fields.find((field) => EvidenceLabel(field?.raw?.label) === wanted)
    ?? fields.find((field) => field?.semantic?.concept === concept);
}

/**
 * 只从 Runtime 最近一次 Snapshot 的内部短寿命 ref 取 selector，绝不接受 URL/模型参数构造的 selector。
 * public refs 只用于 FormFields 语义匹配；private refs 只在本次 checker 表达式中使用，不写入 summary。
 */
function EnterpriseDomSelectors(harness, input) {
  const runtime = harness?.browserRuntime;
  const publicRefs = MapObject(runtime?.refs);
  const personalRuntime = runtime?.personalBrowserRuntime;
  const privateRefs = MapObject(personalRuntime?.refs);
  const pageRevision = Number.isSafeInteger(runtime?.pageRevision) ? runtime.pageRevision : null;
  if (!pageRevision || !Object.keys(publicRefs).length || !Object.keys(privateRefs).length) {
    return { pageRevision, fields: {}, fieldCoverage: {}, fileSelectors: [] };
  }
  let fields;
  try {
    fields = FormFields(publicRefs, pageRevision);
  } catch {
    return { pageRevision, fields: {}, fieldCoverage: {}, fileSelectors: [] };
  }
  const selectors = {};
  const fieldCoverage = {};
  const expectations = Array.isArray(input.fieldExpectations) ? input.fieldExpectations : [];
  for (const expectation of expectations) {
    const label = String(expectation.label ?? '');
    const concept = String(expectation.semantic ?? '').split('.').pop();
    const field = FindEnterpriseField(fields, label, concept);
    const refKey = String(field?.ref || '').replace(/^@/, '');
    const selector = privateRefs[refKey]?.selector;
    fieldCoverage[label] = typeof selector === 'string' && selector.length > 0;
    if (fieldCoverage[label]) selectors[label] = selector;
  }
  const uploadRef = String(input.uploadRef || '').replace(/^@/, '');
  const uploadSelector = publicRefs[uploadRef] && privateRefs[uploadRef]?.selector;
  const fileSelectors = uploadSelector
    ? [uploadSelector]
    : fields
      .filter((field) => field?.control === 'file' || String(field?.inputType || '').toLowerCase() === 'file')
      .map((field) => privateRefs[String(field.ref || '').replace(/^@/, '')]?.selector)
      .filter((selector) => typeof selector === 'string' && selector.length > 0);
  return { pageRevision, fields: selectors, fieldCoverage, fileSelectors: [...new Set(fileSelectors)] };
}

function EnterpriseDomCheckerExpression(fieldSelectors, fileSelectors, expectations, fileExpectation) {
  const encoded = JSON.stringify({
    fields: Object.entries(fieldSelectors).map(([label, selector]) => ({ label, selector })),
    files: fileSelectors,
    fileExpectation: fileExpectation ? {
      name: fileExpectation.name,
      size: fileExpectation.size,
      sha256: fileExpectation.sha256,
    } : null,
    expectations: Object.fromEntries(expectations.map((expectation) => [expectation.label, {
      expectedValue: expectation.expectedValue,
      comparison: expectation.comparison,
    }])),
  });
  return `(async () => {
    const config = ${encoded};
    const find = (selector) => {
      if (typeof selector !== 'string' || !selector) return null;
      try { return document.querySelector(selector); } catch { return null; }
    };
    const normalize = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]/gu, '');
    const valuesOf = (element) => {
      if (!(element instanceof HTMLElement)) return [];
      if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'file') return [];
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type.toLowerCase())) return [element.checked ? 'checked' : ''];
      if (element instanceof HTMLSelectElement) return [element.value, ...[...element.selectedOptions].map((option) => String(option.value) + ' ' + String(option.label) + ' ' + String(option.textContent || ''))];
      const controls = [...element.querySelectorAll('input:not([type=file]),textarea,select,button,[role=combobox]')];
      return [element.value, element.innerText, element.textContent, ...controls.flatMap((control) => [control.value, control.innerText, control.textContent])].filter((value) => typeof value === 'string');
    };
    const matches = (actualValues, expectedValue, comparison) => {
      const expected = normalize(expectedValue);
      if (!expected) return false;
      const candidates = actualValues.map(normalize).filter(Boolean);
      if (comparison === 'exact') return candidates.some((value) => value === expected);
      if (comparison === 'date') {
        const expectedDigits = String(expectedValue).replace(/\\D/g, '');
        return Boolean(expectedDigits) && candidates.some((value) => value.replace(/[^\\d]/g, '').includes(expectedDigits));
      }
      return candidates.some((value) => value.includes(expected));
    };
    const fields = {};
    for (const field of config.fields || []) {
      const element = find(field.selector);
      const expected = config.expectations?.[field.label];
      fields[field.label] = Boolean(element && expected && matches(valuesOf(element), expected.expectedValue, expected.comparison));
    }
    const fileInput = (config.files || []).map(find).find((element) => {
      return element instanceof HTMLInputElement && element.type.toLowerCase() === 'file' && Boolean(element.files && element.files.length > 0);
    });
    const fileSelected = Boolean(fileInput);
    let fileEvidence = { nameMatches: false, sizeMatches: false, sha256Matches: false };
    const selectedFile = fileSelected ? fileInput.files[0] : null;
    if (selectedFile && config.fileExpectation) {
      const expected = config.fileExpectation;
      const bytes = await selectedFile.arrayBuffer();
      const digest = globalThis.crypto?.subtle ? await globalThis.crypto.subtle.digest('SHA-256', bytes) : null;
      const actualSha256 = digest ? [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('') : '';
      fileEvidence = {
        nameMatches: selectedFile.name === expected.name,
        sizeMatches: selectedFile.size === expected.size,
        sha256Matches: actualSha256 === expected.sha256,
        fileName: selectedFile.name,
        sizeBytes: selectedFile.size,
        sha256: actualSha256,
      };
    }
    const submitButton = document.querySelector('[data-pb03-submit]');
    const submitInstrumentationAvailable = typeof window.__pb03SubmitAttempts === 'number';
    return {
      fields, fileSelected, fileEvidence,
      submitButtonPresent: Boolean(submitButton),
      submitInstrumentationAvailable,
      submitAttempts: submitInstrumentationAvailable ? window.__pb03SubmitAttempts : null,
      networkSubmissionAttempts: typeof window.__pb03NetworkSubmitAttempts === 'number' ? window.__pb03NetworkSubmitAttempts : null,
    };
  })()`;
}

/**
 * Host 动作完成后才调用的补充核验：只返回布尔字段和覆盖情况，不回传表单正文/文件名/本地路径。
 * 这不是 Tool Registry 工具，也不能替代 BrowserSnapshot、BrowserFillForm 或 BrowserValidateForm。
 */
async function RunEnterpriseDomChecker(harness, input, observations) {
  const expectedFields = Array.isArray(input.fieldExpectations) ? input.fieldExpectations : [];
  const checkExpectedFields = expectedFields.length > 0;
  const base = {
    checker: 'supplemental_read_only_dom', attempted: false, available: false, verified: false,
    fieldValuesVerified: checkExpectedFields ? false : null,
    fileInputObserved: false, fileSelected: input.uploadTestFile ? false : null,
    noFieldValuesRecorded: true,
  };
  if (!observations?.finalSnapshot) return { ...base, reason: 'final_snapshot_unavailable' };
  const selectors = EnterpriseDomSelectors(harness, { ...input, uploadRef: observations.uploadRef });
  const expectedLabels = expectedFields.map((item) => item.label);
  const coverage = checkExpectedFields
    ? Object.fromEntries(expectedLabels.map((label) => [label, selectors.fieldCoverage[label] === true]))
    : null;
  const fieldSelectors = checkExpectedFields ? selectors.fields : {};
  const fileInputObserved = selectors.fileSelectors.length > 0;
  if ((checkExpectedFields && !expectedLabels.some((label) => selectors.fieldCoverage[label])) && !fileInputObserved) {
    return { ...base, attempted: true, reason: 'browser_form_refs_unavailable', pageRevision: selectors.pageRevision };
  }
  const expression = EnterpriseDomCheckerExpression(fieldSelectors, selectors.fileSelectors, expectedFields, input.fileExpectation);
  try {
    const response = await harness.browserRuntime.RunCommand(
      ['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')],
      { deadline: Date.now() + 10_000 },
    );
    const value = response?.data?.result ?? response?.data?.value ?? response?.data;
    const domFields = value?.fields && typeof value.fields === 'object' ? value.fields : {};
    const fieldValuesVerified = checkExpectedFields
      ? expectedLabels.every((label) => coverage[label] === true && domFields[label] === true)
      : null;
    const fileSelected = input.uploadTestFile ? value?.fileSelected === true : null;
    const expectedFile = input.fileExpectation ?? null;
    const fileVerified = input.uploadTestFile
      ? fileSelected === true
        && value?.fileEvidence?.nameMatches === true
        && value?.fileEvidence?.sizeMatches === true
        && value?.fileEvidence?.sha256Matches === true
      : null;
    return {
      ...base,
      attempted: true,
      available: true,
      verified: checkExpectedFields && fieldValuesVerified === true && (!input.uploadTestFile || fileVerified === true),
      fieldValuesVerified,
      fields: checkExpectedFields ? Object.fromEntries(expectedLabels.map((label) => [label, domFields[label] === true])) : null,
      fieldCoverage: coverage,
      fileInputObserved,
      fileSelected,
      fileVerified,
      ...(expectedFile ? { expectedFile: { name: expectedFile.name, size: expectedFile.size, sha256: expectedFile.sha256 } } : {}),
      fileEvidence: value?.fileEvidence ?? null,
      submitButtonPresent: value?.submitButtonPresent === true,
      submitInstrumentationAvailable: value?.submitInstrumentationAvailable === true,
      submitAttempts: Number.isSafeInteger(value?.submitAttempts) ? value.submitAttempts : null,
      networkSubmissionAttempts: Number.isSafeInteger(value?.networkSubmissionAttempts) ? value.networkSubmissionAttempts : null,
      pageRevision: selectors.pageRevision,
    };
  } catch (error) {
    return { ...base, attempted: true, reason: 'dom_checker_failed', errorCode: typeof error?.code === 'string' ? error.code : 'BROWSER_DOM_CHECK_FAILED', pageRevision: selectors.pageRevision };
  }
}

async function RunHostConversation(harness, input) {
  const sessionId = `pb03-enterprise-${Digest(input.enterpriseUrl)}`;
  const confirmations = [];
  const handledConfirmations = new Set();
  const attachments = input.uploadTestFile
    ? [{ name: 'PB-03-synthetic-resume.pdf', path: SyntheticResumeAttachmentId }]
    : [];
  let sendResult = null;
  for (let turn = 0; turn < 4; turn += 1) {
    const requestId = `${sessionId}-${turn}`;
    sendResult = await harness.host.Send({
      requestId,
      sessionId,
      scenarioId: 'application',
      confirmationMode: 'fully_trusted',
      attachments,
      content: `PB-03 企业招聘官网提交前验收：打开 ${input.enterpriseUrl}，${input.fillData ? '使用合成资料填写表单' : '只读观察表单'}，并核对文件上传；严禁点击提交。`,
    });
    const pending = [...(harness.events ?? [])].reverse().find((event) => (
      event?.type === 'browser_confirmation'
      && event.requestId === requestId
      && typeof event.confirmationId === 'string'
      && !handledConfirmations.has(event.confirmationId)
    ));
    if (!pending) return { sendResult, confirmations, turns: turn + 1 };
    const confirmationId = pending.confirmationId ?? pending.proposalId ?? pending.browserAction?.confirmationId;
    if (typeof confirmationId !== 'string' || !confirmationId) {
      return { sendResult, confirmations, turns: turn + 1, waiting: { toolName: String(pending.browserAction?.toolName || 'unknown'), confirmationIdPresent: false } };
    }
    handledConfirmations.add(confirmationId);
    const toolName = String(pending.browserAction?.toolName || '');
    const allowed = (toolName === 'BrowserUploadFile' && input.allowUploadConfirmation === true)
      || (toolName === 'BrowserFillForm' && input.fillData === true);
    if (!allowed) {
      try {
        const rejected = await harness.host.ConfirmBrowserAction(confirmationId, false, { sessionId });
        confirmations.push({ toolName: toolName || 'unknown', accepted: false, status: String(rejected?.status || 'unknown') });
      } catch (error) {
        confirmations.push({ toolName: toolName || 'unknown', accepted: false, status: 'rejection_failed', error: SafeErrorText(error) });
      }
      return { sendResult, confirmations, turns: turn + 1, rejectedUnsafeAction: true, waiting: { toolName: toolName || 'unknown', confirmationIdPresent: true } };
    }
    try {
      const completed = await harness.host.ConfirmBrowserAction(confirmationId, true, { sessionId });
      confirmations.push({ toolName, accepted: true, status: String(completed?.status || 'unknown') });
      if (completed?.status !== 'succeeded') return { sendResult, confirmations, turns: turn + 1, failed: true };
      harness.provider?.SetConfirmedToolResult?.(toolName, completed);
    } catch (error) {
      confirmations.push({ toolName, accepted: true, status: 'failed' });
      return { sendResult, confirmations, turns: turn + 1, failed: true, error: SafeErrorText(error) };
    }
  }
  return { sendResult, confirmations, turns: 4, failed: true, error: 'Enterprise Host continuation exceeded the bounded turn count.' };
}

function EnterpriseFillEvidence(observations, input) {
  const fill = observations?.fill;
  if (!input.fillData) {
    return { attempted: false, verified: false, status: 'not_tested', notTested: true, evidence: fill ?? null };
  }
  const rawLabels = Array.isArray(fill?.filledLabels) ? fill.filledLabels : [];
  const labels = new Set(rawLabels.map(EvidenceLabel).filter(Boolean));
  const expectedFields = Array.isArray(input.fieldExpectations) ? input.fieldExpectations : [];
  const expected = expectedFields.length
    ? Object.fromEntries(expectedFields.map((item) => [item.label, labels.has(EvidenceLabel(item.label))]))
    : null;
  const filledCount = Number.isSafeInteger(fill?.filledCount) ? fill.filledCount : rawLabels.length;
  const skippedCount = Number.isSafeInteger(fill?.skippedCount) ? fill.skippedCount : 0;
  const ambiguousCount = Number.isSafeInteger(fill?.ambiguousCount) ? fill.ambiguousCount : 0;
  const remainingCount = Number.isSafeInteger(fill?.remainingCount) ? fill.remainingCount : null;
  const minimumCount = expectedFields.length || 1;
  const verified = Boolean(
    fill
    && fill.done === true
    && filledCount >= minimumCount
    && skippedCount === 0
    && ambiguousCount === 0
    && (remainingCount === null || remainingCount === 0)
    && (!expected || Object.values(expected).every(Boolean)),
  );
  return {
    attempted: true,
    verified,
    status: verified ? 'verified' : 'partial',
    filledCount,
    filledLabels: rawLabels,
    expected,
    skippedCount,
    ambiguousCount,
    remainingCount,
    knownFieldSemantics: expectedFields.length > 0,
    expectations: expectedFields.map((item) => ({ label: item.label, ...(item.semantic ? { semantic: item.semantic } : {}), valueSha256: Sha256(item.expectedValue) })),
  };
}

async function RunEnterprise(harness, input) {
  const targetUrl = ValidatedHttpsUrl(input.enterpriseUrl, /./);
  const base = { target: SafeUrl(targetUrl), attachments: ['PB-03-synthetic-resume.pdf'] };
  if (!targetUrl) return { ...base, status: 'blocked_invalid_enterprise_url' };
  try {
    const flow = await RunHostConversation(harness, { ...input, enterpriseUrl: targetUrl });
    const observations = harness.provider?.observations ?? {};
    const auth = observations.gate ?? { loginRequired: false, captchaPresent: false };
    const fill = EnterpriseFillEvidence(observations, input);
    const validation = observations.validation ?? { valid: null, issueCount: null, inspectedFieldCount: null, validationMetadataAvailable: false };
    const domChecker = await RunEnterpriseDomChecker(harness, input, observations);
    const uploadConfirmation = flow.confirmations.find((item) => item.toolName === 'BrowserUploadFile');
    const upload = input.uploadTestFile
      ? {
        attempted: uploadConfirmation?.status === 'succeeded',
        confirmation: uploadConfirmation?.status ?? 'pending',
        fixture: 'PB-03-synthetic-resume.pdf',
        fileSelected: domChecker.fileSelected === true,
        fileVerified: domChecker.fileVerified === true,
      }
      : { attempted: false, reason: 'upload_not_requested' };
    const finalSnapshot = observations.finalSnapshot ?? null;
    const toolEvents = SafeToolEvents(harness.events ?? []);
    const toolCalls = toolEvents.filter((event) => event.type === 'tool_call');
    const clickOrKeyToolEvents = toolCalls.filter((event) => ['BrowserClick', 'BrowserPressKey'].includes(event.toolName));
    const ledger = SafeLedger(await ReadState(harness.userDataPath));
    const clickOrKeyLedgerEntries = ledger.filter((entry) => ['BrowserClick', 'BrowserPressKey'].includes(entry.toolName));
    const submitAttempted = clickOrKeyToolEvents.length > 0 || clickOrKeyLedgerEntries.length > 0;
    const actionEvents = toolCalls.map((event) => ({ toolName: event.toolName, ok: event.ok, ...(event.code ? { code: event.code } : {}) }));
    const successfulTools = new Set((observations.toolResults ?? []).filter((item) => item.ok).map((item) => item.toolName));
    const requiredToolCoverage = {
      navigate: successfulTools.has('BrowserNavigate'),
      initialSnapshot: Number(observations.snapshotCount || 0) >= 2,
      readPage: successfulTools.has('BrowserReadPage'),
      fillForm: input.fillData ? successfulTools.has('BrowserFillForm') : null,
      uploadFile: input.uploadTestFile ? successfulTools.has('BrowserUploadFile') : null,
      validateForm: successfulTools.has('BrowserValidateForm'),
      finalSnapshot: Boolean(finalSnapshot) && successfulTools.has('BrowserSnapshot'),
    };
    const uploadOkay = !input.uploadTestFile || (upload.attempted && domChecker.fileVerified === true);
    const validationOkay = validation.validationMetadataAvailable === true && validation.issueCount === 0 && validation.valid === true;
    const hostAccepted = flow.sendResult?.accepted === true;
    const extensionReady = input.connectionVerified === true;
    const allRequiredToolsSucceeded = Object.values(requiredToolCoverage).every((value) => value === true || value === null);
    const domSubmissionObserved = domChecker.submitInstrumentationAvailable === true
      && domChecker.submitAttempts === 0
      && domChecker.networkSubmissionAttempts === 0;
    const initialUrl = observations.initialSnapshot?.finalUrl ?? null;
    const finalUrl = finalSnapshot?.finalUrl ?? null;
    const hostToolLedgerEvidence = clickOrKeyToolEvents.length === 0
      && clickOrKeyLedgerEntries.length === 0
      && !toolCalls.some((event) => ['BrowserSubmit', 'SubmitApplication', 'ContactBossJobs'].includes(event.toolName))
      && !ledger.some((entry) => ['BrowserSubmit', 'SubmitApplication', 'ContactBossJobs'].includes(entry.toolName));
    const pageUrlUnchanged = Boolean(initialUrl && finalUrl && initialUrl === finalUrl);
    const noSubmitEvidence = {
      clickOrKeyToolCalls: clickOrKeyToolEvents.length,
      clickOrKeyLedgerEntries: clickOrKeyLedgerEntries.length,
      submitOrOutboundToolCalls: toolCalls.filter((event) => ['BrowserSubmit', 'SubmitApplication', 'ContactBossJobs'].includes(event.toolName)).length,
      submitOrOutboundLedgerEntries: ledger.filter((entry) => ['BrowserSubmit', 'SubmitApplication', 'ContactBossJobs'].includes(entry.toolName)).length,
      domInstrumentationAvailable: domChecker.submitInstrumentationAvailable === true,
      domSubmitAttempts: domChecker.submitAttempts,
      networkSubmissionAttempts: domChecker.networkSubmissionAttempts,
      finalSubmitControlPresent: Number(finalSnapshot?.finalSubmitCandidates || 0) > 0,
      hostToolLedgerEvidence,
      pageUrlUnchanged,
      evidenceBoundary: domSubmissionObserved ? 'dom_submit_and_network_monitors_plus_host_tool_ledger' : 'host_tool_ledger_and_url_only; cannot exclude site-initiated AJAX submission',
      noSubmitObserved: !submitAttempted && domSubmissionObserved,
      hostNoSubmitObserved: !submitAttempted && hostToolLedgerEvidence && pageUrlUnchanged,
    };
    const waiting = flow.waiting;
    const status = flow.failed
      ? 'failed'
      : flow.rejectedUnsafeAction
        ? 'blocked_unsafe_confirmation_rejected'
        : waiting
        ? (waiting.toolName === 'BrowserUploadFile' ? 'blocked_waiting_upload_confirmation' : 'blocked_waiting_user')
        : auth.loginRequired || auth.captchaPresent
          ? 'blocked_auth_or_captcha'
          : submitAttempted
            ? 'blocked_submit_action_detected'
            : !input.fillData
              ? 'not_tested'
              : hostAccepted && extensionReady && allRequiredToolsSucceeded && fill.verified && domChecker.verified && uploadOkay && validationOkay && Boolean(finalSnapshot) && noSubmitEvidence.noSubmitObserved
            ? 'passed_pre_submit'
            : 'partial_pre_submit';
    return {
      ...base,
      status,
      finalUrl: finalSnapshot?.finalUrl || targetUrl,
      finalSubmitClicked: submitAttempted,
      auth,
      host: {
        accepted: hostAccepted,
        turns: flow.turns,
        confirmations: flow.confirmations,
        waiting: waiting ? { toolName: waiting.toolName, confirmationIdPresent: waiting.confirmationIdPresent } : null,
      },
      actions: {
        executed: actionEvents,
        submitToolEvents: clickOrKeyToolEvents.map((event) => ({ toolName: event.toolName, ok: event.ok, ...(event.code ? { code: event.code } : {}) })),
        submitAttempted,
        noSubmitToolCalled: clickOrKeyToolEvents.length === 0 && clickOrKeyLedgerEntries.length === 0,
      },
      noSubmitEvidence,
      requiredToolCoverage,
      extensionVerified: extensionReady,
      toolEvents,
      fill,
      upload,
      validation,
      domChecker,
      ledger,
      final: finalSnapshot,
      finalSubmitCandidates: Number(finalSnapshot?.finalSubmitCandidates || 0),
      ...(flow.error ? { error: SafeErrorText(flow.error) } : {}),
    };
  } catch (error) {
    return { ...base, status: 'failed', errorCode: typeof error?.code === 'string' ? error.code : 'BROWSER_ATS_FLOW_FAILED', error: SafeErrorText(error) };
  }
}

async function Main() {
  const args = ParseArguments(process.argv.slice(2));
  const mode = String(args.mode || 'status');
  const engine = args.engine === 'edge' ? 'edge' : 'chrome';
  const allowBrowserLaunch = BooleanArgument(args, 'allow-browser-launch', false);
  // Status and attach-only live modes must still produce an actionable
  // offline/stale artifact on machines without a browser executable.
  if (mode !== 'status' && allowBrowserLaunch && !existsSync(browserPaths[engine])) throw new Error(`${engine} executable is unavailable.`);
  if (!existsSync(projectExtensionPath)) throw new Error('The project browser extension path is unavailable.');
  if (!existsSync(syntheticResumeFixturePath)) throw new Error('The PB-03 synthetic PDF fixture is unavailable.');
  if (!['status', 'collect', 'contact', 'enterprise'].includes(mode)) throw new Error(`Unsupported PB-03 mode: ${mode}`);

  const runtimeRoot = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'avery-pb03-live-'));
  const artifactStamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const artifactDir = join(projectRoot, 'artifacts', 'browser-migration', 'pb03', `${artifactStamp}-${process.pid}`);
  await mkdir(artifactDir, { recursive: true });
  const worktree = await WorktreeEvidence();
  const bridgeStatePath = args['bridge-state'] ? resolve(args['bridge-state']) : process.env.APPDATA
    ? join(process.env.APPDATA, 'avery', 'browser-extension', 'bridge.json')
    : join(runtimeRoot, 'browser-extension', 'bridge.json');
  const requestedBridgePort = mode === 'status'
    ? (args['bridge-port'] === 'existing'
      ? ParseBridgePort(args['bridge-port-number'], { fallback: DefaultBridgePort })
      : ParseBridgePort(args['bridge-port'], { fallback: DefaultBridgePort }))
    : (args['bridge-port'] === 'existing'
      ? ParseBridgePort(args['bridge-port-number'], { fallback: DefaultBridgePort })
      : ParseBridgePort(args['bridge-port'], { allowEphemeral: true, fallback: 0 }));
  const restorePort = Number(args['restore-port'] || 0);
  const attachments = new Map();
  const resumeAttachmentBytes = await readFile(syntheticResumeFixturePath);
  if (!resumeAttachmentBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The PB-03 resume fixture is not a PDF.');
  const resumeAttachmentDigest = createHash('sha256').update(resumeAttachmentBytes).digest('hex');
  attachments.set(SyntheticResumeAttachmentId, { id: SyntheticResumeAttachmentId, name: 'PB-03-synthetic-resume.pdf', mimeType: 'application/pdf', physicalPath: syntheticResumeFixturePath });
  const includeSyntheticImage = BooleanArgument(args, 'include-test-image') && BooleanArgument(args, 'allow-synthetic-image');
  if (includeSyntheticImage) {
    const imageAttachmentPath = join(runtimeRoot, 'PB-03-synthetic-image.png');
    await writeFile(imageAttachmentPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), { flag: 'wx' });
    attachments.set(SyntheticImageId, { id: SyntheticImageId, name: 'PB-03-synthetic-image.png', mimeType: 'image/png', physicalPath: imageAttachmentPath, source: 'synthetic-fixture' });
  }
  const launchState = { attempted: false, pairPageOpened: false, launchDenied: false, preflightSucceeded: false, sideEffectPerformed: false, restorePerformed: false };
  const events = [];
  const batchEvents = [];
  const contactUrl = BossUrl(args['contact-url']);
  const contactJobId = String(args['contact-job-id'] || '').trim();
  const contactCompany = String(args['contact-company'] || '').trim();
  const contactTitle = String(args['contact-title'] || '').trim();
  const view = {
    browserEngine: engine, resumes: [{ id: SyntheticResumeId, name: 'PB-03 合成测试简历', updatedAt: '2026-01-01', revision: 1, content: 'PB-03 synthetic resume; not a personal resume.' }],
    jobs: contactUrl && contactJobId && contactCompany && contactTitle ? [{ id: contactJobId, jobId: contactJobId, company: contactCompany, title: contactTitle, url: contactUrl, channel: 'boss_zhipin', contactStatus: 'not_contacted', revision: 1 }] : [],
    applications: [],
  };
  let bridge;
  let runtime;
  let host;
  const commandArguments = {
    mode,
    engine,
    bridgePort: args['bridge-port'] ?? (mode === 'status' ? DefaultBridgePort : 'ephemeral'),
    loadExtensionRequested: BooleanArgument(args, 'load-extension', true),
    allowBrowserLaunch,
    ...(mode === 'collect' ? { query: String(args.query || '产品经理'), city: String(args.city || '佛山') } : {}),
    ...(mode === 'contact' ? {
      target: contactUrl ? SafeUrl(contactUrl, /./) : null,
      jobIdSha256: contactJobId ? Sha256(contactJobId) : null,
      companySha256: contactCompany ? Sha256(contactCompany) : null,
      titleSha256: contactTitle ? Sha256(contactTitle) : null,
      messageProvided: Boolean(String(args.message || '').trim()),
      executeContact: BooleanArgument(args, 'execute-contact'),
      syntheticImageRequested: includeSyntheticImage,
    } : {}),
    ...(mode === 'enterprise' ? {
      target: SafeUrl(args['enterprise-url'], /./),
      fillData: BooleanArgument(args, 'fill-enterprise'),
      uploadTestFile: BooleanArgument(args, 'upload-test-file', true),
      uploadConfirmationAllowed: BooleanArgument(args, 'allow-test-upload'),
      fieldExpectationsProvided: Boolean(String(args['field-expectations'] || args['field-expectations-file'] || '').trim()),
    } : {}),
  };
  const initialBrowserEvidence = BuildPb03PreflightEvidence({ launchState, browserProcessRunning: false, browser: { browserProcess: { engine, running: false } } });
  let summary = {
    schemaVersion: PB03SchemaVersion,
    mode,
    engine,
    status: 'blocked',
    generatedAt: new Date().toISOString(),
    worktree,
    commandArguments,
    extension: { projectPath: 'apps/browser-extension', expectedVersion: ExpectedExtensionVersion, expectedProtocolRevision: ExpectedExtensionProtocolRevision, loadRequested: commandArguments.loadExtensionRequested },
    resource: { name: 'PB-03-synthetic-resume.pdf', bytes: resumeAttachmentBytes.length, sha256: resumeAttachmentDigest, source: 'repo-fixture', personalMaterial: false },
    browser: initialBrowserEvidence,
    browserProcess: initialBrowserEvidence.browserProcess,
    pairPageOpened: initialBrowserEvidence.pairPageOpened,
    preflightNoSideEffects: initialBrowserEvidence.preflightNoSideEffects,
  };
  // Persist the attach-only decision before constructing a live Host/provider.
  await writeFile(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(join(artifactDir, 'summary.log'), `${HumanReadableSummary(summary)}\n`, 'utf8');
  const PrepareLiveBrowser = async ({ extensionLoadRequested }) => {
    const browserParts = await CreateLiveBrowser({
      engine, runtimeRoot, bridgeStatePath, bridgePort: requestedBridgePort,
      extensionLoadRequested, launchState, attachments, events, allowBrowserLaunch,
    });
    bridge = browserParts.bridge;
    runtime = browserParts.browserRuntime;
    const preflight = await RunLivePreflight(browserParts, { engine, allowBrowserLaunch, launchState });
    summary = {
      ...summary,
      browser: preflight.browser,
      browserProcess: preflight.browser.browserProcess,
      pairPageOpened: preflight.browser.pairPageOpened,
      preflightNoSideEffects: preflight.browser.preflightNoSideEffects,
    };
    if (preflight.blocked) {
      summary.status = preflight.status;
      summary.errorCode = 'PB03_PREFLIGHT_BLOCKED';
      summary.error = preflight.action;
      summary.connectionGuidance = preflight.action;
      return null;
    }
    return { browserParts, browser: preflight.browser };
  };
  try {
    if (mode === 'status') {
      // Status is side-effect free: without a listener, it cannot infer that the extension needs reloading.
      const statusBrowser = await RunStatusOnly(engine, requestedBridgePort);
      const browser = BuildPb03PreflightEvidence({ launchState, browserProcessRunning: statusBrowser.browserProcess?.running === true, browser: statusBrowser });
      summary = { ...summary, status: 'observed', browser, browserProcess: browser.browserProcess, pairPageOpened: browser.pairPageOpened, preflightNoSideEffects: browser.preflightNoSideEffects };
    } else if (mode === 'collect') {
      const prepared = await PrepareLiveBrowser({ extensionLoadRequested: BooleanArgument(args, 'load-extension', true) });
      if (prepared) {
        const harness = await CreateLiveHarness({ engine, runtimeRoot, bridgeStatePath, bridgePort: requestedBridgePort, view, attachments, batchEvents, events, mode, input: { query: args.query || '产品经理', city: args.city || '佛山' }, extensionLoadRequested: BooleanArgument(args, 'load-extension', true), launchState, allowBrowserLaunch, browserParts: prepared.browserParts });
        ({ bridge, browserRuntime: runtime, host } = harness);
        harness.events = events;
        harness.batchEvents = batchEvents;
        const collect = await RunCollect(harness, {
          runtimeRoot,
          query: String(args.query || '产品经理'),
          city: String(args.city || '佛山'),
        });
        summary = { ...summary, browser: prepared.browser, collect };
        summary.status = summary.collect.status;
      }
    } else if (mode === 'contact') {
      if (!contactUrl || !contactJobId || !contactCompany || !contactTitle) {
        summary = { ...summary, status: 'blocked_missing_explicit_contact_target', required: ['--contact-job-id', '--contact-url', '--contact-company', '--contact-title', '--message'] };
      } else {
        const message = String(args.message || '').trim();
        if (!message) throw new Error('ContactBossJobs requires an explicit --message.');
        const execute = BooleanArgument(args, 'execute-contact');
        if (execute && !BooleanArgument(args, 'acknowledge-external-send')) throw new Error('External contact requires --acknowledge-external-send=true.');
        const prepared = await PrepareLiveBrowser({ extensionLoadRequested: BooleanArgument(args, 'load-extension', true) });
        if (prepared) {
          const harness = await CreateLiveHarness({ engine, runtimeRoot, bridgeStatePath, bridgePort: requestedBridgePort, view, attachments, batchEvents, events, mode, input: { jobId: contactJobId, imageAssetId: includeSyntheticImage ? SyntheticImageId : undefined, message }, extensionLoadRequested: BooleanArgument(args, 'load-extension', true), launchState, allowBrowserLaunch, browserParts: prepared.browserParts });
          ({ bridge, browserRuntime: runtime, host } = harness);
          harness.events = events;
          harness.batchEvents = batchEvents;
          const contact = await RunContact(harness, { runtimeRoot, jobId: contactJobId }, execute);
          summary = { ...summary, browser: prepared.browser, contact };
          summary.status = summary.contact.status;
        }
      }
    } else {
      // 两个 ATS 由同一脚本分别运行，避免一次命令跨站复用页面/会话证据。
      const enterpriseUrl = ValidatedHttpsUrl(args['enterprise-url'], /./);
      if (!enterpriseUrl) summary = { ...summary, status: 'blocked_missing_enterprise_url', required: ['--enterprise-url'] };
      else {
        const hostName = new URL(enterpriseUrl).hostname;
        const fieldExpectations = await LoadFieldExpectations(args, hostName);
        commandArguments.fieldExpectations = fieldExpectations.map((item) => ({
          label: item.label,
          ...(item.semantic ? { semantic: item.semantic } : {}),
          comparison: item.comparison,
          expectedValueSha256: Sha256(item.expectedValue),
        }));
        const enterpriseInput = {
          enterpriseUrl,
          uploadTestFile: BooleanArgument(args, 'upload-test-file', true),
          allowUploadConfirmation: BooleanArgument(args, 'allow-test-upload'),
          // 只有明确传入 --fill-enterprise 才执行字段写入；未知 ATS 没有期望映射时只能报告 partial。
          fillData: BooleanArgument(args, 'fill-enterprise'),
          fieldExpectations,
          fileExpectation: {
            name: 'PB-03-synthetic-resume.pdf',
            size: resumeAttachmentBytes.length,
            sha256: resumeAttachmentDigest,
          },
        };
        const prepared = await PrepareLiveBrowser({ extensionLoadRequested: BooleanArgument(args, 'load-extension', true) });
        if (prepared) {
          const harness = await CreateLiveHarness({
            engine, runtimeRoot, bridgeStatePath, bridgePort: requestedBridgePort, view, attachments, batchEvents, events,
            mode: 'enterprise', input: enterpriseInput, profiles: EnterpriseFillSources.profiles,
            extensionLoadRequested: BooleanArgument(args, 'load-extension', true), launchState, allowBrowserLaunch, browserParts: prepared.browserParts,
          });
          ({ bridge, browserRuntime: runtime, host } = harness);
          harness.events = events;
          harness.batchEvents = batchEvents;
          const enterprise = await RunEnterprise(harness, { ...enterpriseInput, connectionVerified: true });
          const finalConnection = await BrowserConnectionEvidence(bridge, engine);
          enterprise.extension = finalConnection.extension;
          if (enterprise.status === 'passed_pre_submit' && (!finalConnection.extension.handshakeReceived || !finalConnection.extension.versionMatches || finalConnection.bridge.listening !== true)) {
            enterprise.status = 'partial_pre_submit';
            enterprise.extensionVerified = false;
          }
          summary = { ...summary, browser: prepared.browser, enterprise, connectionGuidance: ConnectionGuidance(finalConnection, launchState, engine) };
          summary.enterpriseFlows = [summary.enterprise];
          summary.status = summary.enterprise.status;
        }
      }
    }
  } catch (error) {
    summary = { ...summary, status: 'failed', errorCode: typeof error?.code === 'string' ? error.code : 'PB03_SCRIPT_FAILED', error: SafeErrorText(error) };
  } finally {
    const userDataPath = join(runtimeRoot, 'user-data');
    const state = await ReadState(userDataPath);
    if (bridge) {
      const latestConnection = await BrowserConnectionEvidence(bridge, engine).catch(() => null);
      if (latestConnection) {
        summary.browser = BuildPb03PreflightEvidence({
          browserProcessRunning: latestConnection.browserProcess?.running === true,
          launchState,
          browser: { ...(summary.browser ?? {}), ...latestConnection },
        });
        summary.browserProcess = summary.browser.browserProcess;
        summary.pairPageOpened = summary.browser.pairPageOpened;
        summary.preflightNoSideEffects = summary.browser.preflightNoSideEffects;
        summary.extensionVersion = latestConnection.extension.version;
        summary.connectionGuidance = summary.connectionGuidance ?? ConnectionGuidance(latestConnection, launchState, engine);
      }
    } else {
      summary.extensionVersion = summary.browser?.extension?.version ?? null;
    }
    summary = { ...summary, events: SafeToolEvents(events), toolEvents: SafeToolEvents(events), ledger: SafeLedger(state), batchEvents: batchEvents.map((event) => ({ type: event.type, status: event.status, step: event.step, itemCount: event.itemCount })) };
    if (host) await host.Close().catch(() => undefined);
    else if (runtime) await runtime.Close().catch(() => undefined);
    if (restorePort > 0 && restorePort <= 65_535) {
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
        summary.restorePairing = launchState.preflightSucceeded !== true
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
          const token = String(JSON.parse(await readFile(bridgeStatePath, 'utf8')).token || '');
          const restore = await RestorePb03Pairing({
            ...restoreOptions,
            token,
            state: launchState,
            spawnBrowser: async (pairUrl) => {
              const browser = spawn(browserPaths[engine], [pairUrl], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
              browser.unref();
            },
          });
          summary.restorePairing = restore.performed ? 'performed' : 'skipped_' + restore.reason;
        } catch {
          // 恢复配对失败必须保留在 summary 中；不把它伪装成验收成功。
          summary.restorePairing = 'failed';
        }
      }
    }
    summary.browser = BuildPb03PreflightEvidence({
      browserProcessRunning: summary.browser?.browserProcess?.running === true,
      launchState,
      browser: summary.browser ?? {},
    });
    summary.browserProcess = summary.browser.browserProcess;
    summary.pairPageOpened = summary.browser.pairPageOpened;
    summary.preflightNoSideEffects = summary.browser.preflightNoSideEffects;
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await writeFile(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(join(artifactDir, 'summary.log'), `${HumanReadableSummary(summary)}\n`, 'utf8');
    console.log(JSON.stringify({ ...summary, artifactPath: join(artifactDir, 'summary.json') }));
  }
  if (!['passed', 'observed', 'prepared_waiting_confirmation', 'passed_pre_submit', 'observed_pre_submit_only'].includes(summary.status)) process.exitCode = 1;
}

Main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', errorCode: typeof error?.code === 'string' ? error.code : 'PB03_SCRIPT_FAILED', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
