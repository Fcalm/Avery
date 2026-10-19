import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationPresentation, ConversationResource } from '@avery/contracts';
import { ReadConversationResource } from '../../../apps/backend/src/electron/backend/conversation-resource-reader';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function Ports(resource: ConversationResource, root = '') {
  const snapshot: ConversationPresentation = { version: 1, requestId: 'req1', sequence: 1, status: 'completed', parts: [{ id: 'ref1', stepId: 's1', type: 'resource', resource }] };
  return {
    workspacePath: root,
    presentations: async (sessionId: string) => sessionId === 'owner' ? [snapshot] : [],
    workspace: async () => ({ conversations: [], applications: [], jobs: [], resumes: [{ id: 'r1', name: '当前简历', revision: 3, targetRoles: [], summary: '', content: '当前内容' }] }),
    profiles: async () => ({ items: [{ id: 'p1', category: 'job_intent' as const, title: '意向', content: '广州' }] }),
    revisions: async () => [{ id: 'version2', revision: 2, source: 'agent' as const, createdAt: 1, isCurrent: false }],
    revision: async () => ({ document: { id: 'r1', name: '历史简历', revision: 2, targetRoles: [], summary: '', content: '历史内容' } }),
  };
}

describe('会话产物读取边界', () => {
  it('缺失文件给出明确提示且不暴露物理路径，大文件在读取前拒绝', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'avery-resource-large-')); roots.push(root);
    const assetId = '12345678-1234-1234-1234-123456789abc';
    const resource = { kind: 'file' as const, id: 'asset://resume/' + assetId, title: '简历文件', fileName: 'resume.pdf' };
    await expect(ReadConversationResource('owner', resource, Ports(resource, root))).rejects.toThrow('请重新导出');
    const directory = path.join(root, 'exports', 'agent-resume-files', assetId);
    await mkdir(directory, { recursive: true });
    const handle = await open(path.join(directory, 'resume.pdf'), 'w');
    try { await handle.truncate(25 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(ReadConversationResource('owner', resource, Ports(resource, root))).rejects.toThrow('格式或大小不合法');
  });

  it('会话归属由宿主记录核对，伪造资源和跨会话读取均拒绝', async () => {
    const resource = { kind: 'profile' as const, id: 'p1', title: '档案' };
    expect(await ReadConversationResource('owner', resource, Ports(resource))).toMatchObject({ format: 'markdown', content: '广州' });
    await expect(ReadConversationResource('other', resource, Ports(resource))).rejects.toThrow('不属于当前会话');
    await expect(ReadConversationResource('owner', { ...resource, id: 'p2' }, Ports(resource))).rejects.toThrow('不属于当前会话');
  });

  it('历史简历严格读取指定版本，缺失版本不得静默展示当前内容', async () => {
    const resource = { kind: 'resume' as const, id: 'r1', title: '简历', revision: 2 };
    expect(await ReadConversationResource('owner', resource, Ports(resource))).toMatchObject({ document: { content: '历史内容', revision: 2 } });
    await expect(ReadConversationResource('owner', { ...resource, revision: 1 }, Ports(resource))).rejects.toThrow('历史版本已被清理');
    expect(await ReadConversationResource('owner', { ...resource, revision: undefined }, Ports(resource))).toMatchObject({ document: { content: '当前内容', revision: 3 } });
  });

  it('重启后可从持久化引用恢复导出文件，前端文件名不能覆盖宿主记录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'avery-resource-')); roots.push(root);
    const assetId = '12345678-1234-1234-1234-123456789abc';
    const directory = path.join(root, 'exports', 'agent-resume-files', assetId);
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'resume.pdf'), '%PDF-1.4\ncontent');
    const resource = { kind: 'file' as const, id: 'asset://resume/' + assetId, title: '简历文件', fileName: 'resume.pdf' };
    const view = await ReadConversationResource('owner', { ...resource, fileName: '../../secret.pdf' }, Ports(resource, root));
    expect(view).toMatchObject({ format: 'file', mimeType: 'application/pdf', resource: { fileName: 'resume.pdf' } });
    expect(view.format === 'file' && Buffer.from(view.base64, 'base64').toString()).toBe('%PDF-1.4\ncontent');
  });

  it('非法资源路径和伪装文件内容被拒绝', async () => {
    const resource = { kind: 'file' as const, id: 'asset://resume/../../secret', title: '非法文件', fileName: 'secret.pdf' };
    await expect(ReadConversationResource('owner', resource, Ports(resource))).rejects.toThrow('无效的导出文件引用');
    const root = await mkdtemp(path.join(tmpdir(), 'avery-resource-invalid-')); roots.push(root);
    const assetId = '12345678-1234-1234-1234-123456789abc';
    const directory = path.join(root, 'exports', 'agent-resume-files', assetId);
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'resume.pdf'), '<script>bad</script>');
    const bad = { kind: 'file' as const, id: 'asset://resume/' + assetId, title: '伪装文件', fileName: 'resume.pdf' };
    await expect(ReadConversationResource('owner', bad, Ports(bad, root))).rejects.toThrow('格式或大小不合法');
  });
});
