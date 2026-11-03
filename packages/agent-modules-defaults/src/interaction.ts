import { createHash, randomUUID } from 'node:crypto';
import { AgentSdkContractVersion } from '@avery/agent-sdk';
import { ParseAgentResumeData, ResumeDataToText } from '@avery/contracts';
import type { InteractionModule, ToolContext, ToolLedgerEntry, ToolReceipt } from '@avery/agent-sdk';
import { RequireString, type PendingResumeEdit } from './helpers';

/** 交互模块：澄清提问与简历确认的宿主侧状态与事件；AskUserQuestion 作为内置工具由 tools 槽实现。 */
export function CreateInteractionModule(): InteractionModule {
  function GetLedger(context: ToolContext) {
    if (!context.ledger) throw new Error('Persistent Tool Ledger is required to apply a confirmed write.');
    return context.ledger;
  }

  return {
    packageName: '@avery/agent-modules-defaults',
    name: 'avery.agent-defaults',
    version: '0.1.0',
    sdkVersion: AgentSdkContractVersion,
    slot: 'interaction',
    capabilities: ['interaction'],
    /** 应用或丢弃待确认简历补丁：接受时重新获取锁并校验 revision，确认标识只能使用一次；等待期间不持有锁。 */
    async ConfirmResumeEdit(confirmationId, accepted, context: ToolContext) {
      const pending = context.pendingEdits.get(RequireString(confirmationId, 'confirmationId', 300)) as PendingResumeEdit | undefined;
      if (!pending) throw new Error('The resume confirmation is unavailable or has expired.');
      // 确认标识只能使用一次；拒绝/接受/冲突后均不可复用。
      context.pendingEdits.delete(confirmationId);
      if (!accepted) {
        return { applied: false };
      }
      // 旧提案继续使用原协议；新版提案校验数据、预览正文和冻结哈希一致后才进入写入。
      let data = pending.data;
      if (data) {
        const { version, mode, legacyContent, ...fields } = data;
        if (version !== 1 || mode !== 'structured') throw new Error('简历提案数据版本无效');
        data = ParseAgentResumeData(fields, legacyContent);
        if (ResumeDataToText(data) !== pending.content) throw new Error('简历提案正文与结构化数据不一致');
        const canonical = pending.kind === 'create'
          ? { kind: 'create', resumeId: pending.resumeId, name: pending.name, content: pending.content, data, reason: pending.reason }
          : { kind: 'edit', resumeId: pending.resumeId, content: pending.content, data, reason: pending.reason, baseRevision: pending.baseRevision };
        if (createHash('sha256').update(JSON.stringify(canonical)).digest('hex') !== pending.proposalHash) throw new Error('简历提案已变更，请重新提交修改');
      }
      const toolName = pending.kind === 'create' ? 'CreateResume' : 'UpdateResume';
      const ledger = GetLedger(context);
      const previous = await ledger.FindByIdempotencyKey(pending.idempotencyKey);
      if (previous?.status === 'succeeded' && previous.receipt) {
        return { applied: true };
      }
      const ledgerEntry: ToolLedgerEntry = {
        ledgerId: `ledger-${randomUUID()}`,
        runId: context.runId,
        toolCallId: context.requestId,
        toolName,
        idempotencyKey: pending.idempotencyKey,
        argumentsHash: pending.proposalHash,
        actor: `agent:${context.requestId}`,
        resourceIds: [pending.resumeId],
        status: 'started',
        startedAt: Date.now(),
      };
      await ledger.Start(ledgerEntry);
      // 等待期间不持有锁；确认时重新获取 Agent 锁，并用提案冻结的 baseRevision 校验资源未被并发修改。
      const lockResult = await context.ports.resumeWrite.AcquireLock({
        resumeId: pending.resumeId,
        owner: 'agent',
        ownerId: pending.ownerId,
        baseRevision: pending.baseRevision,
      });
      if (!lockResult.acquired) {
        await ledger.Finish(ledgerEntry.ledgerId, 'failed', { errorCode: lockResult.code });
        throw Object.assign(new Error('User is editing this resume.'), { code: lockResult.code });
      }
      let saved;
      try {
        saved = await context.ports.resumeWrite.Save({
          resume: pending.kind === 'create'
            ? { id: pending.resumeId, name: pending.name ?? '', content: pending.content, ...(data ? { data, templateId: 'classic' as const } : {}), updatedAt: '', targetRoles: [], summary: pending.content.slice(0, 120) }
            : { ...pending.resume, id: pending.resumeId, name: pending.resume?.name ?? '', content: pending.content, ...(data ? { data } : {}), updatedAt: '', targetRoles: pending.resume?.targetRoles, summary: pending.resume?.summary },
          baseRevision: pending.baseRevision,
        });
      } catch (error) {
        await ledger.Finish(ledgerEntry.ledgerId, 'failed', { errorCode: 'SAVE_FAILED' });
        throw error;
      } finally {
        await context.ports.resumeWrite.ReleaseLock(pending.resumeId, pending.ownerId);
      }
      const receipt: ToolReceipt = {
        receiptId: `receipt-${randomUUID()}`,
        toolDefinitionId: toolName,
        resourceIds: [pending.resumeId],
        revisions: { resume: saved.revision },
        idempotencyKey: pending.idempotencyKey,
      };
      await ledger.Finish(ledgerEntry.ledgerId, 'succeeded', { receipt });
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
