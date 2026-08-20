/** 岗位库的应用服务：封装岗位 Repository，提供 CRUD 与收藏管理。 */
export class JobService {
  private repository: any;

  constructor({ repository }: { repository: any }) {
    this.repository = repository;
  }

  /** 读取全部未删除岗位，供工作空间聚合视图使用。 */
  ListAll(): any {
    return this.repository.ListAll();
  }

  /** 创建或编辑岗位；透传期望版本供冲突检测。 */
  Upsert(job: any, expectedRevision?: number): any {
    return this.repository.Upsert(job, expectedRevision);
  }

  /** 切换岗位收藏状态；透传期望版本供冲突检测。 */
  SetFavorite(id: string, favorite: boolean, expectedRevision?: number): any {
    return this.repository.SetFavorite(id, favorite, expectedRevision);
  }

  /** 逻辑删除岗位。 */
  Delete(id: string): any {
    return this.repository.Delete(id);
  }
}
