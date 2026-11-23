import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';
import { EvalService } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { EvalArtifactStore } from '../../../apps/backend/src/electron/backend/evaluation/eval-artifact-store';
import { CreateBackend, ReadOnlyChannels } from '../../../apps/backend/src/router';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const config = { executionProvider: 'DeepSeek' as const, executionModel: 'deepseek-v4-flash', judgeProvider: 'DeepSeek' as const, judgeModel: 'deepseek-v4-pro', candidates: [{ id: 'a', name: 'A', promptOverrides: {} }], toolNames: ['ReadResume'], userSimulator: 'approve_valid' as const, maxModelTurns: 5, repeatCount: 1 };
const base = { id: 'case-1', category: '简历', input: { userMessage: '读取资料后回答' }, fixtures: {}, expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' }, tags: [] };
const browserCase = { ...base, browser: { fixtureVersion: '2', assertions: [{ id: 'no-submit', type: 'state_equals', path: 'fixture.submissionCount', expected: 0, weight: 100 }] } };

async function Fixture(mode: 'prompt' | 'browser' | 'career-portal' = 'prompt', enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'avery-dataset-management-'));
  const store = new ObservabilityStore(root);
  const execute = vi.fn();
  const service = new EvalService({ userDataPath: root, store, credentialPort: EvaluationTestCredentials(), getStoredSettings: async () => ({ developerMode: enabled }), Emit() {}, promptRunner: { Execute: execute } as any, browserRunner: { Execute: execute } as any });
  cleanup.push(async () => { await service.Close(); store.Close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await service.Initialize();
  const project = enabled ? await service.CreateProject({ name: '数据集预检', rubric: '依据资料回答', runnerType: mode === 'prompt' ? 'prompt' : 'browser', config: { ...config, ...(mode === 'prompt' ? {} : { toolNames: ['BrowserNavigate', 'BrowserSnapshot'], fixtureBranch: mode === 'browser' ? 'clean' : 'career-portal' }) } }) : null;
  return { root, store, service, project: project!, execute };
}

describe('测试集预检与模式边界', () => {
  it.each(['prompt', 'browser', 'career-portal'] as const)('%s 的模板可原样预检和导入，预检不写文件或改 revision', async mode => {
    const { root, service, project } = await Fixture(mode);
    const before = await service.ReadProject(project.id);
    const blank = await service.PreviewDatasetImport(project.id, '');
    expect(blank.valid).toBe(false);
    expect(blank.environment).toBe(mode);
    const preview = await service.PreviewDatasetImport(project.id, blank.templateJsonl);
    expect(preview).toMatchObject({ valid: true, diagnostics: [] });
    expect(await service.ReadProject(project.id)).toEqual(before);
    if (mode !== 'career-portal') await expect(readdir(join(root, 'evaluation-data', 'datasets'))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.ImportDataset(project.id, preview.templateJsonl, project.rubric, before.revision);
    expect((await service.ReadProject(project.id)).datasetCaseCount).toBe(preview.caseCount);
    expect(await service.ValidateProject(project.id)).toMatchObject({ valid: true });
  });

  it('12 道旧版题逐行给出真实声明、要求与修正指引，导入不产生新登记', async () => {
    const { service, project } = await Fixture('browser');
    const jsonl = '\n' + Array.from({ length: 12 }, (_, index) => JSON.stringify({ ...browserCase, id: `asr-${String(index + 1).padStart(3, '0')}`, browser: { ...browserCase.browser, fixtureVersion: '1' } })).join('\n');
    const preview = await service.PreviewDatasetImport(project.id, jsonl);
    expect(preview).toMatchObject({ valid: false, caseCount: 12, expectedFixtureVersion: '2' });
    expect(preview.diagnostics).toHaveLength(12);
    expect(preview.diagnostics[0]).toMatchObject({ line: 2, caseId: 'asr-001', declaredVersion: '1', expectedVersion: '2', code: 'FIXTURE_VERSION_UNSUPPORTED' });
    expect(preview.diagnostics.at(-1)).toMatchObject({ line: 13, caseId: 'asr-012' });
    expect(preview.diagnostics.every(item => item.action.includes('不能仅改版本号'))).toBe(true);
    await expect(service.ImportDataset(project.id, jsonl, project.rubric, project.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { preview } });
    expect(await service.ListDatasetVersions(project.id)).toEqual([]);
    expect(await service.ReadProject(project.id)).toEqual(project);
  });

  it('缺失 Fixture 版本不能绕过校验，畸形或重复 JSONL 保留准确行号', async () => {
    const { service, project } = await Fixture('browser');
    const missing = await service.PreviewDatasetImport(project.id, JSON.stringify({ ...browserCase, browser: { assertions: browserCase.browser.assertions } }));
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'FIXTURE_VERSION_UNSUPPORTED', declaredVersion: null }));
    for (const jsonl of [`\n${JSON.stringify(browserCase)}\n{bad`, `${JSON.stringify(browserCase)}\n\n${JSON.stringify(browserCase)}`]) {
      expect((await service.PreviewDatasetImport(project.id, jsonl)).diagnostics[0]).toMatchObject({ line: 3, code: 'DATASET_SCHEMA_INVALID' });
    }
    const malformed = await service.PreviewDatasetImport(project.id, JSON.stringify({ ...browserCase, input: {} }));
    expect(malformed.diagnostics[0].action).toContain('input.userMessage');
  });

  it('普通浏览器与拟真网申环境相互错配时立即拒绝，错误显示各自真实版本', async () => {
    const ordinary = await Fixture('browser');
    const portal = await Fixture('career-portal');
    const portalJsonl = (await portal.service.PreviewDatasetImport(portal.project.id, '')).templateJsonl;
    for (const [fixture, jsonl] of [[ordinary, portalJsonl], [portal, JSON.stringify(browserCase)]] as const) {
      const preview = await fixture.service.PreviewDatasetImport(fixture.project.id, jsonl);
      expect(preview.valid).toBe(false);
      expect(preview.diagnostics.some(item => item.code === 'FIXTURE_ENVIRONMENT_MISMATCH')).toBe(true);
      expect(preview.expectedFixtureVersion).toBe(fixture === ordinary ? '2' : 'career-portal-2');
      await expect(fixture.service.ImportDataset(fixture.project.id, jsonl, fixture.project.rubric, fixture.project.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('Prompt 与浏览器案例相互错配时拒绝；历史错配版本也不能选用或开始', async () => {
    const prompt = await Fixture();
    const browser = await Fixture('browser');
    await expect(prompt.service.ImportDataset(prompt.project.id, JSON.stringify(browserCase), prompt.project.rubric, prompt.project.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(browser.service.ImportDataset(browser.project.id, JSON.stringify(base), browser.project.rubric, browser.project.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const version = 'a'.repeat(64);
    const artifact = new EvalArtifactStore(prompt.root);
    const key = await artifact.WriteDataset(prompt.project.id, version, JSON.stringify(browserCase));
    const record = prompt.store.ImportEvalDatasetRecord(prompt.project.id, key, prompt.project.rubric, version, 1, '旧错配', prompt.project.revision, Date.now());
    expect(await prompt.service.ValidateProject(prompt.project.id)).toMatchObject({ valid: false });
    await expect(prompt.service.StartRun(prompt.project.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(prompt.service.SelectDatasetVersion(prompt.project.id, version, record.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prompt.execute).not.toHaveBeenCalled();
  });

  it('预检有开发者门禁，读取通道正确转发且拒绝非法参数', async () => {
    const { service } = await Fixture('prompt', false);
    await expect(service.PreviewDatasetImport('project', '{}')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const PreviewDatasetImport = vi.fn(async () => ({ valid: true }));
    const backend = CreateBackend({ container: { evaluation: { PreviewDatasetImport } } });
    expect(ReadOnlyChannels.has('evaluation:dataset-preview')).toBe(true);
    expect(await backend.HandleCommand('evaluation:dataset-preview', 'request', undefined, 'project', '{}')).toMatchObject({ ok: true });
    expect(PreviewDatasetImport).toHaveBeenCalledWith('project', '{}');
    expect(await backend.HandleCommand('evaluation:dataset-preview', 'bad-request', undefined, 'project', 42)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('预检后模式改变仍重新校验，不能沿用已通过的预检导入错误题库', async () => {
    const { service, project } = await Fixture();
    expect((await service.PreviewDatasetImport(project.id, JSON.stringify(base))).valid).toBe(true);
    const updated = await service.UpdateProject(project.id, { name: project.name, runnerType: 'browser', rubric: '', config: { ...config, fixtureBranch: 'clean', toolNames: ['BrowserNavigate'] } }, project.revision);
    await expect(service.ImportDataset(updated.id, JSON.stringify(base), '', updated.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { preview: { diagnostics: [expect.objectContaining({ code: 'CASE_MODE_MISMATCH' })] } } });
    expect(await service.ListDatasetVersions(project.id)).toEqual([]);
  });

  it('导入登记或删除清理任务插入失败时，整个数据库事务回滚且文件不被删除', async () => {
    const { root, service, store, project } = await Fixture();
    store.db.exec("CREATE TRIGGER audit_reject_import BEFORE INSERT ON evaluation_dataset_versions BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END;");
    await expect(service.ImportDataset(project.id, JSON.stringify(base), project.rubric, project.revision)).rejects.toThrow('synthetic import failure');
    expect(await service.ReadProject(project.id)).toEqual(project);
    expect(await service.ListDatasetVersions(project.id)).toEqual([]);
    store.db.exec('DROP TRIGGER audit_reject_import');
    await service.ImportDataset(project.id, JSON.stringify(base), project.rubric, project.revision);
    const saved = await service.ReadProject(project.id);
    const path = join(root, 'evaluation-data', 'datasets', saved.id, `${saved.datasetVersion}.jsonl`);
    const before = await readFile(path, 'utf8');
    store.db.exec("CREATE TRIGGER audit_reject_delete BEFORE INSERT ON evaluation_dataset_cleanup BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;");
    await expect(service.DeleteDatasetVersion(saved.id, saved.datasetVersion!, saved.revision)).rejects.toThrow('synthetic delete failure');
    expect(await service.ReadProject(project.id)).toEqual(saved);
    expect(await service.ListDatasetVersions(project.id)).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
