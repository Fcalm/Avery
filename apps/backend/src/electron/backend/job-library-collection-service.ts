import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as Delay } from 'node:timers/promises';
import type { BrowserAutomationPort } from '@avery/agent-sdk';
import { JobCollectionInputSchema, JobCollectionLimits, type CollectedJob, type JobCollectionInput, type JobCollectionRequest, type JobCollectionTask, type JobImportResult, type RecruitmentSource } from '@avery/contracts';
import { AtsFactStore, AtsSourceRunner, CreateSource } from './ats/source-runner';
import type { AtsSource, NormalizedJob, SourceResult } from './ats/types';
import { BuiltinRecruitmentSources } from './recruitment-sources';
import { JobCityMatches, NormalizeJobFilterValue } from '../repositories/job-query';
import { CampusExpiredThroughYear, CampusRecruitmentSource, IsExpiredCampusRecruitment } from './campus-recruitment-source';
import { CreateFeishuPageReader, FeishuBrowserCollector } from './feishu-browser-collection';

interface CollectionStore {
  schemaVersion: 1;
  /** 自定义来源和内置启停覆盖各自独立，版本更新不会覆盖用户偏好。 */
  customSources: RecruitmentSource[];
  sourceOverrides: Record<string, { enabled?: boolean; lastValidatedAt?: string; lastError?: string }>;
  tasks: JobCollectionTask[];
}
export interface JobLibraryCollectionOptions {
  workspacePath: string;
  importJobs(batch: CollectedJob[]): Promise<JobImportResult>;
  collectBoss(input: { keyword: string; city: string; jobSeekingTypes: JobCollectionRequest['jobSeekingTypes']; educations: JobCollectionRequest['educations']; signal: AbortSignal; deadline: number; accept(job: CollectedJob): Promise<boolean> }): Promise<void>;
  /** 测试替身使用相同分段协议，不改变生产出口限制。 */
  runner?: { Run(source: AtsSource, signal: AbortSignal, options?: { useCache?: boolean; refresh?: boolean; reusePartial?: boolean }): Promise<SourceResult> };
  campus?: Pick<CampusRecruitmentSource, 'Discover'>;
  sources?: RecruitmentSource[];
  taskTimeoutMs?: (count: number) => number;
  withBrowser?: <T>(run: (browser: BrowserAutomationPort) => Promise<T>) => Promise<T>;
  feishu?: Pick<FeishuBrowserCollector, 'Run' | 'HasCachedQuery'>;
}
/** 仅Host传入的执行约束；不属于页面/模型可指定的采集条件。 */
export interface JobCollectionExecution {
  signal?: AbortSignal; deadline?: number; idempotencyKey?: string; reconcileOnly?: boolean;
  collectBoss?: JobLibraryCollectionOptions['collectBoss'];
  withBrowser?: JobLibraryCollectionOptions['withBrowser'];
}
function Failure(message: string, code = 'VALIDATION_ERROR'): Error { return Object.assign(new Error(message), { code }); }
function Message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
/** ATS可能返回HTML或纯文本；只保留正文和段落，不渲染远端HTML，也不压平原有换行。 */
function PlainText(value?: string): string {
  return (value ?? '').replace(/\r\n?/g, '\n')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>/gi, '\n').replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 共用来源身份；同一租户岗位出现在多个入口时仍只写入一次。 */
export function NormalizeCollectedAtsJob(job: NormalizedJob): CollectedJob {
  const identity = `${job.ats}:${job.tenant}:${job.atsJobId}`;
  return {
    identity, platform: job.ats, sourceId: job.sourceId, originalJobId: job.atsJobId,
    sourceUrl: job.sourceUrl, collectedAt: job.lastSeenAt,
    job: {
      // 沿用已有 ATS 候选保存的 ID，兼容此前保存的岗位。
      id: `job-ats-${createHash('sha256').update(job.id).digest('hex').slice(0, 32)}`,
      company: job.company, title: job.title, city: job.locations.join(' / '), salary: job.salary,
      experience: job.experience ?? '', education: job.education, jobSeekingType: job.jobType,
      channel: 'company_website', favorite: false, url: job.applicationUrl,
      jd: [PlainText(job.description), PlainText(job.requirements)].filter(Boolean).join('\n\n'),
    },
  };
}

/** 后端独立长任务：不依赖模型/会话，业务写入与事实快照分离，进度只统计确认落盘批次。 */
export class JobLibraryCollectionService {
  private state: CollectionStore = { schemaVersion: 1, customSources: [], sourceOverrides: {}, tasks: [] };
  private initialized?: Promise<void>;
  private persistTail: Promise<void> = Promise.resolve();
  private active?: { task: JobCollectionTask; controller: AbortController; work: Promise<void> };
  private starting = false;
  private closing = false;
  private path: string;
  private runner: NonNullable<JobLibraryCollectionOptions['runner']>;
  private readonly sources: RecruitmentSource[];
  private campus: Pick<CampusRecruitmentSource, 'Discover'>;
  private feishu: Pick<FeishuBrowserCollector, 'Run' | 'HasCachedQuery'>;

  constructor(private readonly options: JobLibraryCollectionOptions) {
    this.path = join(options.workspacePath, 'job-collection', 'state.json');
    this.sources = options.sources ?? BuiltinRecruitmentSources;
    this.campus = options.campus ?? new CampusRecruitmentSource(join(options.workspacePath, 'job-collection', 'campus-cache.json'));
    this.feishu = options.feishu ?? new FeishuBrowserCollector(join(options.workspacePath, 'job-collection', 'feishu-browser-cache.json'));
    this.runner = options.runner ?? new AtsSourceRunner(undefined, new AtsFactStore(join(options.workspacePath, 'job-collection', 'ats-facts.json')));
  }
  Initialize(): Promise<void> { return this.initialized ??= this.Load(); }
  private async Load(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8')) as CollectionStore;
      if (state.schemaVersion !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.customSources) || !state.sourceOverrides) throw Failure('采集存储格式无效。', 'STORAGE_ERROR');
      this.state = state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // 未正常退出的任务不会在重启后继续后台执行或冒充完成。
    for (const task of this.state.tasks) if (task.status === 'running') {
      task.status = 'interrupted'; task.finishedAt = task.updatedAt = Date.now();
      task.warnings.push('应用退出中断采集；已入库岗位保留。');
    }
    await this.Persist();
  }
  private Persist(): Promise<void> {
    const path = this.path, snapshot = JSON.stringify(this.state);
    const operation = this.persistTail.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, snapshot, 'utf8'); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => undefined); }
    });
    this.persistTail = operation;
    return operation;
  }
  HasActiveTask(): boolean { return this.starting || Boolean(this.active); }
  HasActiveBrowserTask(): boolean { return Boolean(this.active && (this.active.task.request.channel === 'boss_zhipin' || this.active.task.request.browserFallback)); }
  async ListRecruitmentSources(): Promise<RecruitmentSource[]> {
    await this.Initialize();
    return [...this.sources, ...this.state.customSources].map((source) => ({ ...source, ...this.state.sourceOverrides[source.sourceId] }));
  }
  async SetRecruitmentSourceEnabled(sourceId: string, enabled: boolean): Promise<RecruitmentSource> {
    const source = (await this.ListRecruitmentSources()).find((entry) => entry.sourceId === sourceId);
    if (!source) throw Failure('企业来源不存在。');
    this.state.sourceOverrides[sourceId] = { ...this.state.sourceOverrides[sourceId], enabled };
    await this.Persist(); return { ...source, enabled };
  }
  async GetJobCollectionTask(taskId?: string): Promise<JobCollectionTask | null> {
    await this.Initialize();
    const task = (taskId ? this.state.tasks.find((task) => task.taskId === taskId) : this.state.tasks[0]) ?? null;
    // 终态只有在最终记录保存、任务锁释放后才对外发布，防止“已完成”后立即启动被误判占用。
    if (task && task.status !== 'running' && this.active?.task === task) await this.active.work;
    return structuredClone(task);
  }
  /** Agent等待同一个持久任务收尾；重放只复用任务，不重新采集或重复写入。 */
  async CollectAndWait(input: JobCollectionInput, execution: JobCollectionExecution): Promise<JobCollectionTask> {
    await this.Initialize();
    const existing = execution.idempotencyKey ? this.state.tasks.find((task) => task.idempotencyKey === execution.idempotencyKey) : undefined;
    if (!existing && execution.reconcileOnly) throw Failure('原采集任务记录不可用，请先读取岗位库核对，不自动重新采集。', 'JOB_COLLECTION_TASK_MISSING');
    // 旧任务可能缺少新增的缺省字段；两侧统一规范化，升级后重放不能误判参数冲突。
    if (existing && JSON.stringify(JobCollectionInputSchema.parse(existing.request)) !== JSON.stringify(JobCollectionInputSchema.parse(input))) throw Failure('采集幂等键对应的参数不一致。');
    const task = existing ?? await this.StartJobCollection(input, execution);
    if (this.active?.task.taskId === task.taskId) await this.active.work;
    return (await this.GetJobCollectionTask(task.taskId))!;
  }
  async StartJobCollection(input: JobCollectionInput, execution: JobCollectionExecution = {}): Promise<JobCollectionTask> {
    if (this.active && this.active.task.status !== 'running') await this.active.work;
    if (this.closing || this.HasActiveTask()) throw Failure('已有采集任务正在运行，请等待或取消。', 'RESOURCE_LOCKED');
    this.starting = true;
    try {
      await this.Initialize();
      const parsed = JobCollectionInputSchema.safeParse(input);
      if (!parsed.success) throw Failure(parsed.error.issues.map((issue) => issue.message).join('；'));
      const request = parsed.data;
      if (execution.signal?.aborted || (execution.deadline ?? Infinity) <= Date.now()) throw Failure('采集开始前已取消或超时。', execution.signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
      const catalog = await this.ListRecruitmentSources();
      const selected = request.channel === 'company_website'
        ? catalog.filter((source) => source.enabled && (!request.sourceIds?.length || request.sourceIds.includes(source.sourceId))) : [];
      if (request.sourceIds?.some((id) => !selected.some((source) => source.sourceId === id))) throw Failure('指定来源不存在或已停用。');
      if (request.channel === 'company_website' && !selected.length) throw Failure('没有可用的企业招聘来源。');
      const now = Date.now();
      const task: JobCollectionTask = {
        taskId: `collection-${randomUUID()}`, request, status: 'running', createdAt: now, updatedAt: now,
        ...(execution.idempotencyKey ? { idempotencyKey: execution.idempotencyKey } : {}),
        deadline: Math.min(execution.deadline ?? Infinity, now + (this.options.taskTimeoutMs?.(request.targetCount) ?? Math.min(30 * 60_000, 120_000 + request.targetCount * 5000))),
        scanned: 0, collected: 0, inserted: 0, existing: 0, skippedDeleted: 0, failedWrites: 0,
        sources: selected.map((source) => ({ sourceId: source.sourceId, company: source.company, status: 'pending', segments: 0, received: 0 })), warnings: [],
      };
      this.state.tasks = [task, ...this.state.tasks].slice(0, 100);
      await this.Persist();
      const controller = new AbortController();
      // 先占有任务锁再启动异步工作；避免快速重复点击在首次 await 期间创建第二个任务。
      const active = { task, controller, work: Promise.resolve() };
      this.active = active;
      const abort = () => controller.abort(Date.now() >= task.deadline ? 'timed_out' : 'cancelled');
      if (execution.signal?.aborted) abort();
      else execution.signal?.addEventListener('abort', abort, { once: true });
      active.work = this.Run(task, selected, controller, execution.collectBoss, execution.withBrowser).finally(() => {
        execution.signal?.removeEventListener('abort', abort);
        if (this.active === active) this.active = undefined;
      });
      // 运行期存储失败仍保留内存错误进度，避免未处理 rejection 破坏 Utility Process。
      void active.work.catch((error) => { task.status = 'failed'; task.warnings.push(`采集记录保存失败：${Message(error)}`); });
      return structuredClone(task);
    } finally { this.starting = false; }
  }
  async CancelJobCollection(taskId: string): Promise<JobCollectionTask> {
    await this.Initialize();
    if (this.active?.task.taskId === taskId) {
      this.active.controller.abort('cancelled');
      // 不提前声明取消完成；等待已经提交 Worker 的批次落盘并计数。
      await this.active.work;
    }
    const task = await this.GetJobCollectionTask(taskId);
    if (!task) throw Failure('采集任务不存在。');
    return task;
  }
  async Close(): Promise<void> {
    this.closing = true;
    while (this.starting) await Delay(10);
    this.active?.controller.abort('interrupted');
    await this.active?.work;
    await this.persistTail;
  }
  async SetWorkspacePath(workspacePath: string): Promise<void> {
    if (this.HasActiveTask()) throw Failure('采集任务运行时不能切换工作空间。', 'RESOURCE_LOCKED');
    await this.persistTail;
    this.path = join(workspacePath, 'job-collection', 'state.json');
    this.state = { schemaVersion: 1, customSources: [], sourceOverrides: {}, tasks: [] };
    this.initialized = undefined;
    this.runner = this.options.runner ?? new AtsSourceRunner(undefined, new AtsFactStore(join(workspacePath, 'job-collection', 'ats-facts.json')));
    this.campus = this.options.campus ?? new CampusRecruitmentSource(join(workspacePath, 'job-collection', 'campus-cache.json'));
    this.feishu = this.options.feishu ?? new FeishuBrowserCollector(join(workspacePath, 'job-collection', 'feishu-browser-cache.json'));
    await this.Initialize();
  }
  private async Update(task: JobCollectionTask): Promise<void> { task.updatedAt = Date.now(); await this.Persist(); }
  private async Run(task: JobCollectionTask, sources: RecruitmentSource[], controller: AbortController, collectBoss = this.options.collectBoss, withBrowser = this.options.withBrowser): Promise<void> {
    const timer = setTimeout(() => controller.abort('timed_out'), Math.max(1, task.deadline - Date.now()));
    const seen = new Set<string>(), inspected = new Set<string>();
    const filtered = { expired: 0, keyword: 0, jobSeekingType: 0, education: 0, unknownJobType: 0, unknownEducation: 0 };
    const batch: CollectedJob[] = [];
    const Check = () => { if (controller.signal.aborted) throw Failure('采集已停止。', 'CANCELLED'); };
    const Flush = async () => {
      if (!batch.length) return;
      Check();
      const pending = batch.splice(0);
      let result: JobImportResult;
      try { result = await this.options.importJobs(pending); }
      catch (error) {
        task.failedWrites += pending.length;
        await this.Update(task);
        throw error;
      }
      for (const item of result.items) {
        if (item.status === 'inserted') task.inserted++;
        else if (item.status === 'existing') task.existing++;
        else if (item.status === 'deleted') task.skippedDeleted++;
        else { task.failedWrites++; if (task.warnings.length < 50) task.warnings.push(`岗位写入失败：${item.error ?? item.jobId}`); }
      }
      task.collected = task.inserted + task.existing;
      await this.Update(task);
      Check();
    };
    const Accept = async (entry: CollectedJob): Promise<boolean> => {
      Check();
      const firstInspection = !inspected.has(entry.identity);
      if (firstInspection) { inspected.add(entry.identity); task.scanned++; }
      // 新届公告也可能指向混合门户；官网名称明确过期时拒绝本次入库，不删除用户已有岗位。
      if (task.request.channel === 'campus_aggregator' && IsExpiredCampusRecruitment(entry.job.title)) {
        if (firstInspection) filtered.expired++;
        return task.collected < task.request.targetCount;
      }
      const text = (task.request.keywordScope === 'title' ? entry.job.title : `${entry.job.title}\n${entry.job.company}\n${entry.job.jd}`).toLowerCase();
      if (seen.has(entry.identity)) return task.collected < task.request.targetCount;
      if (task.request.keyword && !text.includes(task.request.keyword.toLowerCase())) {
        if (firstInspection) filtered.keyword++;
        return task.collected < task.request.targetCount;
      }
      if (task.request.channel !== 'boss_zhipin' && task.request.city && task.request.city !== '全国' && !JobCityMatches(entry.job.city, task.request.city)) return task.collected < task.request.targetCount;
      // 两个渠道共用入库前筛选；只使用明确来源字段，不根据 JD 或来源名单推测缺失信息。
      if (task.request.jobSeekingTypes.length && !task.request.jobSeekingTypes.some((type) => type === entry.job.jobSeekingType)) {
        if (firstInspection) { filtered.jobSeekingType++; if (!entry.job.jobSeekingType) filtered.unknownJobType++; }
        return task.collected < task.request.targetCount;
      }
      if (task.request.educations.length) {
        const education = NormalizeJobFilterValue('education', entry.job.education);
        if (!task.request.educations.some((value) => value === education)) {
          if (firstInspection) { filtered.education++; if (!education) filtered.unknownEducation++; }
          return task.collected < task.request.targetCount;
        }
      }
      seen.add(entry.identity); batch.push(entry);
      if (batch.length >= Math.min(JobCollectionLimits.batchSize, task.request.targetCount - task.collected)) await Flush();
      return task.collected < task.request.targetCount;
    };
    try {
      if (task.request.channel === 'campus_aggregator') {
        const result = await this.campus.Discover(task.request, controller.signal);
        Check(); sources = result.sources; task.discovery = result.discovery;
        task.sources = sources.map((source) => ({ sourceId: source.sourceId, company: source.company, status: 'pending', segments: 0, received: 0 }));
        task.warnings.push('汇总公告仅用于发现入口；届别/批次来自第三方，需以官网岗位说明核实，未复制第三方摘要或截止日期。');
        if (result.discovery.skipped) task.warnings.push(`跳过 ${result.discovery.skipped} 条公告：${Object.entries(result.discovery.reasons).map(([reason, count]) => `${reason} ${count}`).join('，')}。来源：${result.discovery.url}`);
        await this.Update(task);
      }
      if (task.request.channel === 'boss_zhipin') {
        task.sources.push({ sourceId: 'boss_zhipin', company: 'BOSS直聘', status: 'running', segments: 1, received: 0 });
        await this.Update(task);
        await collectBoss({ keyword: task.request.keyword, city: task.request.city!, jobSeekingTypes: task.request.jobSeekingTypes,
          educations: task.request.educations, signal: controller.signal, deadline: task.deadline, accept: Accept });
        task.sources[0].received = task.scanned; task.sources[0].status = task.collected >= task.request.targetCount ? 'partial' : 'completed';
      } else {
        // 批量发现时先使用通常可后台读取的来源，浏览器受限来源放后，减少冷启动时串行导航。
        if (task.request.browserFallback) sources = sources.slice().sort((a,b) => Number(a.platform === 'feishu') - Number(b.platform === 'feishu'));
        for (const source of sources) {
          Check(); if (task.collected >= task.request.targetCount) break;
          const progress = task.sources.find((entry) => entry.sourceId === source.sourceId)!;
          progress.status = 'running'; await this.Update(task);
          try {
            const Hybrid = async () => {
              if (!withBrowser) throw Failure('当前宿主未提供飞书浏览器辅助采集，请连接浏览器后重试。', 'BROWSER_UNAVAILABLE');
              progress.browserAssisted = true; await this.Update(task);
              const note = '浏览器辅助读取官网原生关键词搜索结果，完成状态只代表该查询范围，不代表企业全部岗位。';
              if (!task.warnings.includes(note)) task.warnings.push(note);
              const report = await withBrowser((browser) => this.feishu.Run({ source, request: task.request, signal: controller.signal, deadline: Math.min(task.deadline, Date.now() + 60_000),
                readPage: CreateFeishuPageReader(browser), accept: (job) => Accept(NormalizeCollectedAtsJob(job)) }));
              progress.received = report.received; progress.segments++;
              progress.status = report.errors.length ? 'failed' : report.complete ? 'completed' : 'partial';
              if (report.errors.length) { progress.error = report.errors.join('；').slice(0,500); task.warnings.push(`${source.company}：${progress.error}`); }
              await Flush();
            };
            if (source.platform === 'feishu' && task.request.browserFallback && await this.feishu.HasCachedQuery(source, task.request)) {
              await Hybrid(); await this.Update(task); continue;
            }
            let previousCursor = '', stalled = 0;
            while (task.collected < task.request.targetCount) {
              Check();
              const result = await this.runner.Run({ ...CreateSource({ url: source.url, company: source.company, ats: source.platform, maxPages: 20 }), id: source.sourceId, companyId: source.companyId }, controller.signal, { useCache: progress.segments === 0, refresh: task.request.refresh, reusePartial: true });
              if (result.cacheHit && result.snapshotStatus === 'partial' && !task.warnings.includes('复用了近期已读取的部分官网岗位；该缓存不代表企业岗位已完整遍历。')) task.warnings.push('复用了近期已读取的部分官网岗位；该缓存不代表企业岗位已完整遍历。');
              Check(); progress.segments++; progress.received = Math.max(progress.received, result.receivedCount);
              if (source.platform === 'feishu' && task.request.browserFallback && result.errors.some(error => error.code === 'SOURCE_BROWSER_REQUIRED')) {
                await Hybrid(); break;
              }
              for (const job of result.jobs) {
                if (job.status !== 'open') continue;
                if (!await Accept(NormalizeCollectedAtsJob(job))) break;
              }
              // 每段结束即落盘，部分失败和取消不依赖整个来源遍历完毕。
              await Flush();
              const warning = result.errors.map((error) => `${error.code}: ${error.message}`).join('；');
              if (task.request.channel !== 'campus_aggregator') this.state.sourceOverrides[source.sourceId] = { ...this.state.sourceOverrides[source.sourceId],
                ...(result.jobs.length ? { lastValidatedAt: result.finishedAt } : {}), lastError: warning || undefined };
              if (task.collected >= task.request.targetCount) { progress.status = result.snapshotStatus === 'complete' ? 'completed' : 'partial'; break; }
              if (result.snapshotStatus === 'complete') { progress.status = 'completed'; break; }
              if (result.scope === 'single_job' && !result.errors.length) { progress.status = 'partial'; break; }
              if (!result.continuation) throw Failure(warning || '来源未能完成遍历，且没有可继续执行的检查点。');
              const cursor = `${result.continuation.nextPage}:${result.continuation.pendingRows?.length ?? 0}:${result.jobs.length}`;
              stalled = cursor === previousCursor ? stalled + 1 : 0; previousCursor = cursor;
              if (stalled >= 3) throw Failure(warning || '来源连续三段未取得进展。');
              if (stalled) await Delay(1000, undefined, { signal: controller.signal });
              await this.Update(task);
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            progress.status = 'failed'; progress.error = Message(error);
            if (task.request.channel !== 'campus_aggregator') this.state.sourceOverrides[source.sourceId] = { ...this.state.sourceOverrides[source.sourceId], lastError: progress.error };
            if (task.warnings.length < 50) task.warnings.push(`${source.company}：${progress.error}`);
            await Flush();
          }
          await this.Update(task);
        }
      }
      await Flush();
      task.status = task.collected >= task.request.targetCount ? 'completed'
        : task.sources.length > 0 && task.sources.every((source) => source.status === 'failed') && !task.collected ? 'failed' : 'completed_with_shortage';
      if (task.status === 'completed_with_shortage') task.warnings.push(`来源耗尽或部分失败，实际采集 ${task.collected}/${task.request.targetCount} 个岗位。`);
    } catch (error) {
      // 来源后续失败时仍保存此前已确认的有效项；用户取消或超时后不再提交新批次。
      if (!controller.signal.aborted) {
        try { await Flush(); }
        catch (writeError) { task.warnings.push(`最后批次保存失败：${Message(writeError)}`); }
      }
      task.status = controller.signal.aborted ? (controller.signal.reason === 'interrupted' ? 'interrupted' : controller.signal.reason === 'timed_out' ? 'timed_out' : 'cancelled') : 'failed';
      task.warnings.push(controller.signal.aborted ? '采集停止，已入库岗位保留。' : Message(error));
      for (const source of task.sources) if (source.status === 'running') { source.status = controller.signal.aborted ? 'partial' : 'failed'; source.error = Message(error); }
    } finally {
      if (task.request.channel === 'boss_zhipin' && task.sources[0]) task.sources[0].received = task.scanned;
      // 按首次检查时的第一个不满足条件计数，重复来源/累计快照不会放大筛除数量。
      if (filtered.expired) task.warnings.push(`跳过 ${filtered.expired} 个官网名称明确标注过期届别或批次的岗位（${CampusExpiredThroughYear}及以前）。`);
      if (filtered.keyword + filtered.jobSeekingType + filtered.education) task.warnings.push(`检查过程筛除：关键词 ${filtered.keyword}，求职类型 ${filtered.jobSeekingType}（未知 ${filtered.unknownJobType}），学历 ${filtered.education}（未知 ${filtered.unknownEducation}）。`);
      clearTimeout(timer); task.finishedAt = Date.now(); await this.Update(task);
    }
  }
}
