import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { platformClient } from '../../../shared/platform/platformClient';
import type { SettingsDraft } from '../../../types/domain';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { DefaultSettings, WORKSPACE_QUERY_KEY, type WorkspaceData } from '../../workspace/api/workspaceData';

/** 非敏感设置；来自工作空间聚合缓存，空库回退到初始值。 */
export function useSettings() {
  const { data } = useWorkspaceData();
  return data?.settings ?? DefaultSettings;
}

/** 设置与更新动作的组合钩子；页面通过 setSettings 乐观更新并节流持久化。 */
export function useSettingsStore() {
  const settings = useSettings();
  const { setSettings, saveSettingsNow } = useSettingsActions();
  return { settings, setSettings, saveSettingsNow };
}

// 设置持久化使用模块级单例防抖，避免多个页面实例各自触发重复写入。
let persistTimer: number | null = null;
let latestSettings: SettingsDraft | null = null;

/** 更新非敏感设置并节流持久化；API Key 只经 Agent IPC 加密保存，不写入工作空间。 */
export function useSettingsActions() {
  const queryClient = useQueryClient();
  const setSettings = useCallback((updater: (current: SettingsDraft) => SettingsDraft) => {
    queryClient.setQueryData<WorkspaceData>(WORKSPACE_QUERY_KEY, (old) => {
      if (!old) return old;
      const next = updater(old.settings);
      latestSettings = next;
      return { ...old, settings: next };
    });
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      if (!latestSettings) return;
      const { apiKey: _apiKey, workspaceName: _workspaceName, ...safeSettings } = latestSettings;
      void platformClient.workspace.SaveSettings(safeSettings);
      latestSettings = null;
    }, 300);
  }, [queryClient]);
  /** 供首次引导等“完成后才允许离开页面”的流程使用，避免防抖写入尚未落盘便进入下一页。 */
  const saveSettingsNow = useCallback(async (settings: SettingsDraft) => {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    const { apiKey: _apiKey, workspaceName: _workspaceName, ...safeSettings } = settings;
    await platformClient.workspace.SaveSettings(safeSettings);
    queryClient.setQueryData<WorkspaceData>(WORKSPACE_QUERY_KEY, (old) => old ? { ...old, settings: { ...settings, apiKey: '' } } : old);
    latestSettings = null;
  }, [queryClient]);
  return { setSettings, saveSettingsNow };
}
