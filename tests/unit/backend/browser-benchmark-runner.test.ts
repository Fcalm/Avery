import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ failure: false, sent: [] as any[], runtimes: [] as any[] }));
vi.mock('../../../apps/backend/src/electron/backend/agent-browser-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../apps/backend/src/electron/backend/agent-browser-runtime')>();
  return { ...actual, AgentBrowserRuntime: class {
    options: any;
    constructor(options: any) { this.options = options; state.runtimes.push(this); }
    async SetEngine() {}
    async FlushLocalEvaluationPage() {}
    async Close() {}
  } };
});
vi.mock('../../../apps/backend/src/electron/backend/agent-host', () => ({ AgentHost: class {
  options: any;
  constructor(options: any) { this.options = options; }
  async Send(input: any) {
    state.sent.push(input);
    if (state.failure) throw new Error('模拟模型请求失败');
    const match = input.content.match(/http:\/\/127\.0\.0\.1:\d+\/runs\/[0-9a-f-]+\/#access=[A-Za-z0-9_-]+/);
    if (!match) throw new Error('未收到完整单轮 URL');
    const url = new URL(match[0]);
    const endpoint = url.origin + '/api/runs/' + url.pathname.split('/')[2];
    const headers = { Authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
    const filePath = await this.options.browserRuntime.options.resolveUploadFile(input.attachments[0].path);
    const bytes = await readFile(filePath);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await this.options.browserRuntime.options.normalizeNavigationUrl(url.toString())).toContain('#access=');
    const { createScenario } = await import('@avery/application-benchmark/scenarios');
    const uploaded = await (await fetch(endpoint + '/files/resume', { method: 'POST', headers, body: JSON.stringify({ name: input.attachments[0].name, base64: bytes.toString('base64') }) })).json() as { revision: number };
    const response = await fetch(endpoint + '/state', { method: 'PUT', headers, body: JSON.stringify({ revision: uploaded.revision, state: createScenario('baseline', 'fill', 1).expected }) });
    expect(response.status).toBe(200);
    this.options.observability.RecordTraceUsage('test', { promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedInputTokens: 100 });
    this.options.Emit({ type: 'completed', content: '已保存，未提交。' });
  }
  Cancel() {}
  async Close() { await this.options.browserRuntime.Close(); }
} }));
import { BrowserEvalRunner } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-runner';
import { BuildApplicationBenchmarkDataset } from '../../../apps/backend/src/electron/backend/evaluation/career-portal-fixture';
import { ParseEvalDataset } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';

async function input(signal = new AbortController().signal) {
  const base = process.env.AVERY_TEST_OUTPUT_ROOT ?? tmpdir(); await mkdir(base, { recursive: true });
  const caseRoot = await mkdtemp(join(base, 'avery-runner-'));
  return { runId: 'run-a', caseRunId: 'case-a', candidate: { id: 'a', name: 'A', promptOverrides: {} }, testCase: ParseEvalDataset(BuildApplicationBenchmarkDataset())[0], model: 'mimo-v2.6-flash', toolNames: ['BrowserRunScript', 'BrowserNavigate', 'BrowserFillForm'], maxModelTurns: 100, userSimulator: 'approve_valid' as const, fixtureBranch: 'career-portal' as const, browserEngine: 'chrome' as const, caseRoot, signal };
}
describe('BrowserEvalRunner 拟真平台编排', () => {
  it('现有 Runner 注入合成资料和二进制附件，保留令牌片段，返回业务成绩及实际 usage', async () => {
    state.failure = false; state.sent = []; state.runtimes = [];
    const runner = new BrowserEvalRunner({ credentialPort: {}, browserExtensionBridge: {} as any, externalBrowserPaths: {} });
    const result = await runner.Execute(await input());
    expect(result.finalState).toMatchObject({ benchmark: { report: { passed: true, fieldAccuracy: 100 } } });
    expect(result.metrics).toMatchObject({ promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedTokens: 100, taskCompleted: true });
    expect(state.sent).toHaveLength(1); expect(state.sent[0].content).not.toContain('controller-token');
    const url = state.sent[0].content.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    await expect(fetch(url + '/api/health')).rejects.toThrow();
  });
  it('已取消的案例不发模型请求，留存取消证据并清理活动资料', async () => {
    state.sent = []; const controller = new AbortController(); controller.abort();
    const task = await input(controller.signal);
    const runner = new BrowserEvalRunner({ credentialPort: {}, browserExtensionBridge: {} as any, externalBrowserPaths: {} });
    await expect(runner.Execute(task)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(state.sent).toHaveLength(0);
    const files = await readdir(join(task.caseRoot, 'benchmark-control', 'results'));
    const result = JSON.parse(await readFile(join(task.caseRoot, 'benchmark-control', 'results', files[0]), 'utf8'));
    expect(result.payload.report.outcome).toBe('environment_failure');
    expect(await readdir(join(task.caseRoot, 'benchmark-control', 'runs'))).toEqual([]);
  });
  it('模型异常保留轨迹，归为 Agent 失败并结束轮次', async () => {
    state.failure = true;
    const task = await input();
    const runner = new BrowserEvalRunner({ credentialPort: {}, browserExtensionBridge: {} as any, externalBrowserPaths: {} });
    try {
      await expect(runner.Execute(task)).rejects.toMatchObject({ evalEvidence: expect.objectContaining({ events: expect.any(Array) }) });
      const files = await readdir(join(task.caseRoot, 'benchmark-control', 'results'));
      const result = JSON.parse(await readFile(join(task.caseRoot, 'benchmark-control', 'results', files[0]), 'utf8'));
      expect(result.payload.report.outcome).toBe('agent_failure');
    } finally { state.failure = false; }
  });
});
