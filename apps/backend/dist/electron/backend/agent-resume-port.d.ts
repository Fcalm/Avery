import type { ResumeSnapshot } from '@offerget/agent-sdk';
import { ResumeLockStore, type ResumeEditLock } from './resume-lock-store';
/**
 * Agent 简历端口（完整方案）：用户与 Agent 共用同一后端锁与乐观锁校验。
 * 读经 business LoadViewModel 获取带 revision 的当前简历；写经 business.UpsertResume，
 * 版本冲突统一映射为 RESUME_REVISION_CONFLICT（Agent 工具层据此决定重试语义）。
 */
export declare class AgentResumePort {
    readonly lockStore: ResumeLockStore;
    private business;
    constructor({ lockStore, business }: {
        lockStore?: ResumeLockStore;
        business: any;
    });
    /** 读取当前简历只读快照（含 revision），供会话级缓存与工具校验。 */
    ReadCurrent(resumeId: string): Promise<ResumeSnapshot | null>;
    /** 尝试获取简历互斥锁；被其他 owner 占用时返回未获取与错误码。 */
    AcquireLock({ resumeId, owner, ownerId, baseRevision }: {
        resumeId: string;
        owner: 'user' | 'agent';
        ownerId: string;
        baseRevision?: number;
    }): Promise<{
        acquired: true;
        lock: ResumeEditLock;
    } | {
        acquired: false;
        code: 'RESUME_LOCKED_BY_USER' | 'RESOURCE_LOCKED';
    }>;
    /** 释放指定 owner 持有的简历锁。 */
    ReleaseLock(resumeId: string, ownerId: string): Promise<void>;
    /** 判断用户当前是否持有该简历锁（供会话工具上下文推导 resumeEditing）。 */
    IsUserEditing(resumeId: string): boolean;
    /** 保存简历并校验乐观锁版本；冲突时抛出 RESUME_REVISION_CONFLICT。 */
    Save({ resume, baseRevision }: {
        resume: ResumeSnapshot;
        baseRevision?: number;
    }): Promise<{
        id: string;
        revision: number;
    }>;
}
