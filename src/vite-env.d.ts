/// <reference types="vite/client" />

import type { DesktopAgentBridge, DesktopBrowserBridge, WorkspaceBridge } from '@offerget/contracts';

declare global {
  interface Window {
    offergetAgent?: DesktopAgentBridge;
    offergetWorkspace?: WorkspaceBridge;
    offergetBrowser?: DesktopBrowserBridge;
  }
}

export {};
