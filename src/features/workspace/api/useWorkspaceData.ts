import { useQuery } from '@tanstack/react-query';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { DefaultSettings, WORKSPACE_QUERY_KEY, type WorkspaceData } from './workspaceData';

/** 从桌面 Bridge 聚合读取工作空间数据；三个只读请求并行，减少启动等待。 */
async function LoadWorkspaceData(): Promise<WorkspaceData> {
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
  });
}
