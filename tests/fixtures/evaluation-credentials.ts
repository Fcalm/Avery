import type { ProviderConfig } from '../../packages/agent-modules-defaults/src/ports';

/** 仅供隔离测评测试校验配置；这些合成凭据永不连接真实供应商。 */
export function EvaluationTestCredentials() {
  const make = (provider: string, model: string, baseUrl: string): ProviderConfig => ({ provider, model, baseUrl, apiKey: `synthetic-${provider}-credential`, thinkingEnabled: false, contextLimit: 128000, compressionThreshold: 80 });
  const providerConfigs = {
    DeepSeek: make('DeepSeek', 'deepseek-v4-flash', 'https://api.deepseek.com'),
    'Z.AI': make('Z.AI', 'glm-5.3-flash', 'https://open.bigmodel.cn/api/paas/v4'),
    MIMO: make('MIMO', 'mimo-v2.6-flash', 'https://api.xiaomimimo.com/v1'),
    '自定义': make('自定义', 'fixture-custom-model', 'https://fixture.invalid/v1'),
  };
  return { Load: async () => structuredClone({ ...providerConfigs.DeepSeek, providerConfigs }) };
}
