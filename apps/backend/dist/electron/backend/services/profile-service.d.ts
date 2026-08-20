/** 档案的应用服务：封装 profile.json Repository，维护哈希基线并编排外部修改冲突的审计。 */
export declare class ProfileService {
    private repository;
    private db;
    private attachmentLifecycle;
    private workspaceOperations;
    private profileHash;
    constructor({ repository, db, attachmentLifecycle, workspaceOperations }: {
        repository: any;
        db: any;
        attachmentLifecycle: any;
        workspaceOperations: any;
    });
    /** 读取档案唯一事实源；缺失或损坏时返回安全回退值，并认可磁盘内容为哈希基线。 */
    Load(fallback: any[]): any[];
    /** 读取档案及外部修改状态，供启动恢复与冲突界面使用。 */
    Get(): any;
    /** 原子写入档案；检测到外部修改时除非强制覆盖（保留应用版本）否则拒绝。 */
    Save(items: any[], force?: boolean): any;
    /** 重新加载磁盘档案版本并更新基线，供冲突界面「重新加载磁盘版本」使用。 */
    Reload(fallback?: any[]): any;
    /** 返回档案最近一次读写维护的哈希基线，供外部修改检测使用。 */
    GetHash(): string | null;
    SynchronizeAttachmentLinks(items: any[]): void;
}
