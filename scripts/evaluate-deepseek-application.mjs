import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHost } from '../apps/backend/dist/electron/backend/agent-host.js';
import { AgentBrowserError, AgentBrowserRuntime } from '../apps/backend/dist/electron/backend/agent-browser-runtime.js';
import { StartBrowserFixture } from '../tests/fixtures/browser-site/server.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiKey = String(process.env.OFFERGET_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
if (!apiKey) throw new Error('OFFERGET_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY is required; evaluation results are never synthesized without a live credential.');
const model = String(process.env.OFFERGET_DEEPSEEK_MODEL || 'deepseek-v4-flash').trim();
const requestedRuns = Number(process.env.OFFERGET_EVALUATION_RUNS || 10);
if (!Number.isSafeInteger(requestedRuns) || requestedRuns < 1 || requestedRuns > 100) throw new Error('OFFERGET_EVALUATION_RUNS must be an integer from 1 to 100.');
const outputRoot = resolve(process.env.OFFERGET_EVALUATION_OUTPUT || join(projectRoot, 'artifacts', 'application-evaluation', new Date().toISOString().replaceAll(':', '-')));
const platformName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const companionExecutable = process.env.OFFERGET_COMPANION_EXECUTABLE || (process.platform === 'win32'
  ? join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'));
const companionAppPath = process.env.OFFERGET_COMPANION_APP_PATH ?? projectRoot;
const agentBrowserExecutable = process.env.OFFERGET_AGENT_BROWSER_EXECUTABLE || join(projectRoot, 'node_modules', 'agent-browser', 'bin', `agent-browser-${platformName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);

function CreateExactOriginNormalizer(origin) {
  const allowed = new URL(origin);
  return async value => {
    if (typeof value !== 'string') throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Fixture URL is invalid.');
    let url;
    try { url = new URL(value); } catch { throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Fixture URL is invalid.'); }
    if (url.origin !== allowed.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Only the active local fixture origin is allowed.');
    }
    url.hash = '';
    return url.toString();
  };
}

function CreateObservabilityStore() {
  const traces = new Map();
  const logs = [];
  return {
    RecordLog(level, event, detail) { logs.push({ at: new Date().toISOString(), level, event, detail: String(detail ?? '').slice(0, 2000) }); },
    StartTrace(requestId, sessionId, traceModel) { traces.set(requestId, { requestId, sessionId, model: traceModel, usage: [] }); },
    AppendTraceEvent() {},
    RecordTraceUsage(requestId, usage) { traces.get(requestId)?.usage.push(usage); },
    FinishTrace() {},
    async GetLogs() { return [...logs]; },
    async GetTraces() { return [...traces.values()]; },
    async GetTraceEvents() { return []; },
    async DeleteTraces() { return { deleted: 0 }; },
    async SetTraceRetention(value) { return { traceRetention: value }; },
    async ClearObservability() { traces.clear(); return { cleared: true }; },
    traces,
    logs,
  };
}

function SanitizeToolArguments(toolName, rawArguments) {
  let args;
  try { args = JSON.parse(rawArguments); } catch { return { invalidJson: true, rawLength: String(rawArguments ?? '').length }; }
  if (!args || typeof args !== 'object') return args;
  const sanitized = { ...args };
  if (toolName === 'BrowserFill' && typeof sanitized.text === 'string') sanitized.text = `[REDACTED_TEXT length=${sanitized.text.length}]`;
  if (toolName === 'BrowserUploadFile' && typeof sanitized.fileId === 'string') sanitized.fileId = '[AUTHORIZED_FILE_ID]';
  return sanitized;
}

function SanitizeToolResult(payload) {
  if (!payload || typeof payload !== 'object') return { valueType: typeof payload };
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const refs = data?.refs && typeof data.refs === 'object' ? data.refs : null;
  return {
    ok: payload.ok === true,
    code: typeof payload.code === 'string' ? payload.code : undefined,
    message: typeof payload.message === 'string' ? payload.message.slice(0, 500) : undefined,
    pageRevision: Number.isSafeInteger(payload.pageRevision) ? payload.pageRevision : Number.isSafeInteger(data?.pageRevision) ? data.pageRevision : undefined,
    currentUrl: typeof payload.currentUrl === 'string' ? payload.currentUrl : typeof data?.currentUrl === 'string' ? data.currentUrl : undefined,
    receipt: payload.receipt && typeof payload.receipt === 'object' ? payload.receipt : undefined,
    snapshotLength: typeof data?.snapshot === 'string' ? data.snapshot.length : undefined,
    refCount: refs ? Object.keys(refs).length : undefined,
  };
}

function ClassifyToolResult(code) {
  if (code === 'CONFIRMATION_REQUIRED') return 'expected_confirmation';
  if (code === 'SKIPPED_AFTER_WAIT') return 'scheduler_skip';
  if (code === 'BROWSER_STALE_PAGE_REF' || code === 'BROWSER_PROPOSAL_STALE') return 'stale_reference';
  if (code === 'INVALID_JSON' || code === 'INVALID_ARGUMENTS' || code === 'BROWSER_ARGUMENT_INVALID') return 'invalid_arguments';
  if (code === 'BROWSER_FILE_NOT_AUTHORIZED' || code === 'RESOURCE_NOT_AUTHORIZED') return 'resource_authorization';
  return 'tool_failure';
}

function BuildToolDiagnostics(history) {
  const calls = new Map();
  for (const message of history) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const toolName = String(call?.function?.name || 'unknown');
      calls.set(String(call?.id || ''), { toolCallId: String(call?.id || ''), toolName, arguments: SanitizeToolArguments(toolName, call?.function?.arguments) });
    }
  }
  const outcomes = [];
  for (const message of history) {
    if (message?.role !== 'tool') continue;
    const call = calls.get(String(message.tool_call_id || '')) ?? { toolCallId: String(message.tool_call_id || ''), toolName: 'unknown', arguments: null };
    let payload;
    try { payload = JSON.parse(message.content); } catch { payload = { ok: false, code: 'INVALID_TOOL_RESULT', message: 'Tool result was not valid JSON.' }; }
    const ok = payload?.ok === true;
    const code = ok ? null : String(payload?.code || 'TOOL_FAILED');
    outcomes.push({ ...call, ok, code, category: ok ? 'success' : ClassifyToolResult(code), message: ok ? null : String(payload?.message || '').slice(0, 500) });
  }
  const expectedWaits = outcomes.filter(outcome => outcome.category === 'expected_confirmation');
  const toolErrors = outcomes.filter(outcome => !outcome.ok && outcome.category !== 'expected_confirmation');
  const errorBreakdown = Object.values(toolErrors.reduce((groups, outcome) => {
    const key = `${outcome.category}:${outcome.code}:${outcome.toolName}`;
    groups[key] ??= { category: outcome.category, code: outcome.code, toolName: outcome.toolName, count: 0 };
    groups[key].count += 1;
    return groups;
  }, {})).sort((left, right) => right.count - left.count);
  return { outcomes, expectedWaits, toolErrors, errorBreakdown };
}

function BuildRunLog(history, events, observability) {
  return {
    schemaVersion: 1,
    messages: history.map(message => {
      if (message?.role === 'assistant') return {
        role: 'assistant', contentLength: String(message.content || '').length, reasoningLength: String(message.reasoning_content || '').length,
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map(call => ({ id: String(call?.id || ''), name: String(call?.function?.name || 'unknown'), arguments: SanitizeToolArguments(String(call?.function?.name || 'unknown'), call?.function?.arguments) })) : [],
      };
      if (message?.role === 'tool') {
        let result;
        try { result = JSON.parse(message.content); } catch { result = { ok: false, code: 'INVALID_TOOL_RESULT' }; }
        return { role: 'tool', toolCallId: String(message.tool_call_id || ''), result: SanitizeToolResult(result) };
      }
      return { role: String(message?.role || 'unknown'), contentLength: String(message?.content || '').length };
    }),
    events: events.filter(event => ['browser_confirmation', 'browser_action_completed', 'browser_user_action', 'waiting_confirmation', 'waiting_user_input', 'paused', 'completed', 'error'].includes(event?.type)).map(event => ({
      type: event.type, requestId: event.requestId, confirmationId: event.confirmationId, browserAction: event.browserAction,
      message: typeof event.message === 'string' ? event.message.slice(0, 1000) : undefined,
      contentLength: typeof event.content === 'string' ? event.content.length : undefined,
    })),
    observabilityLogs: observability.logs,
  };
}

async function EvaluateOnce(runIndex) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const temporaryRoot = await mkdtemp(join(tmpdir(), `offerget-deepseek-eval-${runIndex}-`));
  const fixture = await StartBrowserFixture();
  const resumePath = join(temporaryRoot, 'authorized-resume.txt');
  const fileId = `attachment://deepseek-evaluation/${runIndex}/resume.txt`;
  await writeFile(resumePath, 'OfferGet DeepSeek application evaluation resume', 'utf8');
  const events = [];
  const observability = CreateObservabilityStore();
  const runtime = new AgentBrowserRuntime({
    executablePath: agentBrowserExecutable,
    companionExecutablePath: companionExecutable,
    companionAppPath,
    runtimeRoot: join(temporaryRoot, 'browser-runtime'),
    resolveUploadFile: async value => value === fileId ? resumePath : null,
    normalizeNavigationUrl: CreateExactOriginNormalizer(fixture.origin),
  });
  const business = {
    async GetStoredSettings() { return {}; },
    async GetProfiles() { return { items: [{ name: '测试用户', email: 'candidate@example.com', phone: '13800000000' }] }; },
    async ResolveAttachmentUri(value) { return value === fileId ? resumePath : null; },
  };
  const host = new AgentHost({
    userDataPath: join(temporaryRoot, 'user-data'),
    workspacePath: temporaryRoot,
    Emit: event => events.push(event),
    business,
    observability,
    credentialPort: {
      async Load() {
        return { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model, thinkingEnabled: true, contextLimit: 64000, compressionThreshold: 80, apiKey };
      },
      async Save() { throw new Error('Evaluation must not persist credentials.'); },
    },
    browserRuntime: runtime,
  });

  let sends = 0;
  let confirmations = 0;
  let userActionRequired = false;
  let failure = null;
  let submissionObserved = false;
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      sends += 1;
      const content = attempt === 0
        ? `只操作本地测试站 ${fixture.origin}/。搜索“工程师”，选择“Agent 平台工程师”，使用已授权附件填写并提交申请。姓名测试用户，邮箱 candidate@example.com，手机号 13800000000，自我介绍为“具备 Agent 工具编排与安全验证经验。”，工作方式混合办公，所在地浙江省杭州市，职类技术，方向 Agent 工程。完成后核对页面回执。`
        : submissionObserved
          ? '提交已经发生。禁止再次填写或提交，只读取当前页面并报告投递回执。'
          : '继续当前任务；页面可能已经变化，先重新获取页面状态。';
      await host.Send({
        requestId: `deepseek-evaluation-${runIndex}-${attempt + 1}`,
        sessionId: `deepseek-evaluation-${runIndex}`,
        scenarioId: 'application',
        confirmationMode: 'fully_trusted',
        content,
        attachments: [{ name: 'authorized-resume.txt', path: fileId }],
      });

      const pending = events.filter(event => event?.type === 'browser_confirmation' && !event.__evaluationHandled);
      for (const event of pending) {
        event.__evaluationHandled = true;
        confirmations += 1;
        const outcome = await host.ConfirmBrowserAction(event.confirmationId, true);
        if (outcome.status !== 'succeeded') throw new Error(`Confirmation ${event.browserAction?.toolName || 'unknown'} ended as ${outcome.status}.`);
      }
      userActionRequired ||= events.some(event => event?.type === 'browser_user_action');
      if (userActionRequired) throw new Error('Fixture unexpectedly required login or CAPTCHA takeover.');
      const state = fixture.getState();
      const completed = [...events].reverse().find(event => event?.type === 'completed' && typeof event.content === 'string');
      if (state.submissionCount === 1 && submissionObserved) break;
      if (state.submissionCount === 1) submissionObserved = true;
      if (state.submissionCount === 1 && completed?.content?.includes(state.receipt)) break;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const state = fixture.getState();
  const history = host.histories?.get?.(`deepseek-evaluation-${runIndex}`) ?? [];
  const toolMessages = history.filter(message => message?.role === 'tool');
  const diagnostics = BuildToolDiagnostics(history);
  const completed = [...events].reverse().find(event => event?.type === 'completed' && typeof event.content === 'string');
  const modelTurns = history.filter(message => message?.role === 'assistant').length;
  const usage = [...observability.traces.values()].flatMap(trace => trace.usage);
  const result = {
    schemaVersion: 2,
    provider: 'DeepSeek',
    model,
    runIndex,
    startedAt,
    durationMs: Date.now() - startedMs,
    success: !failure && state.submissionCount === 1 && state.receipt === 'LOCAL-APPLICATION-0001',
    sends,
    modelTurns,
    toolCalls: toolMessages.length,
    toolErrors: diagnostics.toolErrors,
    expectedConfirmationWaits: diagnostics.expectedWaits.length,
    errorBreakdown: diagnostics.errorBreakdown,
    confirmations,
    userActionRequired,
    submissionCount: state.submissionCount,
    receipt: state.receipt,
    finalContent: typeof completed?.content === 'string' ? completed.content.slice(0, 1000) : null,
    usage,
    failure,
  };
  const runLog = BuildRunLog(history, events, observability);
  await host.Close().catch(() => undefined);
  await fixture.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return { result, runLog };
}

await mkdir(outputRoot, { recursive: true });
const logPath = join(outputRoot, 'evaluation.log');
async function WriteEvaluationLog(event, detail) {
  await appendFile(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`, 'utf8');
}
await WriteEvaluationLog('evaluation_started', { schemaVersion: 2, provider: 'DeepSeek', model, requestedRuns });
const results = [];
for (let runIndex = 1; runIndex <= requestedRuns; runIndex += 1) {
  await WriteEvaluationLog('run_started', { runIndex });
  let evaluated;
  try {
    evaluated = await EvaluateOnce(runIndex);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    await WriteEvaluationLog('run_crashed', { runIndex, failure });
    console.error(JSON.stringify({ runIndex, success: false, crashed: true, failure }));
    process.exitCode = 1;
    break;
  }
  const { result, runLog } = evaluated;
  results.push(result);
  await writeFile(join(outputRoot, `run-${String(runIndex).padStart(2, '0')}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(join(outputRoot, `run-${String(runIndex).padStart(2, '0')}-log.json`), `${JSON.stringify(runLog, null, 2)}\n`, 'utf8');
  const line = { runIndex, success: result.success, modelTurns: result.modelTurns, toolErrors: result.toolErrors.length, expectedConfirmationWaits: result.expectedConfirmationWaits, durationMs: result.durationMs };
  await WriteEvaluationLog('run_completed', line);
  console.log(JSON.stringify(line));
}
const successfulRuns = results.filter(result => result.success).length;
const summary = {
  schemaVersion: 2,
  provider: 'DeepSeek',
  model,
  requestedRuns,
  completedRuns: results.length,
  successfulRuns,
  completionRate: results.length ? successfulRuns / results.length : 0,
  totalToolErrors: results.reduce((total, result) => total + result.toolErrors.length, 0),
  totalExpectedConfirmationWaits: results.reduce((total, result) => total + result.expectedConfirmationWaits, 0),
  errorBreakdown: Object.values(results.flatMap(result => result.toolErrors).reduce((groups, outcome) => {
    const key = `${outcome.category}:${outcome.code}:${outcome.toolName}`;
    groups[key] ??= { category: outcome.category, code: outcome.code, toolName: outcome.toolName, count: 0 };
    groups[key].count += 1;
    return groups;
  }, {})).sort((left, right) => right.count - left.count),
  averageModelTurns: results.length ? results.reduce((total, result) => total + result.modelTurns, 0) / results.length : 0,
  generatedAt: new Date().toISOString(),
};
await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
await WriteEvaluationLog('evaluation_completed', summary);
console.log(JSON.stringify({ ...summary, outputRoot }));
if (results.length !== requestedRuns || successfulRuns !== results.length) process.exitCode = 1;
