import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { EvalCaseRun, EvalCaseRunDetail, EvalComparison, EvalDatasetVersion, EvalDatasetImportPreview, EvalEvent, EvalProvider, EvalPromptCandidate, EvalPromptPreview, EvalRunDetail } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { Button, DialogButton, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { AppError } from '../../../shared/platform/platformClient';
import { GetProviderCatalog } from '../../assistant/api/agentQueries';
import { useDeveloperConsole } from './DeveloperConsoleContext';
import { FormatDuration, FormatTime, RunStatusText, ShortHash, TerminalStatuses } from './evaluationDisplay';
import {
  CancelEvalRun, CompareEvalRuns, DeleteEvalDatasetVersion, ImportEvalDataset, ListEvalDatasetVersions,
  PreviewEvalProject, PreviewEvalDatasetImport, ReadEvalCaseResult, ReadEvalRun, SelectEvalDatasetVersion, StartEvalRun, SubscribeEvalEvents, UpdateEvalProject, ValidateEvalProject,
} from '../api/evaluationQueries';

/** Judge 返回的维度键 → 界面中文标签；未知键按原文展示，不虚构。 */
const DimensionLabels: Record<string, string> = {
  taskCompletion: '任务完成', instructionFollowing: '指令遵循', safety: '安全性', responseQuality: '内容质量',
};

const DefaultRubricDimensions = [{ id: 'taskCompletion', label: '任务完成', weight: 25 }, { id: 'instructionFollowing', label: '指令遵循', weight: 25 }, { id: 'safety', label: '安全性', weight: 25 }, { id: 'responseQuality', label: '内容质量', weight: 25 }];

const FragmentLabels: Record<string, string> = {
  'runtime/invariants': '运行时硬约束',
  'runtime/reminder-protocol': 'Runtime Reminder 协议',
  'product/identity': '产品身份与能力',
  'scenario/default': '默认场景规则',
  'scenario/application': '投递场景规则',
  'tool/protocol': '工具调用协议',
  'interaction/policy': '用户交互策略',
  'output/style': '回复风格',
  'user/preferences': '用户偏好边界',
};

type PromptDiffKind = 'unchanged' | 'removed' | 'added';
interface PromptDiffLine { content: string; kind: PromptDiffKind; }

/**
 * 以生产片段原文为基线生成稳定的行级差异（LCS）。删除行与新增行分别保留，便于审核替换内容的实际变化。
 * 仅在用户展开对照时运行；矩阵规模设上限，异常长 Prompt 退化为全量删增，避免阻塞渲染进程。
 */
function CreatePromptLineDiff(productionPrompt: string, candidatePrompt: string): PromptDiffLine[] {
  const productionLines = productionPrompt.split('\n');
  const candidateLines = candidatePrompt.split('\n');
  const matrixCells = (productionLines.length + 1) * (candidateLines.length + 1);
  if (matrixCells > 2_000_000) {
    return [
      ...productionLines.map((content) => ({ content, kind: 'removed' as const })),
      ...candidateLines.map((content) => ({ content, kind: 'added' as const })),
    ];
  }

  const width = candidateLines.length + 1;
  const matrix = new Uint32Array(matrixCells);
  for (let productionIndex = productionLines.length - 1; productionIndex >= 0; productionIndex -= 1) {
    for (let candidateIndex = candidateLines.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const current = productionIndex * width + candidateIndex;
      matrix[current] = productionLines[productionIndex] === candidateLines[candidateIndex]
        ? matrix[(productionIndex + 1) * width + candidateIndex + 1] + 1
        : Math.max(matrix[(productionIndex + 1) * width + candidateIndex], matrix[productionIndex * width + candidateIndex + 1]);
    }
  }

  const lines: PromptDiffLine[] = [];
  let productionIndex = 0;
  let candidateIndex = 0;
  while (productionIndex < productionLines.length || candidateIndex < candidateLines.length) {
    if (productionIndex < productionLines.length && candidateIndex < candidateLines.length && productionLines[productionIndex] === candidateLines[candidateIndex]) {
      lines.push({ content: productionLines[productionIndex], kind: 'unchanged' });
      productionIndex += 1;
      candidateIndex += 1;
    } else if (candidateIndex >= candidateLines.length || (productionIndex < productionLines.length && matrix[(productionIndex + 1) * width + candidateIndex] >= matrix[productionIndex * width + candidateIndex + 1])) {
      lines.push({ content: productionLines[productionIndex], kind: 'removed' });
      productionIndex += 1;
    } else {
      lines.push({ content: candidateLines[candidateIndex], kind: 'added' });
      candidateIndex += 1;
    }
  }
  return lines;
}

/** 对照视图只渲染相对生产片段有变化的行：红底为删除、绿底为新增；完全一致（含无原文）时退回原文或占位展示。 */
function PromptDiffPreview({ productionPrompt, candidatePrompt }: { productionPrompt: string; candidatePrompt: string }) {
  if (candidatePrompt === productionPrompt) return <>{productionPrompt || '（生产提示词里没有这个片段的原文）'}</>;
  const changedLines = CreatePromptLineDiff(productionPrompt, candidatePrompt).filter((line) => line.kind !== 'unchanged');
  return <>{changedLines.length
    ? changedLines.map((line, index) => <span className={`prompt-diff-line is-${line.kind}`} key={`${line.kind}-${index}-${line.content}`}>{line.content || ' '}</span>)
    : <span className="prompt-diff-empty">与生产提示词一致</span>}</>;
}

/** 结果中的结构化数据使用键值视图，避免把 JSON 源码和引号暴露给阅读者。 */
function EvaluationValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="ev-kv-empty">无</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="ev-kv-empty">无</span>;
    return <dl className="ev-kv is-nested">{value.map((item, index) => <div key={index}><dt>#{index + 1}：</dt><dd><EvaluationValue value={item} /></dd></div>)}</dl>;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="ev-kv-empty">无</span>;
    return <dl className="ev-kv is-nested">{entries.map(([key, item]) => <div key={key}><dt>{key}：</dt><dd><EvaluationValue value={item} /></dd></div>)}</dl>;
  }
  return <span>{typeof value === 'boolean' ? (value ? '是' : '否') : String(value)}</span>;
}

function EvaluationKeyValue({ value }: { value: unknown }) {
  return <div className="ev-kv-wrap"><EvaluationValue value={value} /></div>;
}

function TextFileUpload({ label, accept, hint, maxBytes, onLoad, onError, disabled = false }: { label: string; accept: string; hint: string; maxBytes: number; onLoad: (content: string, name: string) => void; onError: (message: string) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');

  async function ReadFile(file?: File) {
    if (!file || disabled) return;
    if (file.size > maxBytes) { onError(`${file.name} 超过允许的文件大小`); return; }
    try {
      const content = await file.text();
      setFileName(file.name);
      onLoad(content, file.name);
    } catch { onError(`无法读取 ${file.name}，请确认它是 UTF-8 文本文件`); }
  }

  function HandleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void ReadFile(event.dataTransfer.files[0]);
  }

  function HandleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    inputRef.current?.click();
  }

  return <div className="ev-upload-field">
    <span>{label}</span>
    <div className={`ev-dropzone ${dragging ? 'is-dragging' : ''}`} role="button" aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) inputRef.current?.click(); }} onKeyDown={HandleKeyDown} onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={HandleDrop}>
      <Icon name="database" size={18} />
      <b>{fileName || '拖动文件到这里，或点击选择'}</b>
      <small>{hint}</small>
      <input ref={inputRef} type="file" disabled={disabled} accept={accept} tabIndex={-1} onChange={(event) => void ReadFile(event.target.files?.[0])} />
    </div>
  </div>;
}

/** 单题展开正文：左侧评估模型结果，右侧评判/断言，与原型的两栏证据语法一致。 */
function EvaluationCaseBody({ summary, detail, runnerType }: { summary: EvalCaseRun; detail?: EvalCaseRunDetail; runnerType: 'prompt' | 'browser' }) {
  const score = detail?.score ?? summary.score;
  const metrics = summary.metrics ?? {};
  const tokens = typeof metrics.totalTokens === 'number' ? metrics.totalTokens : null;
  const turns = typeof metrics.modelTurns === 'number' ? metrics.modelTurns : null;
  const duration = typeof metrics.durationMs === 'number' ? metrics.durationMs : summary.completedAt ? summary.completedAt - summary.createdAt : null;
  const dimensions = Object.entries(score?.dimensions ?? {});
  const requirements = score?.requirementResults ?? [];
  const assertions = score?.assertionResults ?? [];
  const benchmark = score?.benchmark;

  return <div className="ev-case-b">
    <div className="ev-sub">
      <div className="ev-sub-h"><Icon name="cpu" size={14} /><span>评估模型结果</span><span className="ev-tag">{summary.candidateName}</span></div>
      <p className="ev-reply">{summary.finalResponse || '无最终回复'}</p>
      <div className="ev-meta-line">
        <span><Icon name="clock" size={12} />{FormatDuration(duration)}</span>
        <span><Icon name="hash" size={12} />{tokens === null ? '暂无 token' : `${tokens.toLocaleString('zh-CN')} token`}</span>
        {typeof metrics.cachedTokens === 'number' && metrics.cachedTokens > 0 && <span>缓存输入 {metrics.cachedTokens.toLocaleString('zh-CN')}</span>}
        <span><Icon name="refresh" size={12} />{turns === null ? '—' : `${turns} 轮`}</span>
      </div>
      {summary.error && <div className="ev-req is-fail"><Icon name="warning" size={14} /><span className="ev-req-b"><b>执行失败</b><small>{summary.error.code} · {summary.error.message}</small></span></div>}
    </div>
    <div className="ev-sub">
      <div className="ev-sub-h"><Icon name="brain" size={14} /><span>{runnerType === 'prompt' ? '评判模型 judgement' : '确定性断言'}</span>
        {runnerType === 'prompt' && typeof score?.confidence === 'number' && <span className="ev-tag">置信度 {score.confidence.toFixed(2)}</span>}
        {score?.judgeStatus === 'corrected' && <span className="ev-tag">纠正 {score.judgeCorrectionCount ?? 0} 次</span>}
      </div>
      {runnerType === 'prompt'
        ? <>{dimensions.length
          ? <div className="ev-dims">{dimensions.map(([key, value]) => <div className="ev-dim" key={key}><span className="ev-dim-k">{DimensionLabels[key] ?? key}</span><span className="ev-dim-t"><span className="ev-dim-f" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span><span className="ev-dim-v">{value}</span></div>)}</div>
          : <p className="ev-reason">{score?.schemaVersion === 1 ? '旧评分记录没有维度数据。' : '等待评分。'}</p>}
          <div className="ev-reqs">{requirements.map((item, index) => <div className={`ev-req ${item.passed ? '' : 'is-fail'}`} key={`${item.requirement}-${index}`}><Icon name={item.passed ? 'check-circle' : 'warning-circle'} size={14} /><span className="ev-req-b"><b>{item.requirement}</b><small>{item.reason}</small></span></div>)}</div>
          {Boolean(score?.hardFailures.length) && <div className="ev-req is-fail"><Icon name="warning" size={14} /><span className="ev-req-b"><b>硬失败</b><small>{score?.hardFailures.join('、')}</small></span></div>}
          {score?.reason && <p className="ev-reason">{score.reason}</p>}
        </>
        : <>{benchmark && <>
          <p className="ev-reason">{score?.reason} 字段准确率：{benchmark.fieldAccuracy === null ? '待统计' : `${benchmark.fieldAccuracy}%`}；关键字段错误：{benchmark.criticalErrors.length}。</p>
          <div className="ev-reqs">{benchmark.issues.map((issue, index) => <div className="ev-req is-fail" key={`${issue.path}-${index}`}><Icon name="warning-circle" size={14} /><span className="ev-req-b"><b>{issue.path} · {issue.code}</b>{'expected' in issue && <span className="ev-actual">期望 <EvaluationKeyValue value={issue.expected} /></span>}{'actual' in issue && <span className="ev-actual">实际 <EvaluationKeyValue value={issue.actual} /></span>}</span></div>)}</div>
        </>}{assertions.length
          ? <div className="ev-reqs">{assertions.map((item) => <div className={`ev-req ${item.passed ? '' : 'is-fail'}`} key={item.id}><Icon name={item.passed ? 'check-circle' : 'warning-circle'} size={14} /><span className="ev-req-b"><b>{item.id} · 权重 {item.weight}</b><small>{item.reason}</small><span className="ev-actual">实际值 <EvaluationKeyValue value={item.actual} /></span></span></div>)}</div>
          : <p className="ev-reason">旧评分记录没有断言结果。</p>}
          {Boolean(score?.hardFailures.length) && <div className="ev-req is-fail"><Icon name="warning" size={14} /><span className="ev-req-b"><b>硬失败</b><small>{score?.hardFailures.join('、')}</small></span></div>}
        </>}
    </div>
  </div>;
}

/** 应用内测评控制台：侧栏在应用壳层（评测记录属于开发者页侧栏），这里只渲染配置栏与结果/对比视图。 */
export function EvaluationConsole() {
  const { selectedProject } = useDeveloperConsole();
  return <EvaluationProjectConsole key={selectedProject?.id ?? 'empty'} />;
}

/** 项目级组件独立生命周期，旧项目请求的结果不能写入新项目视图。 */
function EvaluationProjectConsole() {
  const { ShowNotice } = useUiStore();
  const { projects, runs, selectedProject: selected, view, Refresh, refreshing, refreshError, OpenCreate } = useDeveloperConsole();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<EvalRunDetail | null>(null);
  const [caseDetails, setCaseDetails] = useState<Record<string, EvalCaseRunDetail>>({});
  const [openCases, setOpenCases] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<EvalDatasetVersion[]>([]);
  const [promptPreview, setPromptPreview] = useState<EvalPromptPreview | null>(null);
  const [candidateDraft, setCandidateDraft] = useState<EvalPromptCandidate[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Array<{ provider: string; configured: boolean; models: string[] }>>([]);
  const [busy, setBusy] = useState(false);
  const [toolDraft, setToolDraft] = useState<string[]>([]);
  const [runError, setRunError] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [providersError, setProvidersError] = useState('');
  const [caseErrors, setCaseErrors] = useState<Record<string, string>>({});
  const [refreshTick, setRefreshTick] = useState(0);
  const [caseTick, setCaseTick] = useState(0);
  const runRequest = useRef(0);
  const previewRequest = useRef(0);
  const caseEpoch = useRef(0);
  const caseLoading = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [repeatDraft, setRepeatDraft] = useState(1);
  const [turnsDraft, setTurnsDraft] = useState(30);
  const [simulatorDraft, setSimulatorDraft] = useState('approve_valid');
  const [dimensionsDraft, setDimensionsDraft] = useState<Array<{ id: string; label: string; weight: number }>>([]);

  const [showStop, setShowStop] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [importJsonl, setImportJsonl] = useState('');
  const [importPreview, setImportPreview] = useState<EvalDatasetImportPreview | null>(null);
  const [datasetTemplate, setDatasetTemplate] = useState('');
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState('');
  const projectIdRef = useRef(selected?.id);
  projectIdRef.current = selected?.id;
  const versionsRequestRef = useRef(0);
  const [deleteVersion, setDeleteVersion] = useState<string | null>(null);
  const [showPromptDrawer, setShowPromptDrawer] = useState(false);
  const [showJudgeDrawer, setShowJudgeDrawer] = useState(false);
  /** Prompt 抽屉的候选页签：一次只编辑一个候选，保存时提交整份草稿。 */
  const [drawerCandidateId, setDrawerCandidateId] = useState<string | null>(null);
  const [judgeDraft, setJudgeDraft] = useState('');
  const [rubricDraft, setRubricDraft] = useState('');
  const [judgeStrictJsonDraft, setJudgeStrictJsonDraft] = useState(false);

  const [compare, setCompare] = useState<EvalComparison | null>(null);
  const [leftRunId, setLeftRunId] = useState('');
  const [rightRunId, setRightRunId] = useState('');
  const [showConds, setShowConds] = useState(false);
  const compareRequest = useRef(0);
  const revisionRef = useRef(selected?.revision); revisionRef.current = selected?.revision;

  const projectRuns = useMemo(() => runs.filter((run) => run.projectId === selected?.id), [runs, selected?.id]);
  const activeRun = projectRuns.find((run) => !TerminalStatuses.has(run.status));
  const displayRun = useMemo(() => {
    if (selectedRunId) return projectRuns.find((run) => run.id === selectedRunId) ?? null;
    return activeRun ?? projectRuns.find((run) => run.status === 'completed') ?? projectRuns[0] ?? null;
  }, [projectRuns, selectedRunId, activeRun]);
  /** 列表项只有汇总；逐题结果来自完整 Run 详情，按 id 匹配避免切换后串页。 */
  const displayDetail = runDetail && displayRun && runDetail.id === displayRun.id ? runDetail : null;

  // 控制台每次重新挂载（离开又回到评估/对比视图）都刷新一次，弥补挂载期间错过的事件。
  useEffect(() => { void Refresh().catch((error) => ShowNotice(error instanceof Error ? error.message : '读取评测项目失败', "error")); }, [Refresh, ShowNotice]);

  const displayRunRef = useRef(displayRun?.id);
  displayRunRef.current = displayRun?.id;
  const ReloadRun = useCallback(async (id: string) => {
    const request = ++runRequest.current;
    setRunLoading(true); setRunError('');
    try {
      const detail = await ReadEvalRun(id);
      if (mounted.current && displayRunRef.current === id && request === runRequest.current) setRunDetail(detail);
    } catch (error) {
      if (mounted.current && displayRunRef.current === id && request === runRequest.current) setRunError(error instanceof Error ? error.message : '读取运行结果失败');
    } finally {
      if (mounted.current && displayRunRef.current === id && request === runRequest.current) setRunLoading(false);
    }
  }, []);
  const ReloadPreview = useCallback(async (id: string) => {
    const request = ++previewRequest.current;
    setPreviewError('');
    try {
      const preview = await PreviewEvalProject(id);
      if (mounted.current && request === previewRequest.current && preview.projectRevision === revisionRef.current) setPromptPreview(preview);
    } catch (error) {
      if (mounted.current && request === previewRequest.current) setPreviewError(error instanceof Error ? error.message : '读取提示词预览失败');
    }
  }, []);
  const ReloadProviders = useCallback(async () => {
    setProvidersError('');
    try { const catalog = await GetProviderCatalog(); if (mounted.current) setProviders(catalog.providers); }
    catch (error) { if (mounted.current) setProvidersError(error instanceof Error ? error.message : '读取模型配置失败'); }
  }, []);
  useEffect(() => {
    if (!displayRun) { setRunDetail(null); return; }
    void ReloadRun(displayRun.id);
  }, [displayRun?.id, displayRun?.status, displayRun?.completedAt, refreshTick, ReloadRun]);
  useEffect(() => { caseEpoch.current += 1; caseLoading.current.clear(); setCaseDetails({}); setCaseErrors({}); setOpenCases(new Set()); }, [displayRun?.id]);

  // 使用尾随节流保留最后一条事件，终态立即刷新；刷新范围绑定当前 Run。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      timer = undefined;
      setRefreshTick(value => value + 1);
      void Refresh().catch(error => ShowNotice(error instanceof Error ? error.message : '刷新评测失败', 'error'));
    };
    const unsubscribe = SubscribeEvalEvents((event: EvalEvent) => {
      if (event.runId !== displayRunRef.current) {
        if (event.type === 'run_status' || event.type === 'error') void Refresh().catch(error => ShowNotice(error instanceof Error ? error.message : '刷新评测失败', 'error'));
        return;
      }
      if (event.type === 'score' || event.type === 'case_status' || event.type === 'run_status' || event.type === 'error') {
        caseEpoch.current += 1; caseLoading.current.clear(); setCaseDetails({}); setCaseErrors({});
      }
      if (event.type === 'run_status' || event.type === 'error' || event.type === 'score') {
        if (timer) clearTimeout(timer);
        refresh();
      } else if (!timer) timer = setTimeout(refresh, 400);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [Refresh, ShowNotice]);

  /** 切换评测：重置运行选择、候选选择与对比状态；回到评估视图由 Provider 统一处理。 */
  useEffect(() => {
    setSelectedRunId(null); setRunDetail(null); setVersions([]); setPromptPreview(null);
    setOpenCases(new Set()); setCaseDetails({}); setCompare(null); setLeftRunId(''); setRightRunId('');
    const candidates = selected?.config.candidates ?? [];
    setCandidateDraft(structuredClone(candidates));
    setSelectedCandidateId(candidates[0]?.id ?? null);
    if (!selected) return;
    setShowManage(false); setImportPreview(null); setDatasetTemplate('');
    void ReloadVersions(selected.id).catch(() => undefined);
    void ReloadPreview(selected.id);
  }, [selected?.id, ShowNotice]);

  useEffect(() => { void ReloadProviders(); }, [ReloadProviders]);
  useEffect(() => { if (!selected) return; setRepeatDraft(selected.config.repeatCount); setTurnsDraft(selected.config.maxModelTurns); setSimulatorDraft(selected.config.userSimulator); setDimensionsDraft(structuredClone(selected.config.rubricDimensions ?? DefaultRubricDimensions)); }, [selected?.id, selected?.revision]);
  useEffect(() => { if (selected) void ReloadPreview(selected.id); }, [selected?.revision, ReloadPreview]);
  useEffect(() => { setToolDraft([...(selected?.config.toolNames ?? [])]); }, [selected?.id, selected?.revision]);

  // 编辑抽屉打开期间 Escape 直接关闭（与投递记录抽屉一致）；草稿未保存会被丢弃，脚注有"未保存"提示兜底。
  useEffect(() => {
    if (!showPromptDrawer && !showJudgeDrawer) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showPromptDrawer) setShowPromptDrawer(false);
      else setShowJudgeDrawer(false);
    };
    window.addEventListener('keydown', CloseOnEscape);
    return () => window.removeEventListener('keydown', CloseOnEscape);
  }, [showPromptDrawer, showJudgeDrawer]);

  const fragmentOptions = promptPreview?.fragments ?? [];
  const selectedCandidate = selected?.config.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const selectedPreview = promptPreview?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;

  const modelOptions = useMemo(() => providers.filter((provider) => provider.configured).flatMap((provider) => provider.models.map((model) => ({ value: JSON.stringify([provider.provider, model]), label: `${provider.provider} · ${model}` }))), [providers]);
  function ModelValue(kind: 'execution' | 'judge') { return JSON.stringify([kind === 'execution' ? selected?.config.executionProvider : selected?.config.judgeProvider, kind === 'execution' ? selected?.config.executionModel : selected?.config.judgeModel]); }
  function ModelOptions(kind: 'execution' | 'judge') {
    const value = ModelValue(kind);
    return modelOptions.some(option => option.value === value) ? modelOptions : [{ value, label: `${kind === 'execution' ? selected?.config.executionProvider : selected?.config.judgeProvider} · ${kind === 'execution' ? selected?.config.executionModel : selected?.config.judgeModel}（未配置或不可用）`, disabled: true }, ...modelOptions];
  }

  async function SaveExecutionSettings() {
    if (!selected) return;
    await WithBusy(async () => {
      await UpdateEvalProject(selected.id, { name: selected.name, runnerType: selected.runnerType, config: { ...selected.config, repeatCount: repeatDraft, maxModelTurns: turnsDraft, userSimulator: simulatorDraft as typeof selected.config.userSimulator } }, selected.revision);
      await Refresh(); ShowNotice('运行配置已保存，下次评测生效', 'success');
    });
  }

  async function SaveTools() {
    if (!selected) return;
    await WithBusy(async () => {
      await UpdateEvalProject(selected.id, { name: selected.name, runnerType: selected.runnerType, rubric: selected.rubric, config: { ...selected.config, toolNames: toolDraft } }, selected.revision);
      await Refresh();
      await ReloadPreview(selected.id);
      ShowNotice('工具配置已保存，下次评测生效', 'success');
    });
  }

  async function ReloadVersions(projectId: string) {
    const request = ++versionsRequestRef.current;
    setVersionsLoading(true); setVersionsError('');
    try {
      const next = await ListEvalDatasetVersions(projectId);
      if (projectIdRef.current === projectId && request === versionsRequestRef.current) setVersions(next);
      return next;
    } catch (error) {
      if (projectIdRef.current === projectId && request === versionsRequestRef.current) setVersionsError(error instanceof Error ? error.message : '读取测试集版本失败');
      throw error;
    } finally {
      if (projectIdRef.current === projectId && request === versionsRequestRef.current) setVersionsLoading(false);
    }
  }

  function ChangeImportText(content: string) { setImportJsonl(content); setImportPreview(null); }

  async function CheckImport() {
    if (!selected) return;
    await WithBusy(async () => setImportPreview(await PreviewEvalDatasetImport(selected.id, importJsonl)));
  }

  async function WithBusy(work: () => Promise<void>) {
    setBusy(true);
    try { await work(); } catch (error) { ShowNotice(error instanceof Error ? error.message : '操作失败', "error"); } finally { setBusy(false); }
  }

  async function SaveCandidates() {
    if (!selected) return;
    await WithBusy(async () => {
      if (candidateDraft.some((candidate) => !candidate.name.trim())) throw new Error('Prompt 版本名称不能为空');
      const updated = await UpdateEvalProject(selected.id, { name: selected.name, runnerType: selected.runnerType, rubric: selected.rubric, judgePrompt: selected.judgePrompt, config: { ...selected.config, candidates: candidateDraft } }, selected.revision);
      await Refresh();
      setCandidateDraft(structuredClone(updated.config.candidates));
      if (!updated.config.candidates.some((candidate) => candidate.id === selectedCandidateId)) setSelectedCandidateId(updated.config.candidates[0]?.id ?? null);
      void ReloadPreview(selected.id);
      ShowNotice('Prompt 候选已保存', "success");
    });
  }

  function UpdateCandidate(candidateId: string, update: (candidate: EvalPromptCandidate) => EvalPromptCandidate) {
    setCandidateDraft((current) => current.map((candidate) => candidate.id === candidateId ? update(candidate) : candidate));
  }

  function AddPromptOverride(candidateId: string) {
    const candidate = candidateDraft.find((item) => item.id === candidateId);
    const fragment = fragmentOptions.find((item) => candidate?.promptOverrides[item.id] === undefined);
    if (!fragment) { ShowNotice('所有可替换位置都已添加', "info"); return; }
    UpdateCandidate(candidateId, (current) => ({ ...current, promptOverrides: { ...current.promptOverrides, [fragment.id]: fragment.content } }));
  }

  function ChangePromptOverride(candidateId: string, previousId: string, nextId: string) {
    const fragment = fragmentOptions.find((item) => item.id === nextId);
    if (!fragment) return;
    UpdateCandidate(candidateId, (candidate) => {
      const next = { ...candidate.promptOverrides };
      delete next[previousId];
      next[nextId] = fragment.content;
      return { ...candidate, promptOverrides: next };
    });
  }

  function RemovePromptOverride(candidateId: string, fragmentId: string) {
    UpdateCandidate(candidateId, (candidate) => {
      const next = { ...candidate.promptOverrides };
      delete next[fragmentId];
      return { ...candidate, promptOverrides: next };
    });
  }

  async function SaveJudgePrompt() {
    if (!selected) return;
    await WithBusy(async () => {
      await UpdateEvalProject(selected.id, { name: selected.name, runnerType: selected.runnerType, rubric: rubricDraft, judgePrompt: judgeDraft, judgeStrictJson: judgeStrictJsonDraft, config: { ...selected.config, rubricDimensions: dimensionsDraft } }, selected.revision);
      setShowJudgeDrawer(false);
      await Refresh(); ShowNotice('评判提示词已保存，下次评测生效', "success");
    });
  }

  async function ChangeModel(kind: 'executionModel' | 'judgeModel', value: string) {
    if (!selected) return;
    await WithBusy(async () => {
      const [provider, model] = JSON.parse(value) as [EvalProvider, string];
      const config = { ...selected.config, [kind]: model, [kind === 'judgeModel' ? 'judgeProvider' : 'executionProvider']: provider };
      await UpdateEvalProject(selected.id, { name: selected.name, runnerType: selected.runnerType, rubric: selected.rubric, judgePrompt: selected.judgePrompt, config }, selected.revision);
      await Refresh(); ShowNotice('模型已更新，下次评测生效', "success");
    });
  }

  async function SelectVersion(version: string) {
    if (!selected || version === selected.datasetVersion) return;
    await WithBusy(async () => {
      await SelectEvalDatasetVersion(selected.id, version, selected.revision);
      await Refresh();
      await ReloadVersions(selected.id);
      ShowNotice('已切换测试集版本，下次评测生效', "success");
    });
  }

  function OpenManage() {
    if (!selected) return;
    setImportJsonl('');
    setImportPreview(null); setDatasetTemplate('');
    setShowManage(true);
    void ReloadVersions(selected.id).catch(() => undefined);
    const projectId = selected.id;
    void PreviewEvalDatasetImport(projectId, '').then(preview => { if (projectIdRef.current === projectId) setDatasetTemplate(preview.templateJsonl); })
      .catch(error => ShowNotice(error instanceof Error ? error.message : '读取模板失败', 'error'));
  }

  async function ConfirmDeleteVersion() {
    if (!selected || !deleteVersion) return;
    await WithBusy(async () => {
      await DeleteEvalDatasetVersion(selected.id, deleteVersion, selected.revision);
      setDeleteVersion(null);
      await Refresh();
      await ReloadVersions(selected.id);
      ShowNotice('版本已删除；已跑完的评测读取自己的冻结快照，结果不受影响', "success");
    });
  }

  async function ImportVersion() {
    if (!selected) return;
    if (!importJsonl.trim()) { ShowNotice('请先粘贴或上传 JSONL 测试集', "error"); return; }
    await WithBusy(async () => {
      const preview = await PreviewEvalDatasetImport(selected.id, importJsonl);
      setImportPreview(preview);
      if (!preview.valid) return;
      let imported;
      try { imported = await ImportEvalDataset(selected.id, importJsonl, selected.rubric, selected.revision); }
      catch (error) {
        if (error instanceof AppError && error.details && typeof error.details === 'object' && 'preview' in error.details) setImportPreview(error.details.preview as EvalDatasetImportPreview);
        throw error;
      }
      setImportJsonl(''); setImportPreview(null);
      await Refresh();
      await ReloadVersions(selected.id);
      ShowNotice(versions.some(item => item.version === imported.datasetVersion) ? '相同内容的版本已存在，已设为当前测试集' : '测试集已冻结为新版本', "success");
    });
  }

  async function StartRun() {
    if (!selected) return;
    await WithBusy(async () => {
      const validation = await ValidateEvalProject(selected.id);
      if (!validation.valid) { ShowNotice(validation.errors.join('；'), "error"); return; }
      const run = await StartEvalRun(selected.id, selectedCandidateId ?? undefined);
      setSelectedRunId(run.id);
      await Refresh();
      ShowNotice('评测已进入队列', "info");
    });
  }

  async function CancelRun() {
    if (!activeRun) return;
    setShowStop(false);
    await WithBusy(async () => {
      await CancelEvalRun(activeRun.id);
      await Refresh(); ShowNotice('评测已终止，未执行的题目不会补跑', "info");
    });
  }

  async function LoadRun(runId: string) {
    caseEpoch.current += 1; caseLoading.current.clear(); setCaseDetails({}); setCaseErrors({});
    setSelectedRunId(runId);
    setRunDetail(null);
    setOpenCases(new Set());
  }

  /** 展开后读取可观察证据；状态/评分事件使缓存失效，迟到请求必须满足同一 Run 和代次。 */
  function ToggleCase(caseRunId: string) {
    setOpenCases(current => { const next = new Set(current); if (next.has(caseRunId)) next.delete(caseRunId); else next.add(caseRunId); return next; });
  }
  useEffect(() => {
    const id = displayRun?.id;
    if (!id) return;
    for (const caseId of openCases) {
      if (caseDetails[caseId] || caseErrors[caseId] || caseLoading.current.has(caseId)) continue;
      const epoch = caseEpoch.current;
      caseLoading.current.add(caseId);
      void ReadEvalCaseResult(caseId).then(detail => {
        if (mounted.current && epoch === caseEpoch.current && displayRunRef.current === id) setCaseDetails(current => ({ ...current, [caseId]: detail }));
      }).catch(error => {
        if (mounted.current && epoch === caseEpoch.current && displayRunRef.current === id) setCaseErrors(current => ({ ...current, [caseId]: error instanceof Error ? error.message : '读取本题证据失败' }));
      }).finally(() => { if (epoch === caseEpoch.current) caseLoading.current.delete(caseId); });
    }
  }, [openCases, caseDetails, caseErrors, displayRun?.id, caseTick, refreshTick]);

  /** 进入对比视图时默认配对同一评测最近两次已完结的运行：旧者为基线，新者为候选。 */
  function PairAndLoadCompare() {
    setCompare(null);
    let left = leftRunId;
    let right = rightRunId;
    if (!left || !right || left === right) {
      const terminal = projectRuns.filter((run) => TerminalStatuses.has(run.status));
      left = terminal[1]?.id ?? '';
      right = left === terminal[0]?.id ? '' : (terminal[0]?.id ?? '');
    }
    setLeftRunId(left); setRightRunId(right);
    if (left && right) void LoadComparison(left, right);
  }

  // 对比视图由侧栏导航进入；重复进入保留已选配对，仅在配对失效时重新默认配对。
  useEffect(() => {
    if (view !== 'compare') return;
    PairAndLoadCompare();
  }, [view]);

  async function RunCompare() {
    if (!leftRunId || !rightRunId || leftRunId === rightRunId) { ShowNotice('请选择两个不同的运行记录', "error"); return; }
    await LoadComparison(leftRunId, rightRunId);
  }

  async function LoadComparison(left: string, right: string) {
    const request = ++compareRequest.current;
    setCompare(null);
    await WithBusy(async () => {
      const next = await CompareEvalRuns(left, right);
      if (mounted.current && request === compareRequest.current) setCompare(next);
    });
  }
  function SelectComparisonSide(side: 'left' | 'right', id: string) {
    compareRequest.current += 1; setCompare(null);
    if (side === 'left') setLeftRunId(id); else setRightRunId(id);
  }

  const snapshot = (displayDetail?.snapshot ?? {}) as Record<string, any>;
  const snapshotCases = Array.isArray(snapshot.cases) ? snapshot.cases as Array<{ id: string; category?: string; input: { userMessage: string } }> : [];
  const casePrompt = (caseId: string) => snapshotCases.find((item) => item.id === caseId)?.input.userMessage ?? caseId;
  const summary = displayRun?.summary ?? null;
  const scoredCount = displayDetail ? displayDetail.caseRuns.filter((item) => item.status === 'completed' && typeof item.score?.totalScore === 'number').length : 0;
  const hardFailureCount = displayDetail ? displayDetail.caseRuns.filter((item) => (item.score?.hardFailures?.length ?? 0) > 0).length : 0;
  const lowConfidenceCount = displayDetail ? displayDetail.caseRuns.filter((item) => typeof item.score?.confidence === 'number' && item.score.confidence < 0.92).length : 0;
  const notExecutedCount = displayDetail ? displayDetail.caseRuns.filter((item) => item.status === 'not_run').length : 0;
  const usage = summary?.usage;
  const compareLeft = compare?.left, compareRight = compare?.right;
  /** 抽屉脚注的"未保存"标记与保存按钮的可用态：草稿与当前配置逐字节对比。 */
  const judgeDirty = judgeDraft !== (selected?.judgePrompt ?? '') || rubricDraft !== (selected?.rubric ?? '') || judgeStrictJsonDraft !== (selected?.judgeStrictJson === true) || JSON.stringify(dimensionsDraft) !== JSON.stringify(selected?.config.rubricDimensions ?? DefaultRubricDimensions);
  const promptDirty = JSON.stringify(candidateDraft) !== JSON.stringify(selected?.config.candidates ?? []);

  return <div className="evaluation-console">
    <div className="eval-main">
      {refreshError && <p role="alert">{refreshError}<Button variant="quiet" onClick={() => void Refresh().catch(() => undefined)}>重试读取列表</Button></p>}
      {refreshing && !projects.length && <p role="status">正在读取评测列表…</p>}
      {!selected ? <div className="ev-empty">
        <span className="ev-empty-mark"><Icon name="flask" size={21} /></span>
        <h2>还没有评测</h2>
        <p>创建一个评测，选择测试集与 Prompt 候选后开始运行；结果会按题目逐条落在右侧。</p>
        <Button variant="quiet" onClick={OpenCreate}><Icon name="plus" size={14} />新建评测</Button>
      </div> : view !== 'compare' ? <div className="eval-split">
        <section className="eval-config" aria-label="评测配置">
          <div className="ev-card">
            <div className="ev-card-head">
              <div className="ev-card-titles"><h2>{selected.name}</h2><p>{selected.runnerType === 'prompt' ? 'Prompt 测评 · 由评判模型打分' : '浏览器测评 · 确定性断言评分'} · {selected.datasetCaseCount} 题</p></div>
              <span className={`ev-tag ${activeRun ? 'is-accent' : ''}`}>{activeRun ? '进行中' : (displayRun ? RunStatusText(displayRun.status) : '未开始')}</span>
            </div>
            <div className="ev-info">
              <div className="ev-info-row"><span className="k">时间</span><span className="v">{displayRun ? FormatTime(displayRun.createdAt) : '—'}</span></div>
              <div className="ev-info-row"><span className="k">评估类别</span><span className="v">{versions.find((item) => item.isCurrent)?.category ?? snapshotCases[0]?.category ?? '—'}</span></div>
              <div className="ev-info-row"><span className="k">评测方式</span><span className="v">{selected.runnerType === 'prompt' ? 'Prompt 测评 · 由评判模型打分' : '浏览器测评 · 确定性断言评分'}</span></div>
              {Boolean(summary?.durationMs) && <div className="ev-info-row"><span className="k">耗时</span><span className="v">{FormatDuration(summary?.durationMs)}</span></div>}
            </div>
            <div className="ev-acts">
              <Button variant="primary" disabled={busy || Boolean(activeRun) || !selected.datasetVersion} onClick={() => void StartRun()}><Icon name="play" size={14} />{displayRun ? '重新评测' : '开始'}</Button>
              <Button variant="danger" disabled={!activeRun || busy} onClick={() => setShowStop(true)}><Icon name="stop" size={14} />终止</Button>
            </div>
            <p className={`ev-note ${displayRun?.status === 'cancelled' ? 'is-warn' : ''}`}>{
              activeRun ? '评测进行中。终止后本次评测不能继续，也不能恢复。'
                : displayRun?.status === 'cancelled' ? '本次评测已终止，不能继续。已完成的题目结果保留，未执行的题目不会补跑。'
                  : displayRun?.status === 'failed' ? '本次评测失败，已产生的结果保留。请检查错误后重新评测。' : displayRun ? '本次评测已完成。重新评测会新增一条不可变的运行记录，不会覆盖当前结果。'
                    : '尚未开始。开始后题目会按顺序执行，可以随时终止。'
            }</p>
          </div>

          <section className="ev-sec">
            <div className="ev-sec-h"><Icon name="selection" size={14} /><span>评测集选择</span><span className="sp" /><Button variant="quiet" onClick={OpenManage}><Icon name="sliders" size={13} />管理</Button></div>
            <Select value={selected.datasetVersion ?? ''} disabled={busy || versionsLoading || versions.length === 0} ariaLabel="测试集版本" onChange={(value) => void SelectVersion(value)} options={versions.length ? versions.map((item) => ({ value: item.version, label: `${ShortHash(item.version)} · ${item.caseCount} 案例 · ${FormatTime(item.importedAt)}${item.isCurrent ? ' · 当前使用' : ''}` })) : [{ value: '', label: versionsLoading ? '正在读取测试集…' : '尚未导入测试集' }]} />
            {versionsError && <p role="alert">{versionsError}<Button variant="quiet" onClick={() => void ReloadVersions(selected.id).catch(() => undefined)}>重试</Button></p>}
            <div className="ev-hash"><Icon name="hash" size={13} /><span>数据集版本 {ShortHash(selected.datasetVersion)}，运行时会冻结为不可变快照</span></div>
          </section>

          <section className="ev-sec">
            {previewError && <p role="alert">{previewError}<Button variant="quiet" onClick={() => void ReloadPreview(selected.id)}>重试</Button></p>}
            {Boolean(promptPreview?.tools.invalid.length) && <p role="alert">失效工具：{promptPreview?.tools.invalid.join('、')}<Button variant="quiet" disabled={busy} onClick={() => setToolDraft([...(promptPreview?.tools.suggested ?? [])])}>载入兼容配置</Button></p>}
            <details className="ev-tool-config"><summary><Icon name="wrench" size={14} /><span>工具配置</span><span className="ev-tag">已选 {toolDraft.length} 项</span><Icon name="chevron-right" size={12} className="ev-tool-chevron" /></summary>
              <div className="ev-tool-options" role="group" aria-label="可用工具">{(promptPreview?.tools.allowed ?? []).map(name => <label className="ev-tool-option" key={name}>
                <input type="checkbox" disabled={busy} checked={toolDraft.includes(name)} onChange={event => setToolDraft(current => event.target.checked ? [...current, name] : current.filter(item => item !== name))} />
                <span className="box" aria-hidden="true"><Icon name="check" size={11} /></span>
                <span className="ev-tool-name">{name}</span>
              </label>)}</div>
              {!promptPreview && <p className="ev-tool-empty" role="status">{previewError ? '工具列表加载失败' : '正在读取工具列表…'}</p>}
              {promptPreview && !promptPreview.tools.allowed.length && <p className="ev-tool-empty">暂无可用工具</p>}
              <div className="ev-tool-footer"><Button variant="primary" disabled={busy || !promptPreview || JSON.stringify(toolDraft) === JSON.stringify(selected.config.toolNames)} onClick={() => void SaveTools()}>保存工具配置</Button></div>
            </details>
          </section>

          <section className="ev-sec">
            <details><summary>运行配置</summary>
              <FormField label="每个候选重复次数"><input type="number" min={1} max={10} value={repeatDraft} disabled={busy} onChange={event => setRepeatDraft(Number(event.target.value))} /></FormField>
              <FormField label="最大模型轮数"><input type="number" min={1} max={100} value={turnsDraft} disabled={busy} onChange={event => setTurnsDraft(Number(event.target.value))} /></FormField>
              <FormField label="模拟用户交互"><Select value={simulatorDraft} disabled={busy} ariaLabel="模拟用户交互策略" onChange={setSimulatorDraft} options={[{ value: 'approve_valid', label: '批准有效操作' }, { value: 'reject_submit_once', label: '首次拒绝提交' }, { value: 'scripted', label: '按案例脚本交互' }]} /></FormField>
              <Button disabled={busy || (repeatDraft === selected.config.repeatCount && turnsDraft === selected.config.maxModelTurns && simulatorDraft === selected.config.userSimulator)} onClick={() => void SaveExecutionSettings()}>保存运行配置</Button>
            </details>
          </section>

          <section className="ev-sec">
            <div className="ev-sec-h"><Icon name="resume" size={14} /><span>prompt 配置</span><span className="sp" /><Button variant="quiet" onClick={() => { setCandidateDraft(structuredClone(selected.config.candidates)); setDrawerCandidateId(selectedCandidateId ?? selected.config.candidates[0]?.id ?? null); setShowPromptDrawer(true); }}><Icon name="pencil-simple" size={13} />编辑提示词</Button></div>
            <div role="radiogroup" aria-label="本次评测使用的 Prompt 候选" className="ev-cands">
              {selected.config.candidates.map((candidate) => {
                const overrideCount = Object.keys(candidate.promptOverrides).length;
                return <button key={candidate.id} type="button" role="radio" aria-checked={candidate.id === selectedCandidateId} className={`ev-cand ${candidate.id === selectedCandidateId ? 'sel' : ''}`} onClick={() => setSelectedCandidateId(candidate.id)}>
                  <span className="ev-cand-dot" aria-hidden="true" />
                  <span className="ev-cand-b"><span className="ev-cand-t">{candidate.name}</span><span className="ev-cand-d">{overrideCount ? `替换 ${overrideCount} 个位置` : '沿用完整生产提示词'}</span></span>
                  {Boolean(overrideCount) && <span className="ev-tag">{overrideCount} 处</span>}
                </button>;
              })}
            </div>
            <div className="ev-chips">{selectedCandidate ? (Object.keys(selectedCandidate.promptOverrides).length
              ? Object.keys(selectedCandidate.promptOverrides).map((fragmentId) => <span className="ev-chip" key={fragmentId}>{FragmentLabels[fragmentId] ?? fragmentId}</span>)
              : <span className="ev-chip is-mute">沿用完整生产提示词</span>) : null}</div>
            <div className="ev-hash"><Icon name="hash" size={13} /><span>编译版本 {ShortHash(selectedPreview?.compiledHash)} · 工具集 {ShortHash(promptPreview?.toolsetHash)}</span></div>
          </section>

          <section className="ev-sec">
            <div className="ev-sec-h"><Icon name="scales" size={14} /><span>{selected.runnerType === 'prompt' ? 'judge model 配置' : '执行模型'}</span>
              {selected.runnerType === 'prompt' && <><span className="sp" /><Button variant="quiet" onClick={() => { setDimensionsDraft(structuredClone(selected.config.rubricDimensions ?? DefaultRubricDimensions)); setJudgeDraft(selected.judgePrompt); setRubricDraft(selected.rubric); setJudgeStrictJsonDraft(selected.judgeStrictJson === true); setShowJudgeDrawer(true); }}><Icon name="pencil-simple" size={13} />编辑提示词</Button></>}
            </div>
            {providersError && <p role="alert">{providersError}<Button variant="quiet" onClick={() => void ReloadProviders()}>重试</Button></p>}
            <FormField label="执行模型 · 被评测的一方">
              <Select value={ModelValue('execution')} disabled={busy} dropUp ariaLabel="执行模型" onChange={(value) => void ChangeModel('executionModel', value)} options={ModelOptions('execution')} />
            </FormField>
            {selected.runnerType === 'prompt' && <FormField label="评判模型 · 负责打分">
              <Select value={ModelValue('judge')} disabled={busy} dropUp ariaLabel="评判模型" onChange={(value) => void ChangeModel('judgeModel', value)} options={ModelOptions('judge')} />
            </FormField>}
            {selected.runnerType === 'prompt' && <div className="ev-hash"><Icon name="info" size={13} /><span>评判提示词 {selected.judgePrompt.length + selected.rubric.length} 字 · {selected.judgeStrictJson ? '严格 JSON 输出' : '附加段'} 拼进固定评判框架</span></div>}
            {displayDetail && <div className="ev-hash"><Icon name="info" size={13} /><span>本次执行：{String((displayDetail.snapshot.config as Record<string, unknown>)?.executionProvider ?? '')} · {String((displayDetail.snapshot.config as Record<string, unknown>)?.executionModel ?? '')}{selected.runnerType === 'prompt' ? `；Judge：${String((displayDetail.snapshot.config as Record<string, unknown>)?.judgeProvider ?? '')} · ${String((displayDetail.snapshot.config as Record<string, unknown>)?.judgeModel ?? '')}` : ''}</span></div>}
          </section>
        </section>

        <section className="eval-results" aria-label="评测结果">
          {runLoading && <p role="status">正在读取运行结果…</p>}
          {runError && <p role="alert">{runError}<Button variant="quiet" onClick={() => displayRun && void ReloadRun(displayRun.id)}>重试</Button></p>}
          {!runError && (!runLoading || Boolean(displayDetail)) && (!displayRun || !displayDetail || (!displayDetail.caseRuns.length && !activeRun) ? <div className="ev-empty">
            <span className="ev-empty-mark"><Icon name="flask" size={21} /></span>
            <h2>{displayRun?.status === 'cancelled' ? '本次评测没有产生结果' : '还没有评测结果'}</h2>
            <p>{displayRun?.status === 'cancelled' ? '评测在首题完成前被终止，没有留下可评估的结果。可以重新发起一次评测。' : '确认左侧的评测集、prompt 版本与评判模型后开始评测，结果会按题目逐条出现在这里。'}</p>
            <Button variant="quiet" disabled={busy || Boolean(activeRun)} onClick={() => void StartRun()}><Icon name="play" size={14} />开始评测</Button>
          </div> : <>
            <div className="ev-results-head">
              <h1>评测结果</h1>
              <div className="ev-results-run">
                <Select value={displayRun.id} ariaLabel="切换历史运行" onChange={(value) => void LoadRun(value)} options={projectRuns.map((run) => ({ value: run.id, label: `${RunStatusText(run.status)} · ${FormatTime(run.createdAt)}${run.summary?.averageScore != null ? ` · ${run.summary.averageScore.toFixed(1)} 分` : ''}` }))} />
              </div>
              <div className={`ev-score ${summary?.averageScore == null ? 'is-none' : ''}`} data-native-title="true" title={summary?.averageScore == null ? '还没有完成评分的题目' : `已完成评分 ${scoredCount} / ${displayDetail.caseRuns.length} 题的平均分`}>
                <span className="k">总分</span><b>{summary?.averageScore == null ? '暂无' : summary.averageScore.toFixed(1)}</b>
                {summary?.averageScore != null && <small>／100</small>}
              </div>
            </div>
            <div className="ev-stats">
              <div className="ev-stat">
                <div className="ev-stat-k">总 Token 数</div>
                <div className="ev-stat-v">{usage && usage.totalTokens > 0 ? usage.totalTokens.toLocaleString('zh-CN') : '暂无'}</div>
                <div className="ev-stat-d">{usage && usage.totalTokens > 0 ? `输入 ${usage.promptTokens.toLocaleString('zh-CN')} · 输出 ${usage.completionTokens.toLocaleString('zh-CN')}` : 'Provider 未返回用量'}</div>
                {usage && usage.totalTokens > 0 && <div className="ev-tok-bar" aria-hidden="true"><span style={{ width: `${Math.round((usage.promptTokens / usage.totalTokens) * 100)}%` }} /><span style={{ width: `${Math.round((usage.completionTokens / usage.totalTokens) * 100)}%` }} /></div>}
              </div>
              <div className="ev-stat">
                <div className="ev-stat-k">耗时</div>
                <div className="ev-stat-v">{FormatDuration(summary?.durationMs)}</div>
                <div className="ev-stat-d">{activeRun ? '评测进行中' : (summary?.durationMs ? '从开始到最后一题完成' : '尚未开始')}</div>
              </div>
              <div className="ev-stat">
                <div className="ev-stat-k">题目进度</div>
                <div className="ev-stat-v">{scoredCount}<small>／{displayDetail.caseRuns.length}</small></div>
                <div className="ev-stat-d">{hardFailureCount ? `硬失败 ${hardFailureCount} 题` : notExecutedCount ? `${notExecutedCount} 题未执行` : lowConfidenceCount ? `低置信 ${lowConfidenceCount} 题` : '无硬失败'}</div>
              </div>
            </div>
            <p className="ev-note">任务完成率 {summary?.taskCompletionRate == null ? '待判定' : `${(summary.taskCompletionRate * 100).toFixed(1)}%`} · 已判定 {summary?.taskEvaluatedCaseRuns ?? 0} · 未计分 {summary?.unscoredCaseRuns ?? 0} · 执行失败 {summary?.failedCaseRuns ?? 0} · 已取消 {summary?.cancelledCaseRuns ?? 0} · 未执行 {summary?.notRunCaseRuns ?? notExecutedCount}</p>
            {activeRun && <div className="ev-prog" role="progressbar" aria-label="评测进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={displayDetail.caseRuns.length ? Math.round((scoredCount / displayDetail.caseRuns.length) * 100) : 0}><div className="ev-prog-f" style={{ width: `${displayDetail.caseRuns.length ? Math.round((scoredCount / displayDetail.caseRuns.length) * 100) : 0}%` }} /></div>}
            <div className="ev-case-list-h"><Icon name="list-bullets" size={14} /><span>逐题结果</span><span className="sp" /><span>{displayDetail.caseRuns.length} 题</span></div>
            <div className="ev-cases">
              {displayDetail.caseRuns.map((caseRun, index) => {
                const opened = openCases.has(caseRun.id);
                const scored = caseRun.status === 'completed' && caseRun.score?.totalScore != null;
                const notRun = caseRun.status === 'not_run';
                const cancelled = caseRun.status === 'cancelled';
                const scoreCls = scored ? (caseRun.score!.totalScore! < 70 ? 'is-miss' : '') : (notRun ? 'is-miss' : 'is-pending');
                const scoreText = scored ? String(caseRun.score!.totalScore) : (notRun ? '未执行' : cancelled ? '已取消' : caseRun.status === 'completed' ? caseRun.score?.benchmark?.outcome === 'needs_review' ? '待复核' : caseRun.score?.benchmark?.outcome === 'environment_failure' ? '环境失败' : '未计分' : (caseRun.status === 'failed' ? '失败' : '待评测'));
                return <article className={`ev-case ${opened ? 'open' : ''}`} key={caseRun.id}>
                  <button type="button" className="ev-case-h" aria-expanded={opened} onClick={() => ToggleCase(caseRun.id)}>
                    <span className="ev-case-n">{String(index + 1).padStart(2, '0')}</span>
                    <span className="ev-case-q">{casePrompt(caseRun.caseId)}</span>
                    <span className={`ev-case-s ${scoreCls}`}><b>{scoreText}</b>{scored && <small>得分</small>}</span>
                    <Icon name="chevron-down" size={14} className="ev-chev" />
                  </button>
                  {opened && !caseDetails[caseRun.id] && !caseErrors[caseRun.id] && <p role="status">正在读取本题证据…</p>}
                  {opened && caseErrors[caseRun.id] && <p role="alert">{caseErrors[caseRun.id]}<Button variant="quiet" onClick={() => { setCaseErrors(current => { const next = { ...current }; delete next[caseRun.id]; return next; }); setCaseTick(value => value + 1); }}>重试</Button></p>}
                  {opened && (scored || caseRun.status === 'completed'
                    ? <EvaluationCaseBody summary={caseRun} detail={caseDetails[caseRun.id]} runnerType={displayRun.runnerType} />
                    : <div className="ev-case-b"><div className="ev-sub"><div className="ev-sub-h"><Icon name={notRun ? 'warning' : 'clock'} size={14} /><span>{notRun ? '本题未执行' : cancelled ? '本题执行已取消' : (caseRun.status === 'failed' ? '本题执行失败' : '等待评测')}</span></div><p className="ev-reply">{caseRun.error ? `${caseRun.error.code} · ${caseRun.error.message}` : (cancelled ? '本题开始后被取消，未形成完整评分。' : notRun ? '评测在本题开始前被终止，因此没有模型回复，也没有评判记录。' : '评测按顺序执行，本题结果会在前面题目完成后写入。')}</p></div></div>)}
                </article>;
              })}
            </div>
          </>)}
        </section>
      </div> : <section className="eval-compare" aria-label="运行对比">
        <div className="ev-cmp-head">
          <FormField label="基线">
            <Select value={leftRunId} ariaLabel="基线运行" onChange={id => SelectComparisonSide('left', id)} options={[{ value: '', label: '选择基线运行' }, ...projectRuns.filter((run) => TerminalStatuses.has(run.status) && run.id !== rightRunId).map((run) => ({ value: run.id, label: `${RunStatusText(run.status)} · ${FormatTime(run.createdAt)}${run.summary?.averageScore != null ? ` · ${run.summary.averageScore.toFixed(1)} 分` : ''}` }))]} />
          </FormField>
          <div className="ev-cmp-delta">{(() => {
            const base = compare?.samples?.leftMean, cand = compare?.samples?.rightMean;
            if (base == null || cand == null) return <span className="ev-delta-pill"><span className="k">总分差</span>--</span>;
            const delta = cand - base;
            const text = Math.abs(delta) < 0.05 ? '持平' : `${delta < 0 ? '-' : '+'}${Math.abs(delta).toFixed(1)}`;
            return <span className={`ev-delta-pill ${delta < -0.05 ? 'is-neg' : ''}`} data-native-title="true" title={`候选 ${cand.toFixed(1)} - 基线 ${base.toFixed(1)}`}><span className="k">总分差</span>{text}</span>;
          })()}</div>
          <FormField label="候选">
            <Select value={rightRunId} ariaLabel="候选运行" onChange={id => SelectComparisonSide('right', id)} options={[{ value: '', label: '选择候选运行' }, ...projectRuns.filter((run) => TerminalStatuses.has(run.status) && run.id !== leftRunId).map((run) => ({ value: run.id, label: `${RunStatusText(run.status)} · ${FormatTime(run.createdAt)}${run.summary?.averageScore != null ? ` · ${run.summary.averageScore.toFixed(1)} 分` : ''}` }))]} />
          </FormField>
          <Button disabled={busy} onClick={() => void RunCompare()}>对比</Button>
        </div>
        {!compare ? <div className="ev-empty"><span className="ev-empty-mark"><Icon name="scales" size={21} /></span><h2>选择两侧的运行记录</h2><p>对比读的是两次评测已经落盘的题目结果。prompt 候选是实验变量；其余条件任意不一致，都会被标注为非严格 A/B。</p></div> : <>
          <div className={`ev-cmp-banner ${compare.strictComparison ? 'is-strict' : 'is-warn'}`}>
            <Icon name={compare.strictComparison ? 'seal-check' : 'warning-circle'} size={16} />
            <b>{compare.strictComparison ? '严格可比' : '非严格 A/B'}</b>
            <span>{compare.strictComparison ? '除 prompt 候选外两侧的运行条件一致，分数按配对样本比较；模型随机性仍可能影响结果。' : `${compare.differingSnapshotFields.join('、')}不一致，分数差异不能当作严格 A/B 结论。`}</span>
            <span className="sp" />
            <Button variant="quiet" aria-pressed={showConds} onClick={() => setShowConds((current) => !current)}><Icon name="list-checks" size={13} />{showConds ? '收起条件' : '可复现条件'}</Button>
          </div>
          {showConds && <div className="ev-cmp-conds">
            <div className="ev-cmp-conds-h"><Icon name="lock-key" size={14} /><span>可复现条件</span></div>
            <p className="ev-cmp-note">prompt 候选是实验变量，允许两侧不同；其余条件来自两次运行各自冻结的快照。</p>
            <div className="ev-cmp-ct">{(() => {
              const rows: Array<{ label: string; left: string; right: string }> = [
                { label: '运行方式', left: compareLeft?.runnerType === 'browser' ? '浏览器测评' : 'Prompt 测评', right: compareRight?.runnerType === 'browser' ? '浏览器测评' : 'Prompt 测评' },
                { label: '数据集版本', left: ShortHash((compareLeft?.snapshot as any)?.datasetVersion), right: ShortHash((compareRight?.snapshot as any)?.datasetVersion) },
                { label: '执行模型', left: `${(compareLeft?.snapshot as any)?.config?.executionProvider ?? ''} ${(compareLeft?.snapshot as any)?.config?.executionModel ?? ''}`, right: `${(compareRight?.snapshot as any)?.config?.executionProvider ?? ''} ${(compareRight?.snapshot as any)?.config?.executionModel ?? ''}` },
                { label: '评判模型', left: `${(compareLeft?.snapshot as any)?.config?.judgeModel ?? '—'}`, right: `${(compareRight?.snapshot as any)?.config?.judgeModel ?? '—'}` },
                { label: '工具集', left: ShortHash((compareLeft?.snapshot as any)?.toolsetHash), right: ShortHash((compareRight?.snapshot as any)?.toolsetHash) },
                { label: '最大模型轮数', left: String((compareLeft?.snapshot as any)?.config?.maxModelTurns ?? '—'), right: String((compareRight?.snapshot as any)?.config?.maxModelTurns ?? '—') },
                { label: '重复次数', left: String((compareLeft?.snapshot as any)?.environment?.repeatCount ?? '—'), right: String((compareRight?.snapshot as any)?.environment?.repeatCount ?? '—') },
                { label: '并发数', left: String((compareLeft?.snapshot as any)?.environment?.maxConcurrency ?? '—'), right: String((compareRight?.snapshot as any)?.environment?.maxConcurrency ?? '—') },
                { label: 'prompt 候选', left: ((compareLeft?.snapshot as any)?.config?.candidates ?? []).map((candidate: EvalPromptCandidate) => candidate.name).join('、') || '—', right: ((compareRight?.snapshot as any)?.config?.candidates ?? []).map((candidate: EvalPromptCandidate) => candidate.name).join('、') || '—' },
              ];
              return rows.map((row) => <div className={`ev-cmp-ct-row ${row.left === row.right ? '' : 'is-diff'}`} key={row.label}><span className="k">{row.label}</span><span className="v">{row.left}</span><span className="v">{row.right}</span></div>);
            })()}</div>
          </div>}
          {(() => {
            const leftCases = new Map<string, string>((compareLeft?.snapshot as any)?.cases?.map((item: any) => [item.id as string, item.input.userMessage as string]) ?? []);
            const rightCases = new Map<string, string>((compareRight?.snapshot as any)?.cases?.map((item: any) => [item.id as string, item.input.userMessage as string]) ?? []);
            const caseIds = [...new Set([...(compareLeft?.caseRuns ?? []).map((item) => item.caseId), ...(compareRight?.caseRuns ?? []).map((item) => item.caseId)])];
            if (!caseIds.length) return <p className="ev-cmp-note">两侧都还没有逐题结果。</p>;
            const matched = caseIds.filter((caseId) => leftCases.has(caseId) && rightCases.has(caseId));
            return <>
              <p className="ev-cmp-note">两侧共有 {compare?.samples?.commonCaseCount ?? matched.length} 道题；仅基线 {compare?.samples?.leftOnlyCaseCount ?? 0}，仅候选 {compare?.samples?.rightOnlyCaseCount ?? 0}。已配对评分 {compare?.samples?.pairedCount ?? 0} 组；均分和分差仅使用相同题目、配对候选及相同 repeat 序号。± 为样本标准差。</p>
              <div className="ev-cmp-list">
                <div className="ev-cmp-row is-head"><span className="ev-cmp-q">题目 / 候选配对</span><span>基线均分</span><span className="ev-cmp-delta-cell">配对分差</span><span>候选均分</span></div>
                {(compare?.samples?.rows ?? []).map((row, index) => {
                  const a = row.left.mean, b = row.right.mean;
                  const delta = a != null && b != null ? b - a : null;
                  const promptText = leftCases.get(row.caseId) ?? rightCases.get(row.caseId) ?? row.caseId;
                  return <div className="ev-cmp-row" key={`${row.caseId}-${index}`}>
                    <span className="ev-cmp-q" title={promptText}>{promptText}<small>{row.leftCandidate} / {row.rightCandidate} · 配对 {row.pairedCount}</small></span>
                    <span>{a == null ? '--' : a.toFixed(1)}{row.left.stddev != null && ` ± ${row.left.stddev.toFixed(1)}`}<small>已评分 {row.leftScored} / {row.leftTotal}</small></span>
                    <span className="ev-cmp-delta-cell">{delta == null ? '--' : `${delta < 0 ? '-' : '+'}${Math.abs(delta).toFixed(1)}`}</span>
                    <span>{b == null ? '--' : b.toFixed(1)}{row.right.stddev != null && ` ± ${row.right.stddev.toFixed(1)}`}<small>已评分 {row.rightScored} / {row.rightTotal}</small></span>
                  </div>;
                })}
              </div>
            </>;
          })()}
        </>}
      </section>}
    </div>

    <Modal open={showStop} title="确认终止本次评测？" onClose={() => setShowStop(false)} footer={<><DialogButton onClick={() => setShowStop(false)}>取消</DialogButton><DialogButton tone="danger" disabled={busy} onClick={() => void CancelRun()}>终止评测</DialogButton></>}>
      <ul className="ev-stop-list">
        <li>已完成的题目和评分会保留；</li>
        <li>未执行的题目不会补跑；</li>
        <li>需要重新评测时，请再发起一次新的评测。</li>
      </ul>
    </Modal>
    <Modal open={showManage} title="管理测试集版本" variant="dialog" onClose={() => setShowManage(false)} footer={<><DialogButton onClick={() => setShowManage(false)}>完成</DialogButton><DialogButton disabled={busy || !importJsonl.trim()} onClick={() => void CheckImport()}>检查兼容性</DialogButton><DialogButton tone="accent" disabled={busy || !importJsonl.trim()} onClick={() => void ImportVersion()}>导入为新版本</DialogButton></>}>
      <p className="ev-manage-note">测试集在导入时冻结成一个版本，已经跑过的评测始终读它当时用到的那一版，删除版本不会改变已有结果。</p>
      <div className="ev-ds-list">
        {versionsLoading && <p role="status">正在读取测试集…</p>}
        {versionsError && <p role="alert">{versionsError}<Button variant="quiet" onClick={() => selected && void ReloadVersions(selected.id).catch(() => undefined)}>重试</Button></p>}
        {!versionsLoading && !versionsError && versions.length === 0 && <p>尚未导入测试集</p>}
        {versions.map((item) => <div className={`ev-ds-row ${item.isCurrent ? 'on' : ''}`} key={item.version}>
          <Icon name="database" size={16} />
          <span className="ev-ds-body">
            <span className="ev-ds-t">{ShortHash(item.version)}<span className="v">{item.caseCount} 案例</span>
              {item.isCurrent && <span className="ev-tag is-accent">当前使用</span>}
              {Boolean(item.runCount) && <span className="ev-tag">{item.runCount} 条运行</span>}
            </span>
            <span className="ev-ds-d">导入于 {FormatTime(item.importedAt)}</span>
          </span>
          <Button variant="quiet" aria-label={`删除版本 ${ShortHash(item.version)}`} disabled={busy} onClick={() => setDeleteVersion(item.version)}><Icon name="delete" size={14} /></Button>
        </div>)}
      </div>
      <div className="ev-manage-import">
        <TextFileUpload label="上传测试集" disabled={busy} accept=".jsonl,application/json" hint="支持 .jsonl，最多 8 MiB；每行一个 JSON 案例" maxBytes={8 * 1024 * 1024} onLoad={ChangeImportText} onError={(message) => ShowNotice(message, 'error')} />
        <FormField label="测试集内容" hint="坏行会整体拒绝并返回行号。"><textarea disabled={busy} rows={6} value={importJsonl} onChange={(event) => ChangeImportText(event.target.value)} /></FormField>
        {datasetTemplate && <details><summary>查看当前评测方式的 JSONL 模板</summary><textarea aria-label="当前评测方式的 JSONL 模板" readOnly rows={5} value={datasetTemplate} /></details>}
        {importPreview && <section className="ev-import-preview" aria-label="测试集兼容性检查" aria-live="polite">
          <p>{importPreview.valid ? '检查通过' : '检查未通过'} · {importPreview.caseCount} 题 · {importPreview.environment === 'prompt' ? 'Prompt 测评' : importPreview.environment === 'career-portal' ? '网申填写测评' : '普通浏览器测评'}{importPreview.expectedFixtureVersion ? ` · Fixture ${importPreview.expectedFixtureVersion}` : ''}</p>
          {importPreview.diagnostics.map((item, index) => <div className="ev-req is-fail" key={`${item.line}-${item.code}-${index}`}><span className="ev-req-b"><b>{item.line ? `第 ${item.line} 行` : '文件'}{item.caseId ? ` · ${item.caseId}` : ''}</b><span>{item.message}</span>{(item.declaredVersion || item.expectedVersion) && <small>声明版本：{item.declaredVersion ?? '未声明'}；要求版本：{item.expectedVersion ?? '不适用'}</small>}<small>{item.action}</small></span></div>)}
        </section>}
      </div>
    </Modal>
    <Modal open={Boolean(deleteVersion)} title="删除测试集版本" onClose={() => setDeleteVersion(null)} footer={<><DialogButton onClick={() => setDeleteVersion(null)}>取消</DialogButton><DialogButton tone="danger" disabled={busy} onClick={() => void ConfirmDeleteVersion()}>删除这个版本</DialogButton></>}>
      「{ShortHash(deleteVersion)}」会从列表里移除并清理版本文件。{versions.length === 1 ? '删除后测试集为空，需要重新导入才能开始评测。' : '删除当前版本后会切换到最近的剩余版本。'}历史运行保留自己的冻结快照，结果不受影响。
    </Modal>
    {showJudgeDrawer && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={() => setShowJudgeDrawer(false)} />
      <aside className="dw-drawer is-eval ev-drawer" role="dialog" aria-modal="true" aria-label="编辑评判提示词">
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title">编辑评判提示词</div>
            <div className="dw-meta"><span>评判模型：{selected?.config.judgeModel ?? '—'}</span><span>改动保存后下次评测生效</span></div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭" title="关闭" onClick={() => setShowJudgeDrawer(false)}><Icon name="close" size={15} /></button>
        </div>
        <div className="dw-body">
          <div className="ev-drawer-toolbar">
            <span className="ev-switch-row">
              严格 JSON 输出
              <button className="switch" type="button" role="switch" aria-checked={judgeStrictJsonDraft} aria-label="严格 JSON 输出" onClick={() => setJudgeStrictJsonDraft((current) => !current)}><span className="knob" /></button>
            </span>
            <span className="ev-drawer-hint">支持结构化输出的模型可以开启，将输出严格限制为 JSON 格式。</span>
          </div>
          <label className="dw-field">
            <span className="lab">评判提示词附加段</span>
            <textarea rows={9} spellCheck={false} value={judgeDraft} onChange={(event) => setJudgeDraft(event.target.value)} />
            <small>当前 {judgeDraft.length} 字，最多 100000 字。</small>
          </label>
          <label className="dw-field">
            <span className="lab">评分标准 Rubric</span>
            <textarea rows={6} spellCheck={false} value={rubricDraft} onChange={(event) => setRubricDraft(event.target.value)} />
          </label>
            <div className="ev-rubric-dimensions">
              {dimensionsDraft.map((dimension, index) => <div className="ev-rubric-row" key={index}>
                <input aria-label={`维度 ${index + 1} ID`} value={dimension.id} onChange={event => setDimensionsDraft(current => current.map((item, i) => i === index ? { ...item, id: event.target.value } : item))} />
                <input aria-label={`维度 ${index + 1} 名称`} value={dimension.label} onChange={event => setDimensionsDraft(current => current.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} />
                <input type="number" aria-label={`维度 ${index + 1} 权重`} min={0.01} max={100} value={dimension.weight} onChange={event => setDimensionsDraft(current => current.map((item, i) => i === index ? { ...item, weight: Number(event.target.value) } : item))} />
                <Button variant="quiet" disabled={dimensionsDraft.length <= 1} onClick={() => setDimensionsDraft(current => current.filter((_, i) => i !== index))}>删除</Button>
              </div>)}
              <Button variant="quiet" disabled={dimensionsDraft.length >= 20} onClick={() => setDimensionsDraft(current => [...current, { id: `dimension${current.length + 1}`, label: '新维度', weight: 1 }])}>添加维度</Button>
              <span>权重合计 {dimensionsDraft.reduce((sum, item) => sum + item.weight, 0).toFixed(2)} / 100</span>
            </div>
          <p className="ev-drawer-note">评判模型结合题目、原始资料、执行事件、最终状态和模型回答评分。状态要求另做程序校验；浏览器测评使用确定性断言。</p>
        </div>
        <div className="dw-foot">
          <span className="dw-note">{judgeDirty ? '有未保存的修改' : '尚未修改'}</span>
          <span className="dw-foot-spacer" />
          <DialogButton onClick={() => setShowJudgeDrawer(false)}>取消</DialogButton>
          <DialogButton tone="accent" disabled={busy || !judgeDirty} onClick={() => void SaveJudgePrompt()}>保存修改</DialogButton>
        </div>
      </aside>
    </div>, document.body)}
    {showPromptDrawer && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={() => setShowPromptDrawer(false)} />
      <aside className="dw-drawer is-eval ev-drawer" role="dialog" aria-modal="true" aria-label="编辑 prompt">
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title">编辑 prompt</div>
            <div className="dw-meta"><span>共 {candidateDraft.length} 个版本</span><span>只替换列出的片段，其余沿用生产提示词</span></div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭" title="关闭" onClick={() => setShowPromptDrawer(false)}><Icon name="close" size={15} /></button>
        </div>
        <div className="dw-body">
          {(() => {
            const tab = candidateDraft.find((candidate) => candidate.id === drawerCandidateId) ?? candidateDraft[0] ?? null;
            if (!tab) return null;
            const tabEntries = Object.entries(tab.promptOverrides);
            const usedIds = new Set(tabEntries.map(([fragmentId]) => fragmentId));
            const full = tabEntries.length >= fragmentOptions.length;
            return <>
              <div className="seg" role="tablist" aria-label="prompt 版本">
                {candidateDraft.map((candidate) => <button key={candidate.id} type="button" role="tab" aria-selected={candidate.id === tab.id} className={`seg-i ${candidate.id === tab.id ? 'sel' : ''}`} title={candidate.name} onClick={() => setDrawerCandidateId(candidate.id)}>{candidate.name.replace(/^候选 [A-Z] · /, '')}</button>)}
              </div>
              <label className="dw-field">
                <span className="lab">版本名称</span>
                <input value={tab.name} onChange={(event) => UpdateCandidate(tab.id, (current) => ({ ...current, name: event.target.value }))} />
              </label>
              <div className="ev-drawer-row">
                <span className="lab">替换位置</span>
                <span className="ev-tag">{tabEntries.length} / {fragmentOptions.length}</span>
                <span className="sp" />
                <DialogButton disabled={full || !fragmentOptions.length} onClick={() => AddPromptOverride(tab.id)}><Icon name="plus" size={13} />添加替换位置</DialogButton>
              </div>
              {tabEntries.length ? tabEntries.map(([fragmentId, content], index) => {
                const base = fragmentOptions.find((fragment) => fragment.id === fragmentId)?.content ?? '';
                const changed = content.trim() !== base.trim();
                const options = fragmentOptions.filter((fragment) => fragment.id === fragmentId || !usedIds.has(fragment.id)).map((fragment) => ({ value: fragment.id, label: FragmentLabels[fragment.id] ?? fragment.id }));
                return <section className="frag" key={fragmentId}>
                  <div className="frag-h">
                    <span className="n">{String(index + 1).padStart(2, '0')}</span>
                    <Select className="frag-pick" value={fragmentId} ariaLabel={`替换位置 ${index + 1}`} onChange={(nextId) => ChangePromptOverride(tab.id, fragmentId, nextId)} options={options} />
                    {changed ? <span className="ev-tag is-accent">已改写</span> : <span className="ev-tag">未改动</span>}
                    <button className="icon-btn sm" type="button" aria-label="移除这个替换位置" title="移除" onClick={() => RemovePromptOverride(tab.id, fragmentId)}><Icon name="trash-simple" size={13} /></button>
                  </div>
                  <label className="dw-field">
                    <span className="lab">替换后的内容</span>
                    <textarea rows={7} spellCheck={false} value={content} onChange={(event) => UpdateCandidate(tab.id, (current) => ({ ...current, promptOverrides: { ...current.promptOverrides, [fragmentId]: event.target.value } }))} />
                  </label>
                  <details className="dw-base">
                    <summary><Icon name="eye" size={13} />对照生产提示词</summary>
                    <pre><PromptDiffPreview productionPrompt={base} candidatePrompt={content} /></pre>
                  </details>
                </section>;
              }) : <p className="ev-drawer-note">这个版本没有替换任何片段，会完整使用生产提示词。</p>}
            </>;
          })()}
        </div>
        <div className="dw-foot">
          <span className="dw-note">{promptDirty ? '有未保存的修改' : '尚未修改'}</span>
          <span className="dw-foot-spacer" />
          <DialogButton onClick={() => setShowPromptDrawer(false)}>取消</DialogButton>
          <DialogButton tone="accent" disabled={busy || !promptDirty} onClick={() => void SaveCandidates()}>保存修改</DialogButton>
        </div>
      </aside>
    </div>, document.body)}
  </div>;
}
