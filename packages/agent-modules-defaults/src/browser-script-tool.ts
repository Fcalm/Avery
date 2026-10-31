import type { AgentMessage, BrowserToolName, ToolCallFragment, ToolContext, ToolExecutionResult } from '@avery/agent-sdk';
import { BrowserScriptError, BrowserScriptMethods, RunBrowserScript, type ScriptValue } from './browser-script';

type Payload = Record<string, ScriptValue>;
class ScriptStopped {
  constructor(readonly result: ToolExecutionResult, readonly payload: Payload) {}
}

/** 每个脚本调用独立运行，暂停时只保留已发生的事实，不保存可自动重放的脚本续体。 */
export async function ExecuteBrowserScript(input: {
  context: ToolContext; callId: string; args: Record<string, unknown>;
  execute: (call: ToolCallFragment, context: ToolContext) => Promise<ToolExecutionResult>;
  trace?: (payload: Record<string, unknown>) => void;
}): Promise<ToolExecutionResult> {
  const { context, callId, args } = input;
  const steps: Array<{ index: number; tool: string; ok: boolean; code?: string }> = [];
  const observations: Array<{ step: number; data: ScriptValue }> = [];
  const followups: AgentMessage[] = [];
  let revision = typeof args.pageRevision === 'number' ? args.pageRevision : undefined;
  let needsObservation = context.requiresBrowserSnapshot === true;
  let snapshotInScript = false;
  let lastUrl: string | undefined;
  const result = (payload: Record<string, unknown>, extra: Partial<ToolExecutionResult> = {}): ToolExecutionResult => ({
    role: 'tool', tool_call_id: callId,
    content: JSON.stringify({ ...payload, steps, observations, replay: 'Never replay completed steps. After user confirmation or takeover, observe again and plan only the remaining work.' }),
    ...(followups.length ? { followupMessages: followups } : {}), ...extra,
  });
  const invalid = (message: string): never => { throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', message); };
  try {
    if (!context.allowedToolNames || !context.ports.browser) return result({ ok: false, code: 'BROWSER_SCRIPT_UNAVAILABLE', message: 'Script requires a browser and the frozen Run tool whitelist.' });
    const executed = await RunBrowserScript({
      script: String(args.script ?? ''), signal: context.signal, deadline: context.deadline,
      call: async (method, values) => {
        if (steps.length >= 30) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'At most 30 browser operations are allowed per script.');
        const toolName: BrowserToolName = BrowserScriptMethods[method];
        if (!context.allowedToolNames!.has(toolName)) throw new BrowserScriptError('TOOL_NOT_ALLOWED', `${toolName} is unavailable in this Run.`);
        if (lastUrl === undefined) lastUrl = (await context.ports.browser!.GetStatus()).currentUrl;
        const string = (index: number): string => typeof values[index] === 'string' ? values[index] as string : invalid('Expected a string argument.');
        const options = (): Record<string, ScriptValue> => values.length === 0 ? {} : values[0] && typeof values[0] === 'object' && !Array.isArray(values[0]) ? values[0] as Record<string, ScriptValue> : invalid('Expected an options object.');
        const counts: Record<string, number[]> = { navigate: [1], snapshot: [0, 1], screenshot: [0], readPage: [0], fill: [2], click: [1], press: [1], select: [2], setChecked: [2], uploadFile: [2,3], fillForm: [1], validateForm: [0], wait: [1], switchTab: [1], goBack: [0] };
        if (!counts[method].includes(values.length)) invalid(`Wrong argument count for page.${method}.`);
        const refMethods = ['fill', 'click', 'select', 'setChecked', 'uploadFile'];
        if ((refMethods.includes(method) && revision === undefined) || (needsObservation && (refMethods.includes(method) || method === 'press'))) throw new BrowserScriptError('BROWSER_SNAPSHOT_CONTEXT_LOST', 'Call page.snapshot() before using page references or keys.');
        let childArgs: Record<string, unknown>;
        switch (method) {
          case 'navigate': childArgs = { url: string(0) }; break;
          case 'fill': childArgs = { ref: string(0), pageRevision: revision, text: string(1) }; break;
          case 'click': childArgs = { ref: string(0), pageRevision: revision }; break;
          case 'select': childArgs = { ref: string(0), pageRevision: revision, value: string(1) }; break;
          case 'setChecked': childArgs = { ref: string(0), pageRevision: revision, checked: values[1] }; break;
          case 'uploadFile': {
            const uploadOptions = values.length===3 ? values[2] : {};
            if (!uploadOptions || typeof uploadOptions!=='object' || Array.isArray(uploadOptions)) invalid('Upload options must be an object.');
            childArgs = {...uploadOptions as Record<string,ScriptValue>,ref:string(0),pageRevision:revision,fileId:string(1)}; break;
          }
          case 'press': childArgs = { key: string(0) }; break;
          case 'switchTab': childArgs = { tabId: string(0) }; break;
          case 'snapshot': case 'fillForm': case 'wait': childArgs = options(); break;
          default: childArgs = {};
        }
        const index = steps.length + 1;
        if (context.consumeBrowserScriptStep?.() === false) throw new BrowserScriptError('TOOL_CALL_BUDGET_EXHAUSTED', 'The Run tool budget is exhausted. Completed script actions must not be repeated.');
        const childId = `${callId}:browser:${index}`;
        const activity = (toolStatus: 'running' | 'succeeded' | 'failed' | 'waiting' | 'paused', summary: string) => context.emit({
          type: 'conversation_activity', requestId: context.requestId,
          activity: { kind: 'tool', toolCallId: childId, name: toolName, toolStatus, summary },
        });
        activity('running', `脚本第 ${index} 步`);
        const childContext: ToolContext = {
          ...context, requiresBrowserSnapshot: needsObservation, browserSnapshotResultId: callId,
          hasToolResultInContext: (id) => (id === callId && snapshotInScript) || context.hasToolResultInContext?.(id) === true,
        };
        const child = await input.execute({ id: childId, type: 'function', function: { name: toolName, arguments: JSON.stringify(childArgs) } }, childContext);
        const payload = JSON.parse(child.content) as Payload;
        const ok = payload.ok === true;
        steps.push({ index, tool: toolName, ok, ...(typeof payload.code === 'string' ? { code: payload.code } : {}) });
        input.trace?.({ parentToolCallId: callId, toolCallId: childId, index, name: toolName, ok, code: payload.code });
        // 截图仅保留脚本里最新一张供下一轮视觉判断，避免脚本内累计重复图像。
        if (child.followupMessages?.length) { followups.length = 0; followups.push(...child.followupMessages); }
        const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data as Payload : undefined;
        const currentUrl = typeof data?.currentUrl === 'string' ? data.currentUrl : undefined;
        const navigated = Boolean(lastUrl && currentUrl && currentUrl !== lastUrl);
        if (currentUrl) lastUrl = currentUrl;
        if (typeof data?.pageRevision === 'number') revision = data.pageRevision;
        if (method === 'snapshot' && ok) {
          needsObservation = false; snapshotInScript = true;
          observations.push({ step: index, data: payload.data });
          if (JSON.stringify(observations).length > 96000) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'Snapshot output budget exhausted. Stop and use the observations already collected.');
        }
        const waiting = child.disposition === 'wait_confirmation' || child.disposition === 'wait_user_input';
        activity(waiting ? 'waiting' : child.disposition === 'pause' ? 'paused' : ok ? 'succeeded' : 'failed', `脚本第 ${index} 步${ok ? '完成' : '停止'}`);
        if (!ok || waiting || child.disposition === 'pause') {
          // 宿主 checkpoint 对应的是外层模型调用；确认仍只执行冻结的那一个子动作。
          const confirmationId = payload.confirmationId;
          if (typeof confirmationId === 'string') {
            const pending = context.pendingBrowserActions?.get(confirmationId);
            if (pending && typeof pending === 'object') Object.assign(pending, { toolCallId: callId });
            context.persistSessionState();
          }
          throw new ScriptStopped(child, payload);
        }
        if ((method==='uploadFile' || method==='wait') && data?.readyForFill===false) {
          throw new ScriptStopped(child,{...payload,ok:false,code:data.parseStatus==='failed'?'BROWSER_RESUME_PARSE_FAILED':'BROWSER_RESUME_PARSE_PENDING',message:'Upload is not ready for form filling. Review the existing import; do not blindly repeat the upload.'});
        }
        // 导航后只允许先观察。普通按键会废弃元素引用，但连续按键本身仍可按计划顺序执行。
        if (['navigate', 'switchTab', 'goBack'].includes(method) || (navigated && method !== 'snapshot')) { needsObservation = true; revision = undefined; }
        if (['click', 'select', 'uploadFile'].includes(method) || (method === 'press' && data?.referencesPreserved !== true)) revision = undefined;
        return (payload.data ?? payload) as ScriptValue;
      },
    });
    return result({ ok: true, code: 'BROWSER_SCRIPT_COMPLETED', browserState: { requiresSnapshot: needsObservation }, ...executed });
  } catch (error) {
    if (error instanceof ScriptStopped) return result({ ...error.payload, failedStep: steps.length }, { disposition: error.result.disposition, receipt: error.result.receipt });
    return result({ ok: false, code: error instanceof BrowserScriptError ? error.code : context.signal?.aborted ? 'CANCELLED' : 'BROWSER_SCRIPT_FAILED', message: error instanceof Error ? error.message : 'Script stopped.', completedSteps: steps.filter((step) => step.ok).length });
  }
}
