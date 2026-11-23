import { CreateDefaultModules } from '@avery/agent-modules-defaults';
import type { AgentDefaultPorts } from '@avery/agent-modules-defaults';
import type { EvalProjectConfig, EvalProvider } from '@avery/contracts';

export interface EvaluationCredentials { Load(): ReturnType<AgentDefaultPorts['getConfig']>; }

/** 凭据只保留在本次 Run 的内存，逐次返回副本，不能写入快照、Artifact 或共享 Provider 实例。 */
export async function FreezeEvaluationCredentials(source: EvaluationCredentials): Promise<EvaluationCredentials> {
  const snapshot = structuredClone(await source?.Load?.() ?? null);
  return { Load: async () => structuredClone(snapshot) };
}

export function EvaluationModelProvider(credentials: EvaluationCredentials, providerFetch?: typeof fetch) {
  return CreateDefaultModules({
    providerFetch,
    getConfig: () => credentials.Load(), saveConfig: async () => { throw new Error('测评不能修改供应商凭据。'); }, getStoredSettings: async () => ({}),
    file: {} as AgentDefaultPorts['file'], resumeRead: {} as AgentDefaultPorts['resumeRead'], resumeWrite: {} as AgentDefaultPorts['resumeWrite'], observabilityStore: null,
  }).modelProvider;
}

/** 仅使用已保存凭据与正式 Provider 的本地模型校验，不查询网络，也不静默换供应商或模型。 */
export async function ValidateEvaluationModels(config: EvalProjectConfig, runnerType: 'prompt' | 'browser', credentials: EvaluationCredentials) {
  const provider = EvaluationModelProvider(credentials);
  const selections: Array<{ role: string; provider: EvalProvider; model: string }> = [{ role: '执行', provider: config.executionProvider, model: config.executionModel }];
  if (runnerType === 'prompt') selections.push({ role: 'Judge', provider: config.judgeProvider!, model: config.judgeModel! });
  const actual: Record<string, { provider: EvalProvider; model: string; baseUrl: string | undefined; contextLimit: number | undefined }> = {};
  for (const selected of selections) {
    try {
      const status = await provider.GetStatus(selected.provider);
      if (!status.configured) throw new Error('missing credentials');
      if (provider.ResolveRequestModel(selected.model, selected.provider) !== selected.model) throw new Error('model differs');
      actual[selected.role === '执行' ? 'execution' : 'judge'] = { provider: selected.provider, model: selected.model, baseUrl: status.baseUrl, contextLimit: status.contextLimit };
    } catch {
      throw Object.assign(new Error(`${selected.role}模型 ${selected.provider} · ${selected.model} 未配置或不可用，请重新选择并保存。`), { code: 'VALIDATION_ERROR' });
    }
  }
  return actual;
}
