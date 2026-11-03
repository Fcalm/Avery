import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CreateProviderModule } from '../../../packages/agent-modules-defaults/src/provider';

describe('真实 HTTP 模型恢复', () => {
  it('实际 socket 断流与坏 SSE 经退避恢复为非流式答复，失败正文不重复', async () => {
    const modes: boolean[] = [], startedAt: number[] = [];
    const server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); modes.push(body.stream); startedAt.push(Date.now());
      if (modes.length === 1) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': 100000 });
        response.write('data: {"choices":[{"delta":{"content":"失败半截"}}]}\n\n');
        setTimeout(() => response.destroy(), 15);
      } else if (modes.length === 2) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: {broken json}\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"choices":[{"message":{"content":"已恢复完整答复"},"finish_reason":"stop"}]}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local server address');
    const provider = CreateProviderModule({ getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}) } as never,
      { initialDelayMs: 20, maxDelayMs: 100, connectionTimeoutMs: 2000, idleTimeoutMs: 2000 });
    const deltas: string[] = [];
    try {
      await provider.Configure({ provider: '自定义', model: 'fixture-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'isolated-fixture' });
      const completion = await provider.StreamCompletion({ requestId: 'local-http', provider: '自定义', model: 'fixture-model', reasoningEffort: 'medium', history: [], tools: [], signal: new AbortController().signal,
        instructions: { compiled: 'local fixture' } as never, onDelta: delta => deltas.push(delta.content) });
      expect(completion.content).toBe('已恢复完整答复'); expect(deltas).toEqual(['已恢复完整答复']);
      expect(modes).toEqual([true, true, false]);
      expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(20);
      expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(40);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
