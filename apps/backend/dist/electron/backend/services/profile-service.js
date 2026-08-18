"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const { WriteAudit } = require('../../repositories/helpers.js');
/** 档案的应用服务：封装 profile.json Repository，维护哈希基线并编排外部修改冲突的审计。 */
class ProfileService {
    constructor({ repository, db, attachmentLifecycle, workspaceOperations }) {
        this.repository = repository;
        this.db = db;
        this.attachmentLifecycle = attachmentLifecycle;
        this.workspaceOperations = workspaceOperations;
        this.profileHash = null;
    }
    /** 读取档案唯一事实源；缺失或损坏时返回安全回退值，并认可磁盘内容为哈希基线。 */
    Load(fallback) {
        const { items } = this.repository.Load(fallback);
        this.profileHash = this.repository.GetHash();
        this.SynchronizeAttachmentLinks(items);
        return items;
    }
    /** 读取档案及外部修改状态，供启动恢复与冲突界面使用。 */
    Get() {
        const result = this.repository.Load([]);
        this.profileHash = this.repository.GetHash();
        this.SynchronizeAttachmentLinks(result.items);
        return { items: result.items, hash: result.hash, modified: this.repository.IsModified() };
    }
    /** 原子写入档案；检测到外部修改时除非强制覆盖（保留应用版本）否则拒绝。 */
    Save(items, force = false) {
        this.workspaceOperations.RequireWritable();
        const operationId = this.workspaceOperations.Begin('save_profiles', { itemCount: Array.isArray(items) ? items.length : null });
        const before = this.repository.GetHash();
        try {
            const result = this.repository.Save(items, force);
            this.workspaceOperations.Advance(operationId, 'file_written');
            this.profileHash = this.repository.GetHash();
            this.SynchronizeAttachmentLinks(items);
            this.workspaceOperations.Advance(operationId, 'db_committed');
            if (force)
                WriteAudit(this.db, 'user', 'profile_keep', 'profile', 'profile.json', { from: before, to: result.hash });
            this.workspaceOperations.Advance(operationId, 'completed');
            return result;
        }
        catch (error) {
            this.workspaceOperations.MarkRollback(operationId, 'SAVE_PROFILES_FAILED');
            throw error;
        }
    }
    /** 重新加载磁盘档案版本并更新基线，供冲突界面「重新加载磁盘版本」使用。 */
    Reload(fallback = []) {
        const before = this.repository.GetHash();
        const result = this.repository.Reload(fallback);
        this.profileHash = this.repository.GetHash();
        this.SynchronizeAttachmentLinks(result.items);
        WriteAudit(this.db, 'user', 'profile_reload', 'profile', 'profile.json', { from: before, to: result.hash });
        return { items: result.items, hash: result.hash };
    }
    /** 返回档案最近一次读写维护的哈希基线，供外部修改检测使用。 */
    GetHash() {
        return this.profileHash;
    }
    SynchronizeAttachmentLinks(items) {
        const desired = new Set(items.map((item) => item.id));
        const existing = this.db.prepare("SELECT DISTINCT owner_id FROM attachment_links WHERE owner_type = 'profile'").all();
        const run = this.db.transaction(() => {
            for (const item of items)
                this.attachmentLifecycle.ReplaceLinks('profile', item.id, item);
            for (const row of existing)
                if (!desired.has(row.owner_id))
                    this.attachmentLifecycle.RemoveLinks('profile', row.owner_id);
        });
        run();
    }
}
module.exports = { ProfileService };
