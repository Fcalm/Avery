import { JobCollectionInputSchema, type JobCollectionInput, type JobCollectionTask, type RecruitmentSource } from '@avery/contracts';

interface ManualCollectionPort {
  ListSources(): Promise<RecruitmentSource[]>;
  EnableSource(id: string): Promise<unknown>;
  Start(input: JobCollectionInput): Promise<JobCollectionTask>;
}

/**
 * 手动采集统一刷新缓存并按需使用浏览器；企业官网默认覆盖所有来源。
 * 仅在用户点击开始后恢复旧版停用的来源，逐个等待持久化完成再启动任务，失败时不启动半配置任务。
 * 此策略不改变 Agent 的工具参数与授权边界。
 */
export async function StartManualJobCollection(input: JobCollectionInput, port: ManualCollectionPort): Promise<JobCollectionTask> {
  const options = { ...input, refresh: input.channel !== 'boss_zhipin', browserFallback: input.channel !== 'boss_zhipin' };
  delete options.sourceIds;
  const request = JobCollectionInputSchema.parse(options);
  if (request.channel === 'company_website') {
    const sources = await port.ListSources();
    for (const source of sources) if (!source.enabled) await port.EnableSource(source.sourceId);
  }
  return port.Start(request);
}
