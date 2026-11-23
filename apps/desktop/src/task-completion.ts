export interface NoticeQuestion { id: string; question: string; options: string[] }
export type NoticeInteraction =
  | { kind: 'approval'; id: string; summary: string; url?: string; risk?: string }
  | { kind: 'question'; id: string; questions: NoticeQuestion[] };

export interface TaskCompletionNotice {
  sessionId: string;
  requestId: string;
  title: string;
  playSound: boolean;
  interaction?: NoticeInteraction;
}

export interface NoticeIdentity { sessionId: string; requestId: string; interactionId?: string }
export type NoticeSubmitResult = { ok: true } | { ok: false; message: string; stale?: boolean };

interface CompletionDependencies {
  isForeground: () => boolean;
  readSettings: () => Promise<{ notifyOnComplete?: boolean; notifySound?: boolean } | undefined>;
  readTitle: (sessionId: string) => Promise<string>;
  show: (notice: TaskCompletionNotice) => void;
  dismissInteractions?: (identity: NoticeIdentity) => void;
  log: (error: unknown) => void;
}

const IsId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const RecordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 只把具备真实交互标识的宿主提案转成可操作通知，普通等待文本不具备审批能力。 */
export function NoticeInteractionOf(event: unknown): NoticeInteraction | undefined {
  const value = RecordOf(event);
  const browser = RecordOf(value.browserAction);
  const id = value.type === 'browser_confirmation' ? browser.confirmationId : value.confirmationId;
  if (!IsId(id)) return;
  if (value.type === 'question_requested') {
    if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > 20) return;
    const questions: NoticeQuestion[] = [];
    for (const raw of value.questions) {
      const question = RecordOf(raw);
      if (!IsId(question.id) || typeof question.question !== 'string' || !question.question.trim()
        || !Array.isArray(question.options) || question.options.some((item) => typeof item !== 'string')
        || new Set(questions.map((item) => item.id)).has(question.id)) return;
      questions.push({ id: question.id, question: question.question, options: [...new Set(question.options as string[])] });
    }
    return { kind: 'question', id, questions };
  }
  const cron = RecordOf(value.cronTask);
  if (!['resume_confirmation', 'browser_confirmation', 'cron_task_confirmation'].includes(String(value.type))) return;
  const summary = value.type === 'resume_confirmation'
    ? [value.resumeName, value.reason || '更新简历内容'].filter((item) => typeof item === 'string').join(' · ')
    : value.type === 'browser_confirmation' ? browser.summary || '确认执行浏览器操作' : cron.summary || cron.message || cron.title || '创建定时任务';
  return { kind: 'approval', id, summary: String(summary).slice(0, 1000),
    ...(typeof browser.url === 'string' ? { url: browser.url.slice(0, 2000) } : {}),
    ...(typeof browser.risk === 'string' ? { risk: browser.risk } : {}) };
}

/** 完成、审批与问题都遵循后台提醒偏好；等待点与完成事件分别去重，异步结果不能复活失效提案。 */
export function CreateTaskCompletionHandler(dependencies: CompletionDependencies) {
  const handled = new Set<string>();
  const epochs = new Map<string, number>();
  return async (event: unknown): Promise<void> => {
    if (!event || typeof event !== 'object') return;
    const { type, requestId, sessionId } = event as Record<string, unknown>;
    if (!IsId(requestId) || !IsId(sessionId)) return;
    const runKey = JSON.stringify([sessionId, requestId]);
    const resolve = () => {
      epochs.set(runKey, (epochs.get(runKey) ?? 0) + 1);
      if (epochs.size > 256) epochs.delete(epochs.keys().next().value!);
      dependencies.dismissInteractions?.({ sessionId, requestId });
    };
    if (['run_resumed', 'cancelled', 'error'].includes(String(type))) { resolve(); return; }
    const interaction = NoticeInteractionOf(event);
    if (type !== 'completed' && !interaction) return;
    const key = JSON.stringify([sessionId, requestId, interaction?.id ?? 'completed']);
    if (handled.has(key)) return;
    handled.add(key);
    if (handled.size > 256) handled.delete(handled.values().next().value!);
    if (type === 'completed') resolve();
    const epoch = epochs.get(runKey) ?? 0;
    try {
      if (dependencies.isForeground()) return;
      const settings = await dependencies.readSettings();
      // 旧配置缺少通知字段时与设置界面的默认开启保持一致；读取失败则不擅自提醒。
      if (!settings || settings.notifyOnComplete === false) return;
      const title = await dependencies.readTitle(sessionId).catch(() => 'Avery 任务');
      if (dependencies.isForeground() || (epochs.get(runKey) ?? 0) !== epoch) return;
      dependencies.show({ sessionId, requestId, title: title.trim().slice(0, 240) || 'Avery 任务', playSound: settings.notifySound !== false, ...(interaction ? { interaction } : {}) });
    } catch (error) {
      dependencies.log(error);
    }
  };
}

export { TaskNotificationHtml } from './task-notification-page';
