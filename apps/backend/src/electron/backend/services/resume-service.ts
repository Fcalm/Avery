/** 简历及其版本的应用服务：封装简历 Repository，提供创建、编辑、重命名、删除与三版本管理。 */
export class ResumeService {
  private repository: any;

  constructor({ repository }: { repository: any }) {
    this.repository = repository;
  }

  /** 读取全部未删除简历，供工作空间聚合视图使用。 */
  ListAll(): any {
    return this.repository.ListAll();
  }

  /** 创建或更新简历，并在正文变化时追加版本快照；透传期望版本供冲突检测。 */
  Upsert(resume: any, expectedRevision?: number): any {
    return this.repository.Upsert(resume, expectedRevision);
  }

  /** 重命名简历，不产生内容版本；透传期望版本供冲突检测。 */
  Rename(id: string, name: string, expectedRevision?: number): any {
    return this.repository.Rename(id, name, expectedRevision);
  }

  /** 逻辑删除简历。 */
  Delete(id: string): any {
    return this.repository.Delete(id);
  }

  /** 返回当前版本与最多两份历史版本。 */
  GetRevisions(resumeId: string): any {
    return this.repository.GetRevisions(resumeId);
  }

  /** 读取指定版本的只读正文。 */
  GetRevision(resumeId: string, revisionId: string): any {
    return this.repository.GetRevision(resumeId, revisionId);
  }

  /** 将历史版本还原为新的当前版本；透传期望版本以复用既有并发保护。 */
  RestoreRevision(resumeId: string, revisionId: string, expectedRevision?: number): any {
    return this.repository.RestoreRevision(resumeId, revisionId, expectedRevision);
  }

  /** 删除一份历史版本；Repository 拒绝删除当前版本。 */
  DeleteRevision(resumeId: string, revisionId: string): any {
    return this.repository.DeleteRevision(resumeId, revisionId);
  }
}
