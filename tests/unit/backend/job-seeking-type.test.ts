import { describe, expect, it } from 'vitest';
import { JobToDisplay, JobToStorage } from '../../../apps/backend/src/electron/repositories/enum-map';
import { JobUpsertSchema } from '../../../packages/contracts/src/write-schemas';

describe('岗位求职类型兼容', () => {
  it('将旧版正式工字段读取为社招', () => {
    expect(JobToDisplay({ employmentType: '正式工', channel: '企业官网' })).toEqual({
      jobSeekingType: 'social_recruitment', channel: 'company_website',
    });
  });

  it('保存时仅写入新的求职类型字段', () => {
    expect(JobToStorage({ employmentType: 'full_time', channel: 'boss_zhipin' })).toEqual({
      jobSeekingType: '社招', channel: 'BOSS直聘',
    });
    expect(JobToStorage({ jobSeekingType: 'campus_recruitment', channel: 'boss_zhipin' })).toEqual({
      jobSeekingType: '校招', channel: 'BOSS直聘',
    });
  });

  it('仅接受实习、校招和社招的契约值', () => {
    expect(JobUpsertSchema.safeParse({ id: 'job-1', jobSeekingType: 'intern' }).success).toBe(true);
    expect(JobUpsertSchema.safeParse({ id: 'job-1', jobSeekingType: 'campus_recruitment' }).success).toBe(true);
    expect(JobUpsertSchema.safeParse({ id: 'job-1', jobSeekingType: 'social_recruitment' }).success).toBe(true);
    expect(JobUpsertSchema.safeParse({ id: 'job-1', jobSeekingType: 'full_time' }).success).toBe(false);
  });
});
