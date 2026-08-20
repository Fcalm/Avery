import type { ProfileItemDto } from '@offerget/contracts';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { ProfileItem } from '../../../types/domain';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { useWorkspaceMutation, type WorkspaceMutationHandlers } from '../../workspace/api/mutationHelper';

/** 档案业务集合；来自工作空间聚合缓存。 */
export function useProfiles() {
  const { data } = useWorkspaceData();
  return data?.profiles ?? [];
}

/** 新增或更新档案并整体写回 profile.json；检测到外部修改时进入冲突状态。 */
export function useSaveProfiles(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ items: ProfileItem[] }, { count: number; hash: string }>({
    mutationFn: ({ items }, options) => Unwrap(platformClient.workspace.SaveProfiles(items, undefined, options)),
    applyServer: (data, vars) => ({ ...data, profiles: vars.items }),
    conflictCode: 'PROFILE_CONFLICT',
    ...handlers,
  });
}

/** 强制保留应用版本并覆盖外部修改；用于冲突界面「保留应用版本」。 */
export function useKeepProfiles(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ items: ProfileItem[] }, { count: number; hash: string }>({
    mutationFn: ({ items }, options) => Unwrap(platformClient.workspace.SaveProfiles(items, true, options)),
    applyServer: (data, vars) => ({ ...data, profiles: vars.items }),
    ...handlers,
  });
}

/** 重新加载磁盘档案版本；用于冲突界面「重新加载磁盘版本」。 */
export function useReloadProfiles(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<Record<string, never>, { items: ProfileItemDto[]; hash: string | null }>({
    mutationFn: () => Unwrap(platformClient.workspace.ReloadProfiles()),
    applyServer: (data, vars) => ({ ...data, profiles: vars.items }),
    ...handlers,
  });
}
