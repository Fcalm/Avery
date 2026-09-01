import { parentPort, workerData } from 'node:worker_threads';
import { BusinessStore } from '../business-store';
import { NormalizeError } from '@offerget/contracts';
import { DatabaseRecoveryStore } from '../electron/backend/services/database-recovery-service';

if (!parentPort) throw new Error('parentPort is unavailable in this worker.');
const port = parentPort;

/** 冒烟模式才注册的测试仪器开关；生产路径不暴露原始 SQL 查询。 */
const SmokeMode = Boolean((workerData as any).smoke);
const UpgradeFailure = SmokeMode ? (workerData as any).upgradeFailure : undefined;

/** 排除仅内部使用的原型方法，防止 RPC 客户端误放行迁移与构造逻辑。 */
const Excluded = new Set(['constructor', 'RunMigrations', 'PreflightDatabase', 'CreatePreUpgradeBackupIfNeeded']);

/** 业务 Worker 暴露的方法清单：原型方法 + 生命周期方法；冒烟模式追加测试仪器；去重防止重复注册。 */
const Methods = [...new Set([
  ...Object.getOwnPropertyNames(BusinessStore.prototype).filter((name) => !Excluded.has(name)),
  'GetDatabaseRecoveryStatus', 'RestoreLatestBackup', 'RestoreBackup', 'ExportRecoveryDiagnostic',
  ...(SmokeMode ? ['Query', 'CaptureSchemaSnapshot'] : []),
  'SwitchWorkspace', 'Close',
])];

/** 捕获业务数据库的表、列与迁移 checksum，供 schema 行为快照比对（与 smoke-schema-snapshot 口径一致）。 */
function CaptureSchema(db: any): any {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row: any) => String(row.name));
  const columns: Record<string, any[]> = {};
  for (const table of tables) {
    columns[table] = db.prepare(`PRAGMA table_info("${table}")`).all().map((column: any) => ({
      name: column.name, type: column.type, notNull: column.notnull, primaryKey: column.pk, default: column.dflt_value,
    }));
  }
  const migrations = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
  return { tables, columns, migrations };
}

let store: BusinessStore | DatabaseRecoveryStore | null = null;
try {
  store = new BusinessStore((workerData as any).workspacePath, { upgradeFailure: UpgradeFailure });
} catch (error) {
  store = new DatabaseRecoveryStore({ workspacePath: (workerData as any).workspacePath, cause: error as Error });
}

/** 按方法名派发到生命周期逻辑或 Store 实例方法；未知方法以 INTERNAL_ERROR 拒绝。仅构造成功后注册监听器，因此 store 恒非空。 */
async function Dispatch(method: string, args: any[]): Promise<any> {
  const activeStore = store as BusinessStore | DatabaseRecoveryStore;
  if (method === 'SwitchWorkspace') {
    const [nextPath] = args as [string];
    activeStore.Close();
    store = new BusinessStore(nextPath);
    return { switched: true, workspacePath: (store as BusinessStore).workspacePath };
  }
  if (method === 'Close') {
    activeStore.Close();
    return { closed: true };
  }
  if (method === 'Query') {
    if (!SmokeMode) throw Object.assign(new Error('Query is only available in smoke mode.'), { code: 'INTERNAL_ERROR' });
    const db = (activeStore as BusinessStore).db;
    return db.prepare(args[0]).all(...(args[1] || []));
  }
  if (method === 'CaptureSchemaSnapshot') {
    if (!SmokeMode) throw Object.assign(new Error('CaptureSchemaSnapshot is only available in smoke mode.'), { code: 'INTERNAL_ERROR' });
    const db = (activeStore as BusinessStore).db;
    return CaptureSchema(db);
  }
  const callable = (activeStore as any)[method];
  if (typeof callable !== 'function') throw Object.assign(new Error(`Business worker method ${method} is not supported.`), { code: 'INTERNAL_ERROR' });
  const result = await callable.call(activeStore, ...args);
  if ((method === 'RestoreLatestBackup' || method === 'RestoreBackup') && result?.restored === true) {
    store = new BusinessStore((workerData as any).workspacePath);
  }
  return result;
}

if (store === null) {
  // 构造失败已通过 error 信封上报；不注册消息监听器，事件循环清空后 Worker 自然退出（父线程以启动失败处理，不自动重启）。
} else {
  port.postMessage({ type: 'ready', methods: Methods });
  /** MarkItDown 导入引入异步等待后仍维持业务 Worker 的单写者顺序，避免切换工作空间或关闭与附件落盘交错。 */
  let dispatchQueue: Promise<void> = Promise.resolve();
  const HandleRequest = async (message: any): Promise<void> => {
    if (!message || message.type !== 'request') return;
    const { id, method, args } = message;
    try {
      const result = await Dispatch(method, Array.isArray(args) ? args : []);
      port.postMessage({ type: 'response', id, ok: true, data: result });
    } catch (error) {
      const normalized = NormalizeError(error);
      port.postMessage({ type: 'response', id, ok: false, error: { code: normalized.code, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}), ...(normalized.retryable ? { retryable: true } : {}) } });
    }
  };
  port.on('message', (message: any) => {
    dispatchQueue = dispatchQueue.then(() => HandleRequest(message));
  });
}
