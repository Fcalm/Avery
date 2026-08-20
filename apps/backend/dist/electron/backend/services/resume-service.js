"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResumeService = void 0;
/** 简历及其版本的应用服务：封装简历 Repository，提供创建、编辑、重命名、删除与版本留存管理。 */
class ResumeService {
    repository;
    constructor({ repository }) {
        this.repository = repository;
    }
    /** 读取全部未删除简历，供工作空间聚合视图使用。 */
    ListAll() {
        return this.repository.ListAll();
    }
    /** 创建或更新简历，并在正文变化时追加版本快照；透传期望版本供冲突检测。 */
    Upsert(resume, expectedRevision) {
        return this.repository.Upsert(resume, expectedRevision);
    }
    /** 重命名简历，不产生内容版本；透传期望版本供冲突检测。 */
    Rename(id, name, expectedRevision) {
        return this.repository.Rename(id, name, expectedRevision);
    }
    /** 逻辑删除简历。 */
    Delete(id) {
        return this.repository.Delete(id);
    }
    /** 返回一份简历的版本历史。 */
    GetRevisions(resumeId) {
        return this.repository.GetRevisions(resumeId);
    }
    /** 标记或取消标记重要简历版本。 */
    SetRevisionPinned(revisionId, pinned) {
        return this.repository.SetRevisionPinned(revisionId, pinned);
    }
}
exports.ResumeService = ResumeService;
