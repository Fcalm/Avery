import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src';
import type { AgentMessage, AgentStreamEvent, BrowserActionProposal, BrowserAutomationPort, ModelCompletion } from '../../../packages/agent-sdk/src';

const require = createRequire(import.meta.url);
const { CreateBusinessStoreClient } = require(resolve('apps/backend/dist/infra/business-store-client.js')) as typeof import('../../../apps/backend/src/infra/business-store-client');
const roots: string[] = [];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

describe('导出简历后的浏览器上传确认恢复', () => {
  it.each([
    { format: 'pdf' as const, image: false, legacy: false },
    { format: 'png' as const, image: false, legacy: false },
    { format: 'pdf' as const, image: true, legacy: false },
    { format: 'pdf' as const, image: false, legacy: true },
  ])('$format / 用户图片=$image / 旧等待记录=$legacy：确认后正常续轮、保留授权且各上传只执行一次', async ({ format, image, legacy }) => {
    const root = await mkdtemp(join(tmpdir(), 'avery-upload-continuation-')); roots.push(root);
    const workspacePath = join(root, 'workspace');
    const business = CreateBusinessStoreClient({ workspacePath, smoke: true });
    const sessionId = 'resume-upload-session', requestId = 'resume-upload-request';
    const events: AgentStreamEvent[] = [], requests: AgentMessage[][] = [], resolvedUris: string[] = [];
    const guardedBusiness = new Proxy(business, { get(target, key) {
      if (key === 'ResolveAttachmentUri') return async (uri: string) => { resolvedUris.push(uri); return target.ResolveAttachmentUri(uri); };
      return target[key];
    } });
    const browser: BrowserAutomationPort & { Close(): Promise<void> } = {
      Prepare: vi.fn(async ({ toolName, arguments: args }) => ({
        proposalId: `proposal-${toolName}-${args.ref ?? ''}`, proposalHash: `hash-${toolName}-${args.ref ?? ''}`,
        toolName, canonicalArguments: args, risk: 'low', forceConfirmation: false,
        pageRevision: 1, url: 'https://careers.invalid/form', resourceIds: ['browser:own-task'], summary: toolName,
      })),
      Execute: vi.fn(async ({ proposal }) => ({ status: 'succeeded', data: proposal.toolName === 'BrowserSnapshot'
        ? { pageRevision: 1, currentUrl: 'https://careers.invalid/form', refs: { e1: { role: 'input', type: 'file' }, e2: { role: 'input', type: 'file' } } }
        : { pageRevision: 1, uploaded: true, readyForFill: true } })),
      GetStatus: async () => ({ available: true, running: true, pageRevision: 1 }),
      GetBrowserTaskId: () => 'ego-owned-task', ResetPageReferences() {}, Close: async () => {},
    };
    let host: AgentHost | undefined;
    const exportedFiles: string[] = [];
    try {
      await business.ready;
      await business.CreateConversation({ id: sessionId, title: '简历上传', scenarioId: 'application' });
      await business.UpsertResume({ id: 'resume-upload', name: '求职简历', summary: '', content: '教育经历：信息管理本科。项目经历：用户研究与产品原型。', targetRoles: ['产品经理'], updatedAt: new Date().toISOString() });
      const attachment = image ? await business.ImportAgentImage(sessionId, png) : undefined;
      let turn = 0;
      const stream = vi.fn(async (request: { history: AgentMessage[] }): Promise<ModelCompletion> => {
        requests.push(structuredClone(request.history));
        const index = turn++;
        if (index <= 1) return { content: '', toolCalls: [{ id: `read-resume-${index}`, type: 'function', function: { name: 'ReadResume', arguments: JSON.stringify(index === 0 ? {} : { resumeId: 'resume-upload' }) } }] };
        if (index === 2) return { content: '', toolCalls: [{ id: 'export-resume', type: 'function', function: { name: 'ExportResumeFile', arguments: JSON.stringify({ format }) } }] };
        if (index <= 4) {
          const exported = request.history.find(message => message.role === 'tool' && message.tool_call_id === 'export-resume');
          const fileId = JSON.parse(exported!.content).fileId;
          return { content: '', toolCalls: [{ id: `upload-${index - 2}`, type: 'function', function: { name: 'BrowserUploadFile', arguments: JSON.stringify({ ref: `@e${index - 2}`, pageRevision: 1, fileId, purpose: 'resume' }) } }] };
        }
        return { content: '两个附件框已分别上传完成。', toolCalls: [] };
      });
      host = new AgentHost({
        userDataPath: join(root, 'user-data'), workspacePath, business: guardedBusiness,
        Emit: event => events.push(event as AgentStreamEvent), browserRuntime: browser, credentialPort: { Load: async () => null },
        renderResumeFile: async ({ assetId }) => {
          const directory = join(workspacePath, 'exports', 'agent-resume-files', assetId); await mkdir(directory, { recursive: true });
          const fileName = `求职简历.${format}`, path = join(directory, fileName);
          await writeFile(path, format === 'pdf' ? Buffer.from('%PDF-1.7\nresume') : Buffer.from(png.split(',')[1], 'base64'));
          exportedFiles.push(path); return { path, fileName };
        },
        createDefaultModules: ports => {
          const modules = CreateDefaultModules(ports);
          modules.modelProvider.GetStatus = async () => ({ configured: true, provider: 'MIMO', model: 'mimo-v2.6-flash' });
          modules.modelProvider.StreamCompletion = stream;
          return modules;
        },
      });
      await host.Send({ requestId, sessionId, scenarioId: 'application', confirmationMode: 'always_confirm', provider: 'MIMO', model: 'mimo-v2.6-flash', resumeId: 'resume-upload', content: '把我的简历分别上传到两个附件框，确认后继续。', attachments: attachment ? [{ name: '参考图.png', path: attachment.uri }] : [] });
      const firstHistory = (host as unknown as { histories: Map<string, AgentMessage[]> }).histories.get(sessionId)!;
      expect(firstHistory.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)), JSON.stringify(events.filter(event => event.type === 'error'))).toContainEqual(expect.objectContaining({ fileId: expect.stringMatching(/^asset:\/\/resume\//), ok: true }));
      const Database = require('better-sqlite3');
      const savedState = new Database(join(root, 'user-data', 'agent-runtime.db'), { readonly: true });
      try {
        const row = savedState.prepare("SELECT data FROM runtime_rows WHERE bucket='pausedRuns' AND key=?").get(requestId) as { data: string };
        const persisted = JSON.parse(row.data);
        expect(persisted.input.attachments).toEqual(attachment ? [{ name: '参考图.png', path: attachment.uri }] : []);
        expect(persisted.authorizedAttachments).toContainEqual(expect.objectContaining({ path: expect.stringMatching(/^asset:\/\/resume\//) }));
      } finally { savedState.close(); }
      // 兼容已落盘的旧等待点：旧版把用户输入和导出授权混存进 input.attachments。
      if (legacy) {
        const state = host as unknown as { pausedRuns: Map<string, { input: { attachments?: Array<{ name: string; path: string }> }; authorizedAttachments?: Array<{ name: string; path: string }> }>; SaveState(): Promise<void> };
        const pending = state.pausedRuns.get(requestId)!;
        if (pending.authorizedAttachments) pending.input.attachments = pending.authorizedAttachments;
        delete pending.authorizedAttachments;
        await state.SaveState();
      }
      for (let index = 0; index < 2; index++) {
        const confirmation = events.filter(event => event.type === 'browser_confirmation')[index];
        expect(confirmation?.confirmationId).toBeTruthy();
        await expect(host.RespondToInteraction({ kind: 'approval', requestId, sessionId, interactionId: confirmation.confirmationId!, approved: true })).resolves.toMatchObject({ accepted: true });
      }
      const uploads = vi.mocked(browser.Execute).mock.calls.filter(([{ proposal }]) => proposal.toolName === 'BrowserUploadFile');
      expect(uploads.map(([{ proposal }]) => proposal.canonicalArguments.ref)).toEqual(['@e1', '@e2']);
      expect(requests).toHaveLength(6);
      expect(resolvedUris.every(uri => uri.startsWith('attachment://'))).toBe(true);
      expect(exportedFiles).toHaveLength(1);
      expect((await readFile(exportedFiles[0])).length).toBeGreaterThan(0);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
      const history = (host as unknown as { histories: Map<string, AgentMessage[]> }).histories.get(sessionId)!;
      expect(history.filter(message => message.role === 'user' && message.metadata?.source !== 'runtime')).toHaveLength(1);
      for (const callId of ['upload-1', 'upload-2']) expect(history.filter(message => message.role === 'tool' && message.tool_call_id === callId)).toHaveLength(1);
      const expectedImages = image ? 1 : 0;
      for (const request of requests) {
        const user = request.find(message => message.role === 'user' && message.metadata?.source !== 'runtime')!;
        expect(user.imageAttachments?.length ?? 0).toBe(expectedImages);
        if (image) expect(user.providerContent?.[1]).toMatchObject({ type: 'image_url', image_url: { url: png } });
      }
    } finally {
      await host?.Close();
      try { await business.Close(); } finally { business.close(); }
    }
  });
});
