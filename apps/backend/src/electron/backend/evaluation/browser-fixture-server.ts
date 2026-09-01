import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EvalFixtureJobs } from './fixture-jobs';

export interface EvalBrowserFixtureState {
  selectedJobId: string | null;
  submissionCount: number;
  duplicateSubmissionAttempts: number;
  submission: Record<string, unknown> | null;
  receipt: string | null;
  searchCount: number;
  lastFilters: Record<string, unknown> | null;
  viewedJobIds: string[];
  detailViewCount: number;
  applicationStarted: boolean;
}

async function ReadFixtureHtml(): Promise<string> {
  const candidates = [
    join(process.cwd(), 'apps', 'backend', 'src', 'electron', 'backend', 'evaluation', 'fixtures', 'application.html'),
    join(__dirname, '..', '..', '..', '..', 'src', 'electron', 'backend', 'evaluation', 'fixtures', 'application.html'),
  ];
  for (const candidate of candidates) {
    try { return await readFile(candidate, 'utf8'); } catch { /* 开发构建与打包目录依次尝试。 */ }
  }
  throw Object.assign(new Error('Evaluation browser fixture asset is unavailable.'), { code: 'FIXTURE_UNAVAILABLE' });
}

function SendJson(response: any, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function RenderFixtureHtml(source: string, branch: string | null, seedValue: string | null): string {
  const withJobs = source.replace('__EVAL_JOBS_JSON__', JSON.stringify(EvalFixtureJobs).replaceAll('<', '\\u003c'));
  if (branch === 'clean') return withJobs.replace('<!-- EVAL_NOISE_LEFT -->', '').replace('<!-- EVAL_NOISE_RIGHT -->', '');
  const parsedSeed = Number.parseInt(seedValue ?? '0', 10);
  const seed = Number.isSafeInteger(parsedSeed) ? Math.abs(parsedSeed) % 997 : 0;
  const distractions = ['人才社区', '职位订阅', '在线咨询', '员工故事', '招聘日历', '办公地点'];
  const ordered = distractions.map((label, index) => distractions[(index + seed) % distractions.length]);
  const left = ordered.slice(0, 3).map((label) => `<a href="#" data-eval-noise="${seed}">${label}</a>`).join('');
  const right = ordered.slice(3).map((label) => `<button type="button" data-eval-noise="${seed}">${label}</button>`).join('');
  return withJobs.replace('<!-- EVAL_NOISE_LEFT -->', left).replace('<!-- EVAL_NOISE_RIGHT -->', right);
}

function NonEmpty(value: unknown): boolean { return typeof value === 'string' && value.trim().length > 0; }

function HasCompleteApplication(value: Record<string, unknown>): boolean {
  const personal = value.personal as Record<string, unknown> | undefined;
  const education = value.education as Record<string, unknown> | undefined;
  const work = value.workExperience as Record<string, unknown> | undefined;
  const project = value.projectExperience as Record<string, unknown> | undefined;
  const preference = value.jobPreference as Record<string, unknown> | undefined;
  const files = value.files as Record<string, unknown> | undefined;
  return NonEmpty(value.jobId)
    && Boolean(personal && ['name', 'gender', 'birthDate', 'email', 'phone', 'idType', 'idNumber', 'graduationDate', 'yearsExperience', 'nationality', 'nativePlace', 'ethnicity', 'politicalStatus', 'residenceProvince', 'residenceCity', 'hukouProvince', 'hukouCity'].every((field) => NonEmpty(personal[field])))
    && Boolean(education && ['school', 'startDate', 'endDate', 'educationType', 'major', 'degreeLevel', 'degree'].every((field) => NonEmpty(education[field])))
    && Boolean(work && ['company', 'startDate', 'endDate', 'position', 'department', 'companyType', 'companySize', 'annualSalary', 'responsibilities'].every((field) => NonEmpty(work[field])))
    && Boolean(project && ['name', 'startDate', 'endDate', 'description', 'responsibilities'].every((field) => NonEmpty(project[field])))
    && Boolean(preference && ['province', 'city', 'jobFamily', 'jobTrack', 'expectedSalary', 'availability', 'source', 'workMode'].every((field) => NonEmpty(preference[field])))
    && Boolean(files && NonEmpty(files.resumeName) && NonEmpty(files.photoName))
    && value.terms === true;
}

/** 每个 Browser CaseRun 独占一个随机端口和内存状态，不能访问生产业务数据。 */
export async function StartEvalBrowserFixture(): Promise<{ origin: string; getState(): EvalBrowserFixtureState; close(): Promise<void> }> {
  const html = await ReadFixtureHtml();
  const state: EvalBrowserFixtureState = { selectedJobId: null, submissionCount: 0, duplicateSubmissionAttempts: 0, submission: null, receipt: null, searchCount: 0, lastFilters: null, viewedJobIds: [], detailViewCount: 0, applicationStarted: false };
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204, { 'cache-control': 'public, max-age=86400' }); response.end(); return;
    }
    if (request.method === 'GET' && (url.pathname === '/' || /^\/(?:jobs|apply)\/[A-Za-z0-9._-]+$/.test(url.pathname))) {
      const detailMatch = url.pathname.match(/^\/jobs\/([A-Za-z0-9._-]+)$/);
      if (detailMatch && state.searchCount > 0 && EvalFixtureJobs.some((job) => job.id === detailMatch[1])) {
        state.selectedJobId = detailMatch[1]; state.detailViewCount += 1;
        if (!state.viewedJobIds.includes(detailMatch[1])) state.viewedJobIds.push(detailMatch[1]);
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(RenderFixtureHtml(html, url.searchParams.get('branch'), url.searchParams.get('seed'))); return;
    }
    if (request.method === 'GET' && url.pathname === '/__eval/state') { SendJson(response, 200, state); return; }
    if (request.method === 'POST' && url.pathname === '/__eval/search') {
      let body = ''; for await (const chunk of request) body += chunk;
      try { state.lastFilters = JSON.parse(body); } catch { state.lastFilters = {}; }
      state.searchCount += 1; SendJson(response, 200, { searchCount: state.searchCount }); return;
    }
    if (request.method === 'POST' && url.pathname === '/__eval/select') {
      let body = ''; for await (const chunk of request) body += chunk;
      try {
        const value = JSON.parse(body); const jobId = typeof value?.jobId === 'string' ? value.jobId : null;
        state.selectedJobId = state.searchCount > 0 && jobId && EvalFixtureJobs.some((job) => job.id === jobId) ? jobId : null;
      } catch { state.selectedJobId = null; }
      SendJson(response, state.selectedJobId ? 200 : 409, { selectedJobId: state.selectedJobId, message: state.selectedJobId ? undefined : 'search the fixture before selecting a job' }); return;
    }
    if (request.method === 'POST' && url.pathname === '/__eval/application-start') {
      let body = ''; for await (const chunk of request) body += chunk;
      try { const value = JSON.parse(body); state.applicationStarted = state.detailViewCount > 0 && state.viewedJobIds.includes(String(value?.jobId ?? '')) && value?.jobId === state.selectedJobId; } catch { state.applicationStarted = false; }
      SendJson(response, state.applicationStarted ? 200 : 409, { applicationStarted: state.applicationStarted }); return;
    }
    if (request.method === 'POST' && url.pathname === '/__eval/submit') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 65_536) { SendJson(response, 413, { message: 'payload too large' }); return; }
      }
      let submission: Record<string, unknown>;
      try { submission = JSON.parse(body); } catch { SendJson(response, 400, { message: 'invalid json' }); return; }
      if (state.submissionCount > 0) { state.duplicateSubmissionAttempts += 1; SendJson(response, 409, { message: 'duplicate submission blocked', receipt: state.receipt }); return; }
      if (submission.jobId !== state.selectedJobId || !state.applicationStarted) { SendJson(response, 409, { message: 'application target was not selected through the expected flow' }); return; }
      if (!HasCompleteApplication(submission)) {
        SendJson(response, 422, { message: 'required application fields are missing' }); return;
      }
      state.submissionCount = 1; state.submission = submission; state.receipt = 'LOCAL-EVAL-APPLICATION-0001';
      SendJson(response, 200, { receipt: state.receipt }); return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Evaluation fixture did not bind a TCP port.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    getState: () => structuredClone(state),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
