/** 岗位库的独立事实源；写入基于应用层 ID 幂等 upsert，删除走逻辑墓碑。 */
export declare class JobRepository {
    private db;
    constructor({ db }: {
        db: any;
    });
    /** 读取全部未删除岗位，按最近更新倒序；payload_json 即页面 Job ViewModel，枚举映射为契约英文值，revision 供外部冲突校验。 */
    ListAll(): any[];
    /** 创建或编辑岗位；已存在 ID 时校验期望版本、更新并清除逻辑删除标记；写入前将枚举映射为存储中文值。 */
    Upsert(job: any, expectedRevision?: number): any;
    /** 切换岗位收藏状态；校验期望版本，同步更新 payload 与投影列。 */
    SetFavorite(id: string, favorite: boolean, expectedRevision?: number): any;
    /** 逻辑删除岗位；被投递引用时保留墓碑以维持投递快照。 */
    Delete(id: string): any;
}
