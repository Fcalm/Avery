/** 投递看板的独立事实源；创建与状态迁移均追加不可变事件，删除时由外键级联清理事件。 */
export declare class ApplicationRepository {
    private db;
    constructor({ db }: {
        db: any;
    });
    /** 读取全部投递，按最近更新倒序；payload_json 即页面 Application ViewModel，状态映射为契约英文值，revision 供外部冲突校验。 */
    ListAll(): any[];
    /** 创建或编辑投递；校验期望版本，首次创建追加 created 事件，状态变化时追加 status_changed 事件；写入前将状态映射为存储中文值。 */
    Upsert(application: any, expectedRevision?: number): any;
    /** 推进投递到看板的下一阶段；校验期望版本并记录状态迁移事件；存储用中文、返回契约英文值。 */
    MoveStatus(id: string, status: string, expectedRevision?: number): any;
    /** 删除投递；外键级联移除其不可再访问的事件历史。 */
    Delete(id: string): any;
}
