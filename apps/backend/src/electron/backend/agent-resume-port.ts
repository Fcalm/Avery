import type { ResumeSnapshot } from '@offerget/agent-sdk';
import { ResumeLockStore, type ResumeEditLock } from './resume-lock-store';

/**
 * Agent 简历端口（完整方案）：用户与 Agent 共用同一后端锁与乐观锁校验。
 * 读经 business LoadViewModel 获取带 revision 的当前简历；写经 business.UpsertResume，
 * 版本冲突统一映射为 RESUME_REVISION_CONFLICT（Agent 工具层据此决定重试语义）。
 */
export class AgentResumePort {
  readonly lockStore: ResumeLockStore;
  private business: any;

  constructor({ lockStore, business }: { lockStore?: ResumeLockStore; business: any }) {
    this.lockStore = lockStore ?? new ResumeLockStore();
    this.business = business;
  }

  /** 读取当前简历只读快照（含 revision），供会话级缓存与工具校验。 */
  async ReadCurrent(resumeId: string): Promise<ResumeSnapshot | null> {
    const viewModel = await this.business.LoadViewModel();
    return viewModel.resumes.find((resume: any) => resume.id === resumeId) ?? null;
  }

  /** 尝试获取简历互斥锁；被其他 owner 占用时返回未获取与错误码。 */
  async AcquireLock({ resumeId, owner, ownerId, baseRevision }: { resumeId: string; owner: 'user' | 'agent'; ownerId: string; baseRevision?: number }): Promise<{ acquired: true; lock: ResumeEditLock } | { acquired: false; code: 'RESUME_LOCKED_BY_USER' | 'RESOURCE_LOCKED' }> {
    const lock = this.lockStore.Acquire(resumeId, owner, ownerId, baseRevision);
    if (!lock) return { acquired: false, code: owner === 'user' ? 'RESOURCE_LOCKED' : 'RESUME_LOCKED_BY_USER' };
    return { acquired: true, lock };
  }

  /** 释放指定 owner 持有的简历锁。 */
  async ReleaseLock(resumeId: string, ownerId: string): Promise<void> {
    this.lockStore.Release(resumeId, ownerId);
  }

  /** 判断用户当前是否持有该简历锁（供会话工具上下文推导 resumeEditing）。 */
  IsUserEditing(resumeId: string): boolean {
    return this.lockStore.GetLock(resumeId)?.owner === 'user';
  }

  /** 保存简历并校验乐观锁版本；冲突时抛出 RESUME_REVISION_CONFLICT。 */
  async Save({ resume, baseRevision }: { resume: ResumeSnapshot; baseRevision?: number }): Promise<{ id: string; revision: number }> {
    try {
      const result = await this.business.UpsertResume(resume, baseRevision);
      return { id: result.id, revision: result.revision };
    } catch (error: any) {
      if (error && error.code === 'REVISION_CONFLICT') {
        throw Object.assign(new Error('简历已被其他人修改，请刷新后重试。'), {
          code: 'RESUME_REVISION_CONFLICT',
          ...(error.entityType ? { entityType: error.entityType } : {}),
          ...(error.entityId ? { entityId: error.entityId } : {}),
          ...(error.expectedRevision != null ? { expectedRevision: error.expectedRevision } : {}),
          ...(error.actualRevision != null ? { actualRevision: error.actualRevision } : {}),
        });
      }
      throw error;
    }
  }
}
