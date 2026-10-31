import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConfigurationService, ParseModelDirectory } from '../../../apps/backend/src/electron/backend/model-configuration-service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const identity = { provider: 'DeepSeek' as const, model: 'deepseek-flash' };
async function Root() { const root = await mkdtemp(join(tmpdir(), 'avery-model-config-')); roots.push(root); return root; }
function Directory(image: boolean, output = 8192) {
  return { deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-flash': {
    limit: { context: 500_000, output }, modalities: { input: image ? ['text', 'image'] : ['text'], output: ['text'] }, reasoning: true, tool_call: true,
  } } } };
}

describe('模型目录、个人覆盖与统一生效配置', () => {
  it('无需网络即可识别 DeepSeek Flash 图片能力，并隔离同名第三方模型', async () => {
    const fetch = vi.fn();
    const service = new ModelConfigurationService({ userDataPath: await Root(), fetch });
    expect(await service.Get(identity)).toMatchObject({ source: 'directory', values: { inputImage: true }, verified: false });
    expect(await service.Get({ ...identity, provider: '自定义', baseUrl: 'https://proxy.example/v1' })).toMatchObject({ source: 'unknown', values: { inputImage: false } });
    expect(await service.Get({ ...identity, provider: '自定义', baseUrl: 'https://api.deepseek.com/v1/' })).toMatchObject({ source: 'directory', values: { inputImage: true } });
    expect(await service.Get({ ...identity, model: 'deepseek-flash-other' })).toMatchObject({ source: 'unknown', values: { inputImage: false } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('显式 false 覆盖目录 true，重启保留；恢复自动配置后重新继承目录', async () => {
    const root = await Root();
    const service = new ModelConfigurationService({ userDataPath: root });
    const saved = await service.Save({ ...identity, overrides: { inputImage: false, maxOutput: 4096 }, expectedRevision: 0 });
    expect(saved).toMatchObject({ revision: 1, values: { inputImage: false, maxOutput: 4096 } });
    const restarted = new ModelConfigurationService({ userDataPath: root });
    expect(await restarted.Get(identity)).toMatchObject({ revision: 1, values: { inputImage: false, maxOutput: 4096 } });
    expect(await restarted.Save({ ...identity, overrides: {}, expectedRevision: 1 })).toMatchObject({ revision: 2, values: { inputImage: true }, overrides: {} });
  });
  it('个人覆盖绑定 Provider 和精确端点，不会污染另一个同名服务', async () => {
    const service = new ModelConfigurationService({ userDataPath: await Root() });
    const custom = { ...identity, provider: '自定义' as const, baseUrl: 'https://first.example/v1' };
    await service.Save({ ...custom, overrides: { inputImage: true }, expectedRevision: 0 });
    expect(await service.Get(custom)).toMatchObject({ values: { inputImage: true }, revision: 1 });
    expect(await service.Get({ ...custom, baseUrl: 'https://second.example/v1' })).toMatchObject({ values: { inputImage: false }, revision: 0 });
  });
  it('两个窗口并发保存同一 revision 时只接受一个，不丢失先保存的更改', async () => {
    const service = new ModelConfigurationService({ userDataPath: await Root() });
    const results = await Promise.allSettled([
      service.Save({ ...identity, overrides: { inputImage: false }, expectedRevision: 0 }),
      service.Save({ ...identity, overrides: { inputImage: true }, expectedRevision: 0 }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await service.Get(identity)).toMatchObject({ revision: 1, values: { inputImage: false } });
  });
  it('公开目录更新不抹掉个人覆盖，缓存重启可读，失败后沿用旧目录', async () => {
    const root = await Root();
    const fetch = vi.fn(async () => new Response(JSON.stringify(Directory(false)), { status: 200 }));
    const service = new ModelConfigurationService({ userDataPath: root, fetch });
    await service.Save({ ...identity, overrides: { inputImage: true }, expectedRevision: 0 });
    await service.Refresh(true);
    expect(await service.Get(identity)).toMatchObject({ inherited: { inputImage: false }, values: { inputImage: true } });
    expect(fetch.mock.calls).toHaveLength(1);
    const restarted = new ModelConfigurationService({ userDataPath: root });
    expect(await restarted.Get(identity)).toMatchObject({ inherited: { inputImage: false }, values: { inputImage: true } });
    fetch.mockImplementation(async () => { throw new Error('offline'); });
    await expect(service.Refresh(true)).rejects.toThrow('offline');
    expect(await service.Get(identity)).toMatchObject({ inherited: { inputImage: false }, values: { inputImage: true } });
  });
  it('目录只请求固定公开地址，不发送用户密钥或自定义端点；主源失败可以使用备用快照', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('blocked', { status: 403 })).mockResolvedValueOnce(new Response(JSON.stringify(Directory(true))));
    const service = new ModelConfigurationService({ userDataPath: await Root(), fetch });
    await service.Get({ ...identity, provider: '自定义', baseUrl: 'https://private.example/v1' });
    await service.Refresh(true);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(['https://models.dev/api.json', 'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/models-dev/snapshot.txt']);
    for (const [, options] of fetch.mock.calls) expect(options.headers).not.toHaveProperty('Authorization');
  });
  it('损坏的个人配置明确报错且保留原文，不以空配置覆盖', async () => {
    const root = await Root(); const original = '{broken personal settings';
    await writeFile(join(root, 'model-configurations.json'), original);
    const service = new ModelConfigurationService({ userDataPath: root });
    await expect(service.Get(identity)).rejects.toThrow();
    expect(await readFile(join(root, 'model-configurations.json'), 'utf8')).toBe(original);
  });
  it('落盘失败不发布新能力，也不遗留临时文件', async () => {
    const root = await Root();
    const service = new ModelConfigurationService({ userDataPath: root });
    await service.Initialize();
    await mkdir(join(root, 'model-configurations.json'));
    await expect(service.Save({ ...identity, overrides: { inputImage: false }, expectedRevision: 0 })).rejects.toThrow();
    expect(service.Resolve(identity)).toMatchObject({ revision: 0, values: { inputImage: true } });
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
  it('旧 Provider 上下文与关闭思考只迁移非敏感字段，不复制密钥', async () => {
    const root = await Root();
    const service = new ModelConfigurationService({ userDataPath: root, readLegacy: async () => ({ ...identity, apiKey: 'secret-never-save', contextLimitMode: 'custom', contextLimit: 128000, thinkingEnabled: false }) });
    expect(await service.Get(identity)).toMatchObject({ values: { contextWindow: 128000, thinking: false }, overrides: { contextWindow: 128000, thinking: false } });
    expect(await readFile(join(root, 'model-configurations.json'), 'utf8')).not.toContain('secret-never-save');
  });
  it('严格拒绝额外字段、非法能力数值以及带凭据的端点', async () => {
    const service = new ModelConfigurationService({ userDataPath: await Root() });
    await expect(service.Save({ ...identity, overrides: { apiKey: 'bad' }, expectedRevision: 0 })).rejects.toThrow();
    await expect(service.Save({ ...identity, overrides: { maxOutput: -1 }, expectedRevision: 0 })).rejects.toThrow();
    await expect(service.Get({ ...identity, provider: '自定义', baseUrl: 'https://secret:pass@example.com/v1' })).rejects.toThrow();
    await expect(service.Save({ provider: 'Z.AI', model: 'glm-5.3-flash', overrides: { thinking: false }, expectedRevision: 0 })).rejects.toThrow('始终启用思考');
  });
  it('缺少能力元数据的条目不会被误判为明确不支持图片或工具', () => {
    expect(() => ParseModelDirectory({ provider: { api: 'https://example.com', models: { unknown: { limit: { context: 128000, output: 8192 } } } } })).toThrow('没有可用条目');
  });
});
