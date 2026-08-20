/** 简历及其版本的应用服务：封装简历 Repository，提供创建、编辑、重命名、删除与版本留存管理。 */
export declare class ResumeService {
    private repository;
    constructor({ repository }: {
        repository: any;
    });
    /** 读取全部未删除简历，供工作空间聚合视图使用。 */
    ListAll(): any;
    /** 创建或更新简历，并在正文变化时追加版本快照；透传期望版本供冲突检测。 */
    Upsert(resume: any, expectedRevision?: number): any;
    /** 重命名简历，不产生内容版本；透传期望版本供冲突检测。 */
    Rename(id: string, name: string, expectedRevision?: number): any;
    /** 逻辑删除简历。 */
    Delete(id: string): any;
    /** 返回一份简历的版本历史。 */
    GetRevisions(resumeId: string): any;
    /** 标记或取消标记重要简历版本。 */
    SetRevisionPinned(revisionId: string, pinned: boolean): any;
}
