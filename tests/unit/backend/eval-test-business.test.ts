import { describe, expect, it, vi } from 'vitest';
import { EvalTestBusiness } from '../../../apps/backend/src/electron/backend/evaluation/eval-test-business';

describe('EvalTestBusiness', () => {
  it('每个实例独立复制 Fixture，写入不会污染来源或其他 CaseRun', () => {
    const fixtures = { profile: [{ id: 'p1', content: 'original' }], resume: { id: 'r1', content: 'original', revision: 1 } };
    const left = new EvalTestBusiness(fixtures);
    const right = new EvalTestBusiness(fixtures);
    left.SaveProfiles([{ id: 'p1', content: 'changed' }]);
    left.UpsertResume({ id: 'r1', content: 'changed' }, 1);
    expect(left.Snapshot()).not.toEqual(right.Snapshot());
    expect(fixtures.profile[0].content).toBe('original');
    expect(fixtures.resume.content).toBe('original');
  });
  it('测评截图转交隔离附件端口，Fixture 文件保持独立授权', async () => {
    const image = { uri: 'attachment://screenshot/image.png', mimeType: 'image/png' };
    const storage = { ImportAgentImage: vi.fn(async () => image), ResolveAttachmentUri: vi.fn(async () => ({ physicalPath: 'isolated-image' })), RetainAgentImages: vi.fn(async () => {}), ReleaseAgentImages: vi.fn(async () => {}) };
    const business = new EvalTestBusiness({}, new Map([['attachment://fixture/file', 'isolated-fixture']]), 'ego', true, storage);
    expect(await business.ImportAgentImage('session', 'image-data')).toEqual(image);
    expect(await business.ResolveAttachmentUri(image.uri)).toEqual({ physicalPath: 'isolated-image' });
    expect(await business.ResolveAttachmentUri('attachment://fixture/file')).toEqual({ physicalPath: 'isolated-fixture' });
    await business.RetainAgentImages('session', [image.uri, 'attachment://fixture/file']);
    expect(storage.RetainAgentImages).toHaveBeenCalledExactlyOnceWith('session', [image.uri]);
  });
});
