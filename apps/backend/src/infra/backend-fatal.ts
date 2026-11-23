import type { EventEmitter } from 'node:events';

/** 未捕获异常后的进程不再继续提供服务；上报稳定诊断后退出，由 Main 结算在途请求并退避重启。 */
export function InstallBackendFatalHandlers(post: (message: unknown) => void, options: {
  events?: EventEmitter; exit?: (code: number) => void;
} = {}): () => void {
  const events = options.events ?? process;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (reason: 'UNCAUGHT' | 'UNHANDLED', error: unknown) => {
    if (failed) return;
    failed = true;
    const value = error && typeof error === 'object' ? error as { code?: unknown; name?: unknown } : {};
    // 不转发异常中的模型正文、请求参数、密钥或物理路径；诊断只保留有限的名称和原因码。
    const safe = (code: unknown) => typeof code === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(code) ? code : undefined;
    try { post({ kind: 'backend-fatal', code: reason, causeCode: safe(value.code), name: safe(value.name) }); }
    catch { /* 主通道也已失效时仍必须退出，不能继续提供服务。 */ }
    finally { timer = setTimeout(() => (options.exit ?? process.exit)(1), 25); }
  };
  const uncaught = (error: unknown) => fail('UNCAUGHT', error);
  const unhandled = (error: unknown) => fail('UNHANDLED', error);
  events.on('uncaughtException', uncaught);
  events.on('unhandledRejection', unhandled);
  return () => { clearTimeout(timer); events.removeListener('uncaughtException', uncaught); events.removeListener('unhandledRejection', unhandled); };
}
