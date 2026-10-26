/// <reference types="vite/client" />

import type { DesktopAgentBridge, DesktopEvaluationBridge, WorkspaceBridge, ResultEnvelope } from '@avery/contracts';

/** 无边框窗口控制与常规设置的系统能力；由 preload 注入，浏览器开发环境不存在。 */
interface DesktopWindowBridge {
  /** Windows 返回原生客户区物理像素，其余平台返回 CSS 尺寸；cornerRadius 始终使用 CSS 像素。 */
  GetFrameSize: () => Promise<{ width: number; height: number; unit: 'physical' | 'css'; cornerRadius?: number }>;
  OnFrameSizeChange: (listener: (size: { width: number; height: number; unit: 'physical' | 'css' }) => void) => () => void;
  Minimize: () => Promise<boolean>;
  ToggleMaximize: () => Promise<boolean>;
  IsMaximized: () => Promise<boolean>;
  Close: () => Promise<boolean>;
  OnMaximizedChange: (listener: (maximized: boolean) => void) => () => void;
  GetWorkspaceDirectory: () => Promise<string>;
  OpenDeepSeekApiKeys: () => Promise<ResultEnvelope<boolean>>;
  OpenProviderDashboard: (provider: string) => Promise<ResultEnvelope<boolean>>;
  /** MiMo 控制台 Cookie 只在主进程的隔离会话中使用，桥接仅返回脱敏状态。 */
  ReadMimoAccountUsage: () => Promise<ResultEnvelope<import('@avery/contracts').ProviderAccountUsage>>;
  OpenMimoAccountLogin: () => Promise<ResultEnvelope<{ authorized: boolean }>>;
  DisconnectMimoAccount: () => Promise<ResultEnvelope<boolean>>;
  WriteClipboardText: (text: string) => Promise<ResultEnvelope<boolean>>;
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
