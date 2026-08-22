import type { AgentMessage, ConfirmationMode } from '@offerget/agent-sdk';

/** 发给模型的最小运行状态；不复制 Session/Run 的权威状态机或业务快照。 */
export interface RuntimeReminderState {
  now: number;
  timeZone: string;
  usedTurns: number;
  maxTurns: number;
  confirmationMode: ConfirmationMode;
  finalTurn: boolean;
}

/** 首轮、固定间隔和最后一轮追加提醒；调用方可在权限变化时额外请求一次。 */
export function ShouldInjectRuntimeReminder(usedTurns: number, maxTurns: number, interval: number, confirmationChanged = false): boolean {
  if (!Number.isSafeInteger(usedTurns) || usedTurns < 0) throw new Error('usedTurns must be a non-negative integer.');
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer.');
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('runtime reminder interval must be a positive integer.');
  return confirmationChanged || usedTurns === 0 || usedTurns % interval === 0 || usedTurns === maxTurns - 1;
}

/** 生成由固定 runtime-reminder 标签包裹的直白英语状态栏；不包含 Session、Scenario 或创建时间。 */
export function BuildRuntimeReminder(state: RuntimeReminderState): string {
  const instant = new Date(state.now);
  if (Number.isNaN(instant.getTime())) throw new Error('Runtime reminder time is invalid.');
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: state.timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(instant);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: state.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instant);
  const mode = state.confirmationMode === 'always_confirm'
    ? 'always confirm'
    : state.confirmationMode === 'allow_low_risk'
      ? 'allow low-risk actions'
      : 'fully trusted';
  const remaining = Math.max(0, state.maxTurns - state.usedTurns);
  const lines = [
    `Today is ${date}. The current local time is ${time} in ${state.timeZone}.`,
    `Used turns: ${state.usedTurns} of ${state.maxTurns}. Remaining turns: ${remaining}.`,
    `Current confirmation mode: ${mode}.`,
  ];
  if (state.finalTurn) {
    lines.push('This is the final available turn. Do not start new tool calls. Conclude the current work and explain anything that remains unfinished.');
  }
  lines.push('The above is the current runtime status. No response is needed; continue the task.');
  return `<runtime-reminder>\n${lines.join('\n')}\n</runtime-reminder>`;
}

/** 构造内部可识别但 Provider 只会收到 role/content 的 append-only user 消息。 */
export function CreateRuntimeReminderMessage(state: RuntimeReminderState, reminderRevision: number): AgentMessage {
  return {
    role: 'user',
    content: BuildRuntimeReminder(state),
    metadata: {
      source: 'runtime',
      visibility: 'hidden',
      kind: 'runtime_reminder',
      reminderRevision,
      injectedAtTurn: state.usedTurns,
    },
  };
}
