"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/** 岗位库的应用服务：封装岗位 Repository，提供 CRUD 与收藏管理。 */
class JobService {
    constructor({ repository }) {
        this.repository = repository;
    }
    /** 读取全部未删除岗位，供工作空间聚合视图使用。 */
    ListAll() {
        return this.repository.ListAll();
    }
    /** 创建或编辑岗位；透传期望版本供冲突检测。 */
    Upsert(job, expectedRevision) {
        return this.repository.Upsert(job, expectedRevision);
    }
    /** 切换岗位收藏状态；透传期望版本供冲突检测。 */
    SetFavorite(id, favorite, expectedRevision) {
        return this.repository.SetFavorite(id, favorite, expectedRevision);
    }
    /** 逻辑删除岗位。 */
    Delete(id) {
        return this.repository.Delete(id);
    }
}
module.exports = { JobService };
