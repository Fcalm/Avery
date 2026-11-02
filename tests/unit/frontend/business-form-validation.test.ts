import { describe, expect, it } from 'vitest';
import { GetJobFormErrors } from '../../../src/features/job/jobForm';
import { GetApplicationFormErrors } from '../../../src/features/application/applicationForm';

describe('岗位与投递表单校验', () => {
  it('手动新增岗位拒绝空白必填字段，逐项补齐后允许提交', () => {
    const draft = { company: ' \t', title: '', city: '', experience: '', jd: '' };
    expect(Object.keys(GetJobFormErrors(draft, false))).toEqual(['company', 'title', 'city', 'experience', 'jd']);
    const errors = GetJobFormErrors({ ...draft, company: '测试企业', title: '产品实习生', city: '广州', experience: '不限', jd: '岗位内容\n岗位要求' }, false);
    expect(errors).toEqual({});
  });

  it('编辑来源信息不全的岗位时不强迫补造城市、经验或 JD', () => {
    expect(GetJobFormErrors({ company: '测试企业', title: '产品实习生' }, true)).toEqual({});
    expect(GetJobFormErrors({ company: '测试企业', title: ' ' }, true)).toEqual({ title: '请填写岗位名称' });
  });

  it('投递缺少前置资料时明确指出需创建的资料，不把空菜单视为已选择', () => {
    expect(GetApplicationFormErrors({ status: 'applied' }, [], [])).toEqual({ jobId: '请先在岗位库添加岗位', resumeId: '请先创建简历' });
    expect(GetApplicationFormErrors({ status: 'applied' }, [{ id: 'job' }], [{ id: 'resume' }])).toEqual({ jobId: '请选择有效岗位', resumeId: '请选择有效简历' });
  });

  it('删除过的引用不能提交，选择实际存在的资料后清除对应错误', () => {
    const jobs = [{ id: 'new-job' }], resumes = [{ id: 'resume' }];
    const draft = { jobId: 'deleted-job', resumeId: 'resume', status: 'applied' as const };
    expect(GetApplicationFormErrors(draft, jobs, resumes)).toEqual({ jobId: '请选择有效岗位' });
    expect(GetApplicationFormErrors({ ...draft, jobId: 'new-job' }, jobs, resumes)).toEqual({});
  });

  it('只允许当前看板支持的投递阶段', () => {
    const jobs = [{ id: 'job' }], resumes = [{ id: 'resume' }];
    for (const status of ['applied', 'written_test', 'interviewing'] as const) {
      expect(GetApplicationFormErrors({ jobId: 'job', resumeId: 'resume', status }, jobs, resumes)).toEqual({});
    }
    expect(GetApplicationFormErrors({ jobId: 'job', resumeId: 'resume', status: 'ended' }, jobs, resumes)).toEqual({ status: '请选择有效的投递阶段' });
  });
});
