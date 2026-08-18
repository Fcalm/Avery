"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const crypto = require('node:crypto');
/** 返回 UTC 毫秒时间戳，供所有本地业务记录统一使用。 */
function GetNow() {
    return Date.now();
}
/** 创建供本地记录使用的随机标识；后续迁移阶段替换为 UUIDv7 生成器。 */
function CreateId() {
    return crypto.randomUUID();
}
/** 记录不含业务正文的本地审计事件，供保留策略与故障排查使用。 */
function WriteAudit(db, actorType, action, entityType, entityId, metadata) {
    db.prepare('INSERT INTO audit_events(id, actor_type, action, entity_type, entity_id, metadata_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(CreateId(), actorType, action, entityType, entityId, JSON.stringify(metadata ?? {}), GetNow());
}
/** 构造稳定、脱敏的版本冲突错误；错误码走结构化 code 属性，消息不含代码前缀，供各 Repository 写路径在 expectedRevision 不匹配时抛出。 */
function CreateRevisionConflict(entityType, entityId, expectedRevision, actualRevision) {
    const conflict = new Error('The entity was modified outside this view; expected revision does not match.');
    conflict.code = 'REVISION_CONFLICT';
    conflict.entityType = entityType;
    conflict.entityId = entityId;
    conflict.expectedRevision = expectedRevision;
    conflict.actualRevision = actualRevision;
    return conflict;
}
/** 校验实体当前版本与调用方期望版本一致；不一致时抛出版本冲突，避免覆盖最新内容。 */
function AssertRevision(existing, expectedRevision, entityType, entityId) {
    if (expectedRevision != null && existing && existing.revision !== expectedRevision) {
        throw CreateRevisionConflict(entityType, entityId, expectedRevision, existing.revision);
    }
}
module.exports = { GetNow, CreateId, WriteAudit, CreateRevisionConflict, AssertRevision };
