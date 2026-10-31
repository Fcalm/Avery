import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserRuntime } from '../../../apps/backend/src/electron/backend/agent-browser-runtime';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { BrowserExtensionProtocolRevision } from '../../../apps/backend/src/electron/backend/browser-extension-bridge';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src/index';
import { ParseExpectedToolResult, VerifyNavigationEvidence } from '../../../scripts/fixtures/pb03-tool-result.mjs';

const temporaryRoots: string[] = [];
const fixtureServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(fixtureServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ToolCall(id: string, name: string, args: Record<string, unknown>) {
  return { content: '', toolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] };
}

type MockTarget = {
  targetId: string;
  tabId: number;
  windowId: number;
  openerTabId: number | null;
  type: 'page';
  url: string;
  title: string;
  active: boolean;
  attached: boolean;
  readyState: 'complete';
};

function CreateMockExtensionBridge(bridgeOptions: { emptySnapshotTargetId?: string; snapshotItems?: Array<Record<string, unknown>>; initialInputValue?: string; fillFailure?: 'focus' | 'clear' | 'insert' } = {}) {
  const targetsByTask = new Map<string, MockTarget[]>();
  const userTargets: MockTarget[] = [{
    targetId: 'user-original-tab', tabId: 901, windowId: 1, openerTabId: null, type: 'page', url: 'http://127.0.0.1/user', title: 'user tab',
    active: true, attached: false, readyState: 'complete',
  }];
  const protocolMethods: string[] = [];
  let nextTarget = 1;
  let fixtureResponses = 0;
  let snapshotEvaluations = 0;
  let uploadedFilePath: string | null = null;
  const inputStates = new WeakMap<MockTarget, { locatedNodeId?: number; focusedNodeId?: number; selectedAll: boolean; values: Map<number, string> }>();
  const fillStateChecks: Array<{ targetId: string; nodeId: number; expectedValue?: string; actualValue: string; valid: boolean }> = [];
  // 测试桩必须模拟焦点、清空和插入产生的状态变化，不能用固定成功回执绕过生产填写校验。
  const inputState = (target: MockTarget) => {
    let state = inputStates.get(target);
    if (!state) {
      state = { selectedAll: false, values: new Map((bridgeOptions.snapshotItems ?? [{}]).map((_item, index) => [index + 1, bridgeOptions.initialInputValue ?? ''])) };
      inputStates.set(target, state);
    }
    return state;
  };
  const getTargets = (taskId: string) => {
    let targets = targetsByTask.get(taskId);
    if (!targets) {
      targets = [];
      targetsByTask.set(taskId, targets);
    }
    return targets;
  };
  const fetchFixture = async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1') throw new Error('The mock extension only permits the explicit loopback fixture host.');
    const response = await fetch(url);
    if (!response.ok) throw Object.assign(new Error(`Fixture request failed with HTTP ${response.status}.`), { code: 'BROWSER_COMMAND_FAILED' });
    fixtureResponses += 1;
    return await response.text();
  };
  const request = vi.fn(async (_engine: string, operation: string, payload: any, requestOptions: any) => {
    if (operation !== 'cdp') throw new Error(`Unexpected mock extension operation: ${operation}.`);
    const taskId = requestOptions?.browserTaskId;
    if (typeof taskId !== 'string' || !taskId) throw new Error('Mock Bridge request did not carry browserTaskId.');
    const { id, method, params = {} } = payload ?? {};
    protocolMethods.push(String(method));
    const targets = getTargets(taskId);
    let result: Record<string, unknown>;
    switch (method) {
      case 'Target.getTargets':
        result = { targetInfos: targets.map((target) => ({ ...target })) };
        break;
      case 'Target.createTarget': {
        const url = String(params.url ?? '');
        await fetchFixture(url);
        const target: MockTarget = {
          targetId: `pb03-target-${nextTarget++}`, tabId: 900 + nextTarget, windowId: 1, openerTabId: null, type: 'page', url, title: 'PB-03 local fixture',
          active: true, attached: false, readyState: 'complete',
        };
        targets.push(target);
        result = { targetId: target.targetId };
        break;
      }
      case 'Target.attachToTarget': {
        const target = targets.find((item) => item.targetId === params.targetId);
        if (!target) throw Object.assign(new Error('Task-owned target was not found.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        target.attached = true;
        result = { sessionId: `pb03-session-${target.targetId}` };
        break;
      }
      case 'Target.activateTarget': {
        for (const target of targets) target.active = target.targetId === params.targetId;
        result = {};
        break;
      }
      case 'Target.getTargetInfo': {
        const target = targets.find((item) => item.targetId === params.targetId);
        if (!target) throw Object.assign(new Error('Task-owned target was not found.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        result = { targetInfo: { ...target } };
        break;
      }
      case 'Page.navigate': {
        const target = targets.find((item) => item.active) ?? targets.find((item) => item.attached);
        if (!target) throw Object.assign(new Error('No task-owned attached target.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        const url = String(params.url ?? '');
        await fetchFixture(url);
        inputStates.delete(target);
        target.url = url;
        result = { frameId: `frame-${target.targetId}` };
        break;
      }
      case 'Runtime.evaluate': {
        const target = targets.find((item) => item.active) ?? targets.find((item) => item.attached);
        if (!target) throw Object.assign(new Error('No task-owned attached target.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        const expression = String(params.expression ?? '');
        if (expression.includes('const expectedFillValue =')) {
          const expected = JSON.parse(expression.match(/const expected = (.+);/)![1]) as { nodeId: number };
          const encodedValue = expression.match(/const expectedFillValue = (.+);/)![1];
          const expectedValue: string | undefined = encodedValue === 'undefined' ? undefined : JSON.parse(encodedValue);
          const state = inputState(target);
          const actualValue = state.values.get(expected.nodeId) ?? '';
          const item = bridgeOptions.snapshotItems?.[expected.nodeId - 1];
          const valid = state.focusedNodeId === expected.nodeId && item?.disabled !== true && item?.readOnly !== true
            && (expectedValue === undefined || actualValue === expectedValue);
          fillStateChecks.push({ targetId: target.targetId, nodeId: expected.nodeId, expectedValue, actualValue, valid });
          result = { result: { type: 'object', value: { fillStateValid: valid } } };
        } else if (expression.includes('querySelectorAll')) {
          snapshotEvaluations += 1;
          if (bridgeOptions.emptySnapshotTargetId && target.targetId === bridgeOptions.emptySnapshotTargetId) {
            // This branch models a genuinely loading child.  A static
            // complete page with no controls is covered separately and must
            // succeed with an empty Snapshot.
            result = { result: { type: 'object', value: { url: target.url, title: target.title, readyState: 'loading', truncated: false, items: [] } } };
            break;
          }
          result = { result: { type: 'object', value: {
            url: target.url, title: target.title, readyState: target.readyState, truncated: false,
            items: (bridgeOptions.snapshotItems ?? [{ selector: '#fixture-name', tag: 'input', role: 'textbox', type: 'text', name: 'fixture name', ariaLabel: '姓名' }]).map((item, index) => ({ ...item, nodeId: index + 1 })),
          } } };
        } else if (expression.includes('const expected =') && expression.includes('readyState')) {
          result = { result: { type: 'object', value: { matched: true, fingerprint: 'fixture-ready', readyState: target.readyState } } };
        } else if (expression.includes('document.readyState')) {
          result = { result: { type: 'object', value: { url: target.url, readyState: target.readyState } } };
        } else if (expression.includes('elementFromPoint')) {
          const expected = JSON.parse(expression.match(/const expected = (.+);/)![1]) as { nodeId: number };
          inputState(target).locatedNodeId = expected.nodeId;
          result = { result: { type: 'object', value: { stale: false, x: 100, y: 60, tag: 'input', type: 'text', disabled: false, contentEditable: false } } };
        } else if (expression.includes("element.type !== 'file'")) {
          result = { result: { type: 'object', objectId: 'pb03-file-input' } };
        } else {
          result = { result: { type: 'object', value: { installed: true, url: target.url, readyState: target.readyState } } };
        }
        break;
      }
      case 'Page.getFrameTree': {
        const target = targets.find((item) => item.active) ?? targets.find((item) => item.attached)!;
        result = { frameTree: { frame: { id: `frame-${target.targetId}`, loaderId: target.url } } };
        break;
      }
      case 'Page.createIsolatedWorld': result = { executionContextId: 1 }; break;
      case 'Input.dispatchMouseEvent':
      case 'Input.dispatchKeyEvent':
      case 'Input.insertText': {
        const target = targets.find(item => item.active) ?? targets.find(item => item.attached);
        if (!target) throw new Error('Input event has no task-owned target.');
        const state = inputState(target);
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
          state.focusedNodeId = bridgeOptions.fillFailure === 'focus' ? undefined : state.locatedNodeId; state.selectedAll = false;
        }
        if (state.focusedNodeId !== undefined) {
          if (method === 'Input.dispatchKeyEvent' && params.commands?.includes('selectAll')) state.selectedAll = true;
          if (method === 'Input.dispatchKeyEvent' && params.commands?.includes('deleteBackward') && state.selectedAll && bridgeOptions.fillFailure !== 'clear') {
            state.values.set(state.focusedNodeId, ''); state.selectedAll = false;
          }
          if (method === 'Input.insertText' && bridgeOptions.fillFailure !== 'insert') state.values.set(state.focusedNodeId, (state.values.get(state.focusedNodeId) ?? '') + String(params.text ?? ''));
        }
        result = {};
        break;
      }
      case 'DOM.setFileInputFiles':
        uploadedFilePath = Array.isArray(params.files) && typeof params.files[0] === 'string' ? params.files[0] : null;
        result = {};
        break;
      case 'Runtime.releaseObject':
        result = {};
        break;
      default:
        throw new Error(`Unexpected CDP method in mock extension: ${String(method)}.`);
    }
    return { id, result };
  });
  const closeTask = vi.fn(async (_engine: string, browserTaskId: string) => {
    const closedTabs = getTargets(browserTaskId).length;
    targetsByTask.delete(browserTaskId);
    return { status: 'confirmed', browserTaskId, closed: true, closedTabs, unknownTabs: 0 };
  });
  return {
    Start: vi.fn(async () => undefined),
    EnsureConnected: vi.fn(async () => undefined),
    IsConnected: vi.fn(() => true),
    Status: vi.fn(() => ({
      connected: true,
      state: 'online' as const,
      version: '0.2.0',
      protocolRevision: BrowserExtensionProtocolRevision,
      actualProtocolRevision: BrowserExtensionProtocolRevision,
      expectedProtocolRevision: BrowserExtensionProtocolRevision,
      port: 17653,
    })),
    Request: request,
    CloseTask: closeTask,
    Close: vi.fn(async () => undefined),
    GetTaskTargets: getTargets,
    GetUserTargets: () => userTargets,
    GetProtocolMethods: () => [...protocolMethods],
    GetSnapshotEvaluationCount: () => snapshotEvaluations,
    GetUploadedFilePath: () => uploadedFilePath,
    GetFixtureResponseCount: () => fixtureResponses,
    GetFillStateChecks: () => [...fillStateChecks],
    GetInputValue: (targetId: string, nodeId: number) => {
      const target = [...targetsByTask.values()].flat().find(item => item.targetId === targetId);
      return target ? inputState(target).values.get(nodeId) : undefined;
    },
  };
}

function CreateScriptedProvider(url: string, runtime: AgentBrowserRuntime, bridge: ReturnType<typeof CreateMockExtensionBridge>, observation: Record<string, any>, duplicateNavigateResult = false) {
  let phase = 0;
  let pendingCallId: string | null = null;
  const provider = {
    packageName: 'avery.pb03-navigation-test', name: 'pb03-navigation-scripted', version: '0.2.0', sdkVersion: '0.1.0', slot: 'model-provider' as const, capabilities: ['model:scripted-test'],
    Configure: vi.fn(), TestConnection: vi.fn(), GetBalance: vi.fn(), GetModels: vi.fn(),
    GetStatus: vi.fn(async () => ({ configured: true, provider: 'Test', model: 'pb03-navigation' })),
    ResolveRequestModel: vi.fn(() => 'pb03-navigation'), BaseUrl: vi.fn(() => 'http://127.0.0.1/pb03-navigation'),
    GetRuntimeLimits: vi.fn(() => ({ contextLimit: 128_000, threshold: 70 })), EstimateTokens: vi.fn(() => 10),
    CreateSummary: vi.fn(async () => ({ content: 'summary' })),
    StreamCompletion: vi.fn(async ({ history, onDelta }: any) => {
      observation.providerTurns += 1;
      const finish = (content: string) => { onDelta?.({ reasoning: '', content }); return { content, toolCalls: [] }; };
      if (phase === 0) {
        phase = 1;
        pendingCallId = 'pb03-nav-tool-call';
        (observation.toolCalls ??= []).push('BrowserNavigate');
        return ToolCall(pendingCallId, 'BrowserNavigate', { url });
      }
      if (phase === 1) {
        if (!pendingCallId) throw new Error('Navigate phase lost its tool call identity.');
        const resultHistory = duplicateNavigateResult
          ? [...history, ...history.filter((item: any) => item?.role === 'tool' && item.tool_call_id === pendingCallId)]
          : history;
        const result = ParseExpectedToolResult(resultHistory, pendingCallId);
        observation.navigationToolResult = result;
        if (result.ok !== true) {
          observation.navigationEvidence = VerifyNavigationEvidence({ result, taskTargets: [], expectedUrl: url, readyState: null });
          phase = 3;
          return finish(`Fixture navigation failed [${result.code}]: ${result.message}`);
        }
        const browserTaskId = runtime.GetBrowserTaskId();
        const targets = browserTaskId ? bridge.GetTaskTargets(browserTaskId) : [];
        const evidence = VerifyNavigationEvidence({
          result,
          taskTargets: targets,
          expectedUrl: url,
          readyState: targets.find((target) => target.url === url)?.readyState,
        });
        observation.navigationEvidence = evidence;
        if (!evidence.ok) {
          phase = 3;
          return finish(`Fixture navigation evidence failed [${evidence.code}]: ${evidence.message}`);
        }
        phase = 2;
        pendingCallId = 'pb03-snapshot-tool-call';
        (observation.toolCalls ??= []).push('BrowserSnapshot');
        return ToolCall(pendingCallId, 'BrowserSnapshot', {});
      }
      if (phase === 2) {
        if (!pendingCallId) throw new Error('Snapshot phase lost its tool call identity.');
        const snapshot = ParseExpectedToolResult(history, pendingCallId);
        observation.snapshotToolResult = snapshot;
        phase = 3;
        return finish('Fixture navigation was verified; continuing into BrowserSnapshot succeeded.');
      }
      return finish('Fixture navigation flow finished.');
    }),
    GetCallCount: () => provider.StreamCompletion.mock.calls.length,
  };
  return provider;
}

async function CreateFixtureServer(status = 200) {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(status === 200 ? '<!doctype html><title>PB-03 synthetic fixture</title><main id="fixture-name">Local synthetic fixture</main>' : 'fixture unavailable');
  });
  fixtureServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The loopback fixture server did not bind a TCP port.');
  return { server, url: `http://127.0.0.1:${address.port}/application`, getRequestCount: () => requestCount };
}

async function CreateHostHarness(url: string, bridge: ReturnType<typeof CreateMockExtensionBridge>, observation: Record<string, any>, duplicateNavigateResult = false, runtimeOptions: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avery-pb03-navigation-flow-'));
  temporaryRoots.push(root);
  const events: any[] = [];
  const observability = {
    RecordLog: vi.fn(), StartTrace: vi.fn(), AppendTraceEvent: vi.fn(), RecordTraceUsage: vi.fn(), FinishTrace: vi.fn(),
    GetLogs: vi.fn(async () => []), GetTraces: vi.fn(async () => []), GetTraceEvents: vi.fn(async () => []), DeleteTraces: vi.fn(async () => ({ deleted: 0 })),
    SetTraceRetention: vi.fn(async (value: number) => ({ traceRetention: value })), ClearObservability: vi.fn(async () => ({ cleared: true })),
  };
  const business = {
    GetStoredSettings: vi.fn(async () => ({ browserEngine: 'chrome' })), GetProfiles: vi.fn(async () => ({ items: [] })), ResolveAttachmentUri: vi.fn(async () => null),
    ResolveAttachmentMarkdownUri: vi.fn(async () => null), LoadViewModel: vi.fn(async () => ({ browserEngine: 'chrome', resumes: [], jobs: [], applications: [] })),
    SaveTrackedJob: vi.fn(async (input: any) => ({ jobId: String(input.jobId ?? input.id ?? ''), jobRevision: 1 })),
  };
  const runtime = new AgentBrowserRuntime({
    executablePath: process.execPath,
    companionExecutablePath: process.execPath,
    runtimeRoot: join(root, 'browser-runtime'),
    externalBrowserPaths: { chrome: process.execPath },
    browserExtensionBridge: bridge as any,
    resolveUploadFile: vi.fn(async () => null),
    ...runtimeOptions,
  });
  await runtime.SetEngine('chrome');
  const provider = CreateScriptedProvider(url, runtime, bridge, observation, duplicateNavigateResult);
  const host = new AgentHost({
    userDataPath: join(root, 'user-data'), workspacePath: root, Emit: (event) => events.push(event), browserRuntime: runtime,
    business, observability, credentialPort: { Load: vi.fn(async () => null), Save: vi.fn() },
    createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }),
  });
  return { host, runtime, events, business, root, url, provider };
}

describe('PB-03 fixture BrowserNavigate result handling', () => {
  it('continues the real AgentHost provider loop after a task-owned loopback navigation', async () => {
    const fixture = await CreateFixtureServer();
    const bridge = CreateMockExtensionBridge();
    const observation: Record<string, any> = { providerTurns: 0 };
    const harness = await CreateHostHarness(fixture.url, bridge, observation);

    try {
      const result = await harness.host.Send({ requestId: 'pb03-navigation-success', sessionId: 'pb03-navigation-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Open the local synthetic fixture and then inspect it.' });
      expect(result.accepted).toBe(true);
      expect(observation.providerTurns).toBe(3);
      expect(observation.navigationToolResult).toMatchObject({ ok: true, data: { currentUrl: fixture.url }, toolCallId: 'pb03-nav-tool-call' });
      expect(observation.navigationEvidence).toMatchObject({ ok: true, finalUrl: fixture.url, readyState: 'complete' });
      expect(observation.snapshotToolResult).toMatchObject({ ok: true, data: { currentUrl: fixture.url } });
      expect(observation.toolCalls).toEqual(['BrowserNavigate', 'BrowserSnapshot']);
      expect(fixture.getRequestCount()).toBeGreaterThan(0);
      expect(bridge.GetFixtureResponseCount()).toBeGreaterThan(0);
      expect(bridge.GetProtocolMethods()).toContain('Target.createTarget');
      expect(bridge.GetProtocolMethods()).toContain('Target.getTargets');
      expect(bridge.GetProtocolMethods()).toContain('Runtime.evaluate');
      expect(bridge.CloseTask).toHaveBeenCalledOnce();
      expect(harness.events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'pb03-navigation-success', content: expect.stringContaining('BrowserSnapshot succeeded') }));
      expect(harness.events).toContainEqual(expect.objectContaining({ type: 'run_released', requestId: 'pb03-navigation-success', cleanupOutcomes: [expect.objectContaining({ status: 'confirmed', closedTabs: 1 })] }));
    } finally {
      await harness.host.Close();
    }
  });

  it.each([
    { failure: undefined, validChecks: [true, true, true], expectedValue: '新填写内容' },
    { failure: 'focus', validChecks: [false], expectedValue: '原有内容' },
    { failure: 'clear', validChecks: [true, false], expectedValue: '原有内容' },
    { failure: 'insert', validChecks: [true, true, false], expectedValue: '' },
  ] as const)('verifies actual fixture fill state and stops on $failure failures', async ({ failure, validChecks, expectedValue }) => {
    const fixture = await CreateFixtureServer();
    const bridge = CreateMockExtensionBridge({
      fillFailure: failure,
      initialInputValue: '原有内容',
    });
    const harness = await CreateHostHarness(fixture.url, bridge, { providerTurns: 0 });
    try {
      const { runtime } = harness;
      await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: fixture.url } }) });
      const snapshot = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} }) });
      const pageRevision = (snapshot.data as { pageRevision: number }).pageRevision;
      const result = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserFill', arguments: { ref: '@e1', text: '新填写内容', pageRevision } }) });
      expect(bridge.GetFillStateChecks().map(check => check.valid)).toEqual(validChecks);
      const target = bridge.GetTaskTargets(runtime.GetBrowserTaskId()!)[0];
      expect(bridge.GetInputValue(target.targetId, 1)).toBe(expectedValue);
      if (failure) {
        expect(result).toMatchObject({ status: 'status_unknown', data: { code: 'BROWSER_COMMAND_FAILED' } });
        if (failure !== 'insert') expect(bridge.GetProtocolMethods()).not.toContain('Input.insertText');
      } else {
        expect(result).toMatchObject({ status: 'succeeded', data: { filled: true } });
        expect(bridge.GetFillStateChecks().map(check => check.expectedValue)).toEqual([undefined, '', '新填写内容']);
      }
    } finally { await harness.host.Close(); }
  });

  it('keeps task-scoped refs through a read-only tab list and clears them only on explicit switch', async () => {
    const fixture = await CreateFixtureServer();
    const bridge = CreateMockExtensionBridge();
    const observation: Record<string, any> = { providerTurns: 0 };
    const harness = await CreateHostHarness(fixture.url, bridge, observation);

    try {
      const { runtime } = harness;
      const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: fixture.url } });
      await runtime.Execute({ proposal: navigate });
      const taskId = runtime.GetBrowserTaskId();
      expect(taskId).toEqual(expect.any(String));
      const ownedTargets = bridge.GetTaskTargets(taskId!);
      expect(ownedTargets).toHaveLength(1);
      ownedTargets.push({
        targetId: 'pb03-child-target', tabId: 903, windowId: 1, openerTabId: 902, type: 'page', url: fixture.url, title: 'PB-03 child',
        active: false, attached: false, readyState: 'complete',
      });
      bridge.GetTaskTargets('pb03-other-task').push({
        targetId: 'pb03-other-task-target', tabId: 777, windowId: 2, openerTabId: null, type: 'page', url: fixture.url, title: 'other task',
        active: true, attached: true, readyState: 'complete',
      });
      expect(bridge.GetUserTargets().map((target) => target.targetId)).toEqual(['user-original-tab']);

      const snapshotProposal = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
      const snapshot = await runtime.Execute({ proposal: snapshotProposal });
      expect(snapshot).toMatchObject({ status: 'succeeded', data: { pageRevision: expect.any(Number), tabs: expect.any(Array) } });
      expect((snapshot.data as any).tabs.map((tab: any) => tab.targetId)).toEqual(expect.arrayContaining(['pb03-target-1', 'pb03-child-target']));
      expect((snapshot.data as any).tabs.map((tab: any) => tab.tabId)).toEqual(expect.arrayContaining([902, 903]));
      expect((snapshot.data as any).tabs.find((tab: any) => tab.targetId === 'pb03-child-target')).toMatchObject({ tabId: 903, windowId: 1, openerTabId: 902 });
      await expect(runtime.Prepare({ toolName: 'BrowserSwitchTab', arguments: { tabId: 'pb03-child-target' } }))
        .rejects.toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND' });

      const scoped = (runtime as any).personalBrowserRuntime as {
        taskTargetId: string | null;
        taskSessionId: string | null;
        refs: Map<string, unknown>;
      };
      const pageRevisionBeforeList = (await runtime.GetStatus()).pageRevision;
      const targetBeforeList = scoped.taskTargetId;
      const sessionBeforeList = scoped.taskSessionId;
      const refsBeforeList = [...scoped.refs.keys()];
      const protocolBeforeList = bridge.GetProtocolMethods();
      const list = await scoped.Run(['tab']);
      const protocolAfterList = bridge.GetProtocolMethods();

      expect((list.data.tabs as any[]).map((tab) => tab.targetId)).toEqual(['pb03-target-1', 'pb03-child-target']);
      expect((list.data.tabs as any[]).map((tab) => tab.targetId)).not.toContain('pb03-other-task-target');
      expect((list.data.tabs as any[]).map((tab) => tab.targetId)).not.toContain('user-original-tab');
      expect(scoped.taskTargetId).toBe(targetBeforeList);
      expect(scoped.taskSessionId).toBe(sessionBeforeList);
      expect([...scoped.refs.keys()]).toEqual(refsBeforeList);
      expect((await runtime.GetStatus()).pageRevision).toBe(pageRevisionBeforeList);
      expect(protocolAfterList.slice(protocolBeforeList.length)).toEqual(['Target.getTargets']);

      const fill = await runtime.Prepare({
        toolName: 'BrowserFill', arguments: { ref: '@e1', text: 'AI Agent', pageRevision: pageRevisionBeforeList },
      });
      await expect(runtime.Execute({ proposal: fill })).resolves.toMatchObject({ status: 'succeeded', data: { filled: true } });
      const staleFill = await runtime.Prepare({
        toolName: 'BrowserFill', arguments: { ref: '@e1', text: 'after switch', pageRevision: pageRevisionBeforeList },
      });

      const switchTab = await runtime.Prepare({ toolName: 'BrowserSwitchTab', arguments: { tabId: '903' } });
      const protocolBeforeSwitch = bridge.GetProtocolMethods();
      await expect(runtime.Execute({ proposal: switchTab })).resolves.toMatchObject({ status: 'succeeded' });
      const switchMethods = bridge.GetProtocolMethods().slice(protocolBeforeSwitch.length);
      expect(switchMethods).toEqual(expect.arrayContaining(['Target.getTargets', 'Target.attachToTarget', 'Target.activateTarget']));
      expect(scoped.taskTargetId).toBe('pb03-child-target');
      expect(scoped.taskSessionId).toBe('pb03-session-pb03-child-target');
      expect(scoped.refs.size).toBe(0);
      expect((await runtime.GetStatus()).pageRevision).toBe(pageRevisionBeforeList + 1);
      const childReadyWait = await runtime.Prepare({ toolName: 'BrowserWait', arguments: { kind: 'load', value: 'domcontentloaded' } });
      await expect(runtime.Execute({ proposal: childReadyWait })).resolves.toMatchObject({ status: 'succeeded', data: { matched: true } });
      await expect(runtime.Execute({ proposal: staleFill })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
    } finally {
      await harness.host.Close();
    }
  });

  it('waits for the switched child before Snapshot and exposes semantic Snapshot timeout as the first failure', async () => {
    const fixture = await CreateFixtureServer();
    const bridge = CreateMockExtensionBridge({ emptySnapshotTargetId: 'pb03-child-target' });
    const observation: Record<string, any> = { providerTurns: 0 };
    let clock = Date.now();
    const harness = await CreateHostHarness(fixture.url, bridge, observation, false, {
      now: () => clock,
      delay: vi.fn(async (milliseconds: number) => { clock += milliseconds; }),
    });

    try {
      const { runtime } = harness;
      const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: fixture.url } });
      await runtime.Execute({ proposal: navigate });
      const taskId = runtime.GetBrowserTaskId();
      expect(taskId).toEqual(expect.any(String));
      bridge.GetTaskTargets(taskId!).push({
        targetId: 'pb03-child-target', tabId: 903, windowId: 1, openerTabId: 902, type: 'page', url: fixture.url.replace('/application', '/child'), title: 'PB-03 child',
        active: false, attached: false, readyState: 'complete',
      });
      const snapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
      await runtime.Execute({ proposal: snapshot });
      const wrongIdentifier = await runtime.Prepare({ toolName: 'BrowserSwitchTab', arguments: { tabId: 'pb03-child-target' } }).catch((error) => error);
      expect(wrongIdentifier).toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND' });
      const switchTab = await runtime.Prepare({ toolName: 'BrowserSwitchTab', arguments: { tabId: '903' } });
      await expect(runtime.Execute({ proposal: switchTab })).resolves.toMatchObject({ status: 'succeeded' });
      const readyWait = await runtime.Prepare({ toolName: 'BrowserWait', arguments: { kind: 'load', value: 'domcontentloaded' } });
      await expect(runtime.Execute({ proposal: readyWait })).resolves.toMatchObject({ status: 'succeeded', data: { matched: true } });
      const childSnapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
      await expect(runtime.Execute({ proposal: childSnapshot })).rejects.toMatchObject({
        code: 'BROWSER_COMMAND_TIMEOUT',
        message: 'The task page did not become ready for a semantic snapshot in time.',
      });
      expect(bridge.CloseTask).toHaveBeenCalledWith('chrome', taskId, expect.any(Object));
      expect(runtime.GetBrowserTaskId()).toBeUndefined();
    } finally {
      await harness.host.Close();
    }
  });

  it('validates all required fixture controls through Host and preserves exact missing-field evidence', async () => {
    const fixture = await CreateFixtureServer();
    const requiredItems = [
      { selector: '#name', tag: 'input', role: 'textbox', type: 'text', name: '姓名', rawLabel: '姓名', required: true, valueLength: 4, valid: true },
      { selector: '#direction', tag: 'select', role: 'combobox', type: '', name: '方向', rawLabel: '方向', required: true, valid: true, options: [{ label: '研发', value: '研发', selected: true }] },
      { selector: '#province', tag: 'button', role: 'combobox', type: '', name: '省份', rawLabel: '省份', required: true },
      { selector: '#city', tag: 'button', role: 'combobox', type: '', name: '城市', rawLabel: '城市', required: true },
      { selector: '#date', tag: 'input', role: 'textbox', type: 'date', name: '出生日期', rawLabel: '出生日期', required: true, valueLength: 10, valid: true },
      { selector: '#terms', tag: 'input', role: 'checkbox', type: 'checkbox', name: '同意本地测试条款', rawLabel: '同意本地测试条款', required: true, checked: true, valid: true },
      { selector: '#resume', tag: 'input', role: 'filechooser', type: 'file', name: '简历附件', rawLabel: '简历附件', required: true, valueLength: 24, valid: true },
    ];
    const bridge = CreateMockExtensionBridge({ snapshotItems: requiredItems });
    const observation: Record<string, any> = { providerTurns: 0 };
    const harness = await CreateHostHarness(fixture.url, bridge, observation);

    try {
      const navigate = await harness.runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: fixture.url } });
      await harness.runtime.Execute({ proposal: navigate });
      const valid = await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserValidateForm', arguments: {} }) });
      expect(valid).toMatchObject({ status: 'succeeded', data: { valid: true, inspectedFieldCount: 7, validationMetadataAvailable: true, issues: [] } });
    } finally {
      await harness.host.Close();
    }

    const missingItems = requiredItems.map((item) => item.selector === '#date'
      ? { ...item, valueLength: 0, valid: false, validationMessage: '请填写此字段。' }
      : item.selector === '#terms' ? { ...item, checked: false, valid: false, validationMessage: '请勾选此框。' } : item);
    const missingBridge = CreateMockExtensionBridge({ snapshotItems: missingItems });
    const missingHarness = await CreateHostHarness(fixture.url, missingBridge, { providerTurns: 0 });
    try {
      await missingHarness.runtime.Execute({ proposal: await missingHarness.runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: fixture.url } }) });
      const invalid = await missingHarness.runtime.Execute({ proposal: await missingHarness.runtime.Prepare({ toolName: 'BrowserValidateForm', arguments: {} }) });
      expect(invalid).toMatchObject({ status: 'succeeded', data: {
        valid: false, inspectedFieldCount: 7, validationMetadataAvailable: true,
        issues: [
          { ref: '@e5', label: '出生日期', code: 'required' },
          { ref: '@e6', label: '同意本地测试条款', code: 'required' },
        ],
      } });
    } finally {
      await missingHarness.host.Close();
    }
  });

  it('binds the authorized synthetic upload through DOM.setFileInputFiles and preserves file metadata', async () => {
    const fixture = await CreateFixtureServer();
    const filePath = join(process.cwd(), 'scripts', 'fixtures', 'PB-03-synthetic-resume.pdf');
    const fileBytes = await readFile(filePath);
    const fileDigest = createHash('sha256').update(fileBytes).digest('hex');
    const fileStat = await stat(filePath);
    const bridge = CreateMockExtensionBridge({ snapshotItems: [
      { selector: '#resume', tag: 'input', role: 'filechooser', type: 'file', name: '简历附件', rawLabel: '简历附件', required: true, valueLength: 1 },
    ] });
    const harness = await CreateHostHarness(fixture.url, bridge, { providerTurns: 0 }, false, {
      resolveUploadFile: vi.fn(async (fileId: string) => fileId === 'attachment://pb03/synthetic-resume.pdf' ? filePath : null),
    });

    try {
      await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: fixture.url } }) });
      const snapshot = await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} }) });
      const pageRevision = (snapshot.data as any).pageRevision;
      const upload = await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({
        toolName: 'BrowserUploadFile', arguments: { ref: '@e1', pageRevision, fileId: 'attachment://pb03/synthetic-resume.pdf' },
      }) });
      expect(upload).toMatchObject({ status: 'succeeded', data: {
        uploaded: true,
        fileId: 'attachment://pb03/synthetic-resume.pdf',
        fileName: 'PB-03-synthetic-resume.pdf',
        fileSize: fileBytes.length,
        fileSha256: fileDigest,
      } });
      expect(bridge.GetUploadedFilePath()).toBe(filePath);
      expect({ name: filePath.split(/[\\/]/).pop(), sizeBytes: fileStat.size, sha256: fileDigest }).toMatchObject({
        name: 'PB-03-synthetic-resume.pdf', sizeBytes: fileBytes.length, sha256: fileDigest,
      });
      expect(bridge.GetProtocolMethods()).toEqual(expect.arrayContaining(['DOM.setFileInputFiles', 'Runtime.releaseObject']));
    } finally {
      await harness.host.Close();
    }
  });

  it('restores the parent by tabId after a ready static child Snapshot and closes only its own task', async () => {
    const fixture = await CreateFixtureServer();
    const bridge = CreateMockExtensionBridge({ snapshotItems: [] });
    const harness = await CreateHostHarness(fixture.url, bridge, { providerTurns: 0 });

    try {
      await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: fixture.url } }) });
      const taskId = harness.runtime.GetBrowserTaskId();
      expect(taskId).toEqual(expect.any(String));
      bridge.GetTaskTargets('other-task').push({
        targetId: 'other-task-target', tabId: 777, windowId: 2, openerTabId: null, type: 'page', url: fixture.url, title: 'other task', active: true, attached: true, readyState: 'complete',
      });
      bridge.GetTaskTargets(taskId!).push({
        targetId: 'pb03-child-target', tabId: 903, windowId: 1, openerTabId: 902, type: 'page', url: fixture.url.replace('/application', '/child'), title: 'PB-03 child', active: false, attached: false, readyState: 'complete',
      });
      await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} }) });
      await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserSwitchTab', arguments: { tabId: '903' } }) });
      await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserWait', arguments: { kind: 'load', value: 'domcontentloaded' } }) });
      const childSnapshot = await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} }) });
      expect(childSnapshot).toMatchObject({ status: 'succeeded', data: { refs: {}, currentUrl: fixture.url.replace('/application', '/child') } });
      await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserSwitchTab', arguments: { tabId: '902' } }) });
      await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserWait', arguments: { kind: 'load', value: 'domcontentloaded' } }) });
      const parentSnapshot = await harness.runtime.Execute({ proposal: await harness.runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} }) });
      expect(parentSnapshot).toMatchObject({ status: 'succeeded', data: { refs: {}, currentUrl: fixture.url } });
      const owned = bridge.GetTaskTargets(taskId!);
      expect(owned).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: 'pb03-target-1', tabId: 902, active: true }),
        expect.objectContaining({ targetId: 'pb03-child-target', tabId: 903, openerTabId: 902 }),
      ]));
      await harness.runtime.Close();
      expect(bridge.GetTaskTargets(taskId!)).toHaveLength(0);
      expect(bridge.GetTaskTargets('other-task')).toHaveLength(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('reports file URL and failed navigation explicitly instead of silently ending the scripted turn', async () => {
    const fixture = await CreateFixtureServer();
    const bridge = CreateMockExtensionBridge();
    const observation: Record<string, any> = { providerTurns: 0 };
    const harness = await CreateHostHarness('file:///fixture/application.html', bridge, observation);

    try {
      const result = await harness.host.Send({ requestId: 'pb03-navigation-file-denied', sessionId: 'pb03-navigation-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Open the synthetic fixture.' });
      expect(result.accepted).toBe(true);
      expect(observation.providerTurns).toBe(2);
      expect(observation.navigationToolResult).toMatchObject({ ok: false, code: 'BROWSER_NAVIGATION_DENIED' });
      expect(observation.navigationEvidence).toMatchObject({ ok: false, code: 'BROWSER_NAVIGATION_DENIED' });
      expect(observation.toolCalls).toEqual(['BrowserNavigate']);
      expect(harness.events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('Fixture navigation failed [BROWSER_NAVIGATION_DENIED]') }));
      expect(bridge.GetProtocolMethods()).toEqual([]);
      expect(fixture.getRequestCount()).toBe(0);
    } finally {
      await harness.host.Close();
    }
  });

  it('reports an HTTP fixture navigation failure with its tool error and does not continue to Snapshot', async () => {
    const fixture = await CreateFixtureServer(503);
    const bridge = CreateMockExtensionBridge();
    const observation: Record<string, any> = { providerTurns: 0 };
    const harness = await CreateHostHarness(fixture.url, bridge, observation);

    try {
      const result = await harness.host.Send({ requestId: 'pb03-navigation-http-failed', sessionId: 'pb03-navigation-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Open the synthetic fixture.' });
      expect(result.accepted).toBe(true);
      expect(observation.providerTurns).toBe(2);
      expect(observation.navigationToolResult).toMatchObject({ ok: false, code: 'BROWSER_COMMAND_FAILED' });
      expect(observation.navigationEvidence).toMatchObject({ ok: false, code: 'BROWSER_COMMAND_FAILED' });
      expect(observation.toolCalls).toEqual(['BrowserNavigate']);
      expect(harness.events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('Fixture navigation failed [BROWSER_COMMAND_FAILED]') }));
      expect(bridge.GetProtocolMethods()).toContain('Target.createTarget');
      expect(bridge.GetProtocolMethods()).not.toContain('Runtime.evaluate');
    } finally {
      await harness.host.Close();
    }
  });

  it('fails closed on duplicate same-id results before requesting BrowserSnapshot', async () => {
    const fixture = await CreateFixtureServer();
    const bridge = CreateMockExtensionBridge();
    const observation: Record<string, any> = { providerTurns: 0 };
    const harness = await CreateHostHarness(fixture.url, bridge, observation, true);

    try {
      await expect(harness.host.Send({ requestId: 'pb03-navigation-duplicate-result', sessionId: 'pb03-navigation-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Open the local synthetic fixture and then inspect it.' }))
        .rejects.toThrow(/exactly one is required/i);
      expect(observation.providerTurns).toBe(2);
      expect(observation.toolCalls).toEqual(['BrowserNavigate']);
      expect(bridge.GetSnapshotEvaluationCount()).toBe(0);
      expect(harness.events).not.toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('BrowserSnapshot succeeded') }));
    } finally {
      await harness.host.Close();
    }
  });

  it('accepts one expected result among other call ids and rejects missing, mismatched, duplicate, wrong-role, and malformed results', () => {
    const toolResult = (toolCallId: string, result: Record<string, unknown>) => ({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) });
    const expectedResult = { ok: true, data: { currentUrl: 'http://127.0.0.1:45678/application' } };
    expect(ParseExpectedToolResult([
      toolResult('prior-call', { ok: true, data: { note: 'prior' } }),
      toolResult('expected', expectedResult),
      toolResult('later-call', { ok: false, code: 'OTHER_FAILURE', message: 'different call' }),
    ], 'expected')).toMatchObject({ ...expectedResult, toolCallId: 'expected' });

    expect(() => ParseExpectedToolResult([], 'expected'))
      .toThrow(expect.objectContaining({ code: 'PB03_TOOL_RESULT_MISSING' }));
    expect(() => ParseExpectedToolResult([{ role: 'tool', tool_call_id: 'wrong', content: JSON.stringify({ ok: true, data: {} }) }], 'expected'))
      .toThrow(expect.objectContaining({ code: 'PB03_TOOL_RESULT_CALL_MISMATCH' }));
    expect(() => ParseExpectedToolResult([{ role: 'assistant', tool_call_id: 'expected', content: JSON.stringify(expectedResult) }], 'expected'))
      .toThrow(expect.objectContaining({ code: 'PB03_TOOL_RESULT_INVALID_ROLE' }));
    expect(() => ParseExpectedToolResult([
      toolResult('expected', expectedResult),
      toolResult('expected', expectedResult),
    ], 'expected')).toThrow(expect.objectContaining({ code: 'PB03_TOOL_RESULT_DUPLICATE' }));
    expect(() => ParseExpectedToolResult([
      toolResult('expected', expectedResult),
      toolResult('expected', { ok: false, code: 'NAVIGATION_FAILED', message: 'failed' }),
    ], 'expected')).toThrow(expect.objectContaining({ code: 'PB03_TOOL_RESULT_DUPLICATE' }));
    expect(() => ParseExpectedToolResult([{ role: 'tool', tool_call_id: 'expected', content: JSON.stringify({ ok: true }) }], 'expected'))
      .toThrow(expect.objectContaining({ code: 'PB03_TOOL_RESULT_INVALID_SHAPE' }));
    const result = { ok: true, data: { currentUrl: 'http://127.0.0.1:45678/application' } };
    const taskTarget = { type: 'page', targetId: 'task-target', tabId: 902, windowId: 1, openerTabId: null, url: 'http://127.0.0.1:45678/application' };
    expect(VerifyNavigationEvidence({ result, taskTargets: [], expectedUrl: result.data.currentUrl, readyState: 'complete' }))
      .toMatchObject({ ok: false, code: 'PB03_NAVIGATION_TASK_TARGET_MISSING' });
    expect(VerifyNavigationEvidence({ result, taskTargets: [{ ...taskTarget, url: 'http://127.0.0.1:45678/other' }], expectedUrl: result.data.currentUrl, readyState: 'complete' }))
      .toMatchObject({ ok: false, code: 'PB03_NAVIGATION_TASK_TARGET_MISSING' });
    expect(VerifyNavigationEvidence({ result: { ok: true, data: { currentUrl: 'http://127.0.0.1:45678/other' } }, taskTargets: [taskTarget], expectedUrl: result.data.currentUrl, readyState: 'complete' }))
      .toMatchObject({ ok: false, code: 'PB03_NAVIGATION_FINAL_URL_MISMATCH' });
    expect(VerifyNavigationEvidence({ result, taskTargets: [taskTarget], expectedUrl: result.data.currentUrl, readyState: 'loading' }))
      .toMatchObject({ ok: false, code: 'PB03_NAVIGATION_DOCUMENT_NOT_READY' });
  });
});
