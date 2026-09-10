import { describe, expect, it, vi } from 'vitest';
import { AgentResumePort } from '../../../apps/backend/src/electron/backend/agent-resume-port';

describe('AgentResumePort', () => {
  it('简历索引不包含正文，指定 ID 读取才返回完整快照', async () => {
    const resume = {
      id: 'resume-1', name: '后端简历', content: '不应出现在索引中的正文', updatedAt: '2026-09-05',
      revision: 3, targetRoles: ['后端工程师'], summary: '后端方向',
    };
    const business = { LoadViewModel: vi.fn(async () => ({ resumes: [resume] })) };
    const port = new AgentResumePort({ business });

    const index = await port.List();
    expect(index).toEqual([{
      id: 'resume-1', name: '后端简历', updatedAt: '2026-09-05', revision: 3,
      targetRoles: ['后端工程师'],
    }]);
    expect(index[0]).not.toHaveProperty('content');
    await expect(port.ReadCurrent('resume-1')).resolves.toEqual(resume);
  });
});
