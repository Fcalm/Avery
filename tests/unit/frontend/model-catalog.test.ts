import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplyModelCatalogToProviders, ApplyModelRuntime, CreateCatalogModel, CreateDefaultModelCatalog, FindCatalogModel, FormatContextWindow, IsValidContextWindow, IsValidMaxOutput, LoadModelCatalog, MergeBackendProviders, MergeProviderModels, ModelCatalogStorageKey, SaveModelCatalog, SubscribeModelCatalog, type ModelCatalog } from '../../../src/features/settings/api/modelCatalog';

/** 应用内缓存以 localStorage 为唯一后端；用内存实现替换，避免测试依赖真实浏览器环境。 */
function StubStorage() {
  const entries = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    },
  });
  return entries;
}

const BackendSnapshots = [
  { provider: 'DeepSeek' as const, model: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], contextLimit: 256_000, thinkingEnabled: true },
  { provider: 'Z.AI' as const, model: 'glm-5.3-flash', models: ['glm-5.3-flash'], contextLimit: 128_000, thinkingEnabled: true },
  { provider: '自定义' as const, model: 'local-model', models: [], contextLimit: 64_000, thinkingEnabled: false },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('模型目录的应用内缓存', () => {
  it('没有缓存或缓存不可解析时回退默认目录，官方三家默认启用', () => {
    const entries = StubStorage();
    const defaults = LoadModelCatalog();
    expect(defaults.seeded).toBe(false);
    expect(defaults.providers.map((item) => item.id)).toEqual(['DeepSeek', 'Z.AI', '自定义']);
    expect(defaults.providers.every((item) => item.enabled)).toBe(true);

    entries.set(ModelCatalogStorageKey, '{not json');
    expect(LoadModelCatalog().providers.map((item) => item.id)).toEqual(['DeepSeek', 'Z.AI', '自定义']);
  });

  it('保存后原样读回启用状态、接口格式与模型能力', () => {
    StubStorage();
    const catalog = CreateDefaultModelCatalog();
    catalog.providers[1] = { ...catalog.providers[1], enabled: false, apiFormat: 'messages' };
    catalog.providers[2] = {
      ...catalog.providers[2],
      models: [CreateCatalogModel('local-model', { contextWindow: 64_000, maxOutput: 4_096, inputImage: true, thinking: false })],
    };

    SaveModelCatalog(catalog);

    const loaded = LoadModelCatalog();
    expect(loaded.providers[1].enabled).toBe(false);
    expect(loaded.providers[1].apiFormat).toBe('messages');
    expect(FindCatalogModel(loaded, '自定义', 'local-model')).toMatchObject({ contextWindow: 64_000, maxOutput: 4_096, inputImage: true, thinking: false });
  });

  it('丢弃非法的供应商与模型条目，并补回缓存里缺失的官方供应商', () => {
    const entries = StubStorage();
    entries.set(ModelCatalogStorageKey, JSON.stringify({
      seeded: true,
      providers: [
        { id: 'DeepSeek', name: 'DeepSeek', enabled: 'yes', apiFormat: 'grpc', models: [{ id: 'deepseek-v4-pro', contextWindow: 100_000, maxOutput: 8_192 }, { id: '', contextWindow: 1, maxOutput: 1 }] },
        { id: '未知供应商', name: '未知', models: [] },
      ],
    }));

    const loaded = LoadModelCatalog();
    expect(loaded.providers.map((item) => item.id)).toEqual(['DeepSeek', 'Z.AI', '自定义']);
    // enabled 只认布尔值，apiFormat 回退 chat，只有字段完整的模型被保留
    expect(loaded.providers[0]).toMatchObject({ enabled: true, apiFormat: 'chat', custom: false });
    expect(loaded.providers[0].models.map((item) => item.id)).toEqual(['deepseek-v4-pro']);
  });

  it('与宿主目录合并后补齐模型与能力初值，且不覆盖已有模型', () => {
    StubStorage();
    const snapshots = [
      ...BackendSnapshots.slice(0, 2).map((item) => item.provider === 'Z.AI' ? { ...item, models: ['glm-5.3-flash', 'glm-5.3-air'] } : item),
      BackendSnapshots[2],
    ];
    const merged = MergeBackendProviders(CreateDefaultModelCatalog(), snapshots);

    expect(merged.seeded).toBe(true);
    // 默认列表里已有的模型保持本地值（用户在弹窗里改过就不能被宿主的解析值覆盖）
    expect(FindCatalogModel(merged, 'Z.AI', 'glm-5.3-flash')?.contextWindow).toBe(256_000);
    expect(FindCatalogModel(merged, 'Z.AI', 'glm-5.3-air')?.contextWindow).toBe(128_000);
    // 自定义供应商的默认列表为空，模型与能力初值都来自宿主
    expect(FindCatalogModel(merged, '自定义', 'local-model')).toMatchObject({ contextWindow: 64_000, thinking: false });

    const edited: ModelCatalog = MergeProviderModels(merged, 'Z.AI', ['glm-5.3-flash', 'glm-5.3-pro'], { contextWindow: 999 });
    expect(FindCatalogModel(edited, 'Z.AI', 'glm-5.3-flash')?.contextWindow).toBe(256_000);
    expect(FindCatalogModel(edited, 'Z.AI', 'glm-5.3-pro')?.contextWindow).toBe(999);
  });

  it('对话可选模型按目录裁剪：禁用或移除的供应商不出现，模型列表以本地为准', () => {
    StubStorage();
    const merged = MergeBackendProviders(CreateDefaultModelCatalog(), BackendSnapshots);
    const disabled: ModelCatalog = { ...merged, providers: merged.providers.map((item) => item.id === 'Z.AI' ? { ...item, enabled: false } : item) };
    const entries = ApplyModelCatalogToProviders(disabled, BackendSnapshots as Array<{ provider: 'DeepSeek' | 'Z.AI' | '自定义'; model: string; models: string[] }>);

    expect(entries.map((item) => item.provider)).toEqual(['DeepSeek', '自定义']);

    // 尚未与宿主合并过时原样返回，避免用不完整的本地列表覆盖宿主可用模型
    expect(ApplyModelCatalogToProviders(CreateDefaultModelCatalog(), BackendSnapshots as Array<{ provider: 'DeepSeek' | 'Z.AI' | '自定义'; model: string; models: string[] }>)).toEqual(BackendSnapshots);
  });

  it('保存目录后通知订阅者，供对话页重新裁剪模型选择', () => {
    StubStorage();
    const listener = vi.fn();
    const unsubscribe = SubscribeModelCatalog(listener);

    SaveModelCatalog(CreateDefaultModelCatalog());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    SaveModelCatalog(CreateDefaultModelCatalog());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('用宿主当前生效值回写模型，避免进入设置页把已配置的窗口重置成默认值', () => {
    StubStorage();
    const catalog = CreateDefaultModelCatalog();

    const synced = ApplyModelRuntime(catalog, 'DeepSeek', 'deepseek-v4-flash', { contextWindow: 1_000_000, thinking: false });

    expect(FindCatalogModel(synced, 'DeepSeek', 'deepseek-v4-flash')).toMatchObject({ contextWindow: 1_000_000, thinking: false });
    // 非法窗口与缺失的宿主值不写入
    const ignored = ApplyModelRuntime(catalog, 'DeepSeek', 'deepseek-v4-flash', { contextWindow: 0, thinking: undefined });
    expect(FindCatalogModel(ignored, 'DeepSeek', 'deepseek-v4-flash')).toMatchObject({ contextWindow: 256_000, thinking: true });
  });

  it('上下文窗口按原型格式展示，并校验 8K–2000K 与正整数输出上限', () => {
    expect(FormatContextWindow(1_000_000)).toBe('1M');
    expect(FormatContextWindow(256_000)).toBe('256K');
    expect(FormatContextWindow(1_500_000)).toBe('1.5M');

    expect(IsValidContextWindow(8_000)).toBe(true);
    expect(IsValidContextWindow(2_000_000)).toBe(true);
    expect(IsValidContextWindow(7_999)).toBe(false);
    expect(IsValidContextWindow(2_000_001)).toBe(false);
    expect(IsValidMaxOutput(8_192)).toBe(true);
    expect(IsValidMaxOutput(0)).toBe(false);
  });
});
