import type { FileReadPort, LogEntry, ProviderUsageFact, ResumeReadPort, ResumeWritePort, TraceEntry, TraceEventEntry } from '@offerget/agent-sdk';

/** 模型 Provider 配置：API Key 仅经宿主持有的 CredentialPort 存取，默认模块不直接接触 safeStorage。 */
export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  thinkingEnabled: boolean;
  contextLimit: number;
  /** default 使用模型能力钳制后的 256K；custom 使用用户明确配置的限制。旧配置可缺失。 */
  contextLimitMode?: 'default' | 'custom';
  compressionThreshold: number;
  apiKey: string;
}

/** 可观测性存储端口：方法可选，缺失或失败时模块以本地缓冲兜底，读失败返回空由宿主兜底。 */
export interface ObservabilityStorePort {
  RecordLog?(level: 'INFO' | 'WARN' | 'ERROR', event: string, detail: string): unknown;
  StartTrace?(requestId: string, sessionId: string, model: string): unknown;
  AppendTraceEvent?(requestId: string, eventType: string, payload: unknown, tokenCount?: number): unknown;
  RecordTraceUsage?(requestId: string, usage: ProviderUsageFact): unknown;
  FinishTrace?(requestId: string, state: string, summary: string): unknown;
  GetLogs?(): Promise<LogEntry[]>;
  GetTraces?(): Promise<TraceEntry[]>;
  GetTraceEvents?(requestId: string): Promise<TraceEventEntry[]>;
  DeleteTraces?(sessionIds: string[]): Promise<{ deleted: number }>;
  SetTraceRetention?(value: number): Promise<{ traceRetention: number }>;
  ClearObservability?(): Promise<{ cleared: boolean }>;
}

/** 官方默认模块所需的宿主窄端口集合：密钥、文件资源边界与观测存储均由宿主持有并注入。 */
export interface AgentDefaultPorts {
  /** 惰性读取已保存的模型配置（宿主经 CredentialPort）；无配置返回 null。 */
  getConfig(): Promise<ProviderConfig | null>;
  /** 保存模型配置（宿主移交 safeStorage 加密落盘）。 */
  saveConfig(config: ProviderConfig): Promise<void>;
  /** 读取已保存设置（供上下文槽读取自定义上下文）。 */
  getStoredSettings(): Promise<Record<string, unknown>>;
  /** 文件读取端口：宿主注入 agent-file-reader，路径校验与资源边界不由模块持有。 */
  file: FileReadPort;
  /** 简历只读端口。 */
  resumeRead: ResumeReadPort;
  /** 简历写端口：S6 切换为锁实现，S4/S5 模块暂不调用。 */
  resumeWrite: ResumeWritePort;
  /** 可观测性存储端口（ObservabilityStore 或窄异步端口）。 */
  observabilityStore: ObservabilityStorePort | null;
}
