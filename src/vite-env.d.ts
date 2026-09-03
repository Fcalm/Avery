/// <reference types="vite/client" />

import type { DesktopAgentBridge, DesktopEvaluationBridge, WorkspaceBridge } from '@avery/contracts';

declare global {
  interface Window {
    averyAgent?: DesktopAgentBridge;
    averyWorkspace?: WorkspaceBridge;
    averyEvaluation?: DesktopEvaluationBridge;
  }
}

export {};
