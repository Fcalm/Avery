"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileRepository = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const helpers_1 = require("./helpers");
const enum_map_1 = require("./enum-map");
/** 档案的唯一事实源 profile.json；以临时文件写入后 fsync 原子替换，并维护哈希基线供外部修改检测。 */
class ProfileRepository {
    profilePath;
    profileHash = null;
    constructor({ profilePath }) {
        this.profilePath = profilePath;
    }
    /** 读取档案并认可当前磁盘内容为哈希基线；缺失或损坏时返回安全回退值。 */
    Load(fallback) {
        try {
            const raw = (0, node_fs_1.readFileSync)(this.profilePath, 'utf8');
            const parsed = JSON.parse(raw);
            const hash = (0, node_crypto_1.createHash)('sha256').update(raw).digest('hex');
            const items = Array.isArray(parsed?.items) ? parsed.items.map(enum_map_1.ProfileItemToDisplay) : fallback;
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
            const raw = (0, node_fs_1.readFileSync)(this.profilePath, 'utf8');
            return (0, node_crypto_1.createHash)('sha256').update(raw).digest('hex') !== this.profileHash;
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
        const payload = { schemaVersion: 1, updatedAt: (0, helpers_1.GetNow)(), items: items.map(enum_map_1.ProfileItemToStorage) };
        const temporaryPath = `${this.profilePath}.tmp`;
        const raw = JSON.stringify(payload, null, 2);
        const descriptor = (0, node_fs_1.openSync)(temporaryPath, 'w');
        try {
            (0, node_fs_1.writeFileSync)(descriptor, raw, 'utf8');
            (0, node_fs_1.fsyncSync)(descriptor);
        }
        finally {
            (0, node_fs_1.closeSync)(descriptor);
        }
        (0, node_fs_1.renameSync)(temporaryPath, this.profilePath);
        this.profileHash = (0, node_crypto_1.createHash)('sha256').update(raw).digest('hex');
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
exports.ProfileRepository = ProfileRepository;
