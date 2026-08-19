/** 简历及其版本快照的独立事实源；正文变动提升 revision 并追加版本，删除走逻辑墓碑。 */
export declare class ResumeRepository {
    private db;
    private attachmentLifecycle;
    constructor({ db, attachmentLifecycle }: {
        db: any;
        attachmentLifecycle: any;
    });
    /** 读取全部未删除简历，按最近更新倒序；document_json 即页面 Resume ViewModel，revision 供外部冲突校验。 */
    ListAll(): any[];
    /** 创建或更新简历；已存在时校验期望版本，正文变化提升 revision 并追加不可变快照。 */
    Upsert(resume: any, expectedRevision?: number): any;
    private UpsertRecord;
    /** 仅更新简历名称与最近更新时间；校验期望版本但不产生内容版本快照。 */
    Rename(id: string, name: string, expectedRevision?: number): any;
    /** 逻辑删除简历；被投递引用时保留墓碑以维持历史快照。 */
    Delete(id: string): any;
    /** 返回一份简历的最近版本与重要标记，供用户在简历详情中管理留存策略。 */
    GetRevisions(resumeId: string): any[];
    /** 标记或取消标记重要简历版本；重要版本不参与普通 100 条版本裁剪。 */
    SetRevisionPinned(revisionId: string, pinned: boolean): any;
    /** 仅清理超出上限且未被标记重要/投递保护的普通简历修订。 */
    PruneRevisions(resumeId: string): void;
}
