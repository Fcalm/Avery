import { createHash } from 'node:crypto';
import type { JobLibraryPort } from '@avery/agent-sdk';
import { JobLibraryReadLimits } from '@avery/agent-sdk';
import { ParseJobQuery, type JobQueryInput, type JobQueryResult } from '@avery/contracts';
import type { JobLibraryCollectionService, JobLibraryCollectionOptions } from './job-library-collection-service';

function Invalid(message: string): Error { return Object.assign(new Error(message), { code: 'INVALID_TOOL_ARGUMENTS' }); }

/** Agent和页面共享采集服务，浏览器执行器按调用冻结；不重置正在运行的Agent/Cron授权。 */
export function CreateAgentJobLibrary(input: {
  collection: JobLibraryCollectionService;
  collectBoss: JobLibraryCollectionOptions['collectBoss'];
  query: (query: JobQueryInput) => Promise<JobQueryResult>;
}): JobLibraryPort {
  return {
    async Collect({ request, idempotencyKey, signal, deadline, reconcileOnly }) {
      const task = await input.collection.CollectAndWait(request, { idempotencyKey, signal, deadline, reconcileOnly, collectBoss: input.collectBoss });
      if (task.status === 'running') throw new Error('Job collection did not settle.');
      return {
        taskId: task.taskId, status: task.status, requestedCount: task.request.targetCount,
        collected: task.collected, inserted: task.inserted, existing: task.existing, failedWrites: task.failedWrites,
        scanned: task.scanned, skippedDeleted: task.skippedDeleted,
        warnings: task.warnings.slice(0, 20).map((warning) => warning.length > 500 ? `${warning.slice(0, 500)}…[truncated]` : warning),
        sourceCount: task.sources.length, warningCount: task.warnings.length,
        truncated: task.sources.length > 20 || task.warnings.length > 20 || task.warnings.some((warning) => warning.length > 500),
        sources: task.sources.slice(0, 20).map(({ sourceId, company, status, received, error }) => ({ sourceId, company, status, received, ...(error ? { error } : {}) })),
      };
    },
    async Read({ jobId, channel, keyword, maxResults = JobLibraryReadLimits.defaultCount, cursor, ...filters }) {
      if (jobId && (cursor || channel || keyword || Object.keys(filters).length)) throw Invalid('Read one jobId separately from list filters and cursor.');
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > JobLibraryReadLimits.maxCount) throw Invalid(`maxResults must be from 1 to ${JobLibraryReadLimits.maxCount}.`);
      const query = ParseJobQuery({ ...filters, ...(jobId ? { jobId } : {}), keyword, channels: channel ? [channel] : [], pageSize: jobId ? 1 : maxResults });
      const hash = createHash('sha256').update(JSON.stringify(query)).digest('hex');
      if (cursor) {
        try {
          const token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (token.hash !== hash || !Number.isInteger(token.page) || token.page < 2 || token.page > 1000000) throw Invalid('Invalid cursor.');
          query.page = token.page;
        } catch { throw Invalid('The cursor is invalid or belongs to different filters. Keep the original filters and maxResults.'); }
      }
      const result = await input.query(query);
      // UI查询会将越界页收敛到末页，Agent游标则返回空页，避免删除数据后重复读取末页。
      const rows = result.page === query.page ? result.items : [];
      const items = rows.map((job) => {
        const truncatedFields: string[] = [];
        const Text = (field: string, value: unknown, limit: number) => {
          const text = typeof value === 'string' ? value : '';
          if (text.length > limit) truncatedFields.push(field);
          return text.slice(0, limit);
        };
        const tracking = job as typeof job & { contactStatus?: string; applicationStatuses?: string[] };
        return {
          jobId: job.id, title: Text('title', job.title, 300), company: Text('company', job.company, 200), channel: job.channel,
          city: Text('city', job.city, 100), salary: Text('salary', job.salary, 100), url: Text('url', job.url, 2048),
          experience: Text('experience', job.experience, 100), education: Text('education', job.education, 100), jobSeekingType: job.jobSeekingType,
          companySize: Text('companySize', job.companySize, 100),
          matchScore: job.matchScore, contactStatus: tracking.contactStatus ?? 'not_contacted', applicationStatuses: tracking.applicationStatuses ?? [],
          jd: Text('jd', job.jd, jobId ? JobLibraryReadLimits.detailJdChars : JobLibraryReadLimits.summaryJdChars), truncatedFields,
        };
      });
      const hasMore = !jobId && rows.length > 0 && result.page < result.pageCount;
      return { mode: jobId ? 'detail' : 'list', items, total: result.total, hasMore,
        nextCursor: hasMore ? Buffer.from(JSON.stringify({ hash, page: query.page + 1 })).toString('base64url') : null,
        truncated: items.some((job) => job.truncatedFields.length > 0) };
    },
  };
}
