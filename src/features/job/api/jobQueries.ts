import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { Job } from '../../../types/domain';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { useWorkspaceMutation, type WorkspaceMutationHandlers } from '../../workspace/api/mutationHelper';

/** 岗位业务集合；来自工作空间聚合缓存。 */
export function useJobs() {
  const { data } = useWorkspaceData();
  return data?.jobs ?? [];
}

/** 创建或编辑岗位；成功后按服务器 revision 写回并置顶。 */
export function useUpsertJob(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ job: Job; expectedRevision?: number }, { id: string; revision: number }>({
    mutationFn: ({ job, expectedRevision }, options) => Unwrap(platformClient.workspace.UpsertJob(job, expectedRevision, options)),
    applyServer: (data, vars, result) => {
      const next = { ...vars.job, revision: result.revision };
      return { ...data, jobs: data.jobs.some((item) => item.id === next.id) ? data.jobs.map((item) => (item.id === next.id ? next : item)) : [next, ...data.jobs] };
    },
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 切换岗位收藏；成功后写回服务器确认的收藏与 revision。 */
export function useSetJobFavorite(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string; favorite: boolean; expectedRevision?: number }, { id: string; isFavorite: boolean; revision: number }>({
    mutationFn: ({ id, favorite, expectedRevision }, options) => Unwrap(platformClient.workspace.SetJobFavorite(id, favorite, expectedRevision, options)),
    applyServer: (data, vars, result) => ({
      ...data,
      jobs: data.jobs.map((item) => (item.id === vars.id ? { ...item, favorite: result.isFavorite, revision: result.revision } : item)),
    }),
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 逻辑删除岗位；成功后从缓存移除。 */
export function useDeleteJob(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string }, { id: string }>({
    mutationFn: ({ id }, options) => Unwrap(platformClient.workspace.DeleteJob(id, options)),
    applyServer: (data, vars) => ({ ...data, jobs: data.jobs.filter((item) => item.id !== vars.id) }),
    ...handlers,
  });
}
