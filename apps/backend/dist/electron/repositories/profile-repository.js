"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const fs = require('node:fs');
const crypto = require('node:crypto');
const { GetNow } = require('./helpers.js');
const { ProfileItemToStorage, ProfileItemToDisplay } = require('./enum-map.js');
/** 档案的唯一事实源 profile.json；以临时文件写入后 fsync 原子替换，并维护哈希基线供外部修改检测。 */
class ProfileRepository {
    constructor({ profilePath }) {
        this.profilePath = profilePath;
        this.profileHash = null;
    }
    /** 读取档案并认可当前磁盘内容为哈希基线；缺失或损坏时返回安全回退值。 */
    Load(fallback) {
        try {
            const raw = fs.readFileSync(this.profilePath, 'utf8');
            const parsed = JSON.parse(raw);
            const hash = crypto.createHash('sha256').update(raw).digest('hex');
            const items = Array.isArray(parsed?.items) ? parsed.items.map(ProfileItemToDisplay) : fallback;
            this.profileHash = hash;
            return { items, hash };
        }
        catch {
            this.profileHash = null;
            return { items: fallback, hash: null };
        }
    }
    /** 判断磁盘文件是否在应用认可基线后被外部修改；从未读取或文件缺失时视为未修改。 */
    IsModified() {
        if (this.profileHash == null)
            return false;
        try {
            const raw = fs.readFileSync(this.profilePath, 'utf8');
            return crypto.createHash('sha256').update(raw).digest('hex') !== this.profileHash;
        }
        catch {
            return false;
        }
    }
    /** 通过临时文件、fsync 和原子替换保存档案；检测到外部修改时除非强制覆盖否则拒绝。 */
    Save(items, force = false) {
        if (!Array.isArray(items))
            throw new Error('Profiles payload is invalid.');
        if (this.IsModified() && !force) {
            const conflict = new Error('The profile file was modified outside the application.');
            conflict.code = 'PROFILE_CONFLICT';
            throw conflict;
        }
        // 契约英文分类映射为存储中文，保持存量 profile.json 兼容外部工具读取。
        const payload = { schemaVersion: 1, updatedAt: GetNow(), items: items.map(ProfileItemToStorage) };
        const temporaryPath = `${this.profilePath}.tmp`;
        const raw = JSON.stringify(payload, null, 2);
        const descriptor = fs.openSync(temporaryPath, 'w');
        try {
            fs.writeFileSync(descriptor, raw, 'utf8');
            fs.fsyncSync(descriptor);
        }
        finally {
            fs.closeSync(descriptor);
        }
        fs.renameSync(temporaryPath, this.profilePath);
        this.profileHash = crypto.createHash('sha256').update(raw).digest('hex');
        return { count: items.length, hash: this.profileHash };
    }
    /** 重新读取磁盘档案并更新哈希基线，供冲突界面「重新加载磁盘版本」使用。 */
    Reload(fallback) {
        return this.Load(fallback);
    }
    /** 返回最近一次认可的档案哈希基线。 */
    GetHash() {
        return this.profileHash;
    }
}
module.exports = { ProfileRepository };
