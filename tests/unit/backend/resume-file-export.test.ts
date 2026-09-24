import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { ExportResume } from '../../../apps/desktop/src/resume-export';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Agent resume file export', () => {
  it('reuses the desktop PDF/PNG renderer and refuses a truncated PNG', async () => {
    const root = mkdtempSync(join(tmpdir(), 'avery-export-render-'));
    roots.push(root);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    let pageHeight = 1400;
    const capturePage = vi.fn(async () => ({ toPNG: () => png }));
    const printToPDF = vi.fn(async () => Buffer.from('%PDF-1.7\nfixture'));
    class FakeWindow {
      webContents = { executeJavaScript: vi.fn(async (script: string) => script.startsWith('Math.max(') ? pageHeight : undefined), printToPDF, capturePage };
      loadURL = vi.fn(async () => undefined);
      setContentSize = vi.fn();
      isDestroyed = () => false;
      destroy = vi.fn();
    }
    const BrowserWindow = FakeWindow as any;
    const resume = { name: '简历', summary: '', content: '测试' };
    const pdf = await ExportResume({ BrowserWindow, workspacePath: root, resume, format: 'pdf' });
    expect(pdf.fileName).toBe('简历.pdf');
    expect(printToPDF).toHaveBeenCalledOnce();
    const image = await ExportResume({ BrowserWindow, workspacePath: root, resume, format: 'png', requireCompleteImage: true });
    expect(image.fileName).toBe('简历.png');
    expect(capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 794, height: 1400 });
    pageHeight = 16001;
    await expect(ExportResume({ BrowserWindow, workspacePath: root, resume, format: 'png', requireCompleteImage: true })).rejects.toThrow('complete PNG capture limit');
    expect(capturePage).toHaveBeenCalledTimes(1);
  });

  it('returns an opaque fileId only after validating bytes, revision and workspace path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'avery-export-host-'));
    roots.push(root);
    const resume = { id: 'resume-1', name: '我的简历', summary: '', content: '可信内容', revision: 2 };
    const bytes = Buffer.from('%PDF-1.7\nfixture');
    let currentRevision = 2;
    let invalidPath = false;
    const renderResumeFile = vi.fn(async ({ assetId }: { assetId: string }) => {
      const folder = invalidPath ? join(root, 'elsewhere') : join(root, 'exports', 'agent-resume-files', assetId);
      mkdirSync(folder, { recursive: true });
      const fileName = '我的简历.pdf';
      const path = join(folder, fileName);
      writeFileSync(path, bytes);
      return { path, fileName };
    });
    const host = new AgentHost({
      userDataPath: join(root, 'user-data'), workspacePath: root, Emit: () => undefined,
      business: { GetStoredSettings: async () => ({}) }, observability: {}, credentialPort: {},
      browserRuntime: { Close: async () => undefined } as any, renderResumeFile,
    });
    const state = host as any;
    state.resumeReadPort = { ReadCurrent: async () => ({ ...resume, revision: currentRevision }) };
    try {
      const result = await state.ExportBoundResumeFile(resume, 'pdf', 'session-1');
      expect(result).toMatchObject({ fileId: expect.stringMatching(/^asset:\/\/resume\/[0-9a-f-]+$/), fileName: '我的简历.pdf', mimeType: 'application/pdf', resumeId: 'resume-1', resumeRevision: 2, sizeBytes: bytes.length });
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(JSON.stringify(result)).not.toContain(root);
      expect(state.generatedAssets.get(result.fileId)).toMatchObject({ sessionId: 'session-1', name: '我的简历.pdf' });
      currentRevision = 3;
      await expect(state.ExportBoundResumeFile(resume, 'pdf', 'session-1')).rejects.toMatchObject({ code: 'RESUME_BINDING_STALE' });
      currentRevision = 2;
      invalidPath = true;
      await expect(state.ExportBoundResumeFile(resume, 'pdf', 'session-1')).rejects.toThrow();
      host.DeleteSessionResources('session-1');
      expect(state.generatedAssets.has(result.fileId)).toBe(false);
    } finally { await host.Close(); }
  });
});
