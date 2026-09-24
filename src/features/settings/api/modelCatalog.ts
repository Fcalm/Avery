/**
 * 模型目录的应用内缓存。
 *
 * 上下文窗口、最大输出 Token、输入类型、API 格式、供应商启用状态与模型增删在宿主侧都没有存储位置，
 * 因此按产品要求只缓存在应用本地（localStorage），不写入业务数据库，也不进入工作空间快照。
 * 只有当前选中模型的上下文窗口与思考模式会在保存时下发宿主配置，缓存同时是这两项的界面来源。
 */

/** 供应商 ID 与宿主侧的 Provider 一一对应；推荐供应商由宿主固定官方端点，本地只决定启用状态与模型列表。 */
export type ModelCatalogProviderId = 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义';

export type ModelApiFormat = 'chat' | 'responses' | 'messages';

export interface ModelApiFormatOption {
  key: ModelApiFormat;
  label: string;
  note: string;
}

/** API 格式选项：只有自定义供应商允许切换，官方供应商固定使用 Chat Completions。 */
export const ModelApiFormats: ModelApiFormatOption[] = [
  { key: 'chat', label: 'Chat Completions (/chat/completions)', note: 'OpenAI 兼容的对话补全接口，大多数供应商都用它。' },
  { key: 'responses', label: 'Responses (/responses)', note: 'OpenAI 较新的接口，支持内置工具与推理摘要。' },
  { key: 'messages', label: 'Anthropic Messages (/v1/messages)', note: 'Claude 系列的原生接口。' },
];

export interface ModelCatalogModel {
  id: string;
  /** 上下文窗口（token）：当前模型的取值会作为宿主端上下文限制下发。 */
  contextWindow: number;
  /** 最大输出 Token：宿主端没有对应配置，仅记录在应用内。 */
  maxOutput: number;
  /** 输入类型：文本恒为可用，图片与 PDF 取决于模型能力。 */
  inputImage: boolean;
  inputPdf: boolean;
  /** 思考模式：当前模型的取值会作为宿主端 thinkingEnabled 下发。 */
  thinking: boolean;
}

export interface ModelCatalogProvider {
  id: ModelCatalogProviderId;
  name: string;
  /** 自定义供应商允许删除与修改端点；推荐分组使用官方端点，不提供删除。 */
  custom: boolean;
  enabled: boolean;
  apiFormat: ModelApiFormat;
  models: ModelCatalogModel[];
}

export interface ModelCatalog {
  /** 是否已与宿主目录合并过：未合并时本地模型列表可能不完整，对话页不应据此裁剪宿主返回的模型。 */
  seeded: boolean;
  providers: ModelCatalogProvider[];
}

/** 宿主侧返回的供应商快照，只取合并目录需要的字段。 */
export interface BackendProviderSnapshot {
  provider: ModelCatalogProviderId;
  model: string;
  models: string[];
  contextLimit?: number;
  thinkingEnabled?: boolean;
}

export const ModelCatalogStorageKey = 'avery.model-catalog.v1';
/** 与宿主端 DefaultContextLimit 一致：作为新模型的上下文窗口初值。 */
export const DefaultContextWindow = 256_000;
export const DefaultMaxOutput = 8_192;
/** 模型弹窗允许填写的上下文窗口区间：按 token 数填写 128000–1000000，不接受 K 简写。 */
export const MinimumContextWindow = 128_000;
export const MaximumContextWindow = 1_000_000;

/** 各供应商的模型初值：DeepSeek 使用官方 V4 默认列表，MiMo 使用官方 V2.6 对话模型，自定义供应商从空列表开始。 */
const DefaultProviderSeeds: Array<{ id: ModelCatalogProviderId; name: string; custom: boolean; models: string[] }> = [
  { id: 'DeepSeek', name: 'DeepSeek', custom: false, models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'] },
  { id: 'Z.AI', name: '智谱 GLM', custom: false, models: ['glm-5.3-flash'] },
  { id: 'MIMO', name: 'MIMO', custom: false, models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'] },
  { id: '自定义', name: '自定义提供商', custom: true, models: [] },
];

type ModelCatalogListener = () => void;

/** 目录变更订阅者：对话页据此重新裁剪可选供应商与模型。 */
const listeners = new Set<ModelCatalogListener>();

export function CreateCatalogModel(id: string, patch: Partial<Omit<ModelCatalogModel, 'id'>> = {}): ModelCatalogModel {
  return { id, contextWindow: DefaultContextWindow, maxOutput: DefaultMaxOutput, inputImage: false, inputPdf: false, thinking: true, ...patch };
}

export function CreateDefaultModelCatalog(): ModelCatalog {
  return {
    seeded: false,
    providers: DefaultProviderSeeds.map((seed) => ({
      id: seed.id,
      name: seed.name,
      custom: seed.custom,
      enabled: true,
      apiFormat: 'chat',
      models: seed.models.map((id) => CreateCatalogModel(id)),
    })),
  };
}

function ToPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function NormalizeModel(value: unknown): ModelCatalogModel | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id || id.length > 200) return null;
  const contextWindow = ToPositiveInteger(record.contextWindow);
  const maxOutput = ToPositiveInteger(record.maxOutput);
  if (contextWindow === null || maxOutput === null) return null;
  return {
    id,
    contextWindow,
    maxOutput,
    inputImage: record.inputImage === true,
    inputPdf: record.inputPdf === true,
    thinking: record.thinking !== false,
  };
}

function NormalizeProvider(value: unknown): ModelCatalogProvider | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (id !== 'DeepSeek' && id !== 'Z.AI' && id !== 'MIMO' && id !== '自定义') return null;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
  const apiFormat = ModelApiFormats.some((option) => option.key === record.apiFormat) ? record.apiFormat as ModelApiFormat : 'chat';
  const models = Array.isArray(record.models) ? record.models.map(NormalizeModel).filter((item): item is ModelCatalogModel => item !== null) : [];
  return { id, name, custom: id === '自定义', enabled: record.enabled !== false, apiFormat, models: RetainOwnModels(id, models) };
}

/** 推荐供应商的模型 ID 命名空间：用于清掉历史版本串到别的供应商里的模型（曾出现 MiMo 列表混入 DeepSeek 模型）。 */
const ProviderModelNamespaces: Partial<Record<ModelCatalogProviderId, RegExp>> = {
  DeepSeek: /^deepseek-/i,
  'Z.AI': /^glm-/i,
  MIMO: /^mimo-/i,
};

/**
 * 只保留属于该供应商命名空间的模型：命中其它推荐供应商命名空间的条目一律丢弃。
 * 历史版本的模型同步曾把 A 供应商的模型写进 B 供应商，缓存里的这类脏数据必须清掉，否则会被一直沿用；
 * 自定义供应商的模型名无法判定归属，不做清洗。
 */
function RetainOwnModels(providerId: ModelCatalogProviderId, models: ModelCatalogModel[]): ModelCatalogModel[] {
  if (!ProviderModelNamespaces[providerId]) return models;
  return models.filter((model) => !Object.entries(ProviderModelNamespaces).some(([id, pattern]) => id !== providerId && pattern.test(model.id)));
}

/** 清洗整个目录：任何入口（读缓存、合并宿主目录、写入缓存）产生的跨供应商模型都在这里被剔除。 */
export function SanitizeModelCatalog(catalog: ModelCatalog): ModelCatalog {
  return {
    ...catalog,
    providers: catalog.providers.map((provider) => {
      const models = RetainOwnModels(provider.id, provider.models);
      return models.length === provider.models.length ? provider : { ...provider, models };
    }),
  };
}

/**
 * 模型列表同步结果是否可并入本地目录：必须与请求的供应商一致。
 * 结果为其它供应商（例如运行中的后端是漏转发 provider 参数的旧版本）时丢弃，绝不并入——
 * 否则会把别的供应商的模型写进目标供应商（曾导致 MiMo 列表混入 DeepSeek 模型）。
 */
export function IsSyncedModelsTrusted(requested: ModelCatalogProviderId, result: { provider?: unknown }): boolean {
  return result?.provider === requested;
}

/**
 * 读取应用内缓存的模型目录；结构非法时回退默认目录。
 * 推荐分组的供应商由宿主固定，缓存里只保留已知 ID，避免出现无法配置的供应商。
 */
export function LoadModelCatalog(): ModelCatalog {
  try {
    const raw = window.localStorage.getItem(ModelCatalogStorageKey);
    if (!raw) return CreateDefaultModelCatalog();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return CreateDefaultModelCatalog();
    const record = parsed as Record<string, unknown>;
    const providers = Array.isArray(record.providers)
      ? record.providers.map(NormalizeProvider).filter((item): item is ModelCatalogProvider => item !== null)
      : [];    // 缓存里缺少官方供应商时补回默认项，避免升级后目录不完整。
    const defaults = CreateDefaultModelCatalog();
    for (const provider of defaults.providers) {
      if (!providers.some((item) => item.id === provider.id)) providers.push(provider);
    }
    return { seeded: record.seeded === true, providers };
  } catch {
    // 存储不可用时目录仅本次会话生效，不影响已保存的模型配置。
    return CreateDefaultModelCatalog();
  }
}

/** 写入应用内缓存并通知订阅者；写入前清洗跨供应商模型，存储不可用时忽略，不阻断设置页操作。 */
export function SaveModelCatalog(catalog: ModelCatalog): void {
  try {
    window.localStorage.setItem(ModelCatalogStorageKey, JSON.stringify(SanitizeModelCatalog(catalog)));
  } catch { /* 存储不可用时目录仅本次会话生效 */ }
  for (const listener of listeners) listener();
}

export function SubscribeModelCatalog(listener: ModelCatalogListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 把一批模型 ID 并入指定供应商；已存在的模型保持原样，用户编辑过的元数据不被覆盖。 */
export function MergeProviderModels(catalog: ModelCatalog, providerId: ModelCatalogProviderId, modelIds: unknown[], defaults: Partial<Omit<ModelCatalogModel, 'id'>> = {}): ModelCatalog {
  const ids = [...new Set(modelIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))];
  if (!ids.length) return catalog;
  return {
    ...catalog,
    providers: catalog.providers.map((provider) => {
      if (provider.id !== providerId) return provider;
      const models = [...provider.models];
      for (const id of ids) {
        if (!models.some((item) => item.id === id)) models.push(CreateCatalogModel(id, defaults));
      }
      return models.length === provider.models.length ? provider : { ...provider, models };
    }),
  };
}

/** 用宿主返回的供应商目录补齐本地目录（首次进入、重新加载配置、官方模型列表同步）。 */
export function MergeBackendProviders(catalog: ModelCatalog, snapshots: BackendProviderSnapshot[]): ModelCatalog {
  let next: ModelCatalog = { ...catalog, providers: catalog.providers.map((provider) => ({ ...provider })) };
  for (const snapshot of snapshots ?? []) {
    const id = snapshot?.provider;
    if (id !== 'DeepSeek' && id !== 'Z.AI' && id !== 'MIMO' && id !== '自定义') continue;
    if (!next.providers.some((item) => item.id === id)) {
      next.providers.push({ id, name: id === '自定义' ? '自定义提供商' : id, custom: id === '自定义', enabled: true, apiFormat: 'chat', models: [] });
    }
    next = MergeProviderModels(next, id, [...(snapshot.models ?? []), snapshot.model], {
      contextWindow: ToPositiveInteger(snapshot.contextLimit) ?? DefaultContextWindow,
      thinking: snapshot.thinkingEnabled !== false,
    });
  }
  return { ...next, seeded: true };
}

/**
 * 按本地目录裁剪宿主返回的供应商目录：禁用或已删除的供应商不再出现在对话的模型选择里。
 * 目录尚未与宿主合并过时原样返回，避免用不完整的本地列表覆盖宿主的可用模型。
 */
export function ApplyModelCatalogToProviders<T extends { provider: ModelCatalogProviderId; model: string; models: string[] }>(catalog: ModelCatalog, entries: T[]): T[] {
  if (!catalog.seeded) return entries;
  return entries.flatMap((entry) => {
    const provider = catalog.providers.find((item) => item.id === entry.provider);
    if (!provider || !provider.enabled) return [];
    const models = provider.models.length ? provider.models.map((item) => item.id) : [entry.model].filter(Boolean);
    return [{ ...entry, models }];
  });
}

export function FindCatalogProvider(catalog: ModelCatalog, providerId: string): ModelCatalogProvider | undefined {
  return catalog.providers.find((item) => item.id === providerId);
}

/**
 * 用宿主返回的当前生效值回写某个模型：进入设置页时，本地目录不能把用户已配置的上下文窗口与思考模式覆盖成默认值。
 * 这里只要求正整数，不套用弹窗的 128000–1000000 区间：区间限制的是手工输入，
 * 存量配置可能落在区间之外，若被拦下就会被默认值悄悄替换掉。
 * 模型 ID 在目录里不存在时原样返回，此时以宿主配置为准的字段由后续保存写回。
 */
export function ApplyModelRuntime(catalog: ModelCatalog, providerId: ModelCatalogProviderId, modelId: string, runtime: { contextWindow?: unknown; thinking?: unknown }): ModelCatalog {
  if (!modelId) return catalog;
  const contextWindow = ToPositiveInteger(runtime.contextWindow);
  const thinking = typeof runtime.thinking === 'boolean' ? runtime.thinking : undefined;
  if (contextWindow === null && thinking === undefined) return catalog;
  return {
    ...catalog,
    providers: catalog.providers.map((provider) => provider.id !== providerId ? provider : {
      ...provider,
      models: provider.models.map((model) => model.id !== modelId ? model : {
        ...model,
        ...(contextWindow === null ? {} : { contextWindow }),
        ...(thinking === undefined ? {} : { thinking }),
      }),
    }),
  };
}

/** 当前生效模型：上下文窗口与思考模式由它决定。 */
export function FindCatalogModel(catalog: ModelCatalog, providerId: string, modelId: string): ModelCatalogModel | undefined {
  return FindCatalogProvider(catalog, providerId)?.models.find((item) => item.id === modelId);
}

/** 上下文窗口读作 1M / 256K；与原型 fmtCtx 一致。 */
export function FormatContextWindow(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function IsValidContextWindow(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MinimumContextWindow && value <= MaximumContextWindow;
}

export function IsValidMaxOutput(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
}
