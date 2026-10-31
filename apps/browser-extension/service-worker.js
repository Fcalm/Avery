const BridgeStorageKey = 'averyBridge';
// 任务身份是扩展侧唯一的标签页授权边界；不要再用一个全局 tab id 表示当前任务。
const TaskTabStorageKey = 'averyTaskTabs';
const TaskSnapshotKeyPrefix = `${TaskTabStorageKey}.`;
const TaskRegistrySchemaVersion = 1;
const PollAlarm = 'avery-bridge-poll';
const DebuggerCommandTimeoutMs = 15000;
const EventStorageTimeoutMs = 1000;
const BridgeStorageTimeoutMs = 3000;
const TaskSnapshotsToKeep = 8;
const PollRetryDelayMs = 100;
const PollRetryMaxDelayMs = 1000;
const PairConfigKeyPrefix = 'averyBridge.';
const PairConfigSchemaVersion = 1;
// 该指纹独立于 manifest version；Chrome 可能继续运行同版本的旧 Service Worker。
// 任何 Bridge 请求都携带它，Backend 缺失或不匹配时会拒绝整条连接。
// v3 清理命令携带 closeTabs；旧 Worker 不能忽略保留策略后仍执行删除。
const BrowserExtensionProtocolRevision = 'avery-browser-extension-bridge-v3';

// This value identifies the in-memory Service Worker generation.  A manifest
// version is not sufficient here: Chrome can keep an old worker alive while a
// newer worker is being reloaded.  Every request carries this own-data field so
// the Bridge can reject late traffic from the retired generation.
function NewWorkerInstanceId() {
  try {
    const value = globalThis.crypto?.randomUUID?.();
    if (typeof value === 'string' && value.length >= 16 && value.length <= 128) return value;
  } catch { /* fall through to the best available local entropy source. */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const workerInstanceId = NewWorkerInstanceId();
const AllowedCdpMethods = new Set([
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Target.getTargets',
  'Target.createTarget',
  'Target.attachToTarget',
  'Target.activateTarget',
  'Target.getTargetInfo',
  'Page.navigate',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.captureScreenshot',
  'Runtime.evaluate',
  'Runtime.releaseObject',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'DOM.setFileInputFiles',
]);

let pollEpoch = 0;
let activePollEpoch = -1;
// 一个任务可以同时附着多个页面；不同任务之间绝不因为切换 active tab 而互相 detach。
const attachedTabIds = new Map();
let activePollAbort = null;
let taskRegistry = null;
let taskRegistryLoad = null;
let taskRegistryWriteTail = Promise.resolve();
let taskRegistryEpoch = Math.floor((globalThis.performance?.timeOrigin ?? Date.now()) * 1000);
let taskRegistryRevision = 0;
const taskRegistryWriterId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const retiredTaskIds = new Set();
let pairingGeneration = Math.floor((globalThis.performance?.timeOrigin ?? Date.now()) * 1000);
let pairingRevision = 0;
let pairingRequestEpoch = 0;
const pairingWriterId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
// Chrome API 调用按桥接命令串行，避免 close_task 和旧页面命令交错修改登记。
let commandTail = Promise.resolve();

function StorageGet(keys) {
  return chrome.storage.local.get(keys);
}

function StorageSet(value) {
  return chrome.storage.local.set(value);
}

function TaskStorageGet(key) {
  return chrome.storage.session.get(key);
}

function TaskStorageSet(value) {
  return chrome.storage.session.set(value);
}

function TaskStorageRemove(keys) {
  return chrome.storage.session.remove(keys);
}

function IsTaskId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function IsPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  } catch {
    return false;
  }
}

// Chrome API 返回值是桥接的不可信边界。直接读取字段会接受继承值或执行
// accessor；标签页 raw identity 只能来自 own data property。
function ReadOwnData(value, key) {
  if (!IsPlainRecord(value)) return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.getOwnPropertyDescriptor(descriptor, 'value')) return { present: false, accessor: Boolean(descriptor) };
  return { present: true, value: descriptor.value };
}

function IsPlainDataRecord(value, allowedKeys) {
  if (!IsPlainRecord(value)) return false;
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.getOwnPropertyNames(value).every((key) => {
      if (!allowedKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && Object.getOwnPropertyDescriptor(descriptor, 'value'));
    });
  } catch {
    return false;
  }
}

function IsArrayIndexKey(key) {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
}

function ReadOwnArrayValues(value) {
  if (!Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Array.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.getOwnPropertyDescriptor(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
    const length = lengthDescriptor.value;
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'length') continue;
      if (!IsArrayIndexKey(key) || Number(key) >= length) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.getOwnPropertyDescriptor(descriptor, 'value')) return null;
    }
    const values = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.getOwnPropertyDescriptor(descriptor, 'value')) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

const PollResponseKeys = new Set(['commands']);

function ParsePollResponse(value) {
  if (!IsPlainDataRecord(value, PollResponseKeys)) return null;
  const commands = ReadOwnData(value, 'commands');
  const values = commands.present ? ReadOwnArrayValues(commands.value) : null;
  return values ? { commands: values } : null;
}

function RecordPollDiagnostic(message, error) {
  try { globalThis.console?.warn?.(message, error); } catch { /* 诊断记录失败不影响轮询安全边界。 */ }
}

function HasInheritedKey(value, key) {
  if (!IsPlainRecord(value)) return false;
  return key in value && !Object.getOwnPropertyDescriptor(value, key);
}

/**
 * 将 Chrome tabs.Tab 归一化为只含 own data 的安全记录。
 * id 必须始终存在；windowId 在最终 TargetInfo 边界强制存在，其余路径
 * 只在字段出现时严格校验，绝不从原型或 getter 取值。
 */
function NormalizeTab(tab, { requireWindowId = false } = {}) {
  if (!IsPlainRecord(tab)) throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab identity must be a plain record.');
  const rawId = ReadOwnData(tab, 'id');
  if (rawId.accessor || !rawId.present || !Number.isSafeInteger(rawId.value) || rawId.value < 0) {
    throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab did not expose its raw tabId identity.');
  }
  const rawWindowId = ReadOwnData(tab, 'windowId');
  if (rawWindowId.accessor || HasInheritedKey(tab, 'windowId')
    || (rawWindowId.present && (!Number.isSafeInteger(rawWindowId.value) || rawWindowId.value < 0))
    || (requireWindowId && !rawWindowId.present)) {
    throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab did not expose its raw windowId identity.');
  }
  const rawOpenerTabId = ReadOwnData(tab, 'openerTabId');
  if (rawOpenerTabId.accessor || HasInheritedKey(tab, 'openerTabId')
    || (rawOpenerTabId.present && rawOpenerTabId.value !== null
      && (!Number.isSafeInteger(rawOpenerTabId.value) || rawOpenerTabId.value < 0))) {
    throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab exposed an invalid raw openerTabId identity.');
  }
  const rawStatus = ReadOwnData(tab, 'status');
  if (rawStatus.accessor || HasInheritedKey(tab, 'status')
    || (rawStatus.present && typeof rawStatus.value !== 'string')) {
    throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab exposed an invalid raw status.');
  }
  const rawTitle = ReadOwnData(tab, 'title');
  if (rawTitle.accessor || HasInheritedKey(tab, 'title')
    || (rawTitle.present && typeof rawTitle.value !== 'string')) {
    throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab exposed an invalid raw title.');
  }
  const rawUrl = ReadOwnData(tab, 'url');
  if (rawUrl.accessor || HasInheritedKey(tab, 'url')
    || (rawUrl.present && typeof rawUrl.value !== 'string')) {
    throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab exposed an invalid raw URL.');
  }
  const normalized = Object.create(null);
  normalized.id = rawId.value;
  if (rawWindowId.present) normalized.windowId = rawWindowId.value;
  normalized.openerTabId = rawOpenerTabId.present ? rawOpenerTabId.value : null;
  if (rawStatus.present) normalized.status = rawStatus.value;
  if (rawTitle.present) normalized.title = rawTitle.value;
  if (rawUrl.present) normalized.url = rawUrl.value;
  return normalized;
}

function NormalizeEventTabId(event) {
  if (!IsPlainRecord(event)) return null;
  const rawTabId = ReadOwnData(event, 'tabId');
  return rawTabId.present && !rawTabId.accessor
    && Number.isSafeInteger(rawTabId.value) && rawTabId.value >= 0
    ? rawTabId.value
    : null;
}

function IsWebUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

async function BridgeConfig() {
  let stored;
  try {
    stored = await AwaitExternal(() => StorageGet(null), Date.now() + BridgeStorageTimeoutMs, {
      code: 'BROWSER_EXTENSION_BRIDGE_UNAVAILABLE', message: 'The Avery browser pairing could not be read in time.',
    });
  } catch { return null; }
  const versioned = LatestPairConfig(stored);
  const value = versioned?.config || stored?.[BridgeStorageKey];
  if (!value || !/^[a-f0-9]{64}$/.test(value.token || '') || !Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535) return null;
  return value;
}

function IsValidPairSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === PairConfigSchemaVersion
    && Number.isSafeInteger(value.epoch) && value.epoch > 0
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && typeof value.writerId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.writerId)
    && /^[a-f0-9]{64}$/.test(value.token || '')
    && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535;
}

function CompareVersioned(left, right) {
  return left.epoch - right.epoch || left.revision - right.revision || left.writerId.localeCompare(right.writerId);
}

function LatestPairConfig(stored) {
  let latest = null;
  for (const [key, value] of Object.entries(stored || {})) {
    if (!key.startsWith(PairConfigKeyPrefix) || !IsValidPairSnapshot(value)) continue;
    if (!latest || CompareVersioned(value, latest.snapshot) > 0) latest = { key, snapshot: value };
  }
  return latest ? { key: latest.key, snapshot: latest.snapshot, config: { token: latest.snapshot.token, port: latest.snapshot.port } } : null;
}

async function PrunePairSnapshots() {
  const deadline = Date.now() + EventStorageTimeoutMs;
  try {
    const stored = await AwaitExternal(() => StorageGet(null), deadline, {
      code: 'BROWSER_EXTENSION_BRIDGE_UNAVAILABLE', message: 'The Avery bridge history lookup timed out.',
    });
    const valid = Object.entries(stored || {})
      .filter(([key, snapshot]) => key.startsWith(PairConfigKeyPrefix) && IsValidPairSnapshot(snapshot))
      .sort((left, right) => CompareVersioned(right[1], left[1]));
    const staleKeys = valid.slice(TaskSnapshotsToKeep).map(([key]) => key);
    if (staleKeys.length) await AwaitExternal(() => chrome.storage.local.remove(staleKeys), deadline, {
      code: 'BROWSER_EXTENSION_BRIDGE_UNAVAILABLE', message: 'The Avery bridge history cleanup timed out.',
    });
  } catch { /* 历史配对回收失败不影响当前桥接或命令。 */ }
}

async function BridgeFetch(config, path, body, signal) {
  const version = chrome.runtime.getManifest()?.version;
  const requestController = signal ? null : new AbortController();
  const requestTimeout = requestController ? setTimeout(() => requestController.abort(), 25_000) : null;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...(body || {}), workerInstanceId, version, protocolRevision: BrowserExtensionProtocolRevision }),
      cache: 'no-store',
      signal: signal || requestController.signal,
    });
    if (!response.ok) {
      let failure;
      try { failure = await response.json(); } catch { failure = null; }
      if (failure?.code === 'BROWSER_EXTENSION_STALE') {
        throw ErrorWithCode('BROWSER_EXTENSION_STALE', String(failure.message || 'The Avery browser extension Service Worker is stale.'));
      }
      throw new Error(`Bridge returned HTTP ${response.status}.`);
    }
    return response.json();
  } finally {
    if (requestTimeout) clearTimeout(requestTimeout);
  }
}

function ErrorWithCode(code, message, statusUnknown = false) {
  return Object.assign(new Error(message), { code, statusUnknown });
}

function NormalizeTaskRecord(value) {
  const tabIds = Array.isArray(value?.tabIds)
    ? [...new Set(value.tabIds.filter((tabId) => Number.isSafeInteger(tabId) && tabId >= 0))]
    : [];
  const parentTabId = Number.isSafeInteger(value?.parentTabId) ? value.parentTabId : null;
  const activeTabId = Number.isSafeInteger(value?.activeTabId) && tabIds.includes(value.activeTabId)
    ? value.activeTabId
    : (tabIds[0] ?? null);
  return { tabIds, parentTabId, activeTabId };
}

function NormalizeTaskRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [taskId, record] of Object.entries(value)) {
    if (IsTaskId(taskId)) result[taskId] = NormalizeTaskRecord(record);
  }
  return result;
}

function IsValidTaskRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([taskId, record]) => IsTaskId(taskId)
    && record && typeof record === 'object' && !Array.isArray(record)
    && Array.isArray(record.tabIds)
    && record.tabIds.every((tabId) => Number.isSafeInteger(tabId) && tabId >= 0)
    && (record.parentTabId === null || (Number.isSafeInteger(record.parentTabId) && record.parentTabId >= 0))
    && (record.activeTabId === null || (Number.isSafeInteger(record.activeTabId) && record.tabIds.includes(record.activeTabId))));
}

function IsValidTaskSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === TaskRegistrySchemaVersion
    && Number.isSafeInteger(value.epoch) && value.epoch > 0
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && typeof value.writerId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.writerId)
    && IsValidTaskRegistry(value.registry);
}

function CompareTaskSnapshots(left, right) {
  return CompareVersioned(left, right);
}

function LatestTaskSnapshot(stored) {
  let latest = null;
  for (const key of Object.keys(stored || {})) {
    if (!key.startsWith(TaskSnapshotKeyPrefix)) continue;
    const snapshot = stored[key];
    if (!IsValidTaskSnapshot(snapshot)) continue;
    if (!latest || CompareTaskSnapshots(snapshot, latest.snapshot) > 0) latest = { key, snapshot };
  }
  return latest;
}

async function PruneTaskSnapshots() {
  const deadline = Date.now() + EventStorageTimeoutMs;
  try {
    const stored = await AwaitExternal(() => TaskStorageGet(null), deadline, {
      code: 'BROWSER_COMMAND_TIMEOUT', message: 'The browser task snapshot cleanup timed out.',
    });
    const valid = Object.entries(stored || {})
      .filter(([key, snapshot]) => key.startsWith(TaskSnapshotKeyPrefix) && IsValidTaskSnapshot(snapshot))
      .sort((left, right) => CompareTaskSnapshots(right[1], left[1]));
    const staleKeys = valid.slice(TaskSnapshotsToKeep).map(([key]) => key);
    if (staleKeys.length) await AwaitExternal(() => TaskStorageRemove(staleKeys), deadline, {
      code: 'BROWSER_COMMAND_TIMEOUT', message: 'The browser task snapshot cleanup timed out.',
    });
  } catch { /* 历史快照回收失败不影响当前任务登记或命令队列。 */ }
}

function TaskDeadline(deadline) {
  return Number.isFinite(deadline) ? deadline : Date.now() + DebuggerCommandTimeoutMs;
}

async function LoadTaskRegistry(deadline) {
  if (taskRegistry) return taskRegistry;
  if (!taskRegistryLoad) {
    if (Date.now() >= TaskDeadline(deadline)) throw ErrorWithCode('BROWSER_COMMAND_TIMEOUT', 'The browser task registry lookup expired before it started.', false);
    const load = { waiters: 0, completed: false, promise: null };
    load.promise = Promise.resolve().then(() => TaskStorageGet(null)).then((stored) => LatestTaskSnapshot(stored)).then((latest) => {
      load.completed = true;
      // 初始化属于底层共享 load，而不是某个 waiter；单个短 deadline 超时不能让长命令拿到空 registry。
      if (taskRegistryLoad === load) {
        taskRegistry = latest ? NormalizeTaskRegistry(latest.snapshot.registry) : {};
        if (latest) taskRegistryEpoch = Math.max(taskRegistryEpoch, latest.snapshot.epoch + 1);
        taskRegistryRevision = 0;
        taskRegistryLoad = null;
      }
      return latest;
    }, (error) => {
      load.completed = true;
      if (taskRegistryLoad === load) taskRegistryLoad = null;
      throw error;
    });
    taskRegistryLoad = load;
  }
  const load = taskRegistryLoad;
  load.waiters += 1;
  try {
    await AwaitExternal(() => load.promise, TaskDeadline(deadline), {
      code: 'BROWSER_COMMAND_TIMEOUT', message: 'The browser task registry lookup timed out.', statusUnknown: false,
    });
    return taskRegistry || {};
  } finally {
    load.waiters -= 1;
    // 无 waiter 再依赖时允许下一条命令重新读存储；旧 Promise 迟到后因 identity 不同不能覆写新状态。
    if (load.waiters === 0 && !load.completed && taskRegistryLoad === load) taskRegistryLoad = null;
  }
}

// 事件回调可能和 Poll 同时到达；任务态变更串行，持久化快照使用不复用的版本键。
function MutateTaskRegistry(mutator, deadline) {
  const limit = TaskDeadline(deadline);
  const operation = taskRegistryWriteTail.then(async () => {
    if (Date.now() >= limit) throw ErrorWithCode('BROWSER_COMMAND_TIMEOUT', 'The browser task registry write expired before execution.');
    const current = await LoadTaskRegistry(limit);
    const registry = Object.fromEntries(Object.entries(current).map(([taskId, record]) => [taskId, {
      tabIds: [...record.tabIds], parentTabId: record.parentTabId, activeTabId: record.activeTabId,
    }]));
    const result = await mutator(registry);
    const snapshot = NormalizeTaskRegistry(registry);
    if (Date.now() >= limit) throw ErrorWithCode('BROWSER_COMMAND_TIMEOUT', 'The browser task registry write expired before it started.', false);
    const revision = ++taskRegistryRevision;
    const key = `${TaskSnapshotKeyPrefix}${taskRegistryEpoch}.${revision}.${taskRegistryWriterId}`;
    const write = AwaitExternal(() => TaskStorageSet({ [key]: {
      schemaVersion: TaskRegistrySchemaVersion, epoch: taskRegistryEpoch, revision, writerId: taskRegistryWriterId, registry: snapshot,
    } }), limit, {
      code: 'BROWSER_COMMAND_TIMEOUT', message: 'The browser task registry write timed out.', statusUnknown: true,
    });
    taskRegistry = snapshot;
    void write.then(() => PruneTaskSnapshots(), () => undefined);
    await write;
    return result;
  });
  taskRegistryWriteTail = operation.then(() => undefined, () => undefined);
  return AwaitExternal(() => operation, limit, {
    code: 'BROWSER_COMMAND_TIMEOUT', message: 'The browser task registry write timed out.', statusUnknown: true,
  });
}

async function ReadTaskRecord(taskId, deadline) {
  if (!IsTaskId(taskId)) throw ErrorWithCode('BROWSER_TASK_ID_REQUIRED', 'A browserTaskId is required for browser operations.');
  if (retiredTaskIds.has(taskId)) return null;
  const registry = await LoadTaskRegistry(deadline);
  return registry[taskId] || null;
}

async function HasTaskTab(taskId, tabId, deadline) {
  const record = await ReadTaskRecord(taskId, deadline);
  return Boolean(record?.tabIds.includes(tabId));
}

async function EnsureTaskRecord(taskId, deadline) {
  await MutateTaskRegistry((registry) => {
    if (!registry[taskId]) registry[taskId] = NormalizeTaskRecord({});
  }, deadline);
}

async function RegisterTaskTab(taskId, tabId, parentTabId = null, active = true, deadline) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
  if (retiredTaskIds.has(taskId)) {
    void RemoveTab(tabId);
    return false;
  }
  let registered = false;
  await MutateTaskRegistry((registry) => {
    if (retiredTaskIds.has(taskId)) return;
    const record = registry[taskId] || NormalizeTaskRecord({});
    if (!record.tabIds.includes(tabId)) record.tabIds.push(tabId);
    if (Number.isSafeInteger(parentTabId) && record.parentTabId === null) record.parentTabId = parentTabId;
    if (active || record.activeTabId === null) record.activeTabId = tabId;
    registry[taskId] = NormalizeTaskRecord(record);
    registered = true;
  }, deadline);
  return registered;
}

async function RemoveTaskTab(taskId, tabId, deadline) {
  await MutateTaskRegistry((registry) => {
    const record = registry[taskId];
    if (!record) return;
    record.tabIds = record.tabIds.filter((candidate) => candidate !== tabId);
    if (record.activeTabId === tabId) record.activeTabId = record.tabIds[0] ?? null;
    if (record.parentTabId === tabId) record.parentTabId = record.tabIds[0] ?? null;
    if (!record.tabIds.length) delete registry[taskId];
    else registry[taskId] = NormalizeTaskRecord(record);
  }, deadline);
  const attached = attachedTabIds.get(taskId);
  attached?.delete(tabId);
  if (attached && !attached.size) attachedTabIds.delete(taskId);
}

async function RemoveTabFromRegistry(tabId) {
  await MutateTaskRegistry((registry) => {
    for (const [taskId, record] of Object.entries(registry)) {
      if (!record.tabIds.includes(tabId)) continue;
      record.tabIds = record.tabIds.filter((candidate) => candidate !== tabId);
      if (record.activeTabId === tabId) record.activeTabId = record.tabIds[0] ?? null;
      if (record.parentTabId === tabId) record.parentTabId = record.tabIds[0] ?? null;
      if (!record.tabIds.length) delete registry[taskId];
      else registry[taskId] = NormalizeTaskRecord(record);
      const attached = attachedTabIds.get(taskId);
      attached?.delete(tabId);
      if (attached && !attached.size) attachedTabIds.delete(taskId);
    }
  }, Date.now() + DebuggerCommandTimeoutMs);
}

function ExpectedSessionId(taskId, tabId) {
  return `avery-${taskId}-${tabId}`;
}

function SessionTabId(taskId, sessionId) {
  const prefix = `avery-${taskId}-`;
  if (typeof sessionId !== 'string' || !sessionId.startsWith(prefix)) return null;
  const rawTabId = sessionId.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(rawTabId)) return null;
  const tabId = Number(rawTabId);
  return Number.isSafeInteger(tabId) ? tabId : null;
}

// Chrome 的某些 tabs/debugger promise 在浏览器崩溃或调试授权对话框下可能永不 resolve。
// 必须只释放本命令的 Promise 链，迟到结果不允许继续改共享登记。
function AwaitExternal(operation, deadline, options = {}) {
  const limit = Number.isFinite(deadline) ? deadline : Date.now() + DebuggerCommandTimeoutMs;
  const timeoutMs = Math.max(1, Math.min(DebuggerCommandTimeoutMs, limit - Date.now()));
  let settled = false;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(ErrorWithCode(options.code || 'BROWSER_COMMAND_TIMEOUT', options.message || 'The browser operation timed out.', options.statusUnknown === true));
    }, timeoutMs);
    Promise.resolve().then(operation).then((value) => {
      if (settled) {
        try { options.onLate?.(value); } catch { /* 迟到清理只能尽力而为。 */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function RemoveTab(tabId, deadline) {
  if (!Number.isSafeInteger(tabId)) return;
  try {
    await AwaitExternal(() => chrome.tabs.remove(tabId), TaskDeadline(deadline), {
      statusUnknown: true,
      message: 'The browser tab cleanup timed out.',
    });
  } catch { /* tab may already be gone or the browser may be disconnected. */ }
}

async function DetachTab(tabId, deadline, requireConfirmation = false) {
  if (!Number.isSafeInteger(tabId)) return;
  try {
    await AwaitExternal(() => chrome.debugger.detach({ tabId }), TaskDeadline(deadline), {
      statusUnknown: true,
      message: 'The browser debugger detach timed out.',
    });
  } catch (error) {
    // 保留页面时必须确认已解除调试；已脱离或页面已不存在等价于权限已收回。
    if (requireConfirmation && !/not attached|No tab with (?:given )?id/i.test(String(error?.message || ''))) throw error;
  }
}

async function LateCreatedTab(taskId, tab) {
  const normalized = NormalizeTab(tab);
  const tabId = normalized.id;
  // 即使 tabs.create 在本命令超时后才返回，也只能归入原 task；原 task
  // 一旦被关闭，绝不能被新的 task 吸收。
  if (!retiredTaskIds.has(taskId)) await RegisterTaskTab(taskId, tabId, normalized.openerTabId, false).catch(() => undefined);
  await RemoveTaskTab(taskId, tabId).catch(() => undefined);
  await RemoveTab(tabId);
}

async function ReadTaskTabs(taskId, beforeExternalCommand, deadline) {
  const record = await ReadTaskRecord(taskId, deadline);
  if (!record) return [];
  const tabs = [];
  const missing = [];
  for (const tabId of [...record.tabIds]) {
    await beforeExternalCommand?.(false);
    try {
      const rawTab = await AwaitExternal(() => chrome.tabs.get(tabId), deadline, {
        code: 'BROWSER_COMMAND_TIMEOUT',
        message: 'The browser task tab lookup timed out.',
        statusUnknown: false,
      });
      const tab = NormalizeTab(rawTab);
      if (tab.id !== tabId) throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab identity changed during task lookup.');
      // 读取恢复后再次确认任务登记没有被 close_task/另一个 worker 事件删除。
      if (!(await HasTaskTab(taskId, tabId, deadline))) continue;
      tabs.push(tab);
    } catch (error) {
      if (error?.code === 'BROWSER_COMMAND_TIMEOUT') throw error;
      missing.push(tabId);
    }
  }
  for (const tabId of missing) await RemoveTaskTab(taskId, tabId, deadline);
  return tabs;
}

async function TaskTab(taskId, required, beforeExternalCommand, deadline, targetId) {
  const tabs = await ReadTaskTabs(taskId, beforeExternalCommand, deadline);
  if (targetId !== undefined && targetId !== null && typeof targetId !== 'string') {
    throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser targetId must preserve its CDP string type.');
  }
  const wanted = targetId === undefined || targetId === null ? undefined : targetId;
  const tab = tabs.find((candidate) => wanted === undefined || String(candidate.id) === wanted) || null;
  if (!tab && required) throw ErrorWithCode('BROWSER_TAB_NOT_FOUND', 'The requested browser target is not owned by this Avery task. Pages opened without a verifiable opener (such as rel=noopener) cannot be safely attributed.');
  return tab;
}

function TargetInfo(tab, taskId, activeTabId) {
  const normalized = NormalizeTab(tab, { requireWindowId: true });
  const tabId = normalized.id;
  const windowId = normalized.windowId;
  const openerTabId = normalized.openerTabId;
  return {
    targetId: String(tabId),
    tabId,
    windowId,
    openerTabId,
    type: 'page',
    ...(normalized.title !== undefined ? { title: normalized.title } : {}),
    ...(normalized.url !== undefined ? { url: normalized.url } : {}),
    active: activeTabId === tabId,
    attached: Boolean(attachedTabIds.get(taskId)?.has(tabId)),
  };
}

async function WaitForTab(taskId, tabId, expectedUrl, beforeExternalCommand, deadline) {
  const end = Math.min(Date.now() + DebuggerCommandTimeoutMs, Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY);
  let latest = null;
  while (Date.now() < end) {
    await beforeExternalCommand?.(false);
    try {
      const rawTab = await AwaitExternal(() => chrome.tabs.get(tabId), end, {
        code: 'BROWSER_COMMAND_TIMEOUT',
        message: 'The Avery task tab did not become ready.',
        statusUnknown: false,
      });
      latest = NormalizeTab(rawTab);
      if (latest.id !== tabId) throw ErrorWithCode('BROWSER_OUTPUT_INVALID', 'The browser tab identity changed while waiting for readiness.');
    } catch (error) {
      if (error?.code === 'BROWSER_COMMAND_TIMEOUT') throw error;
      if (error?.code === 'BROWSER_OUTPUT_INVALID') throw error;
      break;
    }
    if (!(await HasTaskTab(taskId, tabId, deadline))) throw ErrorWithCode('BROWSER_TAB_NOT_FOUND', 'The Avery task tab was closed.');
    await beforeExternalCommand?.(true);
    if (latest.status !== 'loading' && (!expectedUrl || latest.url !== 'about:blank')) return latest;
    const pause = Math.min(100, Math.max(1, end - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw ErrorWithCode('BROWSER_COMMAND_TIMEOUT', 'The Avery task tab did not become ready.', true);
}

async function EnsureAttached(taskId, tabId, beforeExternalCommand, deadline) {
  const attached = attachedTabIds.get(taskId) || new Set();
  if (attached.has(tabId)) return;
  await beforeExternalCommand?.(false);
  try {
    await AwaitExternal(() => chrome.debugger.attach({ tabId }, '1.3'), deadline, {
      statusUnknown: true,
      message: 'The browser debugger attach timed out.',
    });
  } catch (error) {
    if (!String(error?.message || '').includes('already attached')) throw error;
  }
  if (!(await HasTaskTab(taskId, tabId, deadline))) {
    await DetachTab(tabId, deadline);
    throw ErrorWithCode('BROWSER_TAB_NOT_FOUND', 'The requested browser target is outside the Avery task.');
  }
  attached.add(tabId);
  attachedTabIds.set(taskId, attached);
}

async function SendDebuggerCommand(taskId, tabId, method, params, beforeExternalCommand, deadline) {
  await beforeExternalCommand?.(true);
  const timeoutMs = Math.max(1, Math.min(
    DebuggerCommandTimeoutMs,
    Number.isFinite(deadline) ? deadline - Date.now() : DebuggerCommandTimeoutMs,
  ));
  try {
    return await AwaitExternal(() => chrome.debugger.sendCommand({ tabId }, method, params), Date.now() + timeoutMs, {
      statusUnknown: /^(Page|Input|DOM)\./.test(method),
      message: `${method} did not return within ${DebuggerCommandTimeoutMs} ms.`,
    });
  } catch (error) {
    if (error?.code === 'BROWSER_COMMAND_TIMEOUT') {
      await DetachTab(tabId, deadline);
      attachedTabIds.get(taskId)?.delete(tabId);
    }
    throw error;
  }
}

async function ActivateTaskTab(taskId, tab, beforeExternalCommand, deadline) {
  tab = NormalizeTab(tab);
  await beforeExternalCommand?.(false);
  await AwaitExternal(() => chrome.tabs.update(tab.id, { active: true }), deadline, { statusUnknown: true, message: 'The browser tab activation timed out.' });
  if (Number.isSafeInteger(tab.windowId)) {
    await beforeExternalCommand?.(true);
    await AwaitExternal(() => chrome.windows.update(tab.windowId, { focused: true }), deadline, { statusUnknown: true, message: 'The browser window activation timed out.' }).catch(() => undefined);
  }
  await MutateTaskRegistry((registry) => {
    const record = registry[taskId];
    if (record?.tabIds.includes(tab.id)) record.activeTabId = tab.id;
  }, deadline);
}

async function CloseTask(taskId, beforeExternalCommand, deadline, closeTabs = true) {
  await beforeExternalCommand?.(false);
  let record;
  try { record = await ReadTaskRecord(taskId, deadline); }
  catch (error) {
    retiredTaskIds.add(taskId);
    return {
      closed: false, status: error?.statusUnknown ? 'status_unknown' : 'failed', browserTaskId: taskId,
      code: typeof error?.code === 'string' ? error.code : 'BROWSER_TASK_CLEANUP_FAILED',
      message: String(error?.message || 'The browser task registry could not be read for cleanup.').slice(0, 300),
      closedTabs: 0, unknownTabs: null,
    };
  }
  retiredTaskIds.add(taskId);
  if (!record) return { closed: true, status: 'confirmed', browserTaskId: taskId, closedTabs: 0, unknownTabs: 0 };
  const tabIds = [...record.tabIds];
  // 先从登记中摘除固定快照，迟到 tabs.create 只能回收到此 task，不能进入新 task。
  let firstError = null;
  try { await MutateTaskRegistry((registry) => { if (registry[taskId]) delete registry[taskId]; }, deadline); }
  catch (error) { firstError = error; }
  const attached = attachedTabIds.get(taskId);
  if (attached) {
    const detached = await Promise.all(tabIds.filter((tabId) => attached.has(tabId)).map((tabId) =>
      DetachTab(tabId, deadline, !closeTabs).then(() => null, (error) => error)));
    for (const error of detached) firstError ||= error;
    attachedTabIds.delete(taskId);
  }
  if (!closeTabs) {
    // 摘除持久登记并解除调试后交还用户；旧任务即使重放也不能再操作保留的页面。
    return {
      closed: false, status: firstError ? firstError.statusUnknown ? 'status_unknown' : 'failed' : 'confirmed',
      browserTaskId: taskId, closedTabs: 0, retainedTabs: tabIds.length, unknownTabs: firstError ? null : 0,
      ...(firstError ? { code: firstError.code || 'BROWSER_TASK_CLEANUP_FAILED', message: String(firstError.message || 'Task release could not be confirmed.').slice(0, 300) } : {}),
    };
  }
  try { await beforeExternalCommand?.(true); } catch (error) { firstError ||= error; }
  // close_task 已经进入收尾后，按固定 tabIds 尝试清理；每次 Chrome await 仍有界，
  // 不因一个挂死的 remove 阻塞新 task 的命令队列。
  const cleanupDeadline = TaskDeadline(deadline);
  const cleanup = await Promise.all(tabIds.map(async (tabId) => AwaitExternal(
    () => chrome.tabs.remove(tabId), cleanupDeadline,
    { statusUnknown: true, message: 'The browser task tab cleanup timed out.' },
  ).then(() => null, (error) => error)));
  for (const error of cleanup) firstError ||= error;
  const closedTabs = cleanup.filter((error) => error === null).length;
  const unknownTabs = cleanup.filter((error) => error !== null).length;
  return {
    closed: unknownTabs === 0 && !firstError,
    status: !firstError && unknownTabs === 0 ? 'confirmed' : firstError?.statusUnknown || cleanup.some((error) => error?.statusUnknown) ? 'status_unknown' : 'failed',
    browserTaskId: taskId,
    ...(firstError ? {
      code: typeof firstError?.code === 'string' ? firstError.code : 'BROWSER_TASK_CLEANUP_FAILED',
      message: String(firstError?.message || 'The browser task cleanup could not be confirmed.').slice(0, 300),
    } : {}),
    closedTabs,
    unknownTabs,
  };
}

async function HandleCdp(taskId, message, beforeExternalCommand, deadline) {
  const id = message?.id;
  const method = message?.method;
  const params = message?.params && typeof message.params === 'object' ? message.params : {};
  if (!Number.isSafeInteger(id) || !AllowedCdpMethods.has(method)) {
    throw ErrorWithCode('BROWSER_COMMAND_NOT_ALLOWED', `Browser method ${String(method)} is not allowed.`);
  }
  const registry = await LoadTaskRegistry(deadline);
  const record = registry[taskId];
  if (method === 'Target.getTargets') {
    const tabs = await ReadTaskTabs(taskId, beforeExternalCommand, deadline);
    const latest = (await ReadTaskRecord(taskId, deadline)) || record;
    const activeTabId = latest?.activeTabId ?? null;
    return { id, result: { targetInfos: tabs.map((tab) => TargetInfo(tab, taskId, activeTabId)) } };
  }
  if (method === 'Target.createTarget') {
    if (!IsWebUrl(params.url)) throw ErrorWithCode('BROWSER_NAVIGATION_DENIED', 'Only http/https task pages are allowed.');
    await EnsureTaskRecord(taskId, deadline);
    await beforeExternalCommand?.(false);
    const rawCreated = await AwaitExternal(() => chrome.tabs.create({ url: params.url, active: true }), deadline, {
      statusUnknown: true,
      message: 'The browser did not create a task tab in time.',
      onLate: (tab) => {
        void LateCreatedTab(taskId, tab).catch((error) => {
          try { globalThis.console?.warn?.('Avery late tab cleanup failed.', error); } catch { /* 诊断记录失败不影响主流程。 */ }
        });
      },
    });
    let created;
    try { created = NormalizeTab(rawCreated); }
    catch { throw ErrorWithCode('BROWSER_START_FAILED', 'The browser did not create a task tab with a safe raw identity.'); }
    try {
      await beforeExternalCommand?.(true);
      await RegisterTaskTab(taskId, created.id, created.openerTabId, true, deadline);
      const ready = await WaitForTab(taskId, created.id, params.url, beforeExternalCommand, deadline);
      return { id, result: { targetId: String(ready.id) } };
    } catch (error) {
      await RemoveTaskTab(taskId, created.id, deadline).catch(() => undefined);
      await RemoveTab(created.id, deadline);
      throw error;
    }
  }
  if (method === 'Target.attachToTarget' || method === 'Target.activateTarget' || method === 'Target.getTargetInfo') {
    const tab = await TaskTab(taskId, true, beforeExternalCommand, deadline, params.targetId);
    if (method === 'Target.getTargetInfo') {
      const latest = await ReadTaskRecord(taskId, deadline);
      return { id, result: { targetInfo: TargetInfo(tab, taskId, latest?.activeTabId ?? null) } };
    }
    if (method === 'Target.activateTarget') {
      await ActivateTaskTab(taskId, tab, beforeExternalCommand, deadline);
      return { id, result: {} };
    }
    await EnsureAttached(taskId, tab.id, beforeExternalCommand, deadline);
    return { id, result: { sessionId: ExpectedSessionId(taskId, tab.id) } };
  }
  if (!record) throw ErrorWithCode('BROWSER_TAB_NOT_FOUND', 'The Avery task target is unavailable.');
  const sessionTabId = SessionTabId(taskId, message?.sessionId);
  if (sessionTabId === null || !(await HasTaskTab(taskId, sessionTabId, deadline))) {
    throw ErrorWithCode('BROWSER_TAB_NOT_FOUND', 'The browser session is not owned by this Avery task.');
  }
  if (params.targetId !== undefined && String(params.targetId) !== String(sessionTabId)) {
    throw ErrorWithCode('BROWSER_TAB_NOT_FOUND', 'The browser session and target do not belong to the same Avery task page.');
  }
  // SessionTabId 已完成 sessionId 所有权校验，但 Chrome tabId 是数字；进入 CDP
  // targetId 边界前显式还原为协议字符串，避免把内部数字身份误判为外部非法输入。
  const tab = await TaskTab(taskId, true, beforeExternalCommand, deadline, String(sessionTabId));
  if (method === 'Page.navigate') {
    if (!IsWebUrl(params.url)) throw ErrorWithCode('BROWSER_NAVIGATION_DENIED', 'Only http/https task pages are allowed.');
    await beforeExternalCommand?.(false);
    await AwaitExternal(() => chrome.tabs.update(tab.id, { url: params.url }), deadline, { statusUnknown: true, message: 'The task page navigation timed out.' });
    const ready = await WaitForTab(taskId, tab.id, params.url, beforeExternalCommand, deadline);
    return { id, result: { frameId: String(ready.id) } };
  }
  await EnsureAttached(taskId, tab.id, beforeExternalCommand, deadline);
  const result = await SendDebuggerCommand(taskId, tab.id, method, params, beforeExternalCommand, deadline);
  return { id, result: result || {} };
}

async function HandleCommand(command, epoch, config) {
  const beforeExternalCommand = async (alreadyStarted) => {
    if (epoch !== pollEpoch) throw ErrorWithCode('CANCELLED', 'Browser command was cancelled after the Avery bridge was re-paired.', true);
    if (CommandExpired(command)) throw ErrorWithCode('BROWSER_COMMAND_TIMEOUT', 'Browser command expired before the browser operation started.', alreadyStarted);
    let active;
    try {
      active = await AwaitExternal(() => CommandIsActive(config, command), TaskDeadline(command.deadline), {
        code: 'BROWSER_COMMAND_STATUS_UNAVAILABLE',
        message: 'Browser bridge command status could not be verified in time.',
        statusUnknown: alreadyStarted,
      });
    } catch (error) {
      throw ErrorWithCode('BROWSER_COMMAND_STATUS_UNAVAILABLE', String(error?.message || 'Browser bridge command status could not be verified.'), alreadyStarted);
    }
    if (!active) throw ErrorWithCode('CANCELLED', 'Browser command was cancelled before the browser operation started.', alreadyStarted);
    if (epoch !== pollEpoch) throw ErrorWithCode('CANCELLED', 'Browser command was cancelled after the browser bridge was re-paired.', true);
    if (CommandExpired(command)) throw ErrorWithCode('BROWSER_COMMAND_TIMEOUT', 'Browser command expired before the browser operation started.', alreadyStarted);
  };
  if (!Number.isSafeInteger(command?.deadline) || command.deadline <= 0) {
    throw ErrorWithCode('BROWSER_COMMAND_DEADLINE_REQUIRED', 'A browser command deadline is required.');
  }
  const taskId = command?.browserTaskId;
  if (!IsTaskId(taskId)) throw ErrorWithCode('BROWSER_TASK_ID_REQUIRED', 'A browserTaskId is required for browser operations.');
  if (command?.operation === 'close_task') {
    const closeTabs = command.payload?.closeTabs;
    if (closeTabs !== undefined && typeof closeTabs !== 'boolean') throw ErrorWithCode('BROWSER_ARGUMENT_INVALID', 'closeTabs must be a boolean.');
    return CloseTask(taskId, beforeExternalCommand, command.deadline, closeTabs !== false);
  }
  if (retiredTaskIds.has(taskId)) throw ErrorWithCode('BROWSER_TASK_RETIRED', 'This browserTaskId has already been retired and cannot be reused.');
  if (command?.operation === 'cdp') return HandleCdp(taskId, command.payload, beforeExternalCommand, command.deadline);
  throw ErrorWithCode('BROWSER_COMMAND_NOT_ALLOWED', 'Unknown browser bridge operation.');
}

function CancelledAfterPair(command) {
  return { id: command.id, ok: false, error: { code: 'CANCELLED', message: 'Browser command was cancelled after the browser bridge was re-paired.', statusUnknown: true } };
}

function CommandExpired(command) {
  return Number.isFinite(command?.deadline) && Date.now() >= command.deadline;
}

function CancelledBeforeExecution(command) {
  return { id: command.id, ok: false, error: { code: 'CANCELLED', message: 'Browser command was cancelled before execution.', statusUnknown: false } };
}

function TimedOutBeforeExecution(command) {
  return { id: command.id, ok: false, error: { code: 'BROWSER_COMMAND_TIMEOUT', message: 'Browser command expired before execution.', statusUnknown: false } };
}

function InvalidCommand(command, code, message) {
  return { id: command?.id, ok: false, error: { code, message, statusUnknown: false } };
}

async function CommandIsActive(config, command) {
  const status = await BridgeFetch(config, '/bridge/command-status', { id: command.id });
  return status?.active === true;
}

function EnqueueCommand(command, epoch, config) {
  if (!Number.isSafeInteger(command?.deadline) || command.deadline <= 0) {
    return Promise.resolve(InvalidCommand(command, 'BROWSER_COMMAND_DEADLINE_REQUIRED', 'A browser command deadline is required.'));
  }
  if (!IsTaskId(command?.browserTaskId)) {
    return Promise.resolve(InvalidCommand(command, 'BROWSER_TASK_ID_REQUIRED', 'A browserTaskId is required for browser operations.'));
  }
  const task = commandTail.then(async () => {
    if (epoch !== pollEpoch) return CancelledAfterPair(command);
    if (CommandExpired(command)) return TimedOutBeforeExecution(command);
    let active;
    try {
      active = await AwaitExternal(() => CommandIsActive(config, command), TaskDeadline(command.deadline), {
        code: 'BROWSER_COMMAND_STATUS_UNAVAILABLE',
        message: 'Browser bridge command status could not be verified in time.',
        statusUnknown: false,
      });
    } catch (error) {
      return { id: command.id, ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'BROWSER_COMMAND_FAILED', message: String(error?.message || 'Browser bridge command status could not be verified.').slice(0, 500), statusUnknown: false } };
    }
    if (epoch !== pollEpoch) return CancelledAfterPair(command);
    if (CommandExpired(command)) return TimedOutBeforeExecution(command);
    if (!active) return CancelledBeforeExecution(command);
    try {
      return { id: command.id, ok: true, data: await HandleCommand(command, epoch, config) };
    } catch (error) {
      return { id: command.id, ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'BROWSER_COMMAND_FAILED', message: String(error?.message || 'Browser command failed.').slice(0, 500), statusUnknown: error?.statusUnknown === true } };
    }
  });
  commandTail = task.then(() => undefined, () => undefined);
  return task;
}

async function Poll() {
  const epoch = pollEpoch;
  if (activePollEpoch === epoch) return;
  activePollEpoch = epoch;
  try {
    let retryDelay = PollRetryDelayMs;
    // A fresh worker instance must prove its generation before it can poll.
    // After a transport failure the next retry starts with hello again, so a
    // newer worker can atomically supersede an old worker still long-polling.
    let helloBeforePoll = true;
    const retry = async () => {
      if (epoch !== pollEpoch) return false;
      const controller = new AbortController();
      activePollAbort = controller;
      try {
        await new Promise((resolveWait, rejectWait) => {
          let timer = null;
          const abort = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            controller.signal.removeEventListener('abort', abort);
            rejectWait(ErrorWithCode('CANCELLED', 'A newer Avery browser pairing replaced this poll.'));
          };
          timer = setTimeout(() => {
            timer = null;
            controller.signal.removeEventListener('abort', abort);
            resolveWait();
          }, retryDelay);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      } catch {
        return false;
      } finally {
        if (activePollAbort === controller) activePollAbort = null;
      }
      retryDelay = Math.min(PollRetryMaxDelayMs, retryDelay * 2);
      return epoch === pollEpoch;
    };
    while (epoch === pollEpoch) {
      const config = await BridgeConfig();
      if (!config) {
        RecordPollDiagnostic('Avery browser bridge configuration is unavailable; retrying poll.');
        if (!await retry()) return;
        continue;
      }
      if (helloBeforePoll) {
        try {
          await BridgeFetch(config, '/bridge/hello', {}, undefined);
          helloBeforePoll = false;
          retryDelay = PollRetryDelayMs;
        } catch (error) {
          if (epoch !== pollEpoch || error?.code === 'BROWSER_EXTENSION_STALE') {
            RecordPollDiagnostic('Avery browser extension Service Worker is stale; waiting for reload.', error);
            return;
          }
          RecordPollDiagnostic('Avery browser hello failed; retrying before poll.', error);
          if (!await retry()) return;
          continue;
        }
      }
      let response;
      const controller = new AbortController();
      const timeoutController = new AbortController();
      const requestTimeout = setTimeout(() => timeoutController.abort(), 25_000);
      activePollAbort = controller;
      try {
        response = await BridgeFetch(config, '/bridge/poll', {}, AbortSignal.any([controller.signal, timeoutController.signal]));
        retryDelay = PollRetryDelayMs;
      } catch (error) {
        if (epoch !== pollEpoch || controller.signal.aborted) return;
        if (error?.code === 'BROWSER_EXTENSION_STALE') {
          RecordPollDiagnostic('Avery browser extension Service Worker is stale; waiting for reload.', error);
          return;
        }
        RecordPollDiagnostic('Avery browser poll failed; retrying.', error);
        helloBeforePoll = true;
        if (!await retry()) return;
        continue;
      }
      finally {
        clearTimeout(requestTimeout);
        if (activePollAbort === controller) activePollAbort = null;
      }
      if (epoch !== pollEpoch) return;
      const parsed = ParsePollResponse(response);
      if (!parsed) {
        RecordPollDiagnostic('Avery browser poll returned an invalid response.');
        helloBeforePoll = true;
        if (!await retry()) return;
        continue;
      }
      if (!parsed.commands.length) {
        if (!await retry()) return;
        continue;
      }
      for (const command of parsed.commands) {
        if (epoch !== pollEpoch) return;
        const result = await EnqueueCommand(command, epoch, config);
        await BridgeFetch(config, '/bridge/result', result).catch(() => undefined);
      }
    }
  } finally {
    if (activePollEpoch === epoch) activePollEpoch = -1;
  }
}

function StartPoll() {
  void Poll().catch((error) => {
    RecordPollDiagnostic('Avery browser poll loop failed.', error);
  });
}

function ValidBridgeConfig(value) {
  return value && /^[a-f0-9]{64}$/.test(value.token || '')
    && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535;
}

/** 配对成功后只关闭发起配对的顶层页面；重新读取 URL，避免误关已被用户导航的标签页。 */
async function ClosePairedTab(sender, config) {
  const tabId = sender?.tab?.id;
  if (!Number.isSafeInteger(tabId) || sender.frameId !== 0) return;
  const isPairPage = (value) => {
    try {
      const url = new URL(value);
      const params = new URLSearchParams(url.hash.slice(1));
      return url.protocol === 'http:' && url.hostname === '127.0.0.1'
        && Number(url.port || 80) === config.port && url.pathname === '/pair'
        && params.get('token') === config.token && Number(params.get('port')) === config.port;
    } catch { return false; }
  };
  if (!isPairPage(sender.url)) return;
  const tab = await chrome.tabs.get(tabId);
  if (isPairPage(tab.pendingUrl || tab.url)) await chrome.tabs.remove(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'avery_pair') return false;
  let responded = false;
  const respond = (value) => {
    if (responded) return;
    responded = true;
    sendResponse(value);
  };
  const config = { token: message.token, port: message.port };
  if (!ValidBridgeConfig(config)) {
    respond({ ok: false, message: 'pairing credentials are invalid' });
    return false;
  }
  const pairingRequest = ++pairingRequestEpoch;
  const requestRevision = ++pairingRevision;
  const work = (async () => {
    const storageDeadline = Date.now() + BridgeStorageTimeoutMs;
    const stored = await AwaitExternal(() => StorageGet(null), storageDeadline, {
      code: 'BROWSER_EXTENSION_BRIDGE_UNAVAILABLE', message: 'The Avery browser pairing history could not be read in time.',
    });
    if (pairingRequest !== pairingRequestEpoch) throw ErrorWithCode('CANCELLED', 'A newer Avery browser pairing replaced this request.');
    const latest = LatestPairConfig(stored);
    if (latest) pairingGeneration = Math.max(pairingGeneration, latest.snapshot.epoch + 1);
    const epoch = pairingGeneration;
    const key = `${PairConfigKeyPrefix}${epoch}.${requestRevision}.${pairingWriterId}`;
    const snapshot = {
      schemaVersion: PairConfigSchemaVersion,
      epoch,
      revision: requestRevision,
      writerId: pairingWriterId,
      token: config.token,
      port: config.port,
    };
    await AwaitExternal(() => {
      if (pairingRequest !== pairingRequestEpoch) throw ErrorWithCode('CANCELLED', 'A newer Avery browser pairing replaced this request.');
      return StorageSet({ [key]: snapshot });
    }, storageDeadline, {
      code: 'BROWSER_EXTENSION_BRIDGE_UNAVAILABLE', message: 'The Avery browser pairing could not be saved in time.',
    });
    void PrunePairSnapshots();
    if (pairingRequest !== pairingRequestEpoch) throw ErrorWithCode('CANCELLED', 'A newer Avery browser pairing replaced this request.');
    pollEpoch += 1;
    activePollAbort?.abort();
    await AwaitExternal(() => BridgeFetch(config, '/bridge/hello', { version: chrome.runtime.getManifest().version }), Date.now() + BridgeStorageTimeoutMs, {
      code: 'BROWSER_EXTENSION_BRIDGE_UNAVAILABLE', message: 'The Avery browser bridge did not respond in time.',
    });
    if (pairingRequest !== pairingRequestEpoch) throw ErrorWithCode('CANCELLED', 'A newer Avery browser pairing replaced this request.');
    chrome.alarms.create(PollAlarm, { periodInMinutes: 0.5 });
    StartPoll();
    return { ok: true };
  })();
  void work.then((result) => {
    respond(result);
    // 关闭失败不改变已完成的连接结果，页面仍展示成功状态供用户手动关闭。
    void ClosePairedTab(sender, config).catch(() => undefined);
  }, (error) => respond({ ok: false, message: String(error?.message || 'connection failed').slice(0, 300) }));
  return true;
});

function ClearLegacyTaskStorage() {
  void chrome.storage.local.remove(['averyTaskTabId', TaskTabStorageKey]).catch(() => undefined);
}

chrome.runtime.onStartup.addListener(() => { ClearLegacyTaskStorage(); StartPoll(); });
chrome.runtime.onInstalled.addListener(() => { ClearLegacyTaskStorage(); chrome.alarms.create(PollAlarm, { periodInMinutes: 0.5 }); StartPoll(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === PollAlarm) StartPoll(); });

// 只有从已登记任务页打开的标签页才继承身份；用户原始标签页和无 opener 的窗口永不纳入。
chrome.tabs.onCreated?.addListener((tab) => {
  void (async () => {
    const normalized = NormalizeTab(tab);
    const openerTabId = normalized.openerTabId;
    if (!Number.isSafeInteger(openerTabId)) return;
    const registry = await LoadTaskRegistry(Date.now() + EventStorageTimeoutMs);
    const owner = Object.entries(registry).find(([, record]) => record.tabIds.includes(openerTabId))?.[0];
    if (!owner || retiredTaskIds.has(owner)) return;
    await RegisterTaskTab(owner, normalized.id, openerTabId, true, Date.now() + EventStorageTimeoutMs);
  })().catch(() => undefined);
});

chrome.tabs.onActivated?.addListener((activeInfo) => {
  const tabId = NormalizeEventTabId(activeInfo);
  if (tabId === null) return;
  void MutateTaskRegistry((registry) => {
    for (const record of Object.values(registry)) if (record.tabIds.includes(tabId)) record.activeTabId = tabId;
  }, Date.now() + EventStorageTimeoutMs).catch(() => undefined);
});

chrome.tabs.onRemoved?.addListener((tabId) => { void RemoveTabFromRegistry(tabId).catch(() => undefined); });
chrome.debugger.onDetach?.addListener((source) => {
  const tabId = NormalizeEventTabId(source);
  if (tabId === null) return;
  for (const [taskId, tabs] of attachedTabIds) {
    if (!tabs.delete(tabId)) continue;
    if (!tabs.size) attachedTabIds.delete(taskId);
  }
});
StartPoll();
