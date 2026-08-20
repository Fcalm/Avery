"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_worker_threads_1 = require("node:worker_threads");
const business_store_1 = require("../business-store");
const contracts_1 = require("@offerget/contracts");
const database_recovery_service_1 = require("../electron/backend/services/database-recovery-service");
if (!node_worker_threads_1.parentPort)
    throw new Error('parentPort is unavailable in this worker.');
const port = node_worker_threads_1.parentPort;
/** 冒烟模式才注册的测试仪器开关；生产路径不暴露原始 SQL 查询。 */
const SmokeMode = Boolean(node_worker_threads_1.workerData.smoke);
const UpgradeFailure = SmokeMode ? node_worker_threads_1.workerData.upgradeFailure : undefined;
/** 排除仅内部使用的原型方法，防止 RPC 客户端误放行迁移与构造逻辑。 */
const Excluded = new Set(['constructor', 'RunMigrations', 'PreflightDatabase', 'CreatePreUpgradeBackupIfNeeded']);
/** 业务 Worker 暴露的方法清单：原型方法 + 生命周期方法；冒烟模式追加测试仪器；去重防止重复注册。 */
const Methods = [...new Set([
        ...Object.getOwnPropertyNames(business_store_1.BusinessStore.prototype).filter((name) => !Excluded.has(name)),
        'GetDatabaseRecoveryStatus', 'RestoreLatestBackup', 'RestoreBackup', 'ExportRecoveryDiagnostic',
        ...(SmokeMode ? ['Query', 'CaptureSchemaSnapshot'] : []),
        'SwitchWorkspace', 'Close',
    ])];
/** 捕获业务数据库的表、列与迁移 checksum，供 schema 行为快照比对（与 smoke-schema-snapshot 口径一致）。 */
function CaptureSchema(db) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
    const columns = {};
    for (const table of tables) {
        columns[table] = db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => ({
            name: column.name, type: column.type, notNull: column.notnull, primaryKey: column.pk, default: column.dflt_value,
        }));
    }
    const migrations = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    return { tables, columns, migrations };
}
let store = null;
try {
    store = new business_store_1.BusinessStore(node_worker_threads_1.workerData.workspacePath, { upgradeFailure: UpgradeFailure });
}
catch (error) {
    store = new database_recovery_service_1.DatabaseRecoveryStore({ workspacePath: node_worker_threads_1.workerData.workspacePath, cause: error });
}
/** 按方法名派发到生命周期逻辑或 Store 实例方法；未知方法以 INTERNAL_ERROR 拒绝。仅构造成功后注册监听器，因此 store 恒非空。 */
function Dispatch(method, args) {
    const activeStore = store;
    if (method === 'SwitchWorkspace') {
        const [nextPath] = args;
        activeStore.Close();
        store = new business_store_1.BusinessStore(nextPath);
        return { switched: true, workspacePath: store.workspacePath };
    }
    if (method === 'Close') {
        activeStore.Close();
        return { closed: true };
    }
    if (method === 'Query') {
        if (!SmokeMode)
            throw Object.assign(new Error('Query is only available in smoke mode.'), { code: 'INTERNAL_ERROR' });
        const db = activeStore.db;
        return db.prepare(args[0]).all(...(args[1] || []));
    }
    if (method === 'CaptureSchemaSnapshot') {
        if (!SmokeMode)
            throw Object.assign(new Error('CaptureSchemaSnapshot is only available in smoke mode.'), { code: 'INTERNAL_ERROR' });
        const db = activeStore.db;
        return CaptureSchema(db);
    }
    const callable = activeStore[method];
    if (typeof callable !== 'function')
        throw Object.assign(new Error(`Business worker method ${method} is not supported.`), { code: 'INTERNAL_ERROR' });
    const result = callable.call(activeStore, ...args);
    if ((method === 'RestoreLatestBackup' || method === 'RestoreBackup') && result?.restored === true) {
        store = new business_store_1.BusinessStore(node_worker_threads_1.workerData.workspacePath);
    }
    return result;
}
if (store === null) {
    // 构造失败已通过 error 信封上报；不注册消息监听器，事件循环清空后 Worker 自然退出（父线程以启动失败处理，不自动重启）。
}
else {
    port.postMessage({ type: 'ready', methods: Methods });
    port.on('message', (message) => {
        if (!message || message.type !== 'request')
            return;
        const { id, method, args } = message;
        try {
            const result = Dispatch(method, Array.isArray(args) ? args : []);
            port.postMessage({ type: 'response', id, ok: true, data: result });
        }
        catch (error) {
            const normalized = (0, contracts_1.NormalizeError)(error);
            port.postMessage({ type: 'response', id, ok: false, error: { code: normalized.code, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}), ...(normalized.retryable ? { retryable: true } : {}) } });
        }
    });
}
