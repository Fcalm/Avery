import type { InteractionModule, ToolContext } from '@offerget/agent-sdk';
import { RequireString, type PendingResumeEdit } from './helpers';

/** 交互模块：澄清提问与简历确认的宿主侧状态与事件；AskUserQuestion 作为内置工具由 tools 槽实现。 */
export function CreateInteractionModule(): InteractionModule {
  return {
    packageName: '@offerget/agent-modules-defaults',
    name: 'offerget.agent-defaults',
    version: '0.1.0',
    sdkVersion: '0.1.0',
    slot: 'interaction',
    capabilities: ['interaction'],
    /** 应用或丢弃待确认简历补丁：接受时经写端口整份落库并释放锁，确认标识只能使用一次。 */
    async ConfirmResumeEdit(confirmationId, accepted, context: ToolContext) {
      const pending = context.pendingEdits.get(RequireString(confirmationId, 'confirmationId', 300)) as PendingResumeEdit | undefined;
      if (!pending) throw new Error('The resume confirmation is unavailable or has expired.');
      context.pendingEdits.delete(confirmationId);
      if (!accepted) {
        await context.ports.resumeWrite.ReleaseLock(pending.resumeId, pending.ownerId);
        return { applied: false };
      }
      // 落库失败也必须释放锁（否则残留至租约过期，阻塞用户编辑与后续 Agent 编辑）。
      let saved;
      try {
        saved = await context.ports.resumeWrite.Save({
          resume: pending.kind === 'create'
            ? { id: pending.resumeId, name: pending.name ?? '', content: pending.content, updatedAt: '', targetRoles: [], summary: pending.content.slice(0, 120) }
            : { id: pending.resumeId, name: pending.resume?.name ?? '', content: pending.content, updatedAt: '', targetRoles: pending.resume?.targetRoles, summary: pending.resume?.summary },
          baseRevision: pending.baseRevision,
        });
      } finally {
        await context.ports.resumeWrite.ReleaseLock(pending.resumeId, pending.ownerId);
      }
      context.emit(pending.kind === 'create'
        ? { type: 'resume_created', requestId: context.requestId, resumeId: pending.resumeId, resumeName: pending.name, content: pending.content, reason: pending.reason, revision: saved.revision }
        : { type: 'resume_updated', requestId: context.requestId, resumeId: pending.resumeId, content: pending.content, reason: pending.reason, revision: saved.revision });
      return { applied: true };
    },
    /** 返回会话当前挂起的澄清提问；无提问返回 null。 */
    GetPendingQuestions(sessionId, pendingQuestions) {
      return pendingQuestions.get(sessionId) ?? null;
    },
    /** 清除会话挂起的澄清提问。 */
    ClearPendingQuestion(sessionId, pendingQuestions) {
      pendingQuestions.delete(sessionId);
    },
  };
}
