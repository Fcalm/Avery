/** 返回 UTC 毫秒时间戳，供所有本地业务记录统一使用。 */
export declare function GetNow(): number;
/** 创建供本地记录使用的随机标识；后续迁移阶段替换为 UUIDv7 生成器。 */
export declare function CreateId(): string;
interface AuditMetadata {
    [key: string]: string | number | boolean | null;
}
/** 记录不含业务正文的本地审计事件，供保留策略与故障排查使用。 */
export declare function WriteAudit(db: any, actorType: string, action: string, entityType: string, entityId: string | null, metadata?: AuditMetadata): void;
/** 构造稳定、脱敏的版本冲突错误；错误码走结构化 code 属性，消息不含代码前缀，供各 Repository 写路径在 expectedRevision 不匹配时抛出。 */
export declare function CreateRevisionConflict(entityType: string, entityId: string, expectedRevision: number | undefined, actualRevision: number): Error & {
    code: string;
    entityType: string;
    entityId: string;
    expectedRevision?: number;
    actualRevision: number;
};
/** 校验实体当前版本与调用方期望版本一致；不一致时抛出版本冲突，避免覆盖最新内容。 */
export declare function AssertRevision(existing: {
    revision: number;
} | undefined, expectedRevision: number | undefined, entityType: string, entityId: string): void;
export {};
