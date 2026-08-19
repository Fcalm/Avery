import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AppError } from '../../../shared/platform/platformClient';
import { WORKSPACE_QUERY_KEY, type WorkspaceData } from './workspaceData';

/** 工作空间写操作的回调：统一处理成功、业务失败和并发冲突。 */
export interface WorkspaceMutationHandlers {
  onSuccess?: () => void;
  onFailure?: (message: string) => void;
  onConflict?: () => void;
}

/** 写操作配置：mutationFn 负责调用 Bridge，applyServer 负责把服务端确认结果写回聚合缓存。 */
interface WorkspaceMutationOptions<TVariables, TResult> extends WorkspaceMutationHandlers {
  mutationFn: (variables: TVariables) => Promise<TResult>;
  applyServer: (data: WorkspaceData, variables: TVariables, result: TResult) => WorkspaceData;
  conflictCode?: string;
}

/** 工作空间写 Mutation：成功后乐观写回缓存，冲突时刷新并触发回调，其他失败透传中文错误。 */
export function useWorkspaceMutation<TVariables, TResult>(options: WorkspaceMutationOptions<TVariables, TResult>) {
  const queryClient = useQueryClient();
  const { mutationFn, applyServer, conflictCode, onSuccess, onFailure, onConflict } = options;

  return useMutation({
    mutationFn,
    onSuccess: (result, variables) => {
      queryClient.setQueryData<WorkspaceData>(WORKSPACE_QUERY_KEY, (old) => (old ? applyServer(old, variables, result) : old));
      onSuccess?.();
    },
    onError: (error) => {
      if (error instanceof AppError && conflictCode && error.code === conflictCode) {
        onConflict?.();
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
        return;
      }
      onFailure?.(error instanceof Error ? error.message : '操作失败');
    },
  });
}

/** 局部更新工作空间聚合缓存；用于 Agent 流式增量等高频非持久化写回。 */
export function usePatchWorkspace() {
  const queryClient = useQueryClient();
  return useCallback((updater: (data: WorkspaceData) => WorkspaceData) => {
    queryClient.setQueryData<WorkspaceData>(WORKSPACE_QUERY_KEY, (old) => (old ? updater(old) : old));
  }, [queryClient]);
}
