import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { Application, ApplicationStatus } from '../../../types/domain';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { useWorkspaceMutation, type WorkspaceMutationHandlers } from '../../workspace/api/mutationHelper';

/** 投递业务集合；来自工作空间聚合缓存。 */
export function useApplications() {
  const { data } = useWorkspaceData();
  return data?.applications ?? [];
}

/** 创建或编辑投递；成功后按服务器 revision 写回并置顶。 */
export function useUpsertApplication(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ application: Application; expectedRevision?: number }, { id: string; revision: number }>({
    mutationFn: ({ application, expectedRevision }) => Unwrap(platformClient.workspace.UpsertApplication(application, expectedRevision)),
    applyServer: (data, vars, result) => {
      const next = { ...vars.application, revision: result.revision };
      return { ...data, applications: data.applications.some((item) => item.id === next.id) ? data.applications.map((item) => (item.id === next.id ? next : item)) : [next, ...data.applications] };
    },
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 推进投递状态；成功后写回服务器确认的状态与 revision。 */
export function useMoveApplicationStatus(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string; status: Application['status']; expectedRevision?: number }, { id: string; status: string; revision: number }>({
    mutationFn: ({ id, status, expectedRevision }) => Unwrap(platformClient.workspace.MoveApplicationStatus(id, status, expectedRevision)),
    applyServer: (data, vars, result) => ({
      ...data,
      applications: data.applications.map((item) => (item.id === vars.id ? { ...item, status: result.status as ApplicationStatus, revision: result.revision } : item)),
    }),
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 删除投递；成功后从缓存移除。 */
export function useDeleteApplication(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string }, { id: string }>({
    mutationFn: ({ id }) => Unwrap(platformClient.workspace.DeleteApplication(id)),
    applyServer: (data, vars) => ({ ...data, applications: data.applications.filter((item) => item.id !== vars.id) }),
    ...handlers,
  });
}
