import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvalService } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { EvalArtifactStore } from '../../../apps/backend/src/electron/backend/evaluation/eval-artifact-store';
import { CreateObservabilityStoreClient } from '../../../apps/backend/src/infra/observability-store-client';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const input = {
  name: '数据集回归', runnerType: 'prompt' as const, rubric: '依据资料回答',
  config: { executionProvider: 'DeepSeek' as const, executionModel: 'deepseek-v4-flash', judgeProvider: 'DeepSeek' as const, judgeModel: 'deepseek-v4-pro', candidates: [{ id: 'a', name: 'A', promptOverrides: {} }], toolNames: ['ReadResume'], userSimulator: 'approve_valid' as const, maxModelTurns: 5, repeatCount: 1 },
};
const dataset = (id: string) => JSON.stringify({ id, category: '简历', input: { userMessage: '读取简历' }, fixtures: {}, expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' }, tags: [] });
const file = (root: string, project: string, version: string) => join(root, 'evaluation-data', 'datasets', project, `${version}.jsonl`);

async function Open(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'avery-eval-dataset-worker-'));
  if (!root) roots.push(directory);
  const store = CreateObservabilityStoreClient({ userDataPath: directory, workerPath: resolve('apps/backend/dist/workers/observability-worker.js') });
  await store.ready;
  const service = new EvalService({ userDataPath: directory, store, credentialPort: EvaluationTestCredentials(), getStoredSettings: async () => ({ developerMode: true }), Emit() {} });
  await service.Initialize();
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await service.Close(); try { await store.Close(); } finally { store.close(); } };
  closers.push(close);
  return { directory, store, service, close };
}

describe('测评数据集真实 DB Worker', () => {
  it('版本列表可跨进程克隆；重启、选版、删空和重导保留历史快照', async () => {
    let fixture = await Open();
    const root = fixture.directory;
    let project = await fixture.service.CreateProject(input);
    await fixture.service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    project = await fixture.service.ReadProject(project.id);
    const first = project.datasetVersion!;
    await fixture.store.CreateEvalRunRecord({ id: 'historical', projectId: project.id, projectName: project.name, runnerType: 'prompt', status: 'completed', snapshotHash: 'fixture', snapshot: { datasetVersion: first, cases: [JSON.parse(dataset('one'))] }, createdAt: Date.now() });
    await fixture.service.ImportDataset(project.id, dataset('two'), project.rubric, project.revision);
    project = await fixture.service.ReadProject(project.id);
    const second = project.datasetVersion!;
    const versions = await fixture.service.ListDatasetVersions(project.id);
    expect(structuredClone(versions)).toEqual(versions);
    expect(versions.find(row => row.version === first)?.runCount).toBe(1);
    expect(versions.every(row => typeof row.runCount === 'number')).toBe(true);
    await fixture.close();
    fixture = await Open(root);
    expect(await fixture.service.ListDatasetVersions(project.id)).toEqual(versions);
    project = await fixture.service.SelectDatasetVersion(project.id, first, project.revision);
    project = await fixture.service.DeleteDatasetVersion(project.id, first, project.revision);
    expect(project.datasetVersion).toBe(second);
    project = await fixture.service.DeleteDatasetVersion(project.id, second, project.revision);
    expect(project).toMatchObject({ datasetVersion: null, datasetCaseCount: 0 });
    expect((await fixture.store.ReadEvalProjectRecord(project.id)).datasetJsonl).toBe('');
    expect(await fixture.service.ListDatasetVersions(project.id)).toEqual([]);
    await expect(fixture.service.StartRun(project.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await fixture.close();
    fixture = await Open(root);
    expect((await fixture.service.ReadProject(project.id)).datasetVersion).toBeNull();
    await fixture.service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    expect((await fixture.service.ReadProject(project.id)).datasetVersion).toBe(first);
    expect((await fixture.service.ReadRun('historical')).snapshot).toEqual({ datasetVersion: first, cases: [JSON.parse(dataset('one'))] });
    expect(await fixture.service.ValidateProject(project.id)).toMatchObject({ valid: true });
  });

  it('当前和非当前版本的过期 revision 删除都不改变文件、登记和指针', async () => {
    const { directory, service } = await Open();
    let project = await service.CreateProject(input);
    await service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    const first = project.datasetVersion!;
    await service.ImportDataset(project.id, dataset('two'), project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    const before = await service.ListDatasetVersions(project.id);
    for (const version of [first, project.datasetVersion!]) {
      const bytes = await readFile(file(directory, project.id, version), 'utf8');
      await expect(service.DeleteDatasetVersion(project.id, version, project.revision - 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect(await readFile(file(directory, project.id, version), 'utf8')).toBe(bytes);
      expect(await service.ReadProject(project.id)).toEqual(project);
      expect(await service.ListDatasetVersions(project.id)).toEqual(before);
    }
  });

  it('同 revision 的并发导入和删除只提交一个，不产生悬空指针或孤立文件', async () => {
    const { directory, service, store } = await Open();
    let project = await service.CreateProject(input);
    await service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    const outcomes = await Promise.allSettled([
      service.ImportDataset(project.id, dataset('two'), project.rubric, project.revision),
      service.DeleteDatasetVersion(project.id, project.datasetVersion!, project.revision),
    ]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } });
    const current = await service.ReadProject(project.id);
    const versions = await service.ListDatasetVersions(project.id);
    expect(versions.some(row => row.version === current.datasetVersion)).toBe(true);
    for (const version of versions) expect((await stat(file(directory, project.id, version.version))).isFile()).toBe(true);
    await expect(service.ImportDataset(project.id, dataset('three'), project.rubric, project.revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await store.ListEvalDatasetCleanupRecords(project.id)).toEqual([]);
    expect(await service.ListDatasetVersions(project.id)).toEqual(versions);
  });

  it('删除文件失败不撤销元数据，重启会重试；重导同内容会撤销待删任务', async () => {
    let fixture = await Open();
    let project = await fixture.service.CreateProject(input);
    await fixture.service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    project = await fixture.service.ReadProject(project.id);
    const version = project.datasetVersion!;
    const failure = vi.spyOn(EvalArtifactStore.prototype, 'DeleteDataset').mockRejectedValue(new Error('synthetic locked file'));
    project = await fixture.service.DeleteDatasetVersion(project.id, version, project.revision);
    expect(project.datasetVersion).toBeNull();
    expect(await fixture.store.ListEvalDatasetCleanupRecords(project.id)).toHaveLength(1);
    await fixture.service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    project = await fixture.service.ReadProject(project.id);
    expect(await fixture.store.ListEvalDatasetCleanupRecords(project.id)).toEqual([]);
    expect((await stat(file(fixture.directory, project.id, version))).isFile()).toBe(true);
    await fixture.service.DeleteDatasetVersion(project.id, version, project.revision);
    expect(await fixture.store.ListEvalDatasetCleanupRecords(project.id)).toHaveLength(1);
    failure.mockRestore();
    const root = fixture.directory;
    await fixture.close();
    fixture = await Open(root);
    expect(await fixture.store.ListEvalDatasetCleanupRecords(project.id)).toEqual([]);
    await expect(stat(file(root, project.id, version))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('同内容重导不重复登记、不改变原导入时间，过期重导不删除被引用的文件', async () => {
    const { directory, service } = await Open();
    let project = await service.CreateProject(input);
    await service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    const before = await service.ListDatasetVersions(project.id);
    await service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision);
    const after = await service.ReadProject(project.id);
    expect(after.revision).toBe(project.revision + 1);
    await expect(service.ImportDataset(project.id, dataset('one'), project.rubric, project.revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await service.ListDatasetVersions(project.id)).toEqual(before);
    expect((await stat(file(directory, project.id, project.datasetVersion!))).isFile()).toBe(true);
  });

  it('落盘后尚未登记就退出的孤立文件在重启时清理', async () => {
    let fixture = await Open();
    const project = await fixture.service.CreateProject(input);
    const version = 'b'.repeat(64);
    await fixture.store.QueueEvalDatasetCleanupIfUnreferenced(project.id, version);
    await new EvalArtifactStore(fixture.directory).WriteDataset(project.id, version, dataset('interrupted'));
    const root = fixture.directory;
    await fixture.close();
    fixture = await Open(root);
    expect(await fixture.store.ListEvalDatasetCleanupRecords(project.id)).toEqual([]);
    expect(await fixture.service.ListDatasetVersions(project.id)).toEqual([]);
    await expect(stat(file(root, project.id, version))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
