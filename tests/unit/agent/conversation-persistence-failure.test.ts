import { describe, expect, it } from 'vitest';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { CreateKernelHarness, CreateRegisteredTool } from './test-helpers';

describe('持久化失败仍结算对话终态', () => {
  it('保留原始错误及多层 socket 原因，Trace 不保存原始请求和密钥', async () => {
    const socket = Object.assign(new Error('private details'), { code: 'UND_ERR_SOCKET' });
    const original = Object.assign(new Error('模型连接中断'), { code: 'PROVIDER_CONNECTION_INTERRUPTED', cause: new TypeError('terminated', { cause: socket }) });
    const h = CreateKernelHarness({ streamCompletion: async () => { throw original; } });
    await expect(RunAgentLoop(h.input)).rejects.toBe(original);
    const error = h.trace.append.mock.calls.find(([, kind]) => kind === 'error')?.[2];
    expect(error).toMatchObject({ code: 'PROVIDER_CONNECTION_INTERRUPTED', causeCodes: ['UND_ERR_SOCKET'] });
    expect(JSON.stringify(error)).not.toContain('private details');
  });
  it('历史及恢复补写都失败时仍结束 Trace，工具不得被重放', async () => {
    const h = CreateKernelHarness({ tools: [CreateRegisteredTool('Read')], completions: [{ content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] }] });
    h.input.persistHistory = async () => {
      if (h.input.histories.get(h.input.sessionId)?.some(message => message.tool_calls?.length)) throw new Error('disk full');
    };
    await expect(RunAgentLoop(h.input)).rejects.toThrow('disk full');
    expect(h.events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(h.trace.finish).toHaveBeenCalledWith('request-1', 'failed', 'disk full');
    expect(h.modules.tools.ExecuteToolCall).not.toHaveBeenCalled();
    expect(h.trace.append).toHaveBeenCalledWith('request-1', 'history_persistence_failed', expect.any(Object));
  });
  it('取消时历史写入失败也只能发取消终态', async () => {
    const controller = new AbortController(); let broken = false;
    const h = CreateKernelHarness({ signal: controller.signal, streamCompletion: async () => { broken = true; controller.abort(); throw new Error('connection aborted'); } });
    h.input.persistHistory = async () => { if (broken) throw new Error('disk full'); };
    await expect(RunAgentLoop(h.input)).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(h.events.filter(event => event.type === 'cancelled')).toHaveLength(1);
    expect(h.events.some(event => event.type === 'error')).toBe(false);
  });
});
