import { parentPort, workerData } from 'node:worker_threads';
import { ObservabilityStore } from '../observability-store';
import { NormalizeError } from '@offerget/contracts';

if (!parentPort) throw new Error('parentPort is unavailable in this worker.');
const port = parentPort;

/** 排除仅内部使用的原型方法，防止 RPC 客户端误放行构造逻辑。 */
const Excluded = new Set(['constructor']);

/** 可观测性 Worker 暴露的方法清单：原型方法 + Close；去重防止重复注册。 */
const Methods = [...new Set([...Object.getOwnPropertyNames(ObservabilityStore.prototype).filter((name) => !Excluded.has(name)), 'Close'])];

let store: ObservabilityStore | null = null;
try {
  store = new ObservabilityStore((workerData as any).userDataPath);
} catch (error) {
  const normalized = NormalizeError(error);
  port.postMessage({ type: 'error', code: normalized.code, message: normalized.message });
}

/** 按方法名派发到生命周期逻辑或 Store 实例方法；未知方法以 INTERNAL_ERROR 拒绝。仅构造成功后注册监听器，因此 store 恒非空。 */
function Dispatch(method: string, args: any[]): any {
  const activeStore = store as ObservabilityStore;
  if (method === 'Close') {
    activeStore.Close();
    return { closed: true };
  }
  const callable = (activeStore as any)[method];
  if (typeof callable !== 'function') throw Object.assign(new Error(`Observability worker method ${method} is not supported.`), { code: 'INTERNAL_ERROR' });
  return callable.call(activeStore, ...args);
}

if (store === null) {
  // 构造失败已通过 error 信封上报；不注册消息监听器，事件循环清空后 Worker 自然退出（父线程以启动失败处理，不自动重启）。
} else {
  port.postMessage({ type: 'ready', methods: Methods });
  port.on('message', (message: any) => {
    if (!message || message.type !== 'request') return;
    const { id, method, args } = message;
    try {
      const result = Dispatch(method, Array.isArray(args) ? args : []);
      port.postMessage({ type: 'response', id, ok: true, data: result });
    } catch (error) {
      const normalized = NormalizeError(error);
      port.postMessage({ type: 'response', id, ok: false, error: { code: normalized.code, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}), ...(normalized.retryable ? { retryable: true } : {}) } });
    }
  });
}
