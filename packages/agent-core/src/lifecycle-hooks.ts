import type { KernelHookCandidate, KernelRunInput } from '@avery/agent-sdk';

/** 运行宿主注册的钩子并记录结果。只记录身份和判定，候选正文继续由对话历史管理。 */
export async function RunLifecycleHook(
  input: KernelRunInput, event: 'stop' | 'resume', candidate: KernelHookCandidate,
) {
  const hook = input.hooks?.[event];
  if (!hook) return undefined;
  input.signal.throwIfAborted();
  const trace = input.modules.observability;
  const identity = { hook: event, stepId: candidate.stepId, goalId: input.goal?.id };
  trace.AppendTraceEvent(input.requestId, 'lifecycle_hook_started', identity);
  try {
    const decision = await hook(candidate);
    input.signal.throwIfAborted();
    trace.AppendTraceEvent(input.requestId, 'lifecycle_hook_finished', { ...identity, decision: decision.status });
    return decision;
  } catch (error) {
    trace.AppendTraceEvent(input.requestId, 'lifecycle_hook_finished', { ...identity, decision: input.signal.aborted ? 'interrupted' : 'failed' });
    throw error;
  }
}
