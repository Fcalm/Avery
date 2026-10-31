import { z } from 'zod';
import type { ResultEnvelope } from './envelope';

/** 更新源、文件路径和安装命令由 Main 固定，Renderer 只能发出无参数的更新意图。 */
export const AppUpdateStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  status: z.enum(['unavailable', 'idle', 'checking', 'not_available', 'available', 'downloading', 'downloaded', 'installing', 'error']),
  currentVersion: z.string().max(80),
  version: z.string().max(80).optional(),
  progress: z.number().min(0).max(100).optional(),
  checkedAt: z.number().nonnegative().optional(),
  message: z.string().max(300).optional(),
}).strict();

export type AppUpdateState = z.infer<typeof AppUpdateStateSchema>;

export interface DesktopUpdateBridge {
  GetState: () => Promise<ResultEnvelope<AppUpdateState>>;
  Check: () => Promise<ResultEnvelope<AppUpdateState>>;
  Download: () => Promise<ResultEnvelope<AppUpdateState>>;
  Install: () => Promise<ResultEnvelope<boolean>>;
  OnStateChange: (listener: (state: AppUpdateState) => void) => () => void;
}
