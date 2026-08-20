"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsService = void 0;
const helpers_1 = require("../../repositories/helpers");
/** 设置的应用服务：app_state 仅作为非敏感设置载体，不再承载业务实体；持久化前剔除传输与动态注入字段。 */
class SettingsService {
    db;
    constructor({ db }) {
        this.db = db;
    }
    /** 剔除传输层与后端动态注入字段，防止写入业务存储或回流前端。 */
    Sanitize(settings) {
        const { workspaceName, requestId, idempotencyKey, expectedRevision, apiKey, ...safe } = settings ?? {};
        return safe;
    }
    /** 读取已持久化的非敏感设置；未初始化时返回空对象。 */
    GetStoredSettings() {
        const row = this.db.prepare("SELECT payload_json FROM app_state WHERE id = 'current'").get();
        if (!row)
            return {};
        try {
            const payload = JSON.parse(row.payload_json);
            return payload?.settings && typeof payload.settings === 'object' ? this.Sanitize(payload.settings) : {};
        }
        catch {
            return {};
        }
    }
    /** 持久化非敏感设置；app_state 仅作为设置兼容载体，忽略传输层与动态注入字段。 */
    Save(settings) {
        if (!settings || typeof settings !== 'object')
            throw new Error('Settings payload is invalid.');
        const safe = this.Sanitize(settings);
        const now = (0, helpers_1.GetNow)();
        const existing = this.db.prepare("SELECT id FROM app_state WHERE id = 'current'").get();
        if (existing) {
            this.db.prepare("UPDATE app_state SET payload_json = ?, revision = revision + 1, updated_at = ? WHERE id = 'current'").run(JSON.stringify({ settings: safe }), now);
        }
        else {
            this.db.prepare("INSERT INTO app_state(id, payload_json, revision, updated_at) VALUES('current', ?, 1, ?)").run(JSON.stringify({ settings: safe }), now);
        }
        (0, helpers_1.WriteAudit)(this.db, 'user', 'save', 'settings', 'current', {});
        return { saved: true };
    }
}
exports.SettingsService = SettingsService;
