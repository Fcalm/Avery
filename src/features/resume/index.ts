/** 简历库 feature 公共面：页面入口与业务查询。 */
export { ResumesPage } from './pages/ResumesPage';
export { useResumes, useUpsertResume, useRenameResume, useDeleteResume, LoadResumeRevisions, LoadResumeRevision, useRestoreResumeRevision, useDeleteResumeRevision, ExportResumeFile } from './api/resumeQueries';
