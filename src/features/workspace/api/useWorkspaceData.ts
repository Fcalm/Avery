import { useQuery } from '@tanstack/react-query';
import { ErrorCode } from '@avery/contracts';
import { AppError, platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { DefaultSettings, WORKSPACE_QUERY_KEY, type WorkspaceData } from './workspaceData';

/** 仅启动/重启中的服务需要继续等待；数据读取失败等其他错误仍进入原有错误页。 */
function IsBackendStarting(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== ErrorCode.INTERNAL_ERROR) return false;
  const details = error.details;
  if (!details || typeof details !== 'object' || !('backendState' in details)) return false;
  return details.backendState === 'starting' || details.backendState === 'restarting';
}

/** 从桌面 Bridge 聚合读取工作空间数据；三个只读请求并行，减少启动等待。 */
export async function LoadWorkspaceData(): Promise<WorkspaceData> {
  const [viewModel, profiles, settings] = await Promise.all([
    Unwrap(platformClient.workspace.GetViewModel()),
    Unwrap(platformClient.workspace.GetProfiles()),
    Unwrap(platformClient.workspace.GetSettings()),
  ]);
  const provider = settings.provider ?? DefaultSettings.provider;
  const contextLimitMode = settings.contextLimitMode ?? (provider === '自定义' ? 'custom' : 'default');
  const storedContextLength = settings.contextLength ?? DefaultSettings.contextLength;
  const contextLength = provider === 'DeepSeek' && contextLimitMode === 'default' && storedContextLength === '64K'
    ? DefaultSettings.contextLength : storedContextLength;
  return {
    ...viewModel,
    profiles: profiles.items,
    settings: {
      ...DefaultSettings,
      ...settings,
      // 旧 DeepSeek 配置的 64K 是历史默认；旧自定义 Provider 的值由用户填写，应继续视为自定义。
      contextLength,
      contextLimitMode,
      apiKey: '',
    },
  };
}

/** 工作空间聚合缓存 Hook；页面统一从这里读取会话、简历、岗位、投递、档案与设置。 */
export function useWorkspaceData() {
  return useQuery({
    queryKey: WORKSPACE_QUERY_KEY,
    queryFn: LoadWorkspaceData,
    staleTime: 30_000,
    // Gateway 在服务握手前返回明确的启动状态；仅对这个暂态重试只读聚合查询。
    retry: (failureCount, error) => IsBackendStarting(error) || failureCount < 1,
    retryDelay: (attempt, error) => IsBackendStarting(error) ? 1000 : Math.min(1000 * 2 ** attempt, 30_000),
  });
}
