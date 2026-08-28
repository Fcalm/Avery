/// <reference types="vite/client" />

import type { DesktopAgentBridge, DesktopEvaluationBridge, WorkspaceBridge } from '@offerget/contracts';

declare global {
  interface Window {
    offergetAgent?: DesktopAgentBridge;
    offergetWorkspace?: WorkspaceBridge;
    offergetEvaluation?: DesktopEvaluationBridge;
  }
}

export {};
