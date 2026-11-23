import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CreateObservabilityStoreClient } from '../../../apps/backend/src/infra/observability-store-client';
import { EvalService } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';

const config = { executionProvider: 'DeepSeek' as const, executionModel: 'deepseek-v4-flash', judgeProvider: 'DeepSeek' as const, judgeModel: 'deepseek-v4-pro', candidates: [{ id: 'a', name: 'A', promptOverrides: {} }], userSimulator: 'approve_valid' as const, maxModelTurns: 4, repeatCount: 3 };
const testCase = { id: 'case', category: '简历', input: { userMessage: '测试回答' }, fixtures: {}, tags: [], expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' } };

describe('真实 Worker 的排队、中止与恢复', () => {
  it('Run 创建原子规划所有 repeat，重启后 queued 为未执行、running 为失败且汇总一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-recovery-'));
    const open = async () => { const store = CreateObservabilityStoreClient({ userDataPath: root, workerPath: resolve('apps/backend/dist/workers/observability-worker.js') }); await store.ready; return store; };
    let store = await open();
    try {
      await store.CreateEvalRunRecord({ id: 'interrupted', projectId: 'project', projectName: '恢复', runnerType: 'prompt', status: 'running', snapshotHash: 'synthetic', snapshot: { cases: [testCase], config }, createdAt: 10 });
      const rows = await store.ListEvalCaseRunRecords('interrupted');
      expect(rows).toHaveLength(3);
      await store.UpsertEvalCaseRunRecord({ ...rows[0], status: 'running' });
      await store.UpsertEvalCaseRunRecord({ ...rows[1], status: 'completed', score: { totalScore: 80 }, metrics: { taskCompleted: true } });
      await store.Close(); store.close(); store = await open();
      expect(await store.RecoverInterruptedEvalRuns()).toEqual({ recovered: 1 });
      expect((await store.ListEvalCaseRunRecords('interrupted')).map((row: any) => row.status)).toEqual(['failed', 'completed', 'not_run']);
      expect((await store.ReadEvalRunRecord('interrupted')).summary).toMatchObject({ totalCaseRuns: 3, completedCaseRuns: 1, failedCaseRuns: 1, notRunCaseRuns: 1, taskCompletionRate: 1 });
      expect(await store.RecoverInterruptedEvalRuns()).toEqual({ recovered: 0 });
    } finally { await store.Close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); }
  });

  it('排队取消保留完整未执行题数；运行中取消区分已启动和未启动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-cancel-count-'));
    const store = CreateObservabilityStoreClient({ userDataPath: root, workerPath: resolve('apps/backend/dist/workers/observability-worker.js') }); await store.ready;
    let started = 0;
    const execute = vi.fn(async (input: any) => {
      started++;
      await new Promise<void>(done => { if (input.signal.aborted) done(); else input.signal.addEventListener('abort', () => done(), { once: true }); });
      throw Object.assign(new Error('cancel'), { code: 'CANCELLED' });
    });
    const service = new EvalService({ userDataPath: root, store, credentialPort: EvaluationTestCredentials(), getStoredSettings: async () => ({ developerMode: true }), Emit() {}, promptRunner: { Execute: execute } as any });
    try {
      await service.Initialize();
      let project = await service.CreateProject({ name: '停止计数', runnerType: 'prompt', rubric: '评分', config });
      await service.ImportDataset(project.id, JSON.stringify(testCase), project.rubric, project.revision);
      project = await service.ReadProject(project.id);
      const first = await service.StartRun(project.id);
      const queued = await service.StartRun(project.id);
      await service.CancelRun(queued.id);
      const queuedDetail = await service.ReadRun(queued.id);
      expect(queuedDetail.summary).toMatchObject({ totalCaseRuns: 3, notRunCaseRuns: 3, cancelledCaseRuns: 0, taskCompletionRate: null });
      expect(queuedDetail.caseRuns.every(item => item.status === 'not_run')).toBe(true);
      for (let attempt = 0; attempt < 300 && started < 2; attempt++) await new Promise(done => setTimeout(done, 5));
      expect(started).toBe(2);
      await service.CancelRun(first.id);
      let detail = await service.ReadRun(first.id);
      for (let attempt = 0; attempt < 300 && detail.status !== 'cancelled'; attempt++) { await new Promise(done => setTimeout(done, 5)); detail = await service.ReadRun(first.id); }
      expect(detail.summary).toMatchObject({ totalCaseRuns: 3, cancelledCaseRuns: 2, notRunCaseRuns: 1, taskCompletionRate: null });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally { await service.Close(); await store.Close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); }
  });
});
