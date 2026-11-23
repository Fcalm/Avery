import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent, BrowserEngine } from '../../../packages/agent-sdk/src';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { AgentBrowserRuntime } from '../../../apps/backend/src/electron/backend/agent-browser-runtime';
import { BrowserExtensionBridge } from '../../../apps/backend/src/electron/backend/browser-extension-bridge';
import { EgoBrowserRuntimeProvider } from '../../../apps/backend/src/electron/backend/ego-browser-runtime';
import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';

const send = { sessionId: 'workspace-session', requestId: 'workspace-run', content: '填写表单，保留供我提交。', provider: 'DeepSeek' as const,
  model: 'deepseek-v4-pro', scenarioId: 'application' as const, confirmationMode: 'fully_trusted' as const };
type ModelRequest = { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string; parameters: { properties?: object } } }> };

function Reply(content: string, tool?: { name: string; id: string; args?: Record<string, unknown> }) {
  const delta = tool
    ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) } }] }
    : { content };
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Avery Ego 工作区', () => {
  it('仅在工作场景实际使用 Ego 时固定注入技能，页面工具参数不含浏览器选择', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-workspace-injection-'));
    const requests: ModelRequest[] = [];
    let engine: BrowserEngine = 'ego';
    const runtime = new AgentBrowserRuntime({ runtimeRoot: root, resolveUploadFile: async () => null,
      browserExtensionBridge: new BrowserExtensionBridge({ statePath: join(root, 'bridge.json'), port: 0 }), egoBrowserProvider: new EgoBrowserRuntimeProvider(async () => null) });
    const host = new AgentHost({
      userDataPath: root, workspacePath: root, credentialPort: EvaluationTestCredentials(), browserRuntime: runtime, Emit: () => undefined,
      business: { GetProfiles: async () => ({ items: [] }), GetStoredSettings: async () => ({ browserEngine: engine }) },
      providerFetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Reply('已收到。'); },
    });
    try {
      for (const [index, selected] of (['ego', 'edge', 'chrome', 'ego'] as const).entries()) {
        engine = selected;
        await host.Send({ ...send, requestId: 'skill-' + index });
      }
      expect(requests.map((body) => body.messages.filter((message) => message.content?.includes('<runtime-skill id="ego-workspace">')).length))
        .toEqual([1, 0, 0, 1]);
      expect(requests.map((body) => body.tools.some((tool) => tool.function.name === 'BrowserWorkspace'))).toEqual([true, false, false, true]);
      const navigate = requests.map((body) => body.tools.find((tool) => tool.function.name === 'BrowserNavigate')?.function.parameters.properties);
      expect(navigate.every((properties) => Object.keys(properties ?? {}).join() === 'url')).toBe(true);
    } finally {
      await host.Close();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
    }
  });

  it.runIf(process.env.AVERY_TEST_LIVE_EGO === '1')('用真实 Ego 填写本机表单，重启 Avery 后接回原页，并保留或关闭工作区', async () => {
    // 使用生产构建的固定脚本，避免测试转换器改写被序列化给 Ego 的 import。
    const production = createRequire(import.meta.url)('../../../apps/backend/dist/electron/backend/ego-browser-runtime.js') as typeof import('../../../apps/backend/src/electron/backend/ego-browser-runtime');
    const executable = await production.ResolveEgoBrowserExecutable();
    if (!executable) throw new Error('Ego Lite CLI is required for this run.');
    const root = await mkdtemp(join(tmpdir(), 'avery-live-ego-workspace-'));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Workspace Draft</title><label for="name">Application Name</label><input id="name" autocomplete="off">');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The local fixture could not listen.');
    const url = 'http://127.0.0.1:' + address.port + '/form';
    const draft = 'Avery preserved draft 1976';
    const provider = new production.EgoBrowserRuntimeProvider(async () => executable);
    const transitions = vi.spyOn(provider, 'CreateRuntime');
    const events: AgentStreamEvent[] = [];
    const hosts = new Set<AgentHost>();
    const spaceNames = new Map<number, string>();
    let browserEngine: BrowserEngine = 'ego';
    let currentRuntime: AgentBrowserRuntime;
    let phase = 0;
    const requests: ModelRequest[] = [];
    const snapshots: Array<{ refs: Record<string, { name?: string; value?: string }>; pageRevision: number }> = [];
    const options: ConstructorParameters<typeof AgentHost>[0] = {
      userDataPath: root, workspacePath: root, credentialPort: EvaluationTestCredentials(),
      Emit: (event) => events.push(event as AgentStreamEvent),
      business: { GetProfiles: async () => ({ items: [] }), GetStoredSettings: async () => ({ browserEngine, closeTaskTabs: true }) },
      providerFetch: async (_url, init) => {
        const body: ModelRequest = JSON.parse(String(init?.body));
        requests.push(body);
        const resultMessage = body.messages.at(-1);
        const tool = resultMessage?.role === 'tool' ? JSON.parse(resultMessage.content) : null;
        if (tool) expect(tool.ok, 'phase=' + phase + ' result=' + JSON.stringify(tool)).toBe(true);
        const call = (name: string, args?: Record<string, unknown>) => {
          expect(body.tools.map((tool) => tool.function.name), 'phase=' + phase).toContain(name);
          return Reply('', { name, id: 'call-workspace-' + phase, args });
        };
        switch (phase++) {
          case 0: return call('BrowserWorkspace', { action: 'open' });
          case 1: return call('BrowserNavigate', { url });
          case 2: return call('BrowserSnapshot', { mode: 'full' });
          case 3: {
            snapshots.push(tool.data);
            const ref = Object.entries(snapshots[0].refs).find(([, value]) => value.name === 'Application Name')?.[0];
            expect(ref, JSON.stringify(tool)).toBeTruthy();
            return call('BrowserFill', { ref: ref!.startsWith('@') ? ref : '@' + ref, pageRevision: snapshots[0].pageRevision, text: draft });
          }
          case 4:
            await currentRuntime.SuspendWorkspace();
            return call('BrowserWorkspace', { action: 'handoff', instruction: '请处理浏览器中的手动步骤。' });
          case 5:
          case 9: return call('BrowserSnapshot', { mode: 'full' });
          case 6:
          case 10:
            snapshots.push(tool.data);
            expect(JSON.stringify(tool.data)).toContain(draft);
            return call('BrowserWorkspace', { action: 'keep' });
          case 7:
          case 11: return Reply('已保留原申请表，等待用户提交。');
          case 8: return call('BrowserWorkspace', { action: 'resume' });
          case 12: return call('BrowserWorkspace', { action: 'open' });
          case 13: return call('BrowserWorkspace', { action: 'close' });
          case 14:
            expect(tool.state).toBe('closed');
            return Reply('工作区已关闭。');
          default: throw new Error('Unexpected model turn.');
        }
      },
    };
    const openHost = () => {
      const browserRuntime = new AgentBrowserRuntime({
        runtimeRoot: root, resolveUploadFile: async () => null, browserExtensionBridge: new BrowserExtensionBridge({ statePath: join(root, 'bridge.json'), port: 0 }),
        egoBrowserProvider: provider, normalizeNavigationUrl: async () => url,
      });
      currentRuntime = browserRuntime;
      const host = new AgentHost({ ...options, browserRuntime });
      hosts.add(host);
      return host;
    };
    const getSpace = async (index: number) => {
      const workspace = (await transitions.mock.results[index]?.value)?.GetWorkspace?.();
      if (!workspace) throw new Error('Avery did not bind the native workspace.');
      spaceNames.set(workspace.id, workspace.name);
      return workspace;
    };
    const answer = async (host: AgentHost, requestId: string) => {
      const prompt = events.filter(event => event.type === 'question_requested').at(-1);
      expect(prompt, JSON.stringify(events.filter(e => e.type === 'error' || e.type === 'paused'))).toMatchObject({ requestId, confirmationId: expect.any(String) });
      await host.RespondToInteraction({
        kind: 'answer', requestId, sessionId: send.sessionId, interactionId: prompt!.confirmationId!,
        answers: { 'browser-workspace-resume': '继续操作' },
      });
    };
    try {
      let host = openHost();
      await host.Send(send);
      const first = await getSpace(0);
      expect(first.targetId).toBeTruthy();
      expect(await getSpace(1)).toMatchObject({ id: first.id, targetId: first.targetId });
      await host.Close();
      hosts.delete(host);
      browserEngine = 'edge';
      host = openHost();
      await answer(host, send.requestId);
      const afterHandoff = await getSpace(2);
      expect(afterHandoff).toMatchObject({ id: first.id, targetId: first.targetId });
      await host.Send({ ...send, requestId: 'resume-held', content: '请继续使用之前保留的原表单。' });
      await answer(host, 'resume-held');
      expect(await getSpace(3)).toMatchObject({ id: first.id, targetId: first.targetId });
      expect(snapshots).toHaveLength(3);
      expect(requests.every(body => body.tools.some(tool => tool.function.name === 'BrowserWorkspace'))).toBe(true);
      browserEngine = 'ego';
      await host.Send({ ...send, sessionId: 'workspace-close-session', requestId: 'close-workspace', content: '新开工作区，然后关闭。' });
      expect((await getSpace(4)).id).not.toBe(first.id);
      expect(phase).toBe(15);
    } finally {
      for (const host of hosts) await host.Close();
      // 仅清理本测试创建且身份全匹配的工作区。
      for (const outcome of transitions.mock.results) {
        const workspace = (await outcome.value)?.GetWorkspace?.();
        if (workspace) spaceNames.set(workspace.id, workspace.name);
      }
      const owned = JSON.stringify([...spaceNames]);
      const cleanup = `const owned = new Map(${owned}); for (const item of (await ego.listTaskSpaces()).taskSpaces) {
        if (owned.get(item.id) !== item.name) continue;
        if (item.ownership === 'user') await ego.claimTaskSpace(item.id);
        await ego.useTaskSpace(item.id);
        if (item.ownership === 'agentDelegatedToUser') await ego.takeOverTaskSpace();
        await ego.closeTaskSpace();
      }`;
      try { await promisify(execFile)(executable, ['nodejs', '-e', cleanup], { timeout: 5000, windowsHide: true }); }
      finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
      }
    }
  }, 60_000);
});
