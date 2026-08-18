/** 投递管理 feature 公共面：页面入口与业务查询。 */
export { ApplicationsPage } from './pages/ApplicationsPage';
export { useApplications, useUpsertApplication, useMoveApplicationStatus, useDeleteApplication } from './api/applicationQueries';
