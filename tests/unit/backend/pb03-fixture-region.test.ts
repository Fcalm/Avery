import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserRuntime } from '../../../apps/backend/src/electron/backend/agent-browser-runtime';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { BrowserExtensionProtocolRevision } from '../../../apps/backend/src/electron/backend/browser-extension-bridge';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src/index';
import { ParseExpectedToolResult } from '../../../scripts/fixtures/pb03-tool-result.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type RegionTarget = {
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

type RegionState = {
  province: string;
  city: string;
  provinceOpen: boolean;
  cityOpen: boolean;
  cityEnabled: boolean;
  events: RegionEvent[];
};

type RegionEvent = {
  type: string;
  targetRole: string;
  optionRole: string | null;
  optionText: string | null;
  field: 'province' | 'city' | null;
};

function ToolCall(id: string, name: string, args: Record<string, unknown>) {
  return { content: '', toolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] };
}

function RegionStateValue(state: RegionState) {
  return {
    // The fixture controls are buttons, so HTMLButtonElement.value remains empty;
    // selected/display state is carried by the semantic data/ARIA fields.
    province: { value: '', displayText: state.province || '选择省份', selected: state.province, dataSelected: state.province, dataValue: state.province, disabled: false, ariaDisabled: null, dataState: null, expanded: String(state.provinceOpen) },
    city: { value: '', displayText: state.city || (state.cityEnabled ? '选择城市' : '先选择省份'), selected: state.city, dataSelected: state.city, dataValue: state.city, disabled: !state.cityEnabled, ariaDisabled: null, dataState: null, expanded: String(state.cityOpen) },
    provinceOptions: { hidden: !state.provinceOpen, values: ['广东省', '江西省'].map((value) => ({ value, text: value, role: 'option', selected: value === state.province })) },
    cityOptions: { hidden: !state.cityOpen, values: (state.province === '广东省' ? ['佛山市', '广州市'] : []).map((value) => ({ value, text: value, role: 'option', selected: value === state.city, disabled: false })) },
    events: state.events.map((event) => ({ ...event })),
    eventCount: state.events.length,
  };
}

function SelectorFromExpression(expression: string): string {
  return expression.match(/"selector":"([^"]+)"/)?.[1] ?? '';
}

function CreateRegionExtensionBridge(options: { dropOptionEvents?: boolean; dropOptionClick?: boolean; cityOpenFailure?: boolean; cityOptionRemainsOpen?: boolean } = {}) {
  const targetsByTask = new Map<string, RegionTarget[]>();
  const statesByTask = new Map<string, RegionState>();
  const completedStates = new Map<string, RegionState>();
  const retiredTaskIds = new Set<string>();
  const userTargets: RegionTarget[] = [{
    targetId: 'user-original-tab', tabId: 700, windowId: 1, openerTabId: null, type: 'page', url: 'https://user.example/', title: 'user tab', active: true, attached: false, readyState: 'complete',
  }];
  const methods: string[] = [];
  const getTargets = (taskId: string) => targetsByTask.get(taskId) ?? [];
  const getState = (taskId: string) => {
    let state = statesByTask.get(taskId);
    if (!state) {
      state = { province: '', city: '', provinceOpen: false, cityOpen: false, cityEnabled: false, events: [] };
      statesByTask.set(taskId, state);
    }
    return state;
  };
  const selectorTarget = (selector: string): 'province' | 'province-listbox' | 'province-option' | 'province-option-2' | 'city' | 'city-listbox' | 'city-option' | 'city-option-2' | null => {
    if (selector === '#province') return 'province';
    if (selector === '#province-options') return 'province-listbox';
    if (selector.startsWith('#province-options')) return selector.includes('nth-of-type(2)') ? 'province-option-2' : 'province-option';
    if (selector === '#city') return 'city';
    if (selector === '#city-options') return 'city-listbox';
    if (selector.startsWith('#city-options')) return selector.includes('nth-of-type(2)') ? 'city-option-2' : 'city-option';
    return null;
  };
  const optionValue = (element: string) => element.endsWith('-2') ? (element.startsWith('city-') ? '广州市' : '江西省') : element.startsWith('city-') ? '佛山市' : '广东省';
  const eventTarget = (element: string): Omit<RegionEvent, 'type'> => {
    const option = element.includes('option');
    const field = element.startsWith('province') ? 'province' : element.startsWith('city') ? 'city' : null;
    return {
      targetRole: option ? 'option' : element.includes('listbox') ? 'listbox' : 'combobox',
      optionRole: option ? 'option' : null,
      optionText: option ? optionValue(element) : null,
      field,
    };
  };
  const recordEvent = (state: RegionState, type: string, element: string) => state.events.push({ type, ...eventTarget(element) });
  const request = vi.fn(async (_engine: string, operation: string, payload: any, requestOptions: any) => {
    if (operation !== 'cdp') throw new Error(`Unexpected mock bridge operation: ${operation}`);
    const taskId = String(requestOptions?.browserTaskId ?? '');
    if (!taskId) throw new Error('Mock bridge request did not carry browserTaskId.');
    if (retiredTaskIds.has(taskId)) throw Object.assign(new Error('This browserTaskId has already been retired and cannot be reused.'), { code: 'BROWSER_TASK_RETIRED' });
    const { id, method, params = {} } = payload ?? {};
    methods.push(String(method));
    let targets = targetsByTask.get(taskId);
    if (!targets) {
      targets = [];
      targetsByTask.set(taskId, targets);
    }
    const state = getState(taskId);
    let result: Record<string, unknown>;
    switch (method) {
      case 'Target.getTargets':
        result = { targetInfos: targets.map((target) => ({ ...target })) };
        break;
      case 'Target.createTarget': {
        const target: RegionTarget = {
          targetId: `pb03-region-target-${targets.length + 1}`, tabId: 1200 + targets.length + 1, windowId: 1, openerTabId: null, type: 'page',
          url: String(params.url ?? ''), title: 'PB-03 region fixture', active: true, attached: false, readyState: 'complete',
        };
        targets.push(target);
        result = { targetId: target.targetId };
        break;
      }
      case 'Target.attachToTarget': {
        const target = targets.find((item) => item.targetId === params.targetId);
        if (!target) throw Object.assign(new Error('Task-owned target was not found.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        target.attached = true;
        result = { sessionId: `pb03-region-session-${target.targetId}` };
        break;
      }
      case 'Target.activateTarget':
        for (const target of targets) target.active = target.targetId === params.targetId;
        result = {};
        break;
      case 'Target.getTargetInfo': {
        const target = targets.find((item) => item.targetId === params.targetId);
        if (!target) throw Object.assign(new Error('Task-owned target was not found.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        result = { targetInfo: { ...target } };
        break;
      }
      case 'Page.navigate': {
        const target = targets.find((item) => item.attached);
        if (!target) throw Object.assign(new Error('No attached task target.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        target.url = String(params.url ?? '');
        result = { frameId: `frame-${target.targetId}` };
        break;
      }
      case 'Runtime.evaluate': {
        const target = targets.find((item) => item.attached);
        if (!target) throw Object.assign(new Error('No attached task target.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        const expression = String(params.expression ?? '');
        if (expression.includes('const candidates =')) {
          const items: Array<Record<string, unknown>> = [
            { selector: '#province', tag: 'button', role: 'combobox', type: '', name: '省份', ariaLabel: '省份', id: 'province', disabled: false, required: true, readOnly: false },
            { selector: '#city', tag: 'button', role: 'combobox', type: '', name: '城市', ariaLabel: '城市', id: 'city', disabled: !state.cityEnabled, required: true, readOnly: false },
          ];
          if (state.provinceOpen) {
            items.push({ selector: '#province-options', tag: 'div', role: 'listbox', type: '', name: '广东省 江西省', id: 'province-options', disabled: false, required: false, readOnly: false });
            items.push({ selector: '#province-options > button:nth-of-type(1)', tag: 'button', role: 'option', type: '', name: '广东省', id: '', disabled: false, required: false, readOnly: false });
            items.push({ selector: '#province-options > button:nth-of-type(2)', tag: 'button', role: 'option', type: '', name: '江西省', id: '', disabled: false, required: false, readOnly: false });
          }
          if (state.cityOpen) {
            items.push({ selector: '#city-options', tag: 'div', role: 'listbox', type: '', name: '佛山市 广州市', id: 'city-options', disabled: false, required: false, readOnly: false });
            items.push({ selector: '#city-options > button:nth-of-type(1)', tag: 'button', role: 'option', type: '', name: '佛山市', id: '', disabled: false, required: false, readOnly: false });
            items.push({ selector: '#city-options > button:nth-of-type(2)', tag: 'button', role: 'option', type: '', name: '广州市', id: '', disabled: false, required: false, readOnly: false });
          }
          result = { result: { type: 'object', value: { url: target.url, title: target.title, readyState: target.readyState, truncated: false, items } } };
        } else if (expression.includes('document.readyState')) {
          result = { result: { type: 'object', value: { url: target.url, readyState: target.readyState } } };
        } else if (expression.includes('__pb03RegionState')) {
          result = { result: { type: 'object', value: RegionStateValue(state) } };
        } else if (expression.includes('elementFromPoint')) {
          const selector = SelectorFromExpression(expression);
          const element = selectorTarget(selector);
          const disabled = element === 'city' && !state.cityEnabled;
          result = { result: { type: 'object', value: {
            stale: false,
            x: element === 'province' ? 10 : element === 'province-listbox' ? 50 : element === 'province-option' ? 20 : element === 'province-option-2' ? 21
              : element === 'city' ? 30 : element === 'city-listbox' ? 60 : element === 'city-option' ? 40 : 41,
            y: 60, tag: element?.includes('option') || element === 'province' || element === 'city' ? 'button' : 'div', type: '', disabled, contentEditable: false,
          } } };
        } else {
          result = { result: { type: 'object', value: {} } };
        }
        break;
      }
      case 'Input.dispatchMouseEvent': {
        const x = Number(params.x);
        const element = x === 10 ? 'province' : x === 50 ? 'province-listbox' : x === 20 ? 'province-option' : x === 21 ? 'province-option-2'
          : x === 30 ? 'city' : x === 60 ? 'city-listbox' : x === 40 ? 'city-option' : x === 41 ? 'city-option-2' : null;
        if (params.type === 'mousePressed' && element) {
          recordEvent(state, 'pointerdown', element);
          recordEvent(state, 'mousedown', element);
        } else if (params.type === 'mouseReleased' && element) {
          recordEvent(state, 'pointerup', element);
          recordEvent(state, 'mouseup', element);
          if (!options.dropOptionClick || !element.includes('option')) recordEvent(state, 'click', element);
          if (element === 'province') state.provinceOpen = !state.provinceOpen;
          else if (element.startsWith('province-option') && !options.dropOptionEvents) {
            state.province = optionValue(element);
            state.city = '';
            state.cityEnabled = true;
            state.provinceOpen = false;
            state.cityOpen = false;
          } else if (element === 'city' && state.cityEnabled && !options.cityOpenFailure) state.cityOpen = !state.cityOpen;
          else if (element.startsWith('city-option') && !options.dropOptionEvents) {
            state.city = optionValue(element);
            if (!options.cityOptionRemainsOpen) state.cityOpen = false;
          }
        }
        result = {};
        break;
      }
      default:
        throw new Error(`Unexpected CDP method in region bridge: ${String(method)}.`);
    }
    return { id, result };
  });
  const closeTask = vi.fn(async (_engine: string, taskId: string) => {
    if (retiredTaskIds.has(taskId)) throw Object.assign(new Error('This browserTaskId has already been retired and cannot be reused.'), { code: 'BROWSER_TASK_RETIRED' });
    const closedTabs = getTargets(taskId).length;
    const state = statesByTask.get(taskId);
    if (state) completedStates.set(taskId, structuredClone(state));
    targetsByTask.delete(taskId);
    statesByTask.delete(taskId);
    retiredTaskIds.add(taskId);
    return { status: 'confirmed', browserTaskId: taskId, closed: true, closedTabs, unknownTabs: 0 };
  });
  return {
    Start: vi.fn(async () => undefined), EnsureConnected: vi.fn(async () => undefined), IsConnected: vi.fn(() => true),
    Status: vi.fn(() => ({
      connected: true,
      state: 'online' as const,
      version: '0.2.0',
      protocolRevision: BrowserExtensionProtocolRevision,
      actualProtocolRevision: BrowserExtensionProtocolRevision,
      expectedProtocolRevision: BrowserExtensionProtocolRevision,
      port: 17653,
    })), Request: request, CloseTask: closeTask,
    Close: vi.fn(async () => undefined), GetTaskTargets: getTargets, GetUserTargets: () => userTargets,
    GetRetiredTaskIds: () => [...retiredTaskIds],
    GetProtocolMethods: () => [...methods], GetRegionState: (taskId: string) => {
      const state = statesByTask.get(taskId) ?? completedStates.get(taskId);
      return state ? RegionStateValue(state) : null;
    },
  };
}

type RegionBridge = ReturnType<typeof CreateRegionExtensionBridge>;

function FindSnapshotRef(snapshot: any, role: string, name: RegExp): { ref: string; pageRevision: number; metadata: any } {
  const entry = Object.entries(snapshot?.data?.refs ?? {}).find(([, value]: any) => value?.role === role && name.test(String(value?.name ?? '')));
  if (!entry || !Number.isSafeInteger(snapshot?.data?.pageRevision)) throw new Error(`Missing ${role} ${name} ref.`);
  return { ref: `@${entry[0]}`, pageRevision: snapshot.data.pageRevision, metadata: entry[1] };
}

function RefArgs(value: { ref: string; pageRevision: number }) {
  return { ref: value.ref, pageRevision: value.pageRevision };
}

async function ReadRegionState(runtime: AgentBrowserRuntime) {
  const expression = '(() => ({ __pb03RegionState: true }))()';
  const response = await (runtime as any).RunCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], { deadline: Date.now() + 10_000 });
  return response.data.result;
}

function AssertHostOptionAction(state: any, cursor: number, expectedField: 'province' | 'city', expectedText: string) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const start = Number.isSafeInteger(state?.eventCount) ? Math.max(0, state.eventCount - events.length) : 0;
  const recent = events.slice(Math.max(0, cursor - start));
  let previous = -1;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const index = recent.findIndex((event: any, candidate: number) => candidate > previous && event?.type === type);
    if (index < 0) throw new Error(`Host region oracle did not observe ${type} for ${expectedField}/${expectedText}.`);
    const event = recent[index];
    if (event.targetRole !== 'option' || event.optionRole !== 'option' || event.optionText !== expectedText || event.field !== expectedField) {
      throw new Error(`Host region oracle observed the wrong target for ${expectedField}/${expectedText}: ${JSON.stringify(event)}.`);
    }
    previous = index;
  }
}

type RegionMode = 'success' | 'drop-option' | 'container' | 'wrong-option' | 'missing-click' | 'city-hidden' | 'city-not-collapsed';

function CreateRegionProvider(url: string, runtime: AgentBrowserRuntime, mode: RegionMode) {
  let phase = 0;
  let pendingCallId: string | null = null;
  let provinceOptionEventCursor = 0;
  let cityOptionEventCursor = 0;
  const observation: Record<string, any> = { providerTurns: 0, snapshots: [], actions: [], regionTimeline: [] };
  const provider = {
    packageName: 'avery.pb03-region-test', name: 'pb03-region-scripted', version: '0.2.0', sdkVersion: '0.1.0', slot: 'model-provider' as const, capabilities: ['model:scripted-test'],
    Configure: vi.fn(), TestConnection: vi.fn(), GetBalance: vi.fn(), GetModels: vi.fn(), GetStatus: vi.fn(async () => ({ configured: true, provider: 'Test', model: 'pb03-region' })),
    ResolveRequestModel: vi.fn(() => 'pb03-region'), BaseUrl: vi.fn(() => 'http://127.0.0.1/pb03-region'), GetRuntimeLimits: vi.fn(() => ({ contextLimit: 128_000, threshold: 70 })), EstimateTokens: vi.fn(() => 10), CreateSummary: vi.fn(async () => ({ content: 'summary' })),
    StreamCompletion: vi.fn(async ({ history, onDelta }: any) => {
      observation.providerTurns += 1;
      const finish = (content: string) => { onDelta?.({ reasoning: '', content }); return { content, toolCalls: [] }; };
      const result = () => {
        if (!pendingCallId) throw new Error('Region provider lost its pending call.');
        return ParseExpectedToolResult(history, pendingCallId);
      };
      const snapshot = () => {
        const value = result();
        observation.snapshots.push(value);
        return value;
      };
      const dispatch = (id: string, name: string, args: Record<string, unknown>) => {
        pendingCallId = id;
        observation.actions.push(name);
        return ToolCall(id, name, args);
      };
      if (phase === 0) { phase = 1; return dispatch('region-navigate', 'BrowserNavigate', { url }); }
      if (phase === 1) {
        if (result().ok !== true) throw new Error('Region navigation failed.');
        observation.taskId = runtime.GetBrowserTaskId();
        phase = 2;
        return dispatch('region-snapshot-1', 'BrowserSnapshot', {});
      }
      if (phase === 2) {
        const first = snapshot();
        phase = 3;
        return dispatch('region-open-province', 'BrowserClick', RefArgs(FindSnapshotRef(first, 'combobox', /省份/)));
      }
      if (phase === 3) {
        const openResult = result();
        if (openResult.ok !== true) throw new Error(`Province combobox did not open: ${JSON.stringify(openResult)}`);
        phase = 4;
        return dispatch('region-snapshot-2', 'BrowserSnapshot', {});
      }
      if (phase === 4) {
        const open = snapshot();
        const openState = await ReadRegionState(runtime);
        observation.regionTimeline.push({ label: 'province-options-open', state: openState });
        provinceOptionEventCursor = openState.eventCount;
        phase = 5;
        const option = mode === 'container'
          ? FindSnapshotRef(open, 'listbox', /广东省/)
          : FindSnapshotRef(open, 'option', mode === 'wrong-option' ? /江西省/ : /广东省/);
        return dispatch('region-choose-province', 'BrowserClick', RefArgs(option));
      }
      if (phase === 5) {
        if (result().ok !== true) throw new Error('Province option click failed.');
        phase = 6;
        return dispatch('region-snapshot-3', 'BrowserSnapshot', {});
      }
      if (phase === 6) {
        const afterProvince = snapshot();
        const state = await ReadRegionState(runtime);
        observation.regionTimeline.push({ label: 'province-selected', state });
        AssertHostOptionAction(state, provinceOptionEventCursor, 'province', '广东省');
        const beforeProvinceSelection = observation.regionTimeline.at(-2)?.state;
        if (state?.province?.selected !== '广东省' || state?.province?.displayText !== '广东省'
          || beforeProvinceSelection?.city?.disabled !== true || state?.city?.disabled !== false
          || state?.cityOptions?.hidden !== true
          || !(state?.cityOptions?.values ?? []).some((option: any) => option?.value === '佛山市')) {
          throw new Error(`Region cascade oracle failed after province option: ${JSON.stringify({ state, snapshot: afterProvince.data })}`);
        }
        const city = FindSnapshotRef(afterProvince, 'combobox', /城市/);
        if (city.metadata?.disabled === true) throw new Error('Fresh city snapshot still reports disabled.');
        phase = 7;
        return dispatch('region-open-city', 'BrowserClick', RefArgs(city));
      }
      if (phase === 7) {
        if (result().ok !== true) throw new Error('City combobox did not open.');
        phase = 8;
        return dispatch('region-snapshot-4', 'BrowserSnapshot', {});
      }
      if (phase === 8) {
        const open = snapshot();
        const openState = await ReadRegionState(runtime);
        observation.regionTimeline.push({ label: 'city-opened', state: openState });
        if (openState?.city?.expanded !== 'true' || openState?.cityOptions?.hidden !== false
          || openState?.city?.disabled === true || !(openState?.cityOptions?.values ?? []).some((option: any) => option?.value === '佛山市')) {
          throw new Error(`City open oracle failed: ${JSON.stringify({ openState, snapshot: open.data })}`);
        }
        cityOptionEventCursor = openState.eventCount;
        phase = 9;
        return dispatch('region-choose-city', 'BrowserClick', RefArgs(FindSnapshotRef(open, 'option', /佛山市/)));
      }
      if (phase === 9) {
        if (result().ok !== true) throw new Error('City option click failed.');
        phase = 10;
        return dispatch('region-snapshot-5', 'BrowserSnapshot', {});
      }
      if (phase === 10) {
        const finalSnapshot = snapshot();
        const state = await ReadRegionState(runtime);
        AssertHostOptionAction(state, cityOptionEventCursor, 'city', '佛山市');
        if (state?.city?.selected !== '佛山市' || state?.city?.displayText !== '佛山市'
          || state?.city?.disabled !== false || state?.city?.expanded !== 'false' || state?.cityOptions?.hidden !== true) {
          throw new Error(`Final region oracle failed: ${JSON.stringify({ state, snapshot: finalSnapshot.data })}`);
        }
        phase = 11;
        return finish('PB-03 region cascade completed.', onDelta);
      }
      return finish('PB-03 region flow stopped.', onDelta);
    }),
    GetCallCount: () => (provider.StreamCompletion as any).mock.calls.length,
    observation,
  };
  return provider;
}

async function CreateHostHarness(url: string, bridge: RegionBridge, mode: RegionMode) {
  const root = await mkdtemp(join(tmpdir(), 'avery-pb03-region-flow-'));
  temporaryRoots.push(root);
  const events: any[] = [];
  const runtime = new AgentBrowserRuntime({
    executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot: join(root, 'browser-runtime'), externalBrowserPaths: { chrome: process.execPath },
    browserExtensionBridge: bridge as any, resolveUploadFile: vi.fn(async () => null),
  });
  await runtime.SetEngine('chrome');
  const provider = CreateRegionProvider(url, runtime, mode);
  const host = new AgentHost({
    userDataPath: join(root, 'user-data'), workspacePath: root, Emit: (event) => events.push(event), browserRuntime: runtime,
    business: {
      GetStoredSettings: vi.fn(async () => ({ browserEngine: 'chrome' })), GetProfiles: vi.fn(async () => ({ items: [] })), ResolveAttachmentUri: vi.fn(async () => null), ResolveAttachmentMarkdownUri: vi.fn(async () => null),
      LoadViewModel: vi.fn(async () => ({ browserEngine: 'chrome', resumes: [], jobs: [], applications: [] })), SaveTrackedJob: vi.fn(async () => ({ jobId: 'job', jobRevision: 1 })),
    },
    observability: { RecordLog: vi.fn(), StartTrace: vi.fn(), AppendTraceEvent: vi.fn(), RecordTraceUsage: vi.fn(), FinishTrace: vi.fn(), GetLogs: vi.fn(async () => []), GetTraces: vi.fn(async () => []), GetTraceEvents: vi.fn(async () => []), DeleteTraces: vi.fn(async () => ({ deleted: 0 })), SetTraceRetention: vi.fn(async (value: number) => ({ traceRetention: value })), ClearObservability: vi.fn(async () => ({ cleared: true })) },
    credentialPort: { Load: vi.fn(async () => null), Save: vi.fn() },
    createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }),
  });
  return { host, runtime, provider, events, root };
}

async function NavigateAndSnapshot(runtime: AgentBrowserRuntime, url: string) {
  const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url } });
  await runtime.Execute({ proposal: navigate, deadline: Date.now() + 10_000 });
  const snapshotProposal = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
  return await runtime.Execute({ proposal: snapshotProposal, deadline: Date.now() + 10_000 });
}

describe('PB-03 custom province/city cascade through task-scoped personal browser', () => {
  const url = 'http://127.0.0.1/pb03-region';

  it('runs province -> enabled city -> city option through AgentHost and fresh refs', async () => {
    const bridge = CreateRegionExtensionBridge();
    const harness = await CreateHostHarness(url, bridge, 'success');
    try {
      const result = await harness.host.Send({ requestId: 'pb03-region-success', sessionId: 'pb03-region-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Run the synthetic region cascade and stop before submission.' });
      expect(result.accepted).toBe(true);
      expect(harness.provider.observation.actions).toEqual(['BrowserNavigate', 'BrowserSnapshot', 'BrowserClick', 'BrowserSnapshot', 'BrowserClick', 'BrowserSnapshot', 'BrowserClick', 'BrowserSnapshot', 'BrowserClick', 'BrowserSnapshot']);
      const taskId = harness.provider.observation.taskId;
      expect(taskId).toEqual(expect.any(String));
      const finalState = bridge.GetRegionState(taskId!);
      expect(finalState).toMatchObject({ province: { value: '', displayText: '广东省', selected: '广东省' }, city: { value: '', displayText: '佛山市', selected: '佛山市', disabled: false } });
      expect(harness.provider.observation.regionTimeline.map((entry: any) => entry.label)).toEqual(['province-options-open', 'province-selected', 'city-opened']);
      expect(harness.provider.observation.regionTimeline[1].state).toMatchObject({
        province: { value: '', displayText: '广东省', selected: '广东省' },
        city: { disabled: false }, cityOptions: { hidden: true, values: expect.arrayContaining([expect.objectContaining({ value: '佛山市' })]) },
      });
      expect(harness.provider.observation.regionTimeline[2].state).toMatchObject({ city: { expanded: 'true', disabled: false }, cityOptions: { hidden: false } });
      expect(finalState.events.map((event: any) => event.type)).toEqual(expect.arrayContaining(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']));
      const revisions = harness.provider.observation.snapshots.map((entry: any) => entry?.data?.pageRevision).filter((value: unknown) => Number.isSafeInteger(value));
      expect(revisions.length).toBe(5);
      expect(revisions.every((value: number, index: number) => index === 0 || value > revisions[index - 1])).toBe(true);
      expect(bridge.GetProtocolMethods()).toContain('Input.dispatchMouseEvent');
      expect(bridge.GetUserTargets().map((target) => target.targetId)).toEqual(['user-original-tab']);
      expect(harness.events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'pb03-region-success', content: expect.stringContaining('region cascade completed') }));
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
      expect(bridge.GetRetiredTaskIds()).toEqual([taskId]);
      await expect(bridge.Request('chrome', 'cdp', { id: 1, method: 'Target.getTargets', params: {} }, { browserTaskId: taskId }))
        .rejects.toMatchObject({ code: 'BROWSER_TASK_RETIRED' });
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('rejects a disabled city control before dispatching any city mouse event', async () => {
    const bridge = CreateRegionExtensionBridge();
    const root = await mkdtemp(join(tmpdir(), 'avery-pb03-region-disabled-'));
    temporaryRoots.push(root);
    const runtime = new AgentBrowserRuntime({ executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot: join(root, 'browser-runtime'), externalBrowserPaths: { chrome: process.execPath }, browserExtensionBridge: bridge as any, resolveUploadFile: vi.fn(async () => null) });
    await runtime.SetEngine('chrome');
    try {
      const snapshot = await NavigateAndSnapshot(runtime, url);
      const city = FindSnapshotRef(snapshot, 'combobox', /城市/);
      expect(city.metadata.disabled).toBe(true);
      const click = await runtime.Prepare({ toolName: 'BrowserClick', arguments: city });
      await expect(runtime.Execute({ proposal: click, deadline: Date.now() + 10_000 })).rejects.toMatchObject({ code: 'BROWSER_ARGUMENT_INVALID' });
      const taskId = runtime.GetBrowserTaskId();
      expect(bridge.GetRegionState(taskId!)).toMatchObject({ province: { value: '', selected: '' }, city: { value: '', selected: '', disabled: true } });
      const mouseEvents = bridge.GetProtocolMethods().filter((method) => method === 'Input.dispatchMouseEvent');
      expect(mouseEvents).toHaveLength(0);
    } finally {
      await runtime.Close();
    }
  });

  it('fails the cascade oracle when a custom option click does not change DOM state', async () => {
    const bridge = CreateRegionExtensionBridge({ dropOptionEvents: true });
    const harness = await CreateHostHarness(url, bridge, 'drop-option');
    try {
      await expect(harness.host.Send({ requestId: 'pb03-region-drop-event', sessionId: 'pb03-region-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Run the synthetic region cascade.' })).rejects.toThrow(/Region cascade oracle failed/);
      const taskId = harness.provider.observation.taskId;
      expect(bridge.GetRegionState(taskId!)).toMatchObject({ province: { value: '', selected: '' }, city: { value: '', selected: '', disabled: true } });
      expect(harness.provider.observation.actions.filter((name: string) => name === 'BrowserClick')).toHaveLength(2);
      expect(harness.events).toContainEqual(expect.objectContaining({ type: 'error', requestId: 'pb03-region-drop-event', message: expect.stringContaining('Region cascade oracle failed') }));
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: 'run_released', requestId: 'pb03-region-drop-event',
        cleanupOutcomes: [expect.objectContaining({ status: 'confirmed', browserTaskId: taskId })],
      }));
      expect(harness.events.filter((event: any) => event.type === 'error' && /retired/i.test(String(event.message ?? event.content ?? '')))).toHaveLength(0);
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('fails closed when a container ref is clicked instead of the province option', async () => {
    const bridge = CreateRegionExtensionBridge();
    const harness = await CreateHostHarness(url, bridge, 'container');
    try {
      await expect(harness.host.Send({ requestId: 'pb03-region-container', sessionId: 'pb03-region-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Run the synthetic region cascade.' })).rejects.toThrow(/wrong target|expected option/);
      const taskId = harness.provider.observation.taskId;
      expect(bridge.GetRegionState(taskId!)).toMatchObject({ province: { value: '', selected: '' }, city: { value: '', selected: '', disabled: true } });
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('fails closed when the wrong province option text is clicked', async () => {
    const bridge = CreateRegionExtensionBridge();
    const harness = await CreateHostHarness(url, bridge, 'wrong-option');
    try {
      await expect(harness.host.Send({ requestId: 'pb03-region-wrong-option', sessionId: 'pb03-region-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Run the synthetic region cascade.' })).rejects.toThrow(/wrong target|expected option/);
      const taskId = harness.provider.observation.taskId;
      expect(bridge.GetRegionState(taskId!)).toMatchObject({ province: { value: '', displayText: '江西省', selected: '江西省' }, city: { disabled: false } });
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('fails closed when the option action omits the click event even if state changed', async () => {
    const bridge = CreateRegionExtensionBridge({ dropOptionClick: true });
    const harness = await CreateHostHarness(url, bridge, 'missing-click');
    try {
      await expect(harness.host.Send({ requestId: 'pb03-region-missing-click', sessionId: 'pb03-region-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Run the synthetic region cascade.' })).rejects.toThrow(/did not observe click/);
      const taskId = harness.provider.observation.taskId;
      expect(bridge.GetRegionState(taskId!)).toMatchObject({ province: { value: '', displayText: '广东省', selected: '广东省' }, city: { disabled: false } });
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('fails closed when the city trigger reports success but its listbox remains hidden', async () => {
    const bridge = CreateRegionExtensionBridge({ cityOpenFailure: true });
    const harness = await CreateHostHarness(url, bridge, 'city-hidden');
    try {
      await expect(harness.host.Send({ requestId: 'pb03-region-city-hidden', sessionId: 'pb03-region-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Run the synthetic region cascade.' })).rejects.toThrow(/City open oracle failed/);
      const taskId = harness.provider.observation.taskId;
      expect(bridge.GetRegionState(taskId!)).toMatchObject({
        province: { value: '', displayText: '广东省', selected: '广东省' },
        city: { disabled: false, expanded: 'false' },
        cityOptions: { hidden: true },
      });
      expect(harness.events).toContainEqual(expect.objectContaining({ type: 'error', requestId: 'pb03-region-city-hidden', message: expect.stringContaining('City open oracle failed') }));
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('fails closed when a city option changes selection but the listbox does not collapse', async () => {
    const bridge = CreateRegionExtensionBridge({ cityOptionRemainsOpen: true });
    const harness = await CreateHostHarness(url, bridge, 'city-not-collapsed');
    try {
      await expect(harness.host.Send({ requestId: 'pb03-region-city-not-collapsed', sessionId: 'pb03-region-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: 'Run the synthetic region cascade.' })).rejects.toThrow(/Final region oracle failed/);
      const taskId = harness.provider.observation.taskId;
      expect(bridge.GetRegionState(taskId!)).toMatchObject({
        city: { value: '', displayText: '佛山市', selected: '佛山市', expanded: 'true' },
        cityOptions: { hidden: false },
      });
      expect(bridge.CloseTask).toHaveBeenCalledTimes(1);
    } finally {
      await harness.host.Close();
    }
  });

  it('makes an old ref stale after a successful custom-control write', async () => {
    const bridge = CreateRegionExtensionBridge();
    const root = await mkdtemp(join(tmpdir(), 'avery-pb03-region-stale-'));
    temporaryRoots.push(root);
    const runtime = new AgentBrowserRuntime({ executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot: join(root, 'browser-runtime'), externalBrowserPaths: { chrome: process.execPath }, browserExtensionBridge: bridge as any, resolveUploadFile: vi.fn(async () => null) });
    await runtime.SetEngine('chrome');
    try {
      const snapshot = await NavigateAndSnapshot(runtime, url);
      const province = FindSnapshotRef(snapshot, 'combobox', /省份/);
      const click = await runtime.Prepare({ toolName: 'BrowserClick', arguments: province });
      await expect(runtime.Execute({ proposal: click, deadline: Date.now() + 10_000 })).resolves.toMatchObject({ status: 'succeeded', data: { pageRevision: province.pageRevision + 1 } });
      await expect(runtime.Prepare({ toolName: 'BrowserClick', arguments: province })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
    } finally {
      await runtime.Close();
    }
  });
});
