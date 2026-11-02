import type { Application } from '../../types/domain';

/** 防止空选择或已被删除的资料引用通过校验，也不能把菜单兜底显示当成真实选择。 */
export function GetApplicationFormErrors(form: Partial<Application>, jobs: ReadonlyArray<{ id: string }>, resumes: ReadonlyArray<{ id: string }>): Partial<Record<'jobId' | 'resumeId' | 'status', string>> {
  const errors: Partial<Record<'jobId' | 'resumeId' | 'status', string>> = {};
  if (!form.jobId || !jobs.some((job) => job.id === form.jobId)) errors.jobId = jobs.length ? '请选择有效岗位' : '请先在岗位库添加岗位';
  if (!form.resumeId || !resumes.some((resume) => resume.id === form.resumeId)) errors.resumeId = resumes.length ? '请选择有效简历' : '请先创建简历';
  if (!form.status || !['applied', 'written_test', 'interviewing'].includes(form.status)) errors.status = '请选择有效的投递阶段';
  return errors;
}
