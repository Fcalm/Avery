import { createHash } from 'node:crypto';
import type { JobLibraryPort } from '@avery/agent-sdk';
import { JobLibraryReadLimits } from '@avery/agent-sdk';
import { ParseJobQuery, type JobQueryInput, type JobQueryResult } from '@avery/contracts';
import type { JobLibraryCollectionService, JobLibraryCollectionOptions } from './job-library-collection-service';

function Invalid(message: string): Error { return Object.assign(new Error(message), { code: 'INVALID_TOOL_ARGUMENTS' }); }
/** 截断UTF-16字符串时保留完整字符，避免把emoji等字符拆到两次工具回执中。 */
function Prefix(text: string, length: number): string {
  const end = Math.min(length, text.length), last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** Agent和页面共享采集服务，浏览器执行器按调用冻结；不重置正在运行的Agent/Cron授权。 */
export function CreateAgentJobLibrary(input: {
  collection: JobLibraryCollectionService;
  collectBoss: JobLibraryCollectionOptions['collectBoss'];
  withBrowser?: JobLibraryCollectionOptions['withBrowser'];
  query: (query: JobQueryInput) => Promise<JobQueryResult>;
}): JobLibraryPort {
  return {
    async Collect({ request, idempotencyKey, signal, deadline, reconcileOnly }) {
      const task = await input.collection.CollectAndWait(request, { idempotencyKey, signal, deadline, reconcileOnly, collectBoss: input.collectBoss, withBrowser: input.withBrowser });
      if (task.status === 'running') throw new Error('Job collection did not settle.');
      return {
        taskId: task.taskId, status: task.status, requestedCount: task.request.targetCount,
        ...(task.discovery ? { discovery: task.discovery } : {}),
        collected: task.collected, inserted: task.inserted, existing: task.existing, failedWrites: task.failedWrites,
        scanned: task.scanned, skippedDeleted: task.skippedDeleted,
        warnings: task.warnings.slice(0, 20).map((warning) => warning.length > 500 ? `${warning.slice(0, 500)}…[truncated]` : warning),
        sourceCount: task.sources.length, warningCount: task.warnings.length,
        coverage: { examined: task.sources.filter(source => source.status !== 'pending').length, failed: task.sources.filter(source => source.status === 'failed').length, notRun: task.sources.filter(source => source.status === 'pending').length, browserAssisted: task.sources.filter(source => source.browserAssisted).length },
        truncated: task.sources.length > 20 || task.warnings.length > 20 || task.warnings.some((warning) => warning.length > 500),
        sources: task.sources.slice(0, 20).map(({ sourceId, company, status, received, error }) => ({ sourceId, company, status, received, ...(error ? { error } : {}) })),
      };
    },
    async Read({ jobId, channel, keyword, maxResults = JobLibraryReadLimits.defaultCount, cursor, detailLevel = jobId ? 'detail' : 'brief', ...filters }) {
      if (jobId && (channel || keyword || Object.keys(filters).length)) throw Invalid('Read one jobId separately from list filters.');
      if (!['count', 'brief', 'summary', 'detail'].includes(detailLevel) || (detailLevel === 'detail' && !jobId) || (jobId && detailLevel !== 'detail')) throw Invalid('detail requires jobId; count, brief and summary use list filters.');
      if (detailLevel === 'count' && cursor) throw Invalid('count does not accept a cursor.');
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > JobLibraryReadLimits.maxCount) throw Invalid(`maxResults must be from 1 to ${JobLibraryReadLimits.maxCount}.`);
      const query = ParseJobQuery({ ...filters, ...(jobId ? { jobId } : {}), keyword, channels: channel ? [channel] : [], pageSize: jobId || detailLevel === 'count' ? 1 : maxResults });
      const hash = createHash('sha256').update(JSON.stringify([query, detailLevel, maxResults])).digest('hex');
      let offset = 0, contentHash: string | undefined;
      if (cursor) {
        try {
          const token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (token.hash !== hash || !Number.isSafeInteger(token.offset) || token.offset < 1 || token.offset > 100000000) throw Invalid('Invalid cursor.');
          offset = token.offset; contentHash = token.contentHash;
          if (!jobId) query.page = Math.floor(offset / maxResults) + 1;
        } catch { throw Invalid('The cursor is invalid or belongs to different filters. Keep the original filters, detailLevel and maxResults.'); }
      }
      const result = await input.query(query);
      if (detailLevel === 'count') return { mode: 'count', total: result.total, items: [], hasMore: false, nextCursor: null, truncated: false };
      // UI查询会将越界页收敛到末页，Agent游标则返回空页，避免删除数据后重复读取末页。
      const rows = result.page === query.page ? result.items.slice(jobId ? 0 : offset % maxResults) : [];
      const items: Array<Record<string, unknown>> = [];
      let detailHash: string | undefined, nextOffset = offset;
      for (const job of rows) {
        const truncatedFields: string[] = [];
        const Text = (field: string, value: unknown, limit: number) => {
          const text = typeof value === 'string' ? value : '';
          if (text.length > limit) truncatedFields.push(field);
          return Prefix(text, limit);
        };
        const tracking = job as typeof job & { contactStatus?: string; applicationStatuses?: string[] };
        const brief = {
          jobId: job.id, title: Text('title', job.title, 200), company: Text('company', job.company, 120), channel: job.channel,
          city: Text('city', job.city, 100), salary: Text('salary', job.salary, 60),
          experience: Text('experience', job.experience, 100), education: Text('education', job.education, 100), jobSeekingType: job.jobSeekingType,
          matchScore: job.matchScore,
        };
        let detail: Record<string, unknown> = {};
        if (detailLevel !== 'brief') {
          const jd = typeof job.jd === 'string' ? job.jd : '';
          if (jobId) {
            detailHash = createHash('sha256').update(jd).digest('hex');
            if (cursor && contentHash !== detailHash) throw Invalid('Job details changed; read this jobId again without a cursor.');
            if (offset > jd.length) throw Invalid('Invalid detail cursor.');
            const part = Prefix(jd.slice(offset), JobLibraryReadLimits.detailJdChars);
            nextOffset = offset + part.length;
            detail = { jd: part, jdOffset: offset, jdTotalChars: jd.length };
            if (nextOffset < jd.length) truncatedFields.push('jd');
          } else detail = { jd: Text('jd', jd, JobLibraryReadLimits.summaryJdChars) };
          detail = { ...detail, url: Text('url', job.url, 2048), companySize: Text('companySize', job.companySize, 100),
            contactStatus: Text('contactStatus', tracking.contactStatus ?? 'not_contacted', 100), applicationStatuses: (tracking.applicationStatuses ?? []).slice(0, 20).map((value) => Text('applicationStatuses', value, 100)) };
        }
        const item: Record<string, unknown> = { ...brief, ...detail, truncatedFields };
        // JSON转义会膨胀长度；单条超限时缩短占用最大的可截断字段，正文仍通过游标完整续读。
        while (!items.length && JSON.stringify(item).length > JobLibraryReadLimits.responseChars - 1000) {
          const field = ['jd', 'url', 'applicationStatuses', 'title', 'company', 'city', 'experience', 'education', 'salary', 'companySize', 'contactStatus']
            .filter((field) => typeof item[field] === 'string' ? String(item[field]).length > 1 : Array.isArray(item[field]) && item[field].length > 0)
            .sort((a, b) => JSON.stringify(item[b]).length - JSON.stringify(item[a]).length)[0];
          if (!field) throw Invalid('Job metadata exceeds the response budget.');
          const value = item[field];
          item[field] = typeof value === 'string' ? Prefix(value, Math.floor(value.length * 0.8)) : (value as unknown[]).slice(0, -1);
          if (!truncatedFields.includes(field)) truncatedFields.push(field);
        }
        if (jobId) nextOffset = offset + String(item.jd ?? '').length;
        // 按实际发出的条数推进游标；字符预算截断一页时，剩余条目必须在下一次返回。
        if (JSON.stringify([...items, item]).length > JobLibraryReadLimits.responseChars - 1000) break;
        items.push(item);
        if (!jobId) nextOffset++;
      }
      const hasMore = items.length > 0 && (jobId ? nextOffset < Number(items[0].jdTotalChars) : nextOffset < result.total);
      return { mode: jobId ? 'detail' : 'list', detailLevel, items, total: result.total, hasMore,
        remaining: jobId ? Math.max(0, Number(items[0]?.jdTotalChars ?? 0) - nextOffset) : Math.max(0, result.total - nextOffset),
        nextCursor: hasMore ? Buffer.from(JSON.stringify({ hash, offset: nextOffset, ...(jobId ? { contentHash: detailHash } : {}) })).toString('base64url') : null,
        truncated: items.some((job) => (job.truncatedFields as string[]).length > 0) || items.length < rows.length };
    },
  };
}
