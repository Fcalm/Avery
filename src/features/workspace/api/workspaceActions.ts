import { platformClient, Unwrap } from '../../../shared/platform/platformClient';

/** 创建本地工作空间备份；失败时抛统一业务错误，由调用方展示可操作提示。 */
export async function CreateWorkspaceBackup() {
  return Unwrap(await platformClient.workspace.CreateBackup());
}

/** 迁移工作空间到用户选择的目标空目录；成功后调用方失效工作空间缓存。 */
export async function MigrateWorkspace() {
  return Unwrap(await platformClient.workspace.Migrate());
}
