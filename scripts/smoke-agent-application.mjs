import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHost } from '../apps/backend/dist/electron/backend/agent-host.js';
import { AgentBrowserError, AgentBrowserRuntime } from '../apps/backend/dist/electron/backend/agent-browser-runtime.js';
import { CreateDefaultModules } from '../packages/agent-modules-defaults/dist/index.js';
import { StartBrowserFixture } from '../tests/fixtures/browser-site/server.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const electronExecutable = process.env.OFFERGET_COMPANION_EXECUTABLE || (process.platform === 'win32'
  ? join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'));
const companionAppPath = process.env.OFFERGET_COMPANION_APP_PATH ?? projectRoot;
const agentBrowserExecutable = process.env.OFFERGET_AGENT_BROWSER_EXECUTABLE || join(projectRoot, 'node_modules', 'agent-browser', 'bin', `agent-browser-${platformName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);

function Assert(condition, message) { if (!condition) throw new Error(message); }
function ToolCall(index, name, args) { return { id: `application-e2e-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }

/** 测试策略只放行本次随机 fixture origin；它不能由产品配置或环境变量启用。 */
function CreateExactOriginNormalizer(origin) {
  const allowed = new URL(origin);
  return async (value) => {
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

function CreateScriptedProvider(origin, fileId) {
  let step = 0;
  let attempt = 0;
  let latestSnapshot = null;
  const expectedTools = new Set([
    'Read','Glob','Grep','ReadProfile','ReadResume','CreateTodo','UpdateTodo','ReadTodo','AskUserQuestion',
    'BrowserNavigate','BrowserSnapshot','BrowserReadPage','BrowserClick','BrowserFill','BrowserFillForm','BrowserSelect','BrowserSetChecked','BrowserPressKey','BrowserUploadFile','BrowserWait','BrowserSwitchTab','BrowserGoBack',
  ]);
  const forbidden = new Set(['UpdateProfile','CreateResume','UpdateResume','SearchJobs','ReadUrl']);

  function CaptureSnapshot(history) {
    const toolMessages = history.filter(message => message.role === 'tool');
    for (let index = toolMessages.length - 1; index >= 0; index -= 1) {
      try {
        const payload = JSON.parse(toolMessages[index].content);
        if (payload?.ok === true && payload?.data?.refs && Number.isSafeInteger(payload.data.pageRevision)) {
          latestSnapshot = { refs: payload.data.refs, pageRevision: payload.data.pageRevision, text: String(payload.data.snapshot || ''), data: payload.data };
          return;
        }
      } catch { /* 非 JSON 工具结果不是 Snapshot，继续向前查找。 */ }
    }
  }
  function Ref(pattern) {
    Assert(latestSnapshot, `step ${step} requires a browser snapshot`);
    for (const [ref, metadata] of Object.entries(latestSnapshot.refs)) {
      if (pattern.test(JSON.stringify(metadata))) return ref.startsWith('@') ? ref : `@${ref}`;
    }
    throw new Error(`step ${step} could not find element ${pattern} in ${JSON.stringify(latestSnapshot.data).slice(0, 4000)}`);
  }
  function Action(name, args = {}) { const call = ToolCall(`${attempt}-${step}`, name, args); step += 1; return { content: '', toolCalls: [call] }; }

  return {
    packageName: 'offerget.application-e2e', name: 'scripted-provider', version: '0.1.0', sdkVersion: '0.1.0', slot: 'model-provider', capabilities: ['model:scripted-test'],
    Configure: async () => ({ configured: true, provider: 'Scripted', model: 'application-e2e' }),
    TestConnection: async () => ({ connected: true, provider: 'Scripted', baseUrl: origin }),
    GetBalance: async () => ({ available: false, balances: [] }), GetModels: async () => ({ models: ['application-e2e'] }),
    GetStatus: async () => ({ configured: true, provider: 'Scripted', model: 'application-e2e' }),
    ResolveRequestModel: () => 'application-e2e', BaseUrl: () => origin,
    GetRuntimeLimits: () => ({ contextLimit: 128000, threshold: 70 }), EstimateTokens: value => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4)),
    CreateSummary: async () => ({ content: 'application e2e summary' }),
    StreamCompletion: async ({ history, tools, onDelta }) => {
      const names = tools.map(tool => tool.definition.function.name);
      Assert(names.length === expectedTools.size && names.every(name => expectedTools.has(name)), `application tool whitelist mismatch: ${names.join(',')}`);
      Assert(!names.some(name => forbidden.has(name)), 'application scenario exposed a forbidden write/network shortcut tool');
      const lastToolMessage = [...history].reverse().find(message => message.role === 'tool');
      if (lastToolMessage) {
        const lastPayload = JSON.parse(lastToolMessage.content);
        Assert(lastPayload?.ok === true || lastPayload?.code === 'CONFIRMATION_REQUIRED', `step ${step} received failed tool result: ${lastToolMessage.content}`);
      }
      CaptureSnapshot(history);
      switch (step) {
        case 0: return Action('BrowserNavigate', { url: `${origin}/` });
        case 1: return Action('BrowserSnapshot');
        case 2: return Action('BrowserFill', { ref: Ref(/岗位关键词/), pageRevision: latestSnapshot.pageRevision, text: '工程师' });
        case 3: return Action('BrowserClick', { ref: Ref(/"name":"搜索岗位","role":"button"/), pageRevision: latestSnapshot.pageRevision });
        case 4: {
          const wait = ToolCall(`${attempt}-4-wait`, 'BrowserWait', { kind: 'text', value: '找到 3 个岗位' });
          const snapshot = ToolCall(`${attempt}-4-snapshot`, 'BrowserSnapshot', {});
          step = 5;
          return { content: '', toolCalls: [wait, snapshot] };
        }
        case 5: return Action('BrowserClick', { ref: Ref(/查看 Agent 平台工程师 JD/), pageRevision: latestSnapshot.pageRevision });
        case 6: return Action('BrowserSnapshot');
        case 7: return Action('BrowserClick', { ref: Ref(/申请这个岗位/), pageRevision: latestSnapshot.pageRevision });
        case 8: return Action('BrowserSnapshot');
        case 9: return Action('BrowserFillForm', {
          pageRevision: latestSnapshot.pageRevision,
          fields: [
            { ref: Ref(/姓名/), text: '测试用户' },
            { ref: Ref(/邮箱/), text: 'candidate@example.com' },
            { ref: Ref(/手机号/), text: '13800000000' },
            { ref: Ref(/自我介绍/), text: '具备 Agent 工具编排与安全验证经验。' },
          ],
        });
        case 10: return Action('BrowserSelect', { ref: Ref(/工作方式/), pageRevision: latestSnapshot.pageRevision, value: 'hybrid' });
        case 11: return Action('BrowserSnapshot');
        case 12: return Action('BrowserSelect', { ref: Ref(/省份|直辖市/), pageRevision: latestSnapshot.pageRevision, value: '浙江' });
        case 13: return Action('BrowserSnapshot');
        case 14: return Action('BrowserSelect', { ref: Ref(/城市/), pageRevision: latestSnapshot.pageRevision, value: '杭州' });
        case 15: return Action('BrowserSnapshot');
        case 16: return Action('BrowserSelect', { ref: Ref(/职类/), pageRevision: latestSnapshot.pageRevision, value: '技术' });
        case 17: return Action('BrowserSnapshot');
        case 18: return Action('BrowserSelect', { ref: Ref(/具体方向/), pageRevision: latestSnapshot.pageRevision, value: 'Agent 工程' });
        case 19: return Action('BrowserSnapshot');
        case 20: return Action('BrowserUploadFile', { ref: Ref(/简历文件/), pageRevision: latestSnapshot.pageRevision, fileId });
        case 21: return Action('BrowserSnapshot');
        case 22: return Action('BrowserSetChecked', { ref: Ref(/同意申请条款/), pageRevision: latestSnapshot.pageRevision, checked: true });
        case 23: return Action('BrowserSnapshot');
        case 24: return Action('BrowserClick', { ref: Ref(/提交申请/), pageRevision: latestSnapshot.pageRevision });
        case 25: return Action('BrowserSnapshot');
        case 26: return Action('BrowserReadPage');
        default: {
          const content = '已根据投递回执完成 Agent 平台工程师的申请。'; onDelta({ reasoning: '', content }); step += 1; return { content, toolCalls: [] };
        }
      }
    },
    getStep: () => step,
    setStep: value => { attempt += 1; step = value; latestSnapshot = null; },
  };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'offerget-agent-application-e2e-'));
const fixture = await StartBrowserFixture();
const resumePath = join(temporaryRoot, 'authorized-resume.txt');
const fileId = 'attachment://application-e2e/resume.txt';
await writeFile(resumePath, 'OfferGet application E2E resume', 'utf8');
const events = [];
const scriptedProvider = CreateScriptedProvider(fixture.origin, fileId);
const browserRuntime = new AgentBrowserRuntime({
  executablePath: agentBrowserExecutable, companionExecutablePath: electronExecutable, companionAppPath,
  runtimeRoot: join(temporaryRoot, 'browser-runtime'), resolveUploadFile: async value => value === fileId ? resumePath : null,
  normalizeNavigationUrl: CreateExactOriginNormalizer(fixture.origin),
});
const emptyObservability = { RecordLog(){}, StartTrace(){}, AppendTraceEvent(){}, RecordTraceUsage(){}, FinishTrace(){}, async GetLogs(){return[]}, async GetTraces(){return[]}, async GetTraceEvents(){return[]}, async DeleteTraces(){return{deleted:0}}, async SetTraceRetention(value){return{traceRetention:value}}, async ClearObservability(){return{cleared:true}} };
const business = {
  async GetStoredSettings(){return{}}, async GetProfiles(){return{items:[{name:'测试用户',email:'candidate@example.com',phone:'13800000000'}]}},
  async ResolveAttachmentUri(value){return value === fileId ? resumePath : null},
};
const host = new AgentHost({
  userDataPath: join(temporaryRoot, 'user-data'), workspacePath: temporaryRoot, Emit: event => events.push(event), business,
  observability: emptyObservability, credentialPort: { async Load(){return null}, async Save(){} }, browserRuntime,
  createDefaultModules: ports => ({ ...CreateDefaultModules(ports), modelProvider: scriptedProvider }),
});

try {
  const Send = async (index, content) => host.Send({ requestId: `application-run-${index}`, sessionId: 'application-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content, attachments: [{ name: 'authorized-resume.txt', path: fileId }] });
  const ConfirmLatest = async (toolName, accepted = true) => {
    const event = [...events].reverse().find(value => value?.type === 'browser_confirmation' && value?.browserAction?.toolName === toolName && !value.__handled);
    Assert(event, `missing ${toolName} confirmation event`); event.__handled = true;
    const before = fixture.getState().submissionCount;
    const result = await host.ConfirmBrowserAction(event.confirmationId, accepted);
    if (accepted) Assert(result.status === 'succeeded' && result.receipt, `${toolName} confirmation did not produce a receipt`);
    else Assert(result.status === 'rejected' && !result.receipt, `${toolName} rejection produced an external-action receipt`);
    if (toolName !== 'BrowserClick') Assert(fixture.getState().submissionCount === before, `${toolName} changed final submission state`);
  };

  await Send(1, '搜索工程师岗位，选择 Agent 平台工程师并完成投递。');
  Assert(fixture.getState().submissionCount === 0, 'application changed before upload confirmation');
  await ConfirmLatest('BrowserUploadFile', false);
  scriptedProvider.setStep(19);
  await Send(2, '重新准备上传并继续任务');
  await ConfirmLatest('BrowserUploadFile', true);
  await Send(3, '继续任务');
  await ConfirmLatest('BrowserSetChecked', false);
  scriptedProvider.setStep(21);
  await Send(4, '重新准备协议确认并继续任务');
  await ConfirmLatest('BrowserSetChecked', true);
  await Send(5, '继续任务');
  Assert(fixture.getState().submissionCount === 0, 'application submitted before final confirmation');
  await ConfirmLatest('BrowserClick', false);
  Assert(fixture.getState().submissionCount === 0, 'rejected final submission changed the fixture state');
  scriptedProvider.setStep(23);
  await Send(6, '重新准备最终提交并继续任务');
  await ConfirmLatest('BrowserClick', true);
  await Send(7, '继续任务并核对投递回执');

  const state = fixture.getState();
  Assert(state.submissionCount === 1, `expected one application, received ${state.submissionCount}`);
  Assert(state.receipt === 'LOCAL-APPLICATION-0001', 'application receipt mismatch');
  Assert(state.submission?.jobId === 'agent-platform', 'Agent selected the wrong job');
  Assert(state.submission?.workMode === 'hybrid' && state.submission?.province === '浙江' && state.submission?.city === '杭州', 'ordinary/location selections were not persisted');
  Assert(state.submission?.jobFamily === '技术' && state.submission?.jobTrack === 'Agent 工程', 'cascading job selections were not persisted');
  Assert(state.submission?.resumeName === 'authorized-resume.txt' && state.submission?.terms === true, 'upload or agreement was not persisted');
  Assert(scriptedProvider.getStep() >= 28, 'scripted provider did not reach receipt-based final response');
  console.log(JSON.stringify({ passed: true, entry: 'AgentHost.Send', jobs: 6, ordinarySelect: true, cascadingSelects: 2, confirmations: 6, rejectedConfirmations: 3, submissionCount: state.submissionCount, receipt: state.receipt }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, message: error instanceof Error ? error.message : String(error), providerStep: scriptedProvider.getStep(), fixtureState: fixture.getState(), recentHistory: host.histories?.get?.('application-session')?.slice?.(-4), recentEvents: events.slice(-12) }));
  throw error;
} finally {
  await host.Close().catch(() => undefined);
  await fixture.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
