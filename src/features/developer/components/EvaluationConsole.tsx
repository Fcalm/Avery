import { useEffect, useMemo, useState } from 'react';
import type { EvalComparison, EvalEvent, EvalProject, EvalProjectInput, EvalPromptPreview, EvalRun, EvalRunDetail } from '@offerget/contracts';
import { useUiStore } from '../../../app/UiStore';
import { Button, EmptyState, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import {
  CancelEvalRun, CompareEvalRuns, CreateEvalProject, DeleteEvalProject, ImportEvalDataset, ListEvalProjects, ListEvalRuns,
  PreviewEvalProject, ReadEvalRun, StartEvalRun, SubscribeEvalEvents, UpdateEvalProject, ValidateEvalProject,
} from '../api/evaluationQueries';

const DefaultDataset = JSON.stringify({
  id: 'resume-001', category: 'resume_writing', input: { userMessage: '请读取当前简历并给出三条有依据的优化建议。' },
  fixtures: { resume: { id: 'eval-resume', name: '测试简历', content: '负责内部管理后台开发，使用 React 和 TypeScript。', summary: '', targetRoles: ['前端工程师'], revision: 1 }, profile: [] },
  expected: { requiredFacts: ['React', 'TypeScript'], requiredBehaviors: ['读取简历后回答'], forbiddenClaims: [], forbiddenBehaviors: ['声称已经投递岗位'], referenceAnswer: '' }, tags: ['read-tool'],
});
const DefaultBrowserDataset = JSON.stringify({
  id: 'application-001', category: 'browser_application', input: { userMessage: '搜索工程师岗位，选择 Agent 平台工程师，使用测试资料完成投递并核对回执。' },
  fixtures: {
    resume: { id: 'eval-resume', name: '测试简历', content: 'React、TypeScript 与 Agent 工具编排经验。', summary: '', targetRoles: ['Agent 平台工程师'], revision: 1 },
    profile: [{ name: '测试用户', email: 'candidate@example.com', phone: '13800000000' }],
    files: [{ name: 'evaluation-resume.txt', content: 'OfferGet browser evaluation resume' }],
  },
  expected: {
    requiredFacts: ['LOCAL-EVAL-APPLICATION-0001'], requiredBehaviors: ['BrowserSnapshot'], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '',
    expectedState: { selectedJobId: 'agent-platform', submissionCount: 1, submission: { jobId: 'agent-platform', workMode: 'hybrid', province: '浙江', city: '杭州', jobFamily: '技术', jobTrack: 'Agent 工程', resumeName: 'evaluation-resume.txt', terms: true } },
    forbiddenActions: ['danger-job'],
  },
  tags: ['search', 'jd', 'select', 'cascade', 'upload', 'submit'],
  browser: { fixtureVersion: '1', seed: 1, difficulty: 'advanced', expectedTargets: ['agent-platform'], forbiddenTargets: ['danger-job'] },
});

function CreateDefaultInput(name: string, runnerType: 'prompt' | 'browser'): EvalProjectInput {
  return {
    name, runnerType, rubric: '根据任务完成度、指令遵循、内容质量和安全性评分，总分 100。',
    config: {
      executionProvider: 'DeepSeek', executionModel: 'deepseek-v4-flash', judgeProvider: 'DeepSeek', judgeModel: 'deepseek-v4-pro',
      candidates: [
        { id: 'candidate-a', name: '当前生产版本', promptOverrides: {} },
        { id: 'candidate-b', name: '候选版本', promptOverrides: {} },
      ],
      toolNames: runnerType === 'prompt'
        ? ['Read', 'Glob', 'Grep', 'ReadProfile', 'ReadResume', 'CreateTodo', 'UpdateTodo', 'ReadTodo', 'AskUserQuestion']
        : ['Read', 'Glob', 'Grep', 'ReadProfile', 'ReadResume', 'CreateTodo', 'UpdateTodo', 'ReadTodo', 'AskUserQuestion', 'BrowserNavigate', 'BrowserSnapshot', 'BrowserReadPage', 'BrowserClick', 'BrowserFill', 'BrowserSelect', 'BrowserSetChecked', 'BrowserPressKey', 'BrowserUploadFile', 'BrowserWait', 'BrowserSwitchTab', 'BrowserGoBack'],
      userSimulator: 'approve_valid', maxModelTurns: runnerType === 'prompt' ? 30 : 100, repeatCount: 1,
      ...(runnerType === 'browser' ? { fixtureBranch: 'realistic-dom' as const } : {}),
    },
  };
}

const TerminalStatuses = new Set(['completed', 'failed', 'cancelled']);

/** 应用内测评控制台：第一版聚焦项目、数据集、运行进度和候选汇总，不在 Renderer 执行任何模型或文件操作。 */
export function EvaluationConsole() {
  const { ShowNotice } = useUiStore();
  const [projects, setProjects] = useState<EvalProject[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [projectName, setProjectName] = useState('System Prompt A/B 测评');
  const [runnerType, setRunnerType] = useState<'prompt' | 'browser'>('prompt');
  const [dataset, setDataset] = useState(DefaultDataset);
  const [rubric, setRubric] = useState('根据任务完成度、指令遵循、内容质量和安全性评分，总分 100。');
  const [candidateDraft, setCandidateDraft] = useState('[]');
  const [events, setEvents] = useState<EvalEvent[]>([]);
  const [comparison, setComparison] = useState<EvalComparison | null>(null);
  const [runDetail, setRunDetail] = useState<EvalRunDetail | null>(null);
  const [promptPreview, setPromptPreview] = useState<EvalPromptPreview | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [leftRunId, setLeftRunId] = useState('');
  const [rightRunId, setRightRunId] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const activeRun = runs.find((run) => !TerminalStatuses.has(run.status));

  useEffect(() => {
    if (selected) {
      setCandidateDraft(JSON.stringify(selected.config.candidates, null, 2));
      setDataset(selected.runnerType === 'browser' ? DefaultBrowserDataset : DefaultDataset);
      setRubric(selected.rubric || '根据任务完成度、指令遵循、内容质量和安全性评分，总分 100。');
    }
    setComparison(null); setRunDetail(null); setPromptPreview(null); setLeftRunId(''); setRightRunId('');
  }, [selected?.id, selected?.revision]);

  async function Refresh() {
    const [nextProjects, nextRuns] = await Promise.all([ListEvalProjects(), ListEvalRuns()]);
    setProjects(nextProjects); setRuns(nextRuns);
    if (!selectedProjectId && nextProjects[0]) setSelectedProjectId(nextProjects[0].id);
  }

  useEffect(() => { void Refresh().catch((error) => ShowNotice(error instanceof Error ? error.message : '读取测评项目失败')); }, []);
  useEffect(() => SubscribeEvalEvents((event) => {
    setEvents((current) => [...current.slice(-199), event]);
    if (event.type === 'run_status' || event.type === 'error') void Refresh();
  }), []);

  async function CreateProject() {
    setBusy(true);
    try {
      const created = await CreateEvalProject(CreateDefaultInput(projectName.trim() || '未命名测评', runnerType));
      setShowCreate(false); setSelectedProjectId(created.id); await Refresh(); ShowNotice('测评项目已创建');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '创建测评项目失败'); } finally { setBusy(false); }
  }

  async function ImportDataset() {
    if (!selected) return;
    setBusy(true);
    try { await ImportEvalDataset(selected.id, dataset, rubric, selected.revision); await Refresh(); ShowNotice('测试集与 Rubric 已冻结为新版本'); }
    catch (error) { ShowNotice(error instanceof Error ? error.message : '导入测试集失败'); } finally { setBusy(false); }
  }

  async function SaveCandidates() {
    if (!selected) return;
    setBusy(true);
    try {
      const candidates = JSON.parse(candidateDraft);
      if (!Array.isArray(candidates)) throw new Error('候选配置必须是 JSON 数组');
      await UpdateEvalProject(selected.id, {
        name: selected.name, runnerType: selected.runnerType, rubric: selected.rubric,
        config: { ...selected.config, candidates },
      }, selected.revision);
      await Refresh();
      ShowNotice('候选 Prompt 配置已保存');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '保存候选配置失败'); } finally { setBusy(false); }
  }

  async function CopyProject() {
    if (!selected) return;
    setBusy(true);
    try {
      const created = await CreateEvalProject({ name: `${selected.name} 副本`, runnerType: selected.runnerType, config: selected.config, rubric: selected.rubric });
      setSelectedProjectId(created.id); await Refresh(); ShowNotice('已复制项目配置；测试集需单独导入');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '复制项目失败'); } finally { setBusy(false); }
  }

  async function DeleteProject() {
    if (!deleteProjectId) return;
    setBusy(true);
    try {
      await DeleteEvalProject(deleteProjectId); setDeleteProjectId(null); setSelectedProjectId(null); await Refresh(); ShowNotice('测评项目已删除，历史 Run 保留');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '删除项目失败'); } finally { setBusy(false); }
  }

  async function PreviewPrompt() {
    if (!selected) return;
    setBusy(true);
    try { setPromptPreview(await PreviewEvalProject(selected.id)); }
    catch (error) { ShowNotice(error instanceof Error ? error.message : '生成编译预览失败'); } finally { setBusy(false); }
  }

  async function StartRun() {
    if (!selected) return;
    setBusy(true);
    try {
      const validation = await ValidateEvalProject(selected.id);
      if (!validation.valid) { ShowNotice(validation.errors.join('；')); return; }
      await StartEvalRun(selected.id); await Refresh(); ShowNotice('测评已进入队列');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '启动测评失败'); } finally { setBusy(false); }
  }

  async function CompareRuns() {
    if (!leftRunId || !rightRunId || leftRunId === rightRunId) { ShowNotice('请选择两个不同的历史 Run'); return; }
    setBusy(true);
    try { setComparison(await CompareEvalRuns(leftRunId, rightRunId)); }
    catch (error) { ShowNotice(error instanceof Error ? error.message : '对比 Run 失败'); } finally { setBusy(false); }
  }

  async function ViewRun(runId: string) {
    setBusy(true);
    try { setRunDetail(await ReadEvalRun(runId)); }
    catch (error) { ShowNotice(error instanceof Error ? error.message : '读取 Run 结果失败'); } finally { setBusy(false); }
  }

  const selectedRuns = useMemo(() => runs.filter((run) => run.projectId === selected?.id), [runs, selected?.id]);
  return <div className="evaluation-console">
    <header className="developer-console-header"><div className="developer-console-title"><Icon name="trace" size={16} /><span>Agent 测评</span><small>Prompt 与本地浏览器 Runner</small></div><div className="developer-console-actions"><Button variant="quiet" onClick={() => void Refresh()}>刷新</Button><Button variant="primary" onClick={() => setShowCreate(true)}>新建项目</Button></div></header>
    {!projects.length ? <EmptyState title="还没有测评项目" description="创建 Prompt 或浏览器测评项目，导入 JSONL 测试集后开始运行。" action={<Button variant="primary" onClick={() => setShowCreate(true)}>创建第一个项目</Button>} /> : <div className="evaluation-layout">
      <aside className="evaluation-project-list">{projects.map((project) => <button key={project.id} type="button" className={selected?.id === project.id ? 'selected' : ''} onClick={() => setSelectedProjectId(project.id)}><b>{project.name}</b><small>{project.runnerType === 'prompt' ? 'Prompt 测评' : '浏览器测评'} · {project.datasetCaseCount} 个案例</small></button>)}</aside>
      {selected && <section className="evaluation-workspace">
        <div className="evaluation-project-heading"><div><p className="eyebrow">{selected.runnerType === 'prompt' ? 'PROMPT EVAL' : 'BROWSER EVAL'}</p><h2>{selected.name}</h2><p>{selected.config.candidates.length} 个候选 · 数据集 {selected.datasetVersion ? selected.datasetVersion.slice(0, 8) : '未导入'}</p></div><div className="evaluation-actions"><Button variant="quiet" disabled={busy || Boolean(activeRun)} onClick={() => void CopyProject()}>复制配置</Button><Button variant="danger" disabled={busy || Boolean(activeRun)} onClick={() => setDeleteProjectId(selected.id)}>删除</Button><Button variant="primary" disabled={busy || Boolean(activeRun)} onClick={() => void StartRun()}>开始测评</Button></div></div>
        <div className="evaluation-config-grid"><FormField label="测试集 JSONL" hint="每行一个案例；坏行会整体拒绝并返回行号。"><textarea rows={10} value={dataset} onChange={(event) => setDataset(event.target.value)} /></FormField><FormField label="Judge Rubric"><textarea rows={10} value={rubric} onChange={(event) => setRubric(event.target.value)} /></FormField></div>
        <div className="evaluation-actions"><Button disabled={busy || Boolean(activeRun)} onClick={() => void ImportDataset()}>导入并生成新版本</Button><span>执行模型 {selected.config.executionModel} · Judge {selected.config.judgeModel} · 串行执行</span></div>
        <div className="evaluation-candidate-editor">
          <FormField label="Prompt 候选版本" hint={'JSON 数组；promptOverrides 使用 Prompt Fragment id 作为键。空对象表示沿用当前生产内容。'}>
            <textarea rows={12} value={candidateDraft} onChange={(event) => setCandidateDraft(event.target.value)} spellCheck={false} />
          </FormField>
          <div className="evaluation-actions"><Button disabled={busy || Boolean(activeRun)} onClick={() => void SaveCandidates()}>保存候选配置</Button><Button disabled={busy} onClick={() => void PreviewPrompt()}>编译预览</Button><span>预览使用已保存版本；每次 Run 会冻结编译后的 Prompt</span></div>
          {promptPreview && <details className="evaluation-events" open><summary>编译预览 · revision {promptPreview.projectRevision}</summary>{promptPreview.candidates.map((candidate) => <article key={candidate.id}><b>{candidate.name}</b><small>hash {candidate.compiledHash.slice(0, 12)} · 覆盖 {candidate.overriddenFragmentIds.length} 个模块</small><pre>{candidate.compiledPrompt}</pre></article>)}</details>}
        </div>
        <div className="evaluation-run-list"><h3>运行记录</h3>{selectedRuns.length ? selectedRuns.map((run) => <article key={run.id}><div><b>{run.status}</b><small>{new Date(run.createdAt).toLocaleString('zh-CN')}</small></div><div><span>{run.summary ? `${run.summary.completedCaseRuns}/${run.summary.totalCaseRuns} 完成 · 均分 ${run.summary.averageScore?.toFixed(1) ?? '不可用'}` : '等待结果'}</span>{TerminalStatuses.has(run.status) && <Button variant="quiet" onClick={() => void ViewRun(run.id)}>查看结果</Button>}{!TerminalStatuses.has(run.status) && <Button variant="danger" onClick={() => void CancelEvalRun(run.id).then(Refresh)}>取消</Button>}</div></article>) : <p className="empty-copy">暂无运行记录。</p>}</div>
        {runDetail && <div className="evaluation-result-table"><h3>Run 内候选结果</h3><div className="evaluation-result-head"><b>候选</b><b>案例</b><b>得分</b><b>状态</b></div>{runDetail.caseRuns.map((caseRun) => <details key={caseRun.id}><summary><span>{caseRun.candidateName}</span><span>{caseRun.caseId} · #{caseRun.repeatIndex + 1}</span><span>{caseRun.score?.totalScore ?? '—'}</span><span>{caseRun.status}</span></summary><div className="evaluation-case-detail"><b>最终回复</b><pre>{caseRun.finalResponse || '无最终回复'}</pre><b>硬失败</b><span>{caseRun.score?.hardFailures.join('、') || '无'}</span><b>指标</b><pre>{JSON.stringify(caseRun.metrics, null, 2)}</pre>{caseRun.error && <><b>错误</b><span>{caseRun.error.code} · {caseRun.error.message}</span></>}</div></details>)}</div>}
        <div className="evaluation-compare"><h3>历史 Run 对比</h3><div className="evaluation-compare-controls"><Select value={leftRunId} ariaLabel="左侧 Run" onChange={setLeftRunId} options={[{ value: '', label: '选择基线 Run' }, ...selectedRuns.map((run) => ({ value: run.id, label: `${run.status} · ${new Date(run.createdAt).toLocaleString('zh-CN')}` }))]} /><Select value={rightRunId} ariaLabel="右侧 Run" onChange={setRightRunId} options={[{ value: '', label: '选择候选 Run' }, ...selectedRuns.map((run) => ({ value: run.id, label: `${run.status} · ${new Date(run.createdAt).toLocaleString('zh-CN')}` }))]} /><Button disabled={busy} onClick={() => void CompareRuns()}>对比</Button></div>{comparison && <><div className={comparison.strictComparison ? 'evaluation-comparison-strict' : 'evaluation-comparison-warning'}><b>{comparison.strictComparison ? '严格可比' : '非严格 A/B'}</b><span>{comparison.strictComparison ? '关键快照条件一致' : `差异：${comparison.differingSnapshotFields.join('、')}`}</span></div><div className="evaluation-comparison-scores"><span>基线均分 <b>{comparison.left.summary?.averageScore?.toFixed(1) ?? '—'}</b></span><span>候选均分 <b>{comparison.right.summary?.averageScore?.toFixed(1) ?? '—'}</b></span></div></>}</div>
        <details className="evaluation-events"><summary>实时事件（{events.length}）</summary>{events.slice(-50).map((event, index) => <div key={`${event.createdAt}-${index}`}><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><code>{event.type}</code><span>{event.message}</span></div>)}</details>
      </section>}
    </div>}
    <Modal open={showCreate} title="新建测评项目" onClose={() => setShowCreate(false)}><div className="modal-form"><FormField label="项目名称"><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></FormField><FormField label="Runner"><Select value={runnerType} ariaLabel="测评 Runner" onChange={(value) => setRunnerType(value as 'prompt' | 'browser')} options={[{ value: 'prompt', label: 'System Prompt 测评' }, { value: 'browser', label: '拟真浏览器测评' }]} /></FormField></div><div className="modal-actions"><Button onClick={() => setShowCreate(false)}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void CreateProject()}>创建</Button></div></Modal>
    <Modal open={Boolean(deleteProjectId)} title="删除测评项目" onClose={() => setDeleteProjectId(null)}><p>将删除项目配置与项目数据集，历史 Run 和不可变快照会保留。此操作无法撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteProjectId(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void DeleteProject()}>确认删除</Button></div></Modal>
  </div>;
}
