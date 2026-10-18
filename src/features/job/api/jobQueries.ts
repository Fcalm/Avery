import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobQueryInput } from '@avery/contracts';
import type { Job } from '../../../types/domain';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { useWorkspaceMutation, type WorkspaceMutationHandlers } from '../../workspace/api/mutationHelper';

/** 岗位业务集合；来自工作空间聚合缓存。 */
export function useJobs() {
  const { data } = useWorkspaceData();
  return data?.jobs ?? [];
}

/** 查询页独立缓存；工作空间统一失效、岗位或投递写回都会刷新，不因对话消息追加频繁刷新。 */
export function useJobLibraryQuery(input: JobQueryInput) {
  const queryClient = useQueryClient();
  const { data } = useWorkspaceData();
  const previous = useRef({ jobs: data?.jobs, applications: data?.applications });
  useEffect(() => {
    if (previous.current.jobs !== data?.jobs || previous.current.applications !== data?.applications) {
      previous.current = { jobs: data?.jobs, applications: data?.applications };
      void queryClient.invalidateQueries({ queryKey: ['workspace', 'job-query'] });
    }
  }, [data?.jobs, data?.applications, queryClient]);
  return useQuery({
    queryKey: ['workspace', 'job-query', input],
    queryFn: () => Unwrap(platformClient.workspace.QueryJobs(input)),
  });
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

/** 同一事务批量删除；提交成功后才更新缓存，失败保留原有岗位与选择。 */
export function useDeleteJobs(handlers?: WorkspaceMutationHandlers) {
  const queryClient = useQueryClient();
  return useWorkspaceMutation<{ ids: string[] }, { ids: string[] }>({
    mutationFn: ({ ids }, options) => Unwrap(platformClient.workspace.DeleteJobs(ids, options)),
    applyServer: (data, { ids }) => {
      const removed = new Set(ids);
      return { ...data, jobs: data.jobs.filter((item) => !removed.has(item.id)) };
    },
    ...handlers,
    onSuccess: () => {
      // 即使所有 ID 已被其他窗口删除，仍刷新分页总数与末页页码。
      void queryClient.invalidateQueries({ queryKey: ['workspace', 'job-query'] });
      handlers?.onSuccess?.();
    },
  });
}
