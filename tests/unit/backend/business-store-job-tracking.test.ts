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
});
