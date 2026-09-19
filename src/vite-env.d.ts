/// <reference types="vite/client" />

import type { DesktopAgentBridge, DesktopEvaluationBridge, WorkspaceBridge } from '@avery/contracts';

/** 无边框窗口控制与常规设置的系统能力；由 preload 注入，浏览器开发环境不存在。 */
interface DesktopWindowBridge {
  Minimize: () => Promise<boolean>;
  ToggleMaximize: () => Promise<boolean>;
  Close: () => Promise<boolean>;
  GetWorkspaceDirectory: () => Promise<string>;
  OpenWorkspaceDirectory: () => Promise<boolean>;
  SetLoginItemSettings: (openAtLogin: boolean) => Promise<boolean>;
}

declare global {
  /** 构建时由 vite define 注入的应用版本（package.json version）；文件含顶层 import，须在 global 内声明。 */
  const __APP_VERSION__: string;
  interface Window {
    averyAgent?: DesktopAgentBridge;
    averyWorkspace?: WorkspaceBridge;
    averyEvaluation?: DesktopEvaluationBridge;
    averyWindow?: DesktopWindowBridge;
  }
}

export {};
