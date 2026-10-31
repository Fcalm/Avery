import type { AgentMetrics, BenchClient, CreateOptions, SignedResult } from './client.cjs';
export interface ExecuteTask { id: string; url: string; input: string; attachmentPath: string; attachmentName: string; }
/** execute 与 flush 接入 Avery 测评器，函数负责轮次生命周期和失败归类。 */
export function runCase(options: CreateOptions & {
  client?: BenchClient;
  cleanup?: boolean;
  execute: (task: ExecuteTask) => Promise<{ metrics?: AgentMetrics } | void>;
  flush?: (task: ExecuteTask) => Promise<unknown>;
}): Promise<SignedResult>;
