import type { ConversationResource } from '@avery/agent-sdk';

const Record = (value: unknown): { [key: string]: unknown } => value && typeof value === 'object' && !Array.isArray(value) ? value as { [key: string]: unknown } : {};

/** 只从成功工具的结构化回执提取允许的实体字段，绝不解释模型自然语言或任意本地路径。 */
export function GetToolResources(name: string, rawResult: unknown, rawArgs: unknown): ConversationResource[] {
  const result = Record(rawResult), args = Record(rawArgs);
  if (result.ok !== true) return [];
  const resources: ConversationResource[] = [];
  const add = (kind: ConversationResource['kind'], value: unknown, produced: boolean) => {
    const item = Record(value);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 200) return;
    resources.push({ kind, id: item.id, title: String(item.name ?? item.title ?? (kind === 'resume' ? '简历' : kind === 'profile' ? '档案' : '岗位')).slice(0, 200), produced,
      ...(Number.isSafeInteger(item.revision) ? { revision: item.revision as number } : {}) });
  };
  if (name === 'ReadResume' || name === 'CreateResume' || name === 'UpdateResume') add('resume', result.resume, name !== 'ReadResume');
  if (name === 'ReadResume' && Array.isArray(result.resumes)) result.resumes.slice(0, 30).forEach((item) => add('resume', item, false));
  if ((name === 'UpdateResume' || name === 'CreateResume') && typeof result.resumeId === 'string' && result.saved === true) add('resume', { id: result.resumeId, name: args.name, revision: result.revision }, true);
  if (name === 'UpdateProfile' && Array.isArray(args.items)) args.items.forEach((item) => add('profile', item, true));
  if (name === 'ReadProfile') {
    const items = result.items ?? result.profiles;
    if (Array.isArray(items)) items.forEach((item) => add('profile', item, false));
  }
  if (name === 'ReadJobs') {
    const data = Record(result.result ?? result.data ?? result);
    const jobs = data.items ?? data.jobs;
    if (Array.isArray(jobs)) jobs.slice(0, 30).forEach((item) => { const job = Record(item); add('job', { ...job, id: job.id ?? job.jobId }, false); });
    if (data.job) add('job', data.job, false);
  }
  if (name === 'SaveJob' || name === 'UpdateApplicationStatus') {
    const data = Record(result.result ?? result.data ?? result);
    const jobId = data.jobId ?? args.jobId;
    if (typeof jobId === 'string') add('job', { id: jobId, title: args.title ?? '岗位' }, true);
    if (typeof data.applicationId === 'string') add('application', { id: data.applicationId, title: args.title ?? '投递记录' }, true);
  }
  if (name === 'ExportResumeFile' && typeof result.fileId === 'string' && /^asset:\/\/resume\/[a-f0-9-]+$/i.test(result.fileId)) {
    resources.push({ kind: 'file', id: result.fileId, title: String(result.fileName ?? '导出简历').slice(0, 200), fileName: String(result.fileName ?? '').slice(0, 200), produced: true });
  }
  return resources;
}
