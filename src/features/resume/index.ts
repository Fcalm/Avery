/** 简历库 feature 公共面：页面入口与业务查询。 */
export { ResumesPage } from './pages/ResumesPage';
export { useResumes, useUpsertResume, useRenameResume, useDeleteResume, LoadResumeRevisions, SetResumeRevisionPinned, ExportResumeFile } from './api/resumeQueries';
