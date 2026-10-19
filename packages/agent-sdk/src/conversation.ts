/** 面向用户的会话投影，与调试 Trace 分离；只保存可展示的正文、状态和资源引用。 */
export type ConversationRunStatus = 'running' | 'completed' | 'waiting' | 'paused' | 'cancelled' | 'failed' | 'interrupted';
export type ConversationToolStatus = 'running' | 'succeeded' | 'waiting' | 'paused' | 'failed' | 'cancelled' | 'skipped';
export interface ConversationResource {
  kind: 'resume' | 'profile' | 'job' | 'application' | 'file';
  id: string;
  title: string;
  revision?: number;
  /** 文件只接受宿主授权的虚拟标识，不传递绝对路径。 */
  fileName?: string;
  produced?: boolean;
}
export type ConversationPart =
  | { id: string; stepId: string; type: 'text'; text: string }
  | { id: string; stepId: string; type: 'reasoning'; text: string }
  | { id: string; stepId: string; type: 'tool'; toolCallId: string; name: string; status: ConversationToolStatus; summary: string; startedAt: number; completedAt?: number }
  | { id: string; stepId: string; type: 'resource'; resource: ConversationResource; toolCallId?: string };
export interface ConversationPresentation {
  version: 1;
  requestId: string;
  sequence: number;
  status: ConversationRunStatus;
  parts: ConversationPart[];
  error?: string;
}
export interface ConversationActivity {
  kind: 'step' | 'text' | 'reasoning' | 'tool' | 'resource' | 'status';
  stepId?: string;
  partId?: string;
  delta?: string;
  toolCallId?: string;
  name?: string;
  toolStatus?: ConversationToolStatus;
  summary?: string;
  resource?: ConversationResource;
  status?: ConversationRunStatus;
  error?: string;
}

export function CreateConversationPresentation(requestId: string): ConversationPresentation {
  return { version: 1, requestId, sequence: 0, status: 'running', parts: [] };
}

/** 纯投影归并：块与调用按稳定 ID 更新，只有同一块的增量可拼接。 */
export function ApplyConversationActivity(
  current: ConversationPresentation, activity: ConversationActivity, sequence: number, now: number,
): ConversationPresentation {
  if (sequence <= current.sequence) return current;
  let parts = current.parts;
  const stepId = activity.stepId ?? parts.at(-1)?.stepId ?? current.requestId;
  if ((activity.kind === 'text' || activity.kind === 'reasoning') && activity.partId && activity.delta) {
    const existing = parts.find((part) => part.id === activity.partId);
    parts = existing
      ? parts.map((part) => part.id === existing.id && (part.type === 'text' || part.type === 'reasoning') ? { ...part, text: part.text + activity.delta } : part)
      : [...parts, { id: activity.partId, stepId, type: activity.kind, text: activity.delta }];
  } else if (activity.kind === 'tool' && activity.toolCallId && activity.name) {
    const id = 'tool:' + stepId + ':' + activity.toolCallId;
    const existing = parts.find((part) => part.id === id);
    const tool: ConversationPart = {
      id, stepId, type: 'tool', toolCallId: activity.toolCallId, name: activity.name,
      status: activity.toolStatus ?? 'running', summary: activity.summary ?? '',
      startedAt: existing?.type === 'tool' ? existing.startedAt : now,
      ...(activity.toolStatus && activity.toolStatus !== 'running' ? { completedAt: now } : {}),
    };
    parts = existing ? parts.map((part) => part.id === id ? tool : part) : [...parts, tool];
  } else if (activity.kind === 'resource' && activity.resource) {
    const resource = activity.resource;
    const id = 'resource:' + resource.kind + ':' + resource.id + ':' + (resource.revision ?? '');
    const existing = parts.find((part) => part.id === id);
    if (!existing) parts = [...parts, { id, stepId, type: 'resource', resource, ...(activity.toolCallId ? { toolCallId: activity.toolCallId } : {}) }];
    else if (existing.type === 'resource') {
      const upgrade = resource.produced && !existing.resource.produced;
      const attachTool = activity.toolCallId && (!existing.toolCallId || upgrade);
      // 实体事件可能先于工具回执；补齐调用归属时保留同一张卡片及已确认的产物状态。
      if (upgrade || attachTool) parts = parts.map((part) => part.id === id ? {
        ...existing,
        ...(attachTool ? { stepId, toolCallId: activity.toolCallId } : {}),
        resource: { ...existing.resource, ...resource, produced: existing.resource.produced || resource.produced },
      } : part);
    }
  }
  const status = activity.kind === 'status' ? activity.status ?? current.status : current.status;
  if (activity.kind === 'status' && status !== 'running') {
    parts = parts.map((part) => part.type === 'tool' && part.status === 'running'
      ? { ...part, status: status === 'waiting' ? 'waiting' : status === 'cancelled' ? 'cancelled' : status === 'completed' ? 'skipped' : status === 'paused' ? 'paused' : 'failed', completedAt: now }
      : part);
  }
  return { ...current, sequence, parts, status, ...(activity.error ? { error: activity.error } : {}) };
}

/** 最终正文只取最后一次工具调用之后的文本；中间解说保留在过程里。 */
export function GetConversationResult(presentation: ConversationPresentation): string {
  let lastTool = -1;
  presentation.parts.forEach((part, index) => { if (part.type === 'tool') lastTool = index; });
  return presentation.parts.slice(lastTool + 1).flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n');
}

/** 磁盘快照的基础校验；结构不合法时不把它当成新的展示协议。 */
export function IsConversationPresentation(value: unknown): value is ConversationPresentation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ConversationPresentation;
  return candidate.version === 1 && typeof candidate.requestId === 'string'
    && (candidate.error === undefined || typeof candidate.error === 'string')
    && Number.isSafeInteger(candidate.sequence) && candidate.sequence >= 0
    && ['running', 'completed', 'waiting', 'paused', 'cancelled', 'failed', 'interrupted'].includes(candidate.status)
    && Array.isArray(candidate.parts) && candidate.parts.every((part) => {
      if (!part || typeof part.id !== 'string' || typeof part.stepId !== 'string') return false;
      if (part.type === 'text' || part.type === 'reasoning') return typeof part.text === 'string';
      if (part.type === 'tool') return typeof part.toolCallId === 'string' && typeof part.name === 'string' && typeof part.summary === 'string'
        && Number.isFinite(part.startedAt) && (part.completedAt === undefined || Number.isFinite(part.completedAt))
        && ['running', 'succeeded', 'waiting', 'paused', 'failed', 'cancelled', 'skipped'].includes(part.status);
      if (part.type === 'resource') return !!part.resource && ['resume', 'profile', 'job', 'application', 'file'].includes(part.resource.kind)
        && typeof part.resource.id === 'string' && typeof part.resource.title === 'string'
        && (part.resource.revision === undefined || Number.isSafeInteger(part.resource.revision) && part.resource.revision > 0)
        && (part.resource.fileName === undefined || typeof part.resource.fileName === 'string')
        && (part.resource.produced === undefined || typeof part.resource.produced === 'boolean');
      return false;
    });
}

/** 内链必须匹配宿主已确认的引用；不把任意协议、路径或模型编造的 ID 变成系统能力。 */
export function MatchConversationResourceHref(href: string, resources: readonly ConversationResource[]): ConversationResource | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== 'avery:' || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some((key) => key !== 'revision') || url.searchParams.getAll('revision').length > 1) return undefined;
    const id = decodeURIComponent(url.pathname.slice(1));
    const revision = url.searchParams.get('revision');
    if (revision !== null && (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)))) return undefined;
    return resources.find((resource) => resource.kind === url.hostname && resource.id === id && resource.revision === (revision === null ? undefined : Number(revision)));
  } catch { return undefined; }
}
