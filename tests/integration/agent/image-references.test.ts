import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CompactionArchive } from '../../../apps/backend/src/electron/backend/compaction-archive';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src';
import { CreateVisionUserMessage, HydrateVisionMessage } from '../../../apps/backend/src/electron/backend/vision-input';
import type { AgentMessage, AgentStreamEvent, BrowserActionProposal, ModelCompletion } from '../../../packages/agent-sdk/src';

const require = createRequire(import.meta.url);
const { CreateBusinessStoreClient } = require(resolve('apps/backend/dist/infra/business-store-client.js')) as typeof import('../../../apps/backend/src/infra/business-store-client');
const roots: string[] = [];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function Root() {
  const parent = process.env.AVERY_TEST_ARTIFACT_DIR ?? tmpdir(); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'image-references-')); roots.push(root); return root;
}

describe('图片虚拟引用真实 Worker 集成', () => {
  it('保存先于发送，截图跨 Run/重启输入完全一致，故障阻断后恢复原图继续', async () => {
    const root = await Root();
    const business = CreateBusinessStoreClient({ workspacePath: join(root, 'workspace'), smoke: true });
    const sessionId = 'image-session';
    const requests: AgentMessage[][] = [], events: AgentStreamEvent[] = [];
    let saveGate: Promise<void> | undefined, saveEntered: (() => void) | undefined, releaseSave: (() => void) | undefined;
    const guardedBusiness = new Proxy(business, { get(target, key) {
      if (key === 'ImportAgentImage') return async (session: string, data: string) => {
        saveEntered?.(); await saveGate; return target.ImportAgentImage(session, data);
      };
      return target[key];
    } });
    let screenshotRequested = false;
    const stream = vi.fn(async (request: { history: AgentMessage[] }): Promise<ModelCompletion> => {
      requests.push(structuredClone(request.history));
      if (!screenshotRequested) {
        screenshotRequested = true;
        return { content: '', toolCalls: [{ id: 'screen-call', type: 'function', function: { name: 'BrowserScreenshot', arguments: '{}' } }] };
      }
      return { content: '图片已核对', toolCalls: [] };
    });
    const browser = {
      Prepare: async (): Promise<BrowserActionProposal> => ({ proposalId: 'screenshot', proposalHash: 'screenshot', toolName: 'BrowserScreenshot', canonicalArguments: {}, risk: 'low', forceConfirmation: false, pageRevision: 1, resourceIds: [], summary: '截图' }),
      Execute: async () => ({ status: 'succeeded' as const, data: { imageDataUrl: png, byteSize: Buffer.from(png.split(',')[1], 'base64').length, pageRevision: 1 } }),
      Close: async () => {}, ResetPageReferences() {}, GetStatus: async () => ({}), GetBrowserTaskId: () => undefined,
    };
    const options = {
      userDataPath: join(root, 'user-data'), workspacePath: join(root, 'workspace'), business: guardedBusiness,
      Emit: (event: unknown) => events.push(event as AgentStreamEvent), credentialPort: { Load: async () => null }, browserRuntime: browser as never,
      createDefaultModules: (ports: Parameters<typeof CreateDefaultModules>[0]) => {
        const modules = CreateDefaultModules(ports);
        modules.modelProvider.GetStatus = async () => ({ configured: true, provider: 'DeepSeek', model: 'deepseek-flash' });
        modules.modelProvider.GetModels = async () => ({ models: ['deepseek-flash'] });
        modules.modelProvider.StreamCompletion = stream;
        return modules;
      },
    };
    let host: AgentHost | undefined;
    try {
      await business.ready;
      await business.CreateConversation({ id: sessionId, title: '图片引用隔离测试', scenarioId: 'application' });
      host = new AgentHost(options); await host.Ready();
      const input = { sessionId, content: '截图核对', scenarioId: 'application', confirmationMode: 'fully_trusted' };
      await host.Send({ ...input, requestId: 'first' });
      const image = requests.at(-1)?.find(message => message.imageAttachments?.length);
      expect(image?.providerContent?.[1]).toMatchObject({ type: 'image_url', image_url: { url: png, detail: 'auto' } });
      expect(image?.imageAttachments?.[0]).toMatchObject({ uri: expect.stringMatching(/^attachment:\/\//), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const reference = image!.imageAttachments![0];
      const resolved = await business.ResolveAttachmentUri(reference.uri);
      const bytes = await readFile(resolved.physicalPath);
      expect(`data:image/png;base64,${bytes.toString('base64')}`).toBe(png);
      expect(await business.Query("SELECT owner_id FROM attachment_links WHERE owner_type='agent'")).toEqual([{ owner_id: sessionId }]);
      const state = host as unknown as { histories: Map<string, AgentMessage[]> };
      expect(JSON.stringify(state.histories.get(sessionId))).not.toContain('base64');
      await host.Send({ ...input, requestId: 'second', content: '继续核对' });
      expect(requests.at(-1)?.find(message => message.imageAttachments?.length)?.providerContent).toEqual(image!.providerContent);
      await host.Close(); host = new AgentHost(options); await host.Ready();
      await host.Send({ ...input, requestId: 'restarted', content: '重启后继续' });
      expect(requests.at(-1)?.find(message => message.imageAttachments?.length)?.providerContent).toEqual(image!.providerContent);

      await rm(resolved.physicalPath);
      const callsBeforeFailure = stream.mock.calls.length;
      await expect(host.Send({ ...input, requestId: 'missing' })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      expect(stream).toHaveBeenCalledTimes(callsBeforeFailure);
      expect(host.IsBusy()).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: 'run_released', requestId: 'missing' }));
      await writeFile(resolved.physicalPath, bytes);
      await host.Send({ ...input, requestId: 'restored' });
      expect(requests.at(-1)?.find(message => message.imageAttachments?.length)?.providerContent).toEqual(image!.providerContent);

      // 更新普通快照和压缩当前历史都不能清掉独立的 Agent 引用，归档原文仍可能重放图片。
      const archives = new CompactionArchive(join(root, 'user-data', 'compaction-archives'));
      const summary: AgentMessage = { role: 'user', content: '已核对图片', metadata: { source: 'runtime', visibility: 'hidden', kind: 'context_summary', summaryId: 'summary-images' } };
      await archives.Save(sessionId, { summaryId: 'summary-images', messages: [image!] });
      const current = host as unknown as { histories: Map<string, AgentMessage[]>; SaveState(): Promise<void> };
      current.histories.set(sessionId, [summary]); await current.SaveState();
      const expanded = await archives.Expand(sessionId, [summary], new AbortController().signal);
      expect(expanded[0].imageAttachments).toEqual(image!.imageAttachments);
      expect(expanded[0].providerContent).toBeUndefined();
      await business.SetConversationSnapshots(sessionId, { sessionSnapshotJson: '{}', toolSnapshotJson: '{}' });
      await business.RetainAgentImages(sessionId, []);
      expect((await business.CleanupAttachments({ now: Date.now() + 40 * 86400000 })).filesDeleted).toBe(0);
      await business.DeleteConversation(sessionId); await host.DeleteSessionResources(sessionId);
      expect(await business.Query("SELECT owner_id FROM attachment_links WHERE owner_type='agent'")).toEqual([]);
      expect((await business.CleanupAttachments({ now: Date.now() + 40 * 86400000 })).filesDeleted).toBe(1);

      // 删除与截图保存交错时，必须先等写入/取消收尾，再解除图片引用和删除运行历史。
      const deletingSession = 'deleting-image-session';
      await business.CreateConversation({ id: deletingSession, title: '删除竞争测试', scenarioId: 'application' });
      const entered = new Promise<void>(resolve => { saveEntered = resolve; });
      saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
      screenshotRequested = false;
      const running = host.Send({ ...input, sessionId: deletingSession, requestId: 'deleting' });
      await entered;
      let deleted = false;
      await business.DeleteConversation(deletingSession);
      const deletion = host.DeleteSessionResources(deletingSession).then(() => { deleted = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(deleted).toBe(false);
      releaseSave!(); await running; await deletion;
      expect((host as unknown as { histories: Map<string, AgentMessage[]> }).histories.has(deletingSession)).toBe(false);
      expect(await business.Query("SELECT owner_id FROM attachment_links WHERE owner_type='agent'")).toEqual([]);
    } finally {
      releaseSave?.();
      await host?.Close();
      try { await business.Close(); } finally { business.close(); }
    }
  });

  it('图片按内容去重，上传引用与截图重放均检查哈希，拒绝伪图片及超限输入', async () => {
    const root = await Root(), business = CreateBusinessStoreClient({ workspacePath: root, smoke: true });
    try {
      await business.ready;
      const first = await business.ImportAgentImage('one', png), second = await business.ImportAgentImage('two', png);
      expect(first).toEqual(second);
      expect(await business.Query('SELECT COUNT(*) AS count FROM attachments')).toEqual([{ count: 1 }]);
      const resolveAttachment = (uri: string) => business.ResolveAttachmentUri(uri);
      const message = await CreateVisionUserMessage('图片', [{ name: 'image.png', path: first.uri }], resolveAttachment);
      await business.RetainAgentImages('three', [first.uri]);
      expect((await HydrateVisionMessage({ ...message, providerContent: undefined }, resolveAttachment)).providerContent).toEqual(message.providerContent);
      const file = await resolveAttachment(first.uri);
      await writeFile(file.physicalPath, Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from('changed')]));
      await expect(HydrateVisionMessage({ ...message, providerContent: undefined }, resolveAttachment)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      await expect(business.ImportAgentImage('one', 'data:image/png;base64,aGVsbG8=')).rejects.toThrow('Invalid image attachment');
      await expect(business.ImportAgentImage('one', `data:image/png;base64,${'A'.repeat(7 * 1024 * 1024)}`)).rejects.toThrow('5 MiB');
      await business.ReleaseAgentImages('one'); await business.ReleaseAgentImages('two');
      expect((await business.CleanupAttachments({ now: Date.now() + 40 * 86400000 })).filesDeleted).toBe(0);
      await business.ReleaseAgentImages('three');
      expect((await business.CleanupAttachments({ now: Date.now() + 40 * 86400000 })).filesDeleted).toBe(1);
    } finally { try { await business.Close(); } finally { business.close(); } }
  });
});
