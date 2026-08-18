"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const { GetNow, WriteAudit, AssertRevision } = require('./helpers.js');
const { JobToStorage, JobToDisplay } = require('./enum-map.js');
/** 岗位库的独立事实源；写入基于应用层 ID 幂等 upsert，删除走逻辑墓碑。 */
class JobRepository {
    constructor({ db }) {
        this.db = db;
    }
    /** 读取全部未删除岗位，按最近更新倒序；payload_json 即页面 Job ViewModel，枚举映射为契约英文值，revision 供外部冲突校验。 */
    ListAll() {
        return this.db.prepare('SELECT payload_json, revision FROM jobs WHERE deleted_at IS NULL ORDER BY updated_at DESC').all()
            .map((row) => JobToDisplay({ ...JSON.parse(row.payload_json), revision: row.revision }));
    }
    /** 创建或编辑岗位；已存在 ID 时校验期望版本、更新并清除逻辑删除标记；写入前将枚举映射为存储中文值。 */
    Upsert(job, expectedRevision) {
        if (!job || typeof job !== 'object')
            throw new Error('Job is invalid.');
        if (typeof job.id !== 'string' || job.id.length === 0 || job.id.length > 200)
            throw new Error('Job id is invalid.');
        if (typeof job.title !== 'string' || job.title.length === 0 || job.title.length > 300)
            throw new Error('Job title is invalid.');
        if (typeof job.channel !== 'string' || job.channel.length === 0 || job.channel.length > 100)
            throw new Error('Job channel is invalid.');
        const storageJob = JobToStorage(job);
        const now = GetNow();
        const existing = this.db.prepare('SELECT revision FROM jobs WHERE id = ?').get(job.id);
        if (existing)
            AssertRevision(existing, expectedRevision, 'job', job.id);
        const nextRevision = existing ? existing.revision + 1 : 1;
        this.db.prepare('INSERT INTO jobs(id, payload_json, is_favorite, channel, match_score, revision, created_at, updated_at, deleted_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, is_favorite = excluded.is_favorite, channel = excluded.channel, match_score = excluded.match_score, revision = excluded.revision, updated_at = excluded.updated_at, deleted_at = NULL')
            .run(job.id, JSON.stringify(storageJob), storageJob.favorite ? 1 : 0, storageJob.channel, storageJob.matchScore ?? null, nextRevision, now, now);
        WriteAudit(this.db, 'user', 'save', 'job', job.id, {});
        return { id: job.id, revision: nextRevision };
    }
    /** 切换岗位收藏状态；校验期望版本，同步更新 payload 与投影列。 */
    SetFavorite(id, favorite, expectedRevision) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200)
            throw new Error('Job id is invalid.');
        const existing = this.db.prepare('SELECT payload_json, revision FROM jobs WHERE id = ?').get(id);
        if (!existing)
            throw new Error('Job was not found.');
        AssertRevision(existing, expectedRevision, 'job', id);
        const payload = JSON.parse(existing.payload_json);
        payload.favorite = Boolean(favorite);
        const nextRevision = existing.revision + 1;
        this.db.prepare('UPDATE jobs SET is_favorite = ?, payload_json = ?, revision = ?, updated_at = ? WHERE id = ?').run(favorite ? 1 : 0, JSON.stringify(payload), nextRevision, GetNow(), id);
        WriteAudit(this.db, 'user', favorite ? 'favorite' : 'unfavorite', 'job', id, {});
        return { id, isFavorite: Boolean(favorite), revision: nextRevision };
    }
    /** 逻辑删除岗位；被投递引用时保留墓碑以维持投递快照。 */
    Delete(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200)
            throw new Error('Job id is invalid.');
        this.db.prepare('UPDATE jobs SET deleted_at = ?, updated_at = ? WHERE id = ?').run(GetNow(), GetNow(), id);
        WriteAudit(this.db, 'user', 'delete', 'job', id, {});
        return { id };
    }
}
module.exports = { JobRepository };
