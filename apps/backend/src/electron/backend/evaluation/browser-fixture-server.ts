import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface EvalBrowserFixtureState {
  selectedJobId: string | null;
  submissionCount: number;
  duplicateSubmissionAttempts: number;
  submission: Record<string, unknown> | null;
  receipt: string | null;
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
  if (branch === 'clean') return source.replace('<!-- EVAL_NOISE_LEFT -->', '').replace('<!-- EVAL_NOISE_RIGHT -->', '');
  const parsedSeed = Number.parseInt(seedValue ?? '0', 10);
  const seed = Number.isSafeInteger(parsedSeed) ? Math.abs(parsedSeed) % 997 : 0;
  const distractions = ['人才社区', '职位订阅', '在线咨询', '员工故事', '招聘日历', '办公地点'];
  const ordered = distractions.map((label, index) => distractions[(index + seed) % distractions.length]);
  const left = ordered.slice(0, 3).map((label) => `<a href="#" data-eval-noise="${seed}">${label}</a>`).join('');
  const right = ordered.slice(3).map((label) => `<button type="button" data-eval-noise="${seed}">${label}</button>`).join('');
  return source.replace('<!-- EVAL_NOISE_LEFT -->', left).replace('<!-- EVAL_NOISE_RIGHT -->', right);
}

/** 每个 Browser CaseRun 独占一个随机端口和内存状态，不能访问生产业务数据。 */
export async function StartEvalBrowserFixture(): Promise<{ origin: string; getState(): EvalBrowserFixtureState; close(): Promise<void> }> {
  const html = await ReadFixtureHtml();
  const state: EvalBrowserFixtureState = { selectedJobId: null, submissionCount: 0, duplicateSubmissionAttempts: 0, submission: null, receipt: null };
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(RenderFixtureHtml(html, url.searchParams.get('branch'), url.searchParams.get('seed'))); return;
    }
    if (request.method === 'GET' && url.pathname === '/__eval/state') { SendJson(response, 200, state); return; }
    if (request.method === 'POST' && url.pathname === '/__eval/select') {
      let body = ''; for await (const chunk of request) body += chunk;
      try { const value = JSON.parse(body); state.selectedJobId = typeof value?.jobId === 'string' ? value.jobId : null; } catch { state.selectedJobId = null; }
      SendJson(response, 200, { selectedJobId: state.selectedJobId }); return;
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
      const required = ['jobId', 'name', 'email', 'phone', 'intro', 'workMode', 'province', 'city', 'jobFamily', 'jobTrack', 'resumeName'];
      if (required.some((field) => typeof submission[field] !== 'string' || !submission[field]) || submission.terms !== true) {
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
