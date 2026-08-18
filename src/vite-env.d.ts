/// <reference types="vite/client" />

import type { DesktopAgentBridge, WorkspaceBridge } from '@offerget/contracts';

declare global {
  interface Window {
    offergetAgent?: DesktopAgentBridge;
    offergetWorkspace?: WorkspaceBridge;
  }
}

export {};
