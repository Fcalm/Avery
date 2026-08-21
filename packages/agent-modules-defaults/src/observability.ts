import type { LogEntry, ObservabilityModule } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';

/** 观测入口统一脱敏：覆盖凭据、绝对路径及常见无关联系方式，保留可诊断的结构。 */
export function ScrubObservabilityText(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|x-api-key|authorization|token)\s*[:=]\s*[^\s,;"'}]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]')
    .replace(/\b[A-Za-z]:\\[^\r\n"'<>]*/g, '[REDACTED_PATH]')
    .replace(/(?<![:\w])\/(?:[^\s"'<>]+)/g, '[REDACTED_PATH]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]');
}

function ScrubObservabilityPayload(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return ScrubObservabilityText(value).slice(0, 20000);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED_CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => ScrubObservabilityPayload(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1000)
    .map(([key, item]) => [key, /api[_-]?key|authorization|token|secret/i.test(key) ? '[REDACTED]' : ScrubObservabilityPayload(item, seen)]));
}

/** 可观测性模块：本地日志缓冲 + 后端 Trace 存储端口；存储缺失或失败时以本地缓冲兜底，读失败返回空。 */
export function CreateObservabilityModule(ports: AgentDefaultPorts): ObservabilityModule {
  const logs: LogEntry[] = [];
  const store = ports.observabilityStore;

  /** 安全调用存储端口的 void 方法：同步抛错或异步拒绝都不向外传播。 */
  function SafeVoid(call: () => unknown): void {
    try {
      const result = call();
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => { /* 观测失败不阻塞业务主流程。 */ });
      }
    } catch { /* 同上。 */ }
  }

  return {
    packageName: '@offerget/agent-modules-defaults',
    name: 'offerget.agent-defaults',
    version: '0.1.0',
    sdkVersion: '0.1.0',
    slot: 'observability',
    capabilities: ['observability'],
    /** 记录不含用户正文、附件路径或密钥的有限本地运行日志；持久化异步失败不阻塞主流程。 */
    RecordLog(level, event, detail) {
      const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, event, detail: ScrubObservabilityText(detail).slice(0, 300) };
      logs.push(entry);
      if (logs.length > 100) logs.splice(0, logs.length - 100);
      SafeVoid(() => store?.RecordLog?.(level, event, entry.detail));
    },
    StartTrace(requestId, sessionId, model) {
      SafeVoid(() => store?.StartTrace?.(requestId, sessionId, model));
    },
    AppendTraceEvent(requestId, eventType, payload, tokenCount) {
      SafeVoid(() => store?.AppendTraceEvent?.(requestId, eventType, ScrubObservabilityPayload(payload), tokenCount));
    },
    FinishTrace(requestId, state, summary) {
      SafeVoid(() => store?.FinishTrace?.(requestId, state, ScrubObservabilityText(summary).slice(0, 2000)));
    },
    /** 返回持久化日志；存储缺失或失败时回退到本地缓冲。 */
    async GetLogs() {
      try { return (await store?.GetLogs?.()) ?? [...logs]; } catch { return [...logs]; }
    },
    /** 返回持久化 Trace 摘要；存储缺失时返回空列表。 */
    async GetTraces() {
      try { return (await store?.GetTraces?.()) ?? []; } catch { return []; }
    },
    /** 返回单条 Trace 事件；存储缺失时返回空列表。 */
    async GetTraceEvents(requestId) {
      try { return (await store?.GetTraceEvents?.(requestId)) ?? []; } catch { return []; }
    },
    /** 按会话删除 Trace 索引及其事件，不触碰本地日志缓冲。 */
    async DeleteTraces(sessionIds) {
      try { return (await store?.DeleteTraces?.(sessionIds)) ?? { deleted: 0 }; } catch { return { deleted: 0 }; }
    },
    /** 更新 Trace 留存量并裁剪既有索引；存储缺失时返回默认值。 */
    async SetTraceRetention(value) {
      try { return (await store?.SetTraceRetention?.(value)) ?? { traceRetention: 50 }; } catch { return { traceRetention: 50 }; }
    },
    /** 清空本地缓冲与存储日志/Trace，不影响会话、任务和 API 配置。 */
    async ClearObservability() {
      logs.length = 0;
      try { await store?.ClearObservability?.(); } catch { /* 同上。 */ }
      return { cleared: true };
    },
    /** 返回本地日志缓冲副本，供宿主聚合开发者页面数据。 */
    SnapshotLocalLogs() { return [...logs]; },
  };
}
