/** 设置的应用服务：app_state 仅作为非敏感设置载体，不再承载业务实体；持久化前剔除传输与动态注入字段。 */
export declare class SettingsService {
    private db;
    constructor({ db }: {
        db: any;
    });
    /** 剔除传输层与后端动态注入字段，防止写入业务存储或回流前端。 */
    Sanitize(settings: any): any;
    /** 读取已持久化的非敏感设置；未初始化时返回空对象。 */
    GetStoredSettings(): any;
    /** 持久化非敏感设置；app_state 仅作为设置兼容载体，忽略传输层与动态注入字段。 */
    Save(settings: any): any;
}
