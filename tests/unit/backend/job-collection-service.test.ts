import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAutomationPort } from '../../../packages/agent-sdk/src';
import { JobCollectionService } from '../../../apps/backend/src/electron/backend/job-collection-service';

function CreateBrowser(): BrowserAutomationPort {
  let currentUrl = 'https://www.zhipin.com/web/geek/job';
  return {
    Prepare: vi.fn(async ({ toolName, arguments: args }) => ({ proposalId: `p-${Math.random()}`, toolName, arguments: args } as any)),
    Execute: vi.fn(async ({ proposal }) => {
      if (proposal.toolName === 'BrowserNavigate') currentUrl = String((proposal.arguments as any).url);
      return { status: 'succeeded', data: { currentUrl } } as any;
    }),
    EvaluateTrustedPage: vi.fn(async ({ expression }) => {
      if (expression.includes("risk: 'verification'")) return { risk: null };
      if (expression.includes("querySelectorAll('.job-card-wrap')")) return [
        { title: '产品经理', salary: '20-30K', experience: '3-5年', education: '本科', company: '甲公司', city: '佛山', url: '/job_detail/a1.html' },
        { title: '运营经理', salary: '15-20K', experience: '1-3年', education: '本科', company: '乙公司', city: '佛山', url: '/job_detail/a2.html' },
      ];
      const id = currentUrl.includes('a2') ? 'a2' : 'a1';
      return {
        title: id === 'a1' ? '产品经理' : '运营经理', company: id === 'a1' ? '甲公司' : '乙公司', salary: id === 'a1' ? '20-30K' : '15-20K',
        experience: id === 'a1' ? '3-5年' : '1-3年', education: '本科', jd: `${id} 的完整岗位职责和任职要求`,
        recruitmentType: 'social_recruitment', url: currentUrl,
      };
    }),
  };
}

const services: JobCollectionService[] = [];
afterEach(() => services.splice(0).forEach((service) => service.Close()));

function CreateService(input: { now?: () => number; saveJob?: ReturnType<typeof vi.fn> } = {}) {
  const saveJob = input.saveJob ?? vi.fn(async (job) => ({ jobId: job.jobId, jobRevision: 1 }));
  const service = new JobCollectionService({ browser: CreateBrowser(), loadViewModel: () => ({ jobs: [], applications: [] }), saveJob, now: input.now });
  services.push(service);
  return { service, saveJob };
}

async function Collect(service: JobCollectionService) {
  return service.Collect({ sessionId: 'session-1', platforms: ['boss_zhipin'], queries: [{ keyword: '产品', city: '佛山' }], sort: 'relevance', maxResults: 2 });
}

describe('JobCollectionService', () => {
  it('采集只返回会话候选，显式保存时才写入岗位库', async () => {
    const { service, saveJob } = CreateService();
    const result = await Collect(service);

    expect(result.candidates).toHaveLength(2);
    expect(saveJob).not.toHaveBeenCalled();
    const saved = await service.SaveCandidate({ sessionId: 'session-1', collectionId: result.collectionId, candidateId: result.candidates[0].candidateId, matchScore: 91 });
    expect(saved.jobId).toBe('job-boss-a1');
    expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ title: '产品经理', company: '甲公司', matchScore: 91 }));
  });

  it('候选缓存按创建时刻绝对过期且不会滑动续期', async () => {
    let now = 1_000;
    const { service } = CreateService({ now: () => now });
    const result = await Collect(service);
    now += 15 * 60 * 1000;

    await expect(service.SaveCandidate({ sessionId: 'session-1', collectionId: result.collectionId, candidateId: result.candidates[0].candidateId }))
      .rejects.toMatchObject({ code: 'JOB_COLLECTION_EXPIRED' });
  });

  it('删除会话会立即丢弃该会话采集结果', async () => {
    const { service } = CreateService();
    const result = await Collect(service);
    service.DeleteSession('session-1');

    await expect(service.SaveCandidate({ sessionId: 'session-1', collectionId: result.collectionId, candidateId: result.candidates[0].candidateId }))
      .rejects.toMatchObject({ code: 'JOB_COLLECTION_EXPIRED' });
  });

  it('候选引用不能跨会话读取', async () => {
    const { service } = CreateService();
    const result = await Collect(service);

    await expect(service.SaveCandidate({ sessionId: 'session-2', collectionId: result.collectionId, candidateId: result.candidates[0].candidateId }))
      .rejects.toMatchObject({ code: 'JOB_COLLECTION_EXPIRED' });
  });

  it('第四个批次淘汰最早批次，全部候选保存后立即删除批次', async () => {
    const { service } = CreateService();
    const first = await Collect(service);
    await Collect(service);
    await Collect(service);
    const fourth = await Collect(service);
    await expect(service.SaveCandidate({ sessionId: 'session-1', collectionId: first.collectionId, candidateId: first.candidates[0].candidateId }))
      .rejects.toMatchObject({ code: 'JOB_COLLECTION_EXPIRED' });

    for (const candidate of fourth.candidates) {
      await service.SaveCandidate({ sessionId: 'session-1', collectionId: fourth.collectionId, candidateId: candidate.candidateId });
    }
    await expect(service.SaveCandidate({ sessionId: 'session-1', collectionId: fourth.collectionId, candidateId: fourth.candidates[0].candidateId }))
      .rejects.toMatchObject({ code: 'JOB_COLLECTION_EXPIRED' });
  });
});
