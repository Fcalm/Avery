/** 工作空间共享 feature 公共面：聚合查询、统一写命令辅助与实体 ID 生成。 */
export { useWorkspaceData } from './api/useWorkspaceData';
export { useWorkspaceMutation, usePatchWorkspace } from './api/mutationHelper';
export { DefaultSettings, CreateEntityId, WORKSPACE_QUERY_KEY } from './api/workspaceData';
