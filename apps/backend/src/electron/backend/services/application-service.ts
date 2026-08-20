/** 投递看板的应用服务：封装投递 Repository，提供 CRUD 与状态迁移（自动记录事件）。 */
export class ApplicationService {
  private repository: any;

  constructor({ repository }: { repository: any }) {
    this.repository = repository;
  }

  /** 读取全部投递，供工作空间聚合视图使用。 */
  ListAll(): any {
    return this.repository.ListAll();
  }

  /** 创建或编辑投递；透传期望版本供冲突检测，状态变化自动追加事件。 */
  Upsert(application: any, expectedRevision?: number): any {
    return this.repository.Upsert(application, expectedRevision);
  }

  /** 推进投递到看板的下一阶段；透传期望版本供冲突检测，记录状态迁移事件。 */
  MoveStatus(id: string, status: string, expectedRevision?: number): any {
    return this.repository.MoveStatus(id, status, expectedRevision);
  }

  /** 删除投递并级联清理事件。 */
  Delete(id: string): any {
    return this.repository.Delete(id);
  }
}
