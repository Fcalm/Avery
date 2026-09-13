import { describe, expect, it, vi } from 'vitest';
import { BusinessStore } from '../../../apps/backend/src/business-store';

describe('BusinessStore 岗位跟踪', () => {
  it('保存岗位只写岗位库且不要求简历', () => {
    const upsertJob = vi.fn((job) => ({ ...job, revision: 1 }));
    const upsertApplication = vi.fn();
    const store = Object.assign(Object.create(BusinessStore.prototype), {
      jobs: { ListAll: vi.fn(() => []) },
      jobService: { Upsert: upsertJob },
      applicationService: { Upsert: upsertApplication },
    }) as BusinessStore;

    const result = store.SaveTrackedJob({
      jobId: 'job-42', company: '示例科技', title: 'Agent 工程师', url: 'https://jobs.example.com/42',
    });

    expect(upsertJob).toHaveBeenCalledWith(expect.objectContaining({
      id: 'job-42', company: '示例科技', title: 'Agent 工程师', url: 'https://jobs.example.com/42', favorite: false,
    }), undefined);
    expect(upsertApplication).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'job-42', jobRevision: 1 });
  });

  it('仅在确认投递时冻结宿主传入的绑定简历凭证', () => {
    const recordEvidence = vi.fn(() => ({ applicationId: 'application-42', resumeId: 'resume-1', revision: 4, contentHash: 'hash', created: true }));
    const store = Object.assign(Object.create(BusinessStore.prototype), {
      db: { transaction: (work: () => unknown) => work },
      jobs: { ListAll: vi.fn(() => []) },
      applications: { ListAll: vi.fn(() => []), RecordResumeEvidence: recordEvidence },
      jobService: { Upsert: vi.fn(() => ({ id: 'job-42', revision: 2 })) },
      applicationService: { Upsert: vi.fn(() => ({ id: 'application-42', revision: 3 })) },
    }) as BusinessStore;
    const resumeEvidence = { id: 'resume-1', name: '投递简历', content: '提交时的正文', summary: '摘要', targetRoles: ['产品经理'], updatedAt: 1, revision: 4 };

    const result = store.UpdateApplicationTracking({
      applicationId: 'application-42', jobId: 'job-42', company: '示例科技', title: '产品经理', url: 'https://jobs.example.com/42', status: 'applied', resumeId: 'resume-1', resumeEvidence,
    });

    expect(recordEvidence).toHaveBeenCalledWith('application-42', { resumeId: 'resume-1', revision: 4, document: resumeEvidence });
    expect(result).toMatchObject({ applicationId: 'application-42', resumeEvidence: { revision: 4, contentHash: 'hash' } });
    expect(() => store.UpdateApplicationTracking({ applicationId: 'application-42', jobId: 'job-42', status: 'applied', resumeId: 'resume-1' }))
      .toThrow('bound resume evidence');
  });
});
