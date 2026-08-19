"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateInteractionModule = CreateInteractionModule;
const node_crypto_1 = require("node:crypto");
const helpers_1 = require("./helpers");
/** 交互模块：澄清提问与简历确认的宿主侧状态与事件；AskUserQuestion 作为内置工具由 tools 槽实现。 */
function CreateInteractionModule() {
    const fallbackLedger = new Map();
    function GetLedger(context) {
        return context.ledger ?? {
            Start(entry) {
                fallbackLedger.set(entry.ledgerId, { ...entry, status: 'started', startedAt: entry.startedAt });
            },
            Finish(ledgerId, status, extra) {
                const current = fallbackLedger.get(ledgerId);
                if (!current)
                    return;
                fallbackLedger.set(ledgerId, { ...current, status, ...(extra?.receipt ? { receipt: extra.receipt } : {}), ...(extra?.errorCode ? { errorCode: extra.errorCode } : {}), finishedAt: extra?.finishedAt ?? Date.now() });
            },
            FindByIdempotencyKey(idempotencyKey) {
                for (const entry of fallbackLedger.values()) {
                    if (entry.idempotencyKey === idempotencyKey && entry.status !== 'started')
                        return entry;
                }
                return undefined;
            },
        };
    }
    return {
        packageName: '@offerget/agent-modules-defaults',
        name: 'offerget.agent-defaults',
        version: '0.1.0',
        sdkVersion: '0.1.0',
        slot: 'interaction',
        capabilities: ['interaction'],
        /** 应用或丢弃待确认简历补丁：接受时重新获取锁并校验 revision，确认标识只能使用一次；等待期间不持有锁。 */
        async ConfirmResumeEdit(confirmationId, accepted, context) {
            const pending = context.pendingEdits.get((0, helpers_1.RequireString)(confirmationId, 'confirmationId', 300));
            if (!pending)
                throw new Error('The resume confirmation is unavailable or has expired.');
            // 确认标识只能使用一次；拒绝/接受/冲突后均不可复用。
            context.pendingEdits.delete(confirmationId);
            if (!accepted) {
                return { applied: false };
            }
            const toolName = pending.kind === 'create' ? 'CreateResume' : 'UpdateResume';
            const ledger = GetLedger(context);
            const previous = await ledger.FindByIdempotencyKey(pending.idempotencyKey);
            if (previous?.status === 'succeeded' && previous.receipt) {
                return { applied: true };
            }
            const ledgerEntry = {
                ledgerId: `ledger-${(0, node_crypto_1.randomUUID)()}`,
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
                        ? { id: pending.resumeId, name: pending.name ?? '', content: pending.content, updatedAt: '', targetRoles: [], summary: pending.content.slice(0, 120) }
                        : { id: pending.resumeId, name: pending.resume?.name ?? '', content: pending.content, updatedAt: '', targetRoles: pending.resume?.targetRoles, summary: pending.resume?.summary },
                    baseRevision: pending.baseRevision,
                });
            }
            catch (error) {
                await ledger.Finish(ledgerEntry.ledgerId, 'failed', { errorCode: 'SAVE_FAILED' });
                throw error;
            }
            finally {
                await context.ports.resumeWrite.ReleaseLock(pending.resumeId, pending.ownerId);
            }
            const receipt = {
                receiptId: `receipt-${(0, node_crypto_1.randomUUID)()}`,
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
