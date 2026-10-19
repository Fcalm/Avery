import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import type { AgentObservability, AgentStreamEvent, BrowserActionState, ConfirmationMode, ConversationResource, ReasoningEffort } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { WORKSPACE_QUERY_KEY, type WorkspaceData } from '../../../features/workspace/api/workspaceData';
import { LoadWorkspaceData } from '../../../features/workspace/api/useWorkspaceData';
import { MergeWorkspaceSnapshot } from '../../../features/workspace/api/workspaceMerge';
import {
  useAppendConversationMessages, useCompleteConversationMessage, useConversations,
  useCreateConversation, usePatchConversations, useRemoveConversationMessage,
} from '../../../features/conversation/api/conversationQueries';
import { useResumes, useUpsertResume } from '../../../features/resume/api/resumeQueries';
import { useSettings } from '../../../features/settings/api/settingsQueries';
import { ApplyModelCatalogToProviders, LoadModelCatalog, SubscribeModelCatalog } from '../../../features/settings/api/modelCatalog';
import { DocSidePanel } from '../components/DocSidePanel';
import {
  AcquireResumeEditLock, BindProjectEnvironment, CancelAgentRequest, RespondToAgentInteraction, GetAgentObservability, GetAgentTraceEvents, GetProviderCatalog, GetSessionAssistantState, ImportAttachmentFile,
  ReleaseResumeEditLock, ReloadAgentSession, SelectAgentProjectDirectory, SendAgentRequest, SubscribeAgentStream, UpdateAgentConfirmationMode, UpdateAgentReasoningEffort,
} from '../../../features/assistant/api/agentQueries';
import { Button, DialogButton, Modal, Select } from '../../../shared/components/UI';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { ASSISTANT_MAIN_MIN_WIDTH } from '../../../shared/layoutConstants';
import { CalculateTokenSharePercent, CreateSessionTokenUsage, CreateSessionUsagePresentation } from '../usagePresentation';
import { ConversationTrace } from '../../assistant/components/ConversationTrace';
import type { ChatMessage, PageId } from '../../../types/domain';
import { useSessionValue } from '../useSessionValue';
import { ConversationMessage } from '../components/ConversationMessage';

// 保持旧场景 ID 以兼容会话与定时任务；能力边界与后端白名单一致。
const ScenarioOptions: Array<{ id: 'default' | 'application'; label: string; icon: IconName; description: string }> = [
  { id: 'default', label: '聊天', icon: 'assistant', description: '日常问答、资料分析和草稿建议，只读资料，不保存改动或操作浏览器。' },
  { id: 'application', label: '工作', icon: 'briefcase', description: '编辑简历和档案、管理岗位与定时任务，并使用浏览器完成求职任务。' },
];
const FallbackDeepSeekModels = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
const FallbackMimoModels = ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'];
const FallbackReasoningEfforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ReasoningEffortLabels: Record<ReasoningEffort, string> = {
  low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
};
// 确认档位不授予工具权限；读取与写入能力由当前场景决定。
const ConfirmationOptions: Array<{ id: ConfirmationMode; label: string; description: string; note: string; icon: IconName }> = [
  { id: 'always_confirm', label: '始终确认', description: '当前场景内的业务写入和外部动作先征求确认，读取无需确认。', note: '始终确认：业务写入和外部动作执行前请你确认', icon: 'shield-check' },
  { id: 'allow_low_risk', label: '低风险自动', description: '低风险操作自动执行，其他业务写入和外部动作仍按工具策略确认。', note: '低风险自动：其他操作仍按工具策略确认', icon: 'pencil-simple' },
  { id: 'fully_trusted', label: '完全信任', description: '自动执行当前场景内已授权的操作；工具强制确认、文件授权和站点限制仍有效。', note: '完全信任：不扩大场景能力，强制确认仍有效', icon: 'robot' },
];
/** 思考强度菜单的档位说明；强度越高推理越深，耗时与 token 消耗随之增加。 */
const ReasoningEffortDescriptions: Record<ReasoningEffort, string> = {
  low: '直接作答，几乎不占用思考时间。',
  medium: '适度自查要点，速度与质量均衡。',
  high: '会多轮自查后再回答，适合改简历和准备面试。',
  xhigh: '更深入地拆解任务，适合复杂的多步骤工作。',
  max: '穷尽推理与规划，耗时最长，适合最棘手的问题。',
};

/** 上下文弹层中的 token 数按 k 缩写；无数据时显示占位符，不编造用量。 */
function FormatTokenCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(Math.round(value));
}

type SessionUsageView = {
  percent: number; threshold: number; compressionCount: number; tokens: number; limit: number;
  source: 'actual' | 'unavailable' | 'legacy_estimate' | 'loading'; promptTokens: number; completionTokens: number; totalTokens: number; cachedInputTokens: number; reportedRequestCount: number; unreportedRequestCount: number;
};
const EmptyUsage: SessionUsageView = {
  percent: 0, threshold: 80, compressionCount: 0, tokens: 0, limit: 256000,
  source: 'loading', promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0,
};
const ComposerCompactWidth = 640;

function UpgradeDeepSeekModel(model: string | undefined) {
  return model === 'deepseek-chat' || model === 'deepseek-reasoner' || !model ? 'deepseek-v4-flash' : model;
}

/** 官方单模型 Provider 不接受会话遗留的其他模型名；切换供应商后立即归一化本地会话选择。 */
function ResolveProviderModel(provider: string, model: string | undefined) {
  if (provider === 'Z.AI') return 'glm-5.3-flash';
  if (provider === 'MIMO') return model?.trim().startsWith('mimo-') ? model.trim() : 'mimo-v2.6-flash';
  return provider === 'DeepSeek' ? UpgradeDeepSeekModel(model) : model?.trim() || 'deepseek-v4-flash';
}

/** 当前模型列表只返回名称，没有随模型返回可用思考档位；后续接入元数据时仅需在此处替换回退列表。 */
function GetReasoningEffortOptions(_model: string): ReasoningEffort[] {
  return FallbackReasoningEfforts;
}

function IsReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && FallbackReasoningEfforts.includes(value as ReasoningEffort);
}

function GetDefaultReasoningEffort(options: ReasoningEffort[]) {
  return options.includes('medium') ? 'medium' : options[0] ?? 'medium';
}

type ComposerAttachment =
  | { id: string; name: string; status: 'uploading' }
  | { id: string; name: string; path: string; status: 'ready' };
interface AgentTodo { id: string; title: string; description: string; status: string; }
/** 单个会话的 Todo 状态：todos 是该会话已创建的条目，active 表示该会话已有带 Todo 的运行。 */
interface AgentTaskState { todos: AgentTodo[]; active: boolean; }
const EmptyAgentTaskState: AgentTaskState = { todos: [], active: false };
type SupportedProvider = 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义';
type ProviderCatalogEntry = { provider: SupportedProvider; configured: boolean; model: string; models: string[] };

function GetTodoPresentation(status: string) {
  if (status === 'cancelled' || status === 'deleted') return { className: 'is-deleted', symbol: '×', label: '已删除' };
  if (status === 'completed') return { className: 'is-completed', symbol: '✓', label: '已完成' };
  if (status === 'inProgress' || status === 'in_progress') return { className: 'is-in-progress', symbol: '●', label: '进行中' };
  return { className: 'is-pending', symbol: '○', label: '待办' };
}

/**
 * 会话级 UI 配置暂存于 Renderer 本地存储：用于在切换会话或重新进入页面时恢复选择。
 * 它不是权限授予凭据；实际执行仍由每次请求携带的 confirmationMode 和主进程校验决定。
 */
interface StoredConversationComposerState {
  confirmationMode: ConfirmationMode;
  provider: SupportedProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
}

const ConversationComposerStateStorageKey = 'avery.assistant.conversation-composer-state.v1';

function ReadConversationComposerStates(): Record<string, StoredConversationComposerState> {
  try {
    const raw = window.localStorage.getItem(ConversationComposerStateStorageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const states: Record<string, StoredConversationComposerState> = {};
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as Partial<StoredConversationComposerState>;
      if (!['always_confirm', 'allow_low_risk', 'fully_trusted'].includes(candidate.confirmationMode ?? '') || typeof candidate.model !== 'string' || !candidate.model.trim()) continue;
      states[conversationId] = {
        confirmationMode: candidate.confirmationMode as ConfirmationMode,
        provider: candidate.provider === 'Z.AI' || candidate.provider === '自定义' || candidate.provider === 'DeepSeek' || candidate.provider === 'MIMO'
          ? candidate.provider
          : candidate.model === 'glm-5.3-flash' ? 'Z.AI' : candidate.model.startsWith('mimo-') ? 'MIMO' : candidate.model.startsWith('deepseek-') ? 'DeepSeek' : '自定义',
        model: candidate.model,
        // 兼容已有的会话缓存：旧缓存未保存档位时使用中档。
        reasoningEffort: IsReasoningEffort(candidate.reasoningEffort) ? candidate.reasoningEffort : 'medium',
      };
    }
    return states;
  } catch {
    // 本地缓存损坏时以安全默认值继续，不阻断会话功能。
    return {};
  }
}

function WriteConversationComposerStates(states: Record<string, StoredConversationComposerState>) {
  try {
    window.localStorage.setItem(ConversationComposerStateStorageKey, JSON.stringify(states));
  } catch {
    // 隐私模式或存储配额异常不影响本轮请求；状态仅无法跨页面恢复。
  }
}

function AssistantPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { activeConversationId, setActiveConversationId, currentResumeId, setCurrentResumeId, resumePanelOpen, setResumePanelOpen, assistantView, ShowNotice, composerSeed, setComposerSeed } = useUiStore();
  const conversations = useConversations();
  const resumes = useResumes();
  const settings = useSettings();
  const createConversation = useCreateConversation({ onFailure: () => ShowNotice('会话创建失败，请稍后重试。') });
  const appendMessages = useAppendConversationMessages({ onFailure: () => ShowNotice('消息保存失败，请稍后重试。') });
  const completeMessage = useCompleteConversationMessage({ onFailure: () => ShowNotice('消息保存失败，请稍后重试。') });
  const removeMessage = useRemoveConversationMessage();
  const upsertResume = useUpsertResume({ onConflict: () => ShowNotice('简历已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('简历保存失败，请稍后重试。') });
  const patchConversations = usePatchConversations();
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
  const [projectEnvironment, setProjectEnvironment] = useState<{ projectId: string | null; name: string } | null>(null);
  const [permission, setPermission] = useState<ConfirmationMode>('always_confirm');
  const [showPermission, setShowPermission] = useState(false);
  const [showFullyTrustedWarning, setShowFullyTrustedWarning] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showReasoningEffort, setShowReasoningEffort] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [scenarioId, setScenarioId] = useState<'default' | 'application'>('default');
  const [provider, setProvider] = useState<SupportedProvider>(settings.provider);
  const [model, setModel] = useState(ResolveProviderModel(settings.provider, settings.model));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>([
    { provider: settings.provider, configured: true, model: settings.model, models: settings.provider === 'DeepSeek' ? FallbackDeepSeekModels : settings.provider === 'MIMO' ? FallbackMimoModels : [ResolveProviderModel(settings.provider, settings.model)] },
  ]);
  const [panelWidth, setPanelWidth] = useState(430);
  const [isComposerCompact, setIsComposerCompact] = useState(false);
  const [editing, setEditing] = useState(false);
  const [resumeText, setResumeText] = useState(resumes.find((item) => item.id === currentResumeId)?.content ?? '');
  const [savedText, setSavedText] = useState(resumeText);
  const [history, setHistory] = useState<string[]>([]);
  const [resourcePreview, setResourcePreview] = useState<{ sessionId: string; resource: ConversationResource } | null>(null);
  const [runsBySession, setRunsBySession] = useState<Record<string, string | undefined>>({});
  const taskVersions = useRef<Record<string, number>>({});
  const interactionBusy = useRef(new Set<string>());
  const [tasksBySession, setTasksBySession] = useState<Record<string, AgentTaskState>>({});
  const [pendingEdit, setPendingEdit, setPendingEditForSession, pendingEditVersions] = useSessionValue<{ requestId: string; confirmationId: string; name?: string; content: string; reason: string } | null>(activeConversationId, null);
  const [pendingBrowserAction, setPendingBrowserAction, setPendingBrowserActionForSession, pendingBrowserActionVersions] = useSessionValue<(BrowserActionState & { requestId: string }) | null>(activeConversationId, null);
  const [pendingCronTask, setPendingCronTask, setPendingCronTaskForSession, pendingCronTaskVersions] = useSessionValue<{ requestId: string; confirmationId: string; title: string; message: string; scenarioId: 'default' | 'application'; schedule: unknown; summary: string } | null>(activeConversationId, null);
  const [pendingQuestions, setPendingQuestions, setPendingQuestionsForSession, pendingQuestionsVersions] = useSessionValue<{ requestId: string; interactionId: string; questions: Array<{ id: string; question: string; options: string[] }> } | null>(activeConversationId, null);
  const [questionAnswers, setQuestionAnswers, setQuestionAnswersForSession, questionAnswersVersions] = useSessionValue<Record<string, string>>(activeConversationId, {});
  const [otherAnswers, setOtherAnswers, setOtherAnswersForSession, otherAnswersVersions] = useSessionValue<Record<string, string>>(activeConversationId, {});
  const [pendingQuestionIndex, setPendingQuestionIndex, setPendingQuestionIndexForSession, pendingQuestionIndexVersions] = useSessionValue(activeConversationId, 0);
  const [usage, setUsage] = useState(EmptyUsage);
  const [observability, setObservability] = useState<AgentObservability | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const enteredConversationRef = useRef<string | null>(null);
  const resumeSideRef = useRef<HTMLElement>(null);
  const activeRequestsRef = useRef(new Map<string, string>());
  const activePlaceholdersRef = useRef(new Map<string, { conversationId: string; requestId: string; content: string; thinkingContent: string }>());
  const sendInFlightRef = useRef(new Set<string>());
  const runVersions = useRef<Record<string, number>>({});
  const resumesRef = useRef(resumes);
  // 用户编辑锁：记录持有锁的简历，保存/取消/卸载时释放。
  const editLockRef = useRef<string | null>(null);
  // 最新值 ref：流式订阅只依赖稳定引用，避免每次渲染重订阅。
  const completeMessageRef = useRef(completeMessage);
  const removeMessageRef = useRef(removeMessage);
  const patchConversationsRef = useRef(patchConversations);
  const activeConversationRef = useRef(activeConversationId);
  const conversationsRef = useRef(conversations);
  const nextDraftScenarioRef = useRef<'default' | 'application' | null>(null);
  const sessionLoadVersionRef = useRef(0);
  const workspaceRefreshVersionRef = useRef(0);
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState(0);
  const queryClient = useQueryClient();
  completeMessageRef.current = completeMessage;
  removeMessageRef.current = removeMessage;
  patchConversationsRef.current = patchConversations;
  activeConversationRef.current = activeConversationId;
  conversationsRef.current = conversations;

  /**
   * 后台事件可能和确认后的消息追加并发。直接 invalidate 整个 workspace 会让迟到旧快照
   * 覆盖新消息，因此读取完成后必须与当时最新缓存原子合并。
   */
  const RefreshWorkspacePreservingMessages = useCallback(async () => {
    const version = ++workspaceRefreshVersionRef.current;
    const baseline = queryClient.getQueryData<WorkspaceData>(WORKSPACE_QUERY_KEY);
    try {
      const remote = await LoadWorkspaceData();
      if (version !== workspaceRefreshVersionRef.current) return;
      queryClient.setQueryData<WorkspaceData>(WORKSPACE_QUERY_KEY, (local) => MergeWorkspaceSnapshot(baseline, local, remote));
    } catch {
      // 后台刷新失败不影响当前会话；下次页面进入或业务事件会再次读取。
    }
  }, [queryClient]);

  const SetSessionRun = useCallback((sessionId: string, requestId: string | undefined, completedRequestId?: string) => {
    const current = activeRequestsRef.current.get(sessionId);
    if (completedRequestId && current && current !== completedRequestId) return;
    runVersions.current[sessionId] = (runVersions.current[sessionId] ?? 0) + 1;
    if (requestId) activeRequestsRef.current.set(sessionId, requestId);
    else activeRequestsRef.current.delete(sessionId);
    setRunsBySession((runs) => ({ ...runs, [sessionId]: requestId }));
  }, []);

  /** Todo 归属产生它的那次会话：Agent 的 task_* 事件带 sessionId，按会话写入，切换会话不再串台。 */
  const UpdateSessionTasks = useCallback((sessionId: string, update: (state: AgentTaskState) => AgentTaskState) => {
    taskVersions.current[sessionId] = (taskVersions.current[sessionId] ?? 0) + 1;
    setTasksBySession((current) => ({ ...current, [sessionId]: update(current[sessionId] ?? EmptyAgentTaskState) }));
  }, []);

  const RefreshConversationTrace = useCallback(async () => {
    setObservability(await GetAgentObservability());
  }, []);

  useEffect(() => {
    if (assistantView === 'trace') void RefreshConversationTrace();
  }, [activeConversationId, assistantView, RefreshConversationTrace]);

  const conversation = useMemo(() => conversations.find((item) => item.id === activeConversationId), [conversations, activeConversationId]);
  const conversationResources = useMemo(() => conversation?.messages.flatMap((message) => message.presentation?.parts.flatMap((part) => part.type === 'resource' ? [part.resource] : []) ?? []) ?? [], [conversation]);
  const resume = resumes.find((item) => item.id === currentResumeId);
  const usagePresentation = CreateSessionUsagePresentation({
    inputTokens: usage.tokens,
    contextLimit: usage.limit,
    compressionThreshold: usage.threshold,
    source: usage.source,
    reportedRequestCount: usage.reportedRequestCount,
    unreportedRequestCount: usage.unreportedRequestCount,
  });
  // 只有当前会话自己的 Todo 参与渲染：新建会话页（无会话 id）与未产生 Todo 的会话都不显示任务条。
  const agentTasks = (activeConversationId && tasksBySession[activeConversationId]) || EmptyAgentTaskState;
  const agentTodos = agentTasks.todos;
  const activeTodo = agentTodos.find((item) => GetTodoPresentation(item.status).className === 'is-in-progress') ?? agentTodos.find((item) => GetTodoPresentation(item.status).className === 'is-pending') ?? agentTodos.at(-1);
  const PersistConversationComposerState = useCallback((conversationId: string | null, patch: Partial<StoredConversationComposerState>) => {
    if (!conversationId) return;
    const states = ReadConversationComposerStates();
    const existing: StoredConversationComposerState = states[conversationId] ?? {
      confirmationMode: 'always_confirm' as ConfirmationMode,
      provider: settings.provider,
      model: ResolveProviderModel(settings.provider, settings.model),
      reasoningEffort: 'medium',
    };
    WriteConversationComposerStates({ ...states, [conversationId]: { ...existing, ...patch } });
  }, [settings.model, settings.provider]);
  useEffect(() => { resumesRef.current = resumes; }, [resumes]);

  /** 仅在进入会话或一轮 Agent 成功结束时请求定位；不随流式增量抢占用户滚动位置。 */
  useEffect(() => {
    if (!conversation?.id || !conversation.messages.length || enteredConversationRef.current === conversation.id) return;
    enteredConversationRef.current = conversation.id;
    setScrollToBottomRequest((current) => current + 1);
  }, [conversation?.id, conversation?.messages.length]);

  /**
   * 在浏览器完成本次布局后才定位，并继续等待 Markdown、思考区和图片引起的高度变化。
   * 用户一旦主动滚动、触摸或按下滚动条，立即停止本次跟随，避免干扰阅读历史消息。
   */
  useLayoutEffect(() => {
    if (!scrollToBottomRequest) return undefined;
    const list = messageListRef.current;
    const thread = list?.querySelector('.message-thread');
    if (!list || !thread) return undefined;
    let followEnabled = true;
    let scheduledFrame = 0;
    let releaseProgrammaticFlag = 0;
    let isProgrammaticScroll = false;
    const ScrollToBottom = () => {
      if (!followEnabled) return;
      isProgrammaticScroll = true;
      list.scrollTop = list.scrollHeight;
      cancelAnimationFrame(releaseProgrammaticFlag);
      releaseProgrammaticFlag = requestAnimationFrame(() => { isProgrammaticScroll = false; });
    };
    const ScheduleScrollToBottom = () => {
      if (!followEnabled || scheduledFrame) return;
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = 0;
        ScrollToBottom();
      });
    };
    const resizeObserver = new ResizeObserver(ScheduleScrollToBottom);
    const mutationObserver = new MutationObserver(ScheduleScrollToBottom);
    const StopFollowing = () => {
      followEnabled = false;
      cancelAnimationFrame(scheduledFrame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
    const HandleScroll = () => { if (!isProgrammaticScroll) StopFollowing(); };
    const images = Array.from(list.querySelectorAll('img'));
    const HandleImageLoad = () => ScheduleScrollToBottom();
    ScrollToBottom();
    requestAnimationFrame(() => {
      ScrollToBottom();
      requestAnimationFrame(ScrollToBottom);
    });
    resizeObserver.observe(thread);
    mutationObserver.observe(thread, { childList: true, subtree: true, characterData: true });
    images.forEach((image) => image.addEventListener('load', HandleImageLoad, { once: true }));
    list.addEventListener('scroll', HandleScroll, { passive: true });
    list.addEventListener('wheel', StopFollowing, { passive: true });
    list.addEventListener('touchstart', StopFollowing, { passive: true });
    list.addEventListener('pointerdown', StopFollowing, { passive: true });
    const stopFollowingTimeout = window.setTimeout(StopFollowing, 3000);
    return () => {
      StopFollowing();
      cancelAnimationFrame(releaseProgrammaticFlag);
      window.clearTimeout(stopFollowingTimeout);
      images.forEach((image) => image.removeEventListener('load', HandleImageLoad));
      list.removeEventListener('scroll', HandleScroll);
      list.removeEventListener('wheel', StopFollowing);
      list.removeEventListener('touchstart', StopFollowing);
      list.removeEventListener('pointerdown', StopFollowing);
    };
  }, [scrollToBottomRequest]);

  /** 以输入栏的实际可用宽度切换紧凑控件，不依赖任一侧栏的拖拽方向或宽度。
      轨迹视图会卸载输入栏：切回对话时必须重建观察并立即校正，否则卸载期间
      宽度塌缩为 0 的那次采样会把按钮永久钉在紧凑态。宽度为 0 的采样一律忽略。 */
  useEffect(() => {
    const composerElement = composerRef.current;
    if (!composerElement) return undefined;
    const UpdateComposerDensity = () => {
      const width = composerElement.clientWidth;
      if (width > 0) setIsComposerCompact(width < ComposerCompactWidth);
    };
    UpdateComposerDensity();
    const observer = new ResizeObserver(UpdateComposerDensity);
    observer.observe(composerElement);
    return () => observer.disconnect();
  }, [assistantView]);

  /** 原型输入框随内容自动增高，超过 150px 后内部滚动。 */
  useLayoutEffect(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(150, el.scrollHeight)}px`;
  }, [composer]);

  useEffect(() => {
    if (!showPermission && !showScenario && !showModel && !showReasoningEffort) return undefined;
    const CloseAssistantMenusOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      const composerMenu = target instanceof Element ? target.closest('.menu-wrap') : null;
      if (composerMenu?.querySelector('.permission-button')) {
        setShowScenario(false);
        setShowModel(false);
        setShowReasoningEffort(false);
      } else if (composerMenu?.querySelector('.scenario-button')) {
        setShowPermission(false);
        setShowModel(false);
        setShowReasoningEffort(false);
      } else if (composerMenu?.querySelector('.model-button')) {
        setShowPermission(false);
        setShowScenario(false);
        setShowReasoningEffort(false);
      } else if (composerMenu?.querySelector('.reasoning-effort-button')) {
        setShowPermission(false);
        setShowScenario(false);
        setShowModel(false);
      } else {
        setShowPermission(false);
        setShowScenario(false);
        setShowModel(false);
        setShowReasoningEffort(false);
      }
    };
    const CloseAssistantMenusOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowPermission(false);
      setShowScenario(false);
      setShowModel(false);
      setShowReasoningEffort(false);
    };
    document.addEventListener('pointerdown', CloseAssistantMenusOnOutsidePointer);
    document.addEventListener('keydown', CloseAssistantMenusOnEscape);
    return () => {
      document.removeEventListener('pointerdown', CloseAssistantMenusOnOutsidePointer);
      document.removeEventListener('keydown', CloseAssistantMenusOnEscape);
    };
  }, [showModel, showPermission, showReasoningEffort, showScenario]);

  /** 所有交互按事件归属写入；订阅回调不读取当前选中的会话作为默认归属。 */
  const ApplyPendingEvent = useCallback((event: AgentStreamEvent) => {
    const owner = event.sessionId;
    if (!owner || !event.requestId) return;
    if (event.type === 'resume_confirmation' && event.confirmationId && typeof event.content === 'string') {
      setPendingEditForSession(owner, { requestId: event.requestId, confirmationId: event.confirmationId, name: event.resumeName, content: event.content, reason: event.reason ?? '更新简历内容' });
    } else if (event.type === 'browser_confirmation' && event.browserAction?.confirmationId) {
      setPendingBrowserActionForSession(owner, { ...event.browserAction, requestId: event.requestId });
    } else if (event.type === 'cron_task_confirmation' && event.confirmationId && event.cronTask) {
      setPendingCronTaskForSession(owner, { requestId: event.requestId, confirmationId: event.confirmationId, title: event.cronTask.title ?? '定时任务', message: event.cronTask.message ?? '', scenarioId: event.cronTask.scenarioId ?? 'default', schedule: event.cronTask.schedule, summary: event.cronTask.summary ?? '任务将定时执行。' });
    } else if (event.type === 'question_requested' && event.questions) {
      setPendingQuestionsForSession(owner, { requestId: event.requestId, interactionId: event.confirmationId ?? '', questions: event.questions });
      setQuestionAnswersForSession(owner, Object.fromEntries(event.questions.map((question) => [question.id, question.options[0] ?? '其他'])));
      setOtherAnswersForSession(owner, {}); setPendingQuestionIndexForSession(owner, 0);
    }
  }, [setPendingEditForSession, setPendingBrowserActionForSession, setPendingCronTaskForSession, setPendingQuestionsForSession, setQuestionAnswersForSession, setOtherAnswersForSession, setPendingQuestionIndexForSession]);

  /** 读取会话专属状态。切换时先清空旧会话数据，迟到响应不得覆盖当前会话。 */
  const RefreshSessionAssistantState = useCallback(async (sessionId: string | null) => {
    const version = ++sessionLoadVersionRef.current;
    if (!sessionId) { setUsage(EmptyUsage); setProjectEnvironment(null); return; }
    setUsage(EmptyUsage);
    setProjectEnvironment(null);
    const taskVersion = taskVersions.current[sessionId] ?? 0;
    const runVersion = runVersions.current[sessionId] ?? 0;
    const interactionVersions = [pendingEditVersions, pendingBrowserActionVersions, pendingCronTaskVersions, pendingQuestionsVersions].map((ref) => ref.current[sessionId] ?? 0);
    try {
      const next = await GetSessionAssistantState(sessionId);
      if (version !== sessionLoadVersionRef.current || activeConversationRef.current !== sessionId) return;
      setUsage({
        percent: Math.min(100, Math.round((next.usage.inputTokens / Math.max(1, next.usage.contextLimit)) * 100)),
        threshold: next.usage.compressionThreshold,
        compressionCount: next.usage.compressionCount,
        tokens: next.usage.inputTokens,
        limit: next.usage.contextLimit,
        source: next.usage.source,
        promptTokens: next.usage.promptTokens,
        completionTokens: next.usage.completionTokens,
        totalTokens: next.usage.totalTokens,
        cachedInputTokens: next.usage.cachedInputTokens,
        reportedRequestCount: next.usage.reportedRequestCount,
        unreportedRequestCount: next.usage.unreportedRequestCount,
      });
      if ((taskVersions.current[sessionId] ?? 0) === taskVersion && next.tasks) UpdateSessionTasks(sessionId, () => ({ todos: next.tasks!, active: next.tasks!.length > 0 }));
      if ((runVersions.current[sessionId] ?? 0) === runVersion) SetSessionRun(sessionId, next.activeRequestId);
      for (const event of next.pendingEvents ?? []) {
        const index = ['resume_confirmation', 'browser_confirmation', 'cron_task_confirmation', 'question_requested'].indexOf(event.type);
        if (index >= 0 && interactionVersions[index] === 0 && ([pendingEditVersions, pendingBrowserActionVersions, pendingCronTaskVersions, pendingQuestionsVersions][index].current[sessionId] ?? 0) === 0) ApplyPendingEvent(event);
      }
      setProjectEnvironment(next.project);
      // 新会话可能尚未运行过 Agent，后端内存中还没有场景快照；使用已落库的会话场景。
      setScenarioId(conversationsRef.current.find((item) => item.id === sessionId)?.scenarioId ?? next.scenarioId);
      // 本地选择可能比后端上一次发送快照更新；仅在本地缓存缺失时使用后端恢复值。
      // 这样页面重进不覆盖尚未发送的新选择，清理缓存后仍可由后端恢复。
      const localComposerState = ReadConversationComposerStates()[sessionId];
      if (!localComposerState) {
        setPermission(next.confirmationMode);
        setProvider(next.provider);
        setModel(ResolveProviderModel(next.provider, next.model));
        setReasoningEffort(next.reasoningEffort);
        PersistConversationComposerState(sessionId, { confirmationMode: next.confirmationMode, provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort });
      }
    } catch {
      if (version === sessionLoadVersionRef.current && activeConversationRef.current === sessionId) {
        setUsage({ ...EmptyUsage, source: 'unavailable' });
        ShowNotice('会话状态恢复失败，当前 usage 未知');
      }
    }
  }, [PersistConversationComposerState, ShowNotice, settings.provider, UpdateSessionTasks, SetSessionRun, ApplyPendingEvent, pendingEditVersions, pendingBrowserActionVersions, pendingCronTaskVersions, pendingQuestionsVersions]);

  useEffect(() => { void RefreshSessionAssistantState(activeConversationId); }, [activeConversationId, RefreshSessionAssistantState]);

  /** 从已保存会话进入新建页时清空会话草稿态；首次打开页面时同样得到干净默认值。 */
  useEffect(() => {
    if (activeConversationId) return;
    setComposer('');
    setAttachments([]);
    setProjectEnvironment(null);
    setScenarioId(nextDraftScenarioRef.current ?? 'default');
    nextDraftScenarioRef.current = null;
    setPendingEdit(null);
    setPendingBrowserAction(null);
    setPendingCronTask(null);
    setPendingQuestions(null);
    setQuestionAnswers({});
    setOtherAnswers({});
    setPendingQuestionIndex(0);
    enteredConversationRef.current = null;
  }, [activeConversationId]);

  /** 简历页「让Avery保存简历」预填输入框：必须置于上方新建页清空 effect 之后，保证预填不被清空覆盖；消费一次立即失效。 */
  useEffect(() => {
    if (composerSeed === null) return;
    setComposer(composerSeed);
    setComposerSeed(null);
    composerTextareaRef.current?.focus();
  }, [composerSeed, setComposerSeed]);

  /** 会话切换、页面重进和设置更新时优先恢复会话选择；没有缓存的旧会话才使用安全默认值。 */
  useEffect(() => {
    const defaultModel = ResolveProviderModel(settings.provider, settings.model);
    if (!activeConversationId) {
      setPermission('always_confirm');
      setProvider(settings.provider);
      setModel(defaultModel);
      setReasoningEffort('medium');
      return;
    }
    const stored = ReadConversationComposerStates()[activeConversationId];
    setPermission(stored?.confirmationMode ?? 'always_confirm');
    const restoredProvider = stored?.provider ?? settings.provider;
    const restoredModel = ResolveProviderModel(restoredProvider, stored?.model ?? defaultModel);
    setProvider(restoredProvider);
    setModel(restoredModel);
    if (stored && restoredModel !== stored.model) PersistConversationComposerState(activeConversationId, { provider: restoredProvider, model: restoredModel });
    setReasoningEffort(stored?.reasoningEffort ?? 'medium');
  }, [activeConversationId, PersistConversationComposerState, settings.model, settings.provider]);
  useEffect(() => {
    // 模型目录缓存在应用本地：被禁用或移除的供应商、被删掉的模型不再出现在模型选择里。
    const loadCatalog = () => {
      void GetProviderCatalog().then((result) => {
        const configured = result.providers.filter((item) => item.configured && item.models.length) as ProviderCatalogEntry[];
        if (!configured.length) return;
        const visible = ApplyModelCatalogToProviders(LoadModelCatalog(), configured);
        setProviderCatalog(visible.length ? visible : configured);
      }).catch(() => undefined);
    };
    loadCatalog();
    return SubscribeModelCatalog(loadCatalog);
  }, [settings.provider, settings.model]);

  // 卸载时释放仍持有的用户编辑锁，避免锁在租约期内阻塞 Agent 编辑。
  useEffect(() => () => { if (editLockRef.current) void ReleaseResumeEditLock(editLockRef.current); }, []);
  useEffect(() => SubscribeAgentStream((event: AgentStreamEvent) => {
    if (event.type === 'conversation_save_error') { ShowNotice(event.message ?? '会话过程保存失败'); return; }
    const owner = event.sessionId ?? (event.requestId ? activePlaceholdersRef.current.get(event.requestId)?.conversationId : undefined);
    if (event.type === 'run_resumed' && owner && event.requestId) {
      const requestId = event.requestId;
      const existing = conversationsRef.current.find((item) => item.id === owner)?.messages.find((message) => message.id === 'reply-' + requestId);
      activePlaceholdersRef.current.set(requestId, { conversationId: owner, requestId, content: existing?.content ?? '', thinkingContent: existing?.thinkingContent ?? '' });
      SetSessionRun(owner, requestId);
      setPendingEditForSession(owner, (current) => current?.confirmationId === event.confirmationId ? null : current);
      setPendingCronTaskForSession(owner, (current) => current?.confirmationId === event.confirmationId ? null : current);
      setPendingBrowserActionForSession(owner, (current) => current?.confirmationId === event.confirmationId ? null : current);
      setPendingQuestionsForSession(owner, (current) => current?.interactionId === event.confirmationId ? null : current);
      return;
    }
    if (event.type === 'conversation_updated' && owner && event.presentation && event.requestId === event.presentation.requestId) {
      const snapshot = event.presentation;
      patchConversationsRef.current((current) => current.map((item) => item.id !== owner ? item : {
        ...item, messages: item.messages.map((message) => message.id !== 'reply-' + snapshot.requestId || (message.presentation?.sequence ?? -1) >= snapshot.sequence ? message : { ...message, presentation: snapshot }),
      }));
      if (snapshot.status === 'running') SetSessionRun(owner, snapshot.requestId);
      else SetSessionRun(owner, undefined, snapshot.requestId);
      return;
    }
    if (owner && ['resume_confirmation', 'browser_confirmation', 'cron_task_confirmation', 'question_requested'].includes(event.type)) { ApplyPendingEvent({ ...event, sessionId: owner }); return; }
    if ((event.type === 'resume_updated' || event.type === 'resume_created') && event.resumeId && typeof event.content === 'string') {
      void RefreshWorkspacePreservingMessages();
      if (owner === activeConversationRef.current && !editLockRef.current) {
        if (event.type === 'resume_created') setCurrentResumeId(event.resumeId);
        if (event.type === 'resume_created' || event.resumeId === currentResumeId) { setResumeText(event.content); setSavedText(event.content); setHistory([]); }
      }
      ShowNotice(event.type === 'resume_created' ? 'Agent 已创建并保存简历' : 'Agent 已保存简历修改');
      return;
    }
    if (event.type === 'cron_task_changed') return;
    if (event.type === 'cron_run_completed') { void RefreshWorkspacePreservingMessages(); return; }
    if (event.type === 'browser_action_completed' && event.browserAction) {
      if (owner) setPendingBrowserActionForSession(owner, (current) => current?.requestId === event.requestId ? null : current);
      if (event.browserAction.status === 'status_unknown') ShowNotice('浏览器动作结果未知，请先在目标网站核对，不要重复执行');
      return;
    }
    if (event.type === 'browser_user_action') { ShowNotice(event.browserAction?.summary ?? '请在浏览器中完成登录或验证，然后发送“继续任务”'); return; }
    if ((event.type === 'task_created' || event.type === 'task_updated') && event.task && owner) {
      const task = event.task;
      UpdateSessionTasks(owner, (state) => ({ todos: state.todos.some((item) => item.id === task.id) ? state.todos.map((item) => item.id === task.id ? task : item) : [...state.todos, task], active: true }));
      return;
    }
    if (event.type === 'task_deleted' && event.task && owner) {
      UpdateSessionTasks(owner, (state) => ({ ...state, todos: state.todos.filter((item) => item.id !== event.task!.id) })); return;
    }
    if (!event.requestId) return;
    const placeholder = activePlaceholdersRef.current.get(event.requestId);
    if (event.type === 'content_delta' || event.type === 'thinking_delta') {
      if (!placeholder) return;
      const delta = event.delta ?? '';
      const content = event.type === 'content_delta' ? placeholder.content + delta : placeholder.content;
      const thinkingContent = event.type === 'thinking_delta' ? placeholder.thinkingContent + delta : placeholder.thinkingContent;
      activePlaceholdersRef.current.set(event.requestId, { ...placeholder, content, thinkingContent });
      patchConversationsRef.current((current) => current.map((item) => item.id !== placeholder.conversationId ? item : { ...item, messages: item.messages.map((message) => message.id === 'reply-' + event.requestId ? { ...message, content, thinkingContent } : message) }));
      return;
    }
    if (!['completed', 'cancelled', 'error', 'waiting_user_input', 'waiting_confirmation', 'paused', 'run_released'].includes(event.type)) return;
    if (placeholder) {
      completeMessageRef.current.mutate({ conversationId: placeholder.conversationId, messageId: 'reply-' + event.requestId, content: placeholder.content, thinkingContent: placeholder.thinkingContent });
      activePlaceholdersRef.current.delete(event.requestId);
    }
    if (owner) {
      SetSessionRun(owner, undefined, event.requestId);
      if (owner === activeConversationRef.current) { setScrollToBottomRequest((current) => current + 1); void RefreshSessionAssistantState(owner); }
    }
    if (event.type === 'error') ShowNotice(event.message ?? 'Agent 请求失败');
    if (event.type === 'cancelled') ShowNotice('已停止生成');
    if (event.type === 'cancelled' && owner) {
      setPendingQuestionsForSession(owner, (current) => current?.requestId === event.requestId ? null : current);
      setPendingEditForSession(owner, (current) => current?.requestId === event.requestId ? null : current);
      setPendingBrowserActionForSession(owner, (current) => current?.requestId === event.requestId ? null : current);
      setPendingCronTaskForSession(owner, (current) => current?.requestId === event.requestId ? null : current);
    }
    if (event.type === 'paused') ShowNotice('Agent 运行已暂停');
    if (event.type === 'run_released') {
      if (event.cleanupOutcomes?.some((outcome) => outcome.status === 'status_unknown')) ShowNotice('浏览器任务页面清理状态未知；后续任务会使用新的隔离页面。');
      else if (event.cleanupOutcomes?.some((outcome) => outcome.status === 'failed')) ShowNotice('浏览器任务页面清理失败；后续任务会使用新的隔离页面。');
    }
  }), [ShowNotice, currentResumeId, SetSessionRun, UpdateSessionTasks, RefreshSessionAssistantState, RefreshWorkspacePreservingMessages, ApplyPendingEvent, setPendingBrowserActionForSession, setCurrentResumeId]);

  async function HandleSend() {
    const text = composer.trim();
    if (text === '/reload' || text === '/reload-session') {
      if (!activeConversationId) { ShowNotice('请先发送一条消息建立会话，再重载会话上下文'); return; }
      const result = await ReloadAgentSession(activeConversationId);
      if (result.reloaded) ShowNotice(`会话上下文已重载（revision ${result.sessionRevision ?? ''}）`);
      else ShowNotice(result.reason === 'busy' ? 'Agent 正在处理，请等待本轮结束后再试' : '会话上下文重载失败');
      return;
    }
    if (activeConversationId && activeRequestsRef.current.has(activeConversationId)) { ShowNotice('已有任务正在执行，请等待本轮结束或回到原会话停止任务。'); return; }
    if (attachments.some((attachment) => attachment.status === 'uploading')) {
      ShowNotice('附件仍在上传，请完成后再发送。');
      return;
    }
    const readyAttachments = attachments.filter((attachment): attachment is Extract<ComposerAttachment, { status: 'ready' }> => attachment.status === 'ready');
    if (!text && readyAttachments.length === 0) return;
    const sendKey = activeConversationId ?? '__draft__';
    if (sendInFlightRef.current.has(sendKey)) return;
    sendInFlightRef.current.add(sendKey);
    try {
    let targetId = activeConversationId;
    if (!targetId) {
      try {
        // 场景与项目空间随会话创建定格落库：侧栏场景标注与项目分组以这条快照为准，
        // 避免读取 Agent 运行态导致的竞态（此前新会话列表恒显示“聊天”）。
        targetId = await createConversation(text.slice(0, 18) || '新的求职会话', {
          scenarioId,
          ...(projectEnvironment?.projectId ? { projectId: projectEnvironment.projectId, projectName: projectEnvironment.name } : {}),
        });
        enteredConversationRef.current = targetId;
      } catch {
        // 会话创建失败通知已由 mutation onFailure 展示；中止本轮发送。
        return;
      }
    }
    const requestId = `request-${crypto.randomUUID()}`;
    const message: ChatMessage = { id: `message-${Date.now()}`, role: 'user', content: `${text || '请分析我上传的文件'}${readyAttachments.length ? `（附 ${readyAttachments.length} 个附件）` : ''}`, createdAt: Date.now() };
    const placeholder: ChatMessage = { id: `reply-${requestId}`, role: 'assistant', content: '', thinkingContent: '', createdAt: Date.now() };
    // 停止可能已携带旧消息快照的查询；即使底层 IPC 无法中止，React Query 也不会再提交其结果。
    await queryClient.cancelQueries({ queryKey: WORKSPACE_QUERY_KEY });
    patchConversations((current) => current.some((item) => item.id === targetId) ? current.map((item) => item.id === targetId ? { ...item, updatedAt: Date.now(), messages: [...item.messages, message, placeholder] } : item) : [{ id: targetId, title: text.slice(0, 18) || '新的求职会话', updatedAt: Date.now(), messages: [message, placeholder] }, ...current]);
    try {
      // 对话记录先落库再启动 Agent；确认答案不能只存在于 Trace 或 Renderer 内存中。
      await appendMessages.mutateAsync({ conversationId: targetId, messages: [message, placeholder] });
    } catch {
      patchConversations((current) => current.map((item) => item.id === targetId
        ? { ...item, messages: item.messages.filter((itemMessage) => itemMessage.id !== message.id && itemMessage.id !== placeholder.id) }
        : item));
      return;
    }
    // 新会话在首条请求前写入当前选择，后续切回该会话不再丢失模型和确认权限。
    PersistConversationComposerState(targetId, { confirmationMode: permission, provider, model, reasoningEffort });
    // 先在发送来源页消费已提交的草稿，再切换到新建会话，避免等待 React 更新后的会话 ID。
    // 追加消息期间新输入的文字及新附件不属于本次提交，必须保留。
    if (activeConversationRef.current === activeConversationId) {
      setComposer((current) => current === composer ? '' : current);
      const submittedAttachments = new Set(readyAttachments.map((attachment) => attachment.id));
      setAttachments((current) => current.filter((attachment) => !submittedAttachments.has(attachment.id)));
    }
    if (activeConversationRef.current === activeConversationId) setActiveConversationId(targetId);
    SetSessionRun(targetId, requestId);
    const startedRunVersion = runVersions.current[targetId];
    try {
      let boundProject = projectEnvironment;
      if (projectEnvironment?.projectId) {
        const project = await BindProjectEnvironment(targetId, projectEnvironment.projectId);
        boundProject = project ?? projectEnvironment;
        if (activeConversationRef.current === targetId) setProjectEnvironment(boundProject);
      }
      activePlaceholdersRef.current.set(requestId, { conversationId: targetId, requestId, content: '', thinkingContent: '' });
      await SendAgentRequest({ requestId, sessionId: targetId, content: message.content, provider, model, reasoningEffort, confirmationMode: permission, attachments: readyAttachments.map(({ name, path }) => ({ name, path })), projectId: boundProject?.projectId ?? undefined, scenarioId });
    } catch (error) {
      // 保留用户输入和已落盘的过程；启动失败也不能删除已经执行过工具的记录。
      await RefreshWorkspacePreservingMessages();
      if (runVersions.current[targetId] === startedRunVersion) {
        activePlaceholdersRef.current.delete(requestId);
        SetSessionRun(targetId, undefined, requestId);
        UpdateSessionTasks(targetId, (state) => ({ ...state, active: false }));
      }
      ShowNotice(error instanceof Error ? error.message : '无法发起 Agent 请求');
    } finally {
      // 旧 Send 的迟到 IPC 回执不能清理已恢复的同 requestId Run。
      if (runVersions.current[targetId] === startedRunVersion) {
        SetSessionRun(targetId, undefined, requestId);
        activePlaceholdersRef.current.delete(requestId);
      }
    }
    } finally { sendInFlightRef.current.delete(sendKey); }
  }

  const visibleRequestId = activeConversationId ? runsBySession[activeConversationId] : undefined;
  function HandleStop() { if (visibleRequestId) void CancelAgentRequest(visibleRequestId); }

  function OpenConversationResource(resource: ConversationResource) {
    if (!activeConversationId) return;
    if (editing) { ShowNotice('请先保存或取消当前简历编辑，再查看产物。'); return; }
    if (resource.kind === 'resume') HandleSelectResume(resource.id);
    setResourcePreview({ sessionId: activeConversationId, resource });
    setResumePanelOpen(true);
  }
  useEffect(() => { setResourcePreview(null); }, [activeConversationId]);
  useEffect(() => { if (!resumePanelOpen) setResourcePreview(null); }, [resumePanelOpen]);

  /** 权限切换同时更新在途 Run；完全信任由警告弹窗的显式确认入口调用。 */
  async function ApplyConfirmationMode(next: ConfirmationMode) {
    setPermission(next);
    setShowPermission(false);
    PersistConversationComposerState(activeConversationId, { confirmationMode: next });
    const requestId = visibleRequestId;
    if (!requestId) return;
    try {
      await UpdateAgentConfirmationMode(requestId, next);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '确认权限同步失败，将在下一轮任务生效');
    }
  }

  function HandleSelectModel(nextProvider: SupportedProvider, nextModel: string) {
    const nextEffortOptions = GetReasoningEffortOptions(nextModel);
    const nextReasoningEffort = nextEffortOptions.includes(reasoningEffort) ? reasoningEffort : GetDefaultReasoningEffort(nextEffortOptions);
    setProvider(nextProvider);
    setModel(nextModel);
    setReasoningEffort(nextReasoningEffort);
    setShowModel(false);
    PersistConversationComposerState(activeConversationId, { provider: nextProvider, model: nextModel, reasoningEffort: nextReasoningEffort });
  }

  function HandleSelectReasoningEffort(nextEffort: ReasoningEffort) {
    setReasoningEffort(nextEffort);
    // 拖动滑块时保持弹层展开，允许连续比较不同档位；点击外部或主按钮才关闭。
    PersistConversationComposerState(activeConversationId, { reasoningEffort: nextEffort });
    if (activeConversationId) {
      void UpdateAgentReasoningEffort(activeConversationId, nextEffort)
        .catch((error) => ShowNotice(error instanceof Error ? error.message : '思考强度保存失败，将在下一次发送时重试'));
    }
  }

  function HandleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    const availableSlots = Math.max(0, 10 - attachments.length);
    const acceptedFiles = files.slice(0, availableSlots);
    if (acceptedFiles.length < files.length) ShowNotice('最多可添加 10 个附件，超出部分未添加。');
    if (acceptedFiles.length === 0) return;

    const pendingAttachments = acceptedFiles.map((file) => ({ id: crypto.randomUUID(), name: file.name, status: 'uploading' as const }));
    // 先提交本地占位状态，让标签在启动 IPC 导入前进入下一次渲染。
    setAttachments((current) => [...current, ...pendingAttachments]);
    // 延后到当前输入事件结束后启动导入，确保大文件的桥接/序列化不会挡住首帧占位标签。
    window.setTimeout(() => {
      void Promise.all(acceptedFiles.map(async (file, index) => {
        const pending = pendingAttachments[index];
        if (!pending) return;
        try {
          const attachment = await ImportAttachmentFile(file);
          setAttachments((current) => current.map((item) => item.id === pending.id
            ? { id: pending.id, name: attachment.name, path: attachment.uri, status: 'ready' }
            : item));
        } catch (error) {
          setAttachments((current) => current.filter((item) => item.id !== pending.id));
          const reason = error instanceof Error && error.message.trim() ? error.message : '未知错误';
          setAttachmentErrors((current) => [...current, `${file.name} 上传失败：${reason}`]);
        }
      }));
    }, 0);
  }

  function DismissAttachmentError() {
    setAttachmentErrors((current) => current.slice(1));
  }

  function RemoveAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function AttachmentUploadStatus(attachment: ComposerAttachment) {
    return attachment.status === 'uploading' ? <span className="ctx-spinner" role="status" aria-label={`${attachment.name} 正在上传`} /> : <Icon name="resume" size={12} />;
  }

  async function HandleSelectProject() {
    const selected = await SelectAgentProjectDirectory();
    if (!selected) return;
    if (!activeConversationId) { setProjectEnvironment(selected); ShowNotice('项目环境会在发送首条消息后绑定到新会话'); return; }
    try {
      const project = await BindProjectEnvironment(activeConversationId, selected.projectId);
      setProjectEnvironment(project ?? selected);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '项目环境绑定失败');
    }
  }

  function HandleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void HandleSend(); } }
  function HandleEditChange(value: string) { setHistory((current) => [...current, resumeText]); setResumeText(value); }
  /** 撤销最近一次编辑：弹回上一份快照；编辑期间随时可用，保存后历史清空。 */
  function UndoResumeEdit() {
    const last = history.at(-1);
    if (!last) return;
    setResumeText(last);
    setHistory((current) => current.slice(0, -1));
  }
  /** 用户发起手动编辑前获取后端互斥锁；Agent 占用或本轮仍在处理时拒绝进入编辑。 */
  async function HandleStartEditing() {
    if (!resume) return;
    if (activeConversationId && activeRequestsRef.current.has(activeConversationId)) { ShowNotice('Agent 正在处理当前简历，请等待本轮结束后再编辑'); return; }
    const lock = await AcquireResumeEditLock(resume.id);
    if (!lock.acquired) { ShowNotice(lock.reason ?? '简历正被占用，暂时无法编辑'); return; }
    editLockRef.current = resume.id;
    setEditing(true);
  }
  async function HandleSaveResume() {
    if (!resume) return;
    try {
      await upsertResume.mutateAsync({ resume: { ...resume, content: resumeText, updatedAt: Date.now() }, expectedRevision: resume.revision });
      // 保存成功才释放锁并退出编辑态；失败时保留编辑态与锁，供用户重试。
      if (editLockRef.current) { void ReleaseResumeEditLock(editLockRef.current); editLockRef.current = null; }
      setSavedText(resumeText);
      setHistory([]);
      setEditing(false);
      ShowNotice('简历已保存到本地工作空间');
    } catch {
      // 保存失败提示已由 mutation onConflict/onFailure 处理；此处保持编辑态与锁。
    }
  }
  /** 取消编辑必须恢复最后一次已保存内容，并立即释放用户编辑锁供 Agent 继续更新简历。 */
  function HandleCancelEditing() {
    setResumeText(savedText);
    setHistory([]);
    setEditing(false);
    if (editLockRef.current) { void ReleaseResumeEditLock(editLockRef.current); editLockRef.current = null; }
    ShowNotice('已取消编辑，未保存修改已放弃');
  }
  /** 切换当前简历：释放仍持有的编辑锁并重置编辑态，加载用户在菜单中选定的简历。 */
  function HandleSelectResume(resumeId: string) {
    const nextResume = resumes.find((item) => item.id === resumeId);
    if (!nextResume || nextResume.id === currentResumeId) return;
    if (editLockRef.current) { void ReleaseResumeEditLock(editLockRef.current); editLockRef.current = null; }
    setEditing(false);
    setHistory([]);
    setResumeText(nextResume.content);
    setSavedText(nextResume.content);
    setCurrentResumeId(nextResume.id);
  }
  function HandleScenarioChange(nextScenarioId: 'default' | 'application') {
    if (nextScenarioId === scenarioId) { setShowScenario(false); return; }
    if (activeConversationId && activeRequestsRef.current.has(activeConversationId)) { ShowNotice('Agent 正在执行任务，请停止或等待本轮结束后再切换场景'); return; }
    nextDraftScenarioRef.current = activeConversationId ? nextScenarioId : null;
    setActiveConversationId(null);
    setShowScenario(false);
    setScenarioId(nextScenarioId);
    // 场景切换会建立新会话；确认权限不得跨场景沿用，尤其不能把完全信任隐式带入真实网站投递。
    setPermission('always_confirm');
    onNavigate('assistant');
    ShowNotice(`已切换到${ScenarioOptions.find((item) => item.id === nextScenarioId)?.label}的新对话`);
  }

  /** 确认失败可能已消费提案；只清理原会话中同一个确认，不影响切换后的会话或新提案。 */
  async function ReconcileFailedConfirmation(kind: 'resume_confirmation' | 'cron_task_confirmation' | 'browser_confirmation', confirmationId: string) {
    if (!activeConversationId) return;
    try {
      const state = await GetSessionAssistantState(activeConversationId);
      const stillPending = state.pendingEvents?.some((event) => event.type === kind
        && (kind === 'browser_confirmation' ? event.browserAction?.confirmationId : event.confirmationId) === confirmationId);
      if (stillPending) return;
      if (kind === 'resume_confirmation') setPendingEdit((current) => current?.confirmationId === confirmationId ? null : current);
      if (kind === 'cron_task_confirmation') setPendingCronTask((current) => current?.confirmationId === confirmationId ? null : current);
      if (kind === 'browser_confirmation') setPendingBrowserAction((current) => current?.confirmationId === confirmationId ? null : current);
    } catch (error) {
      ShowNotice(error instanceof Error ? `无法核对确认状态：${error.message}` : '无法核对确认状态，请切回原会话检查。');
    }
  }

  /** 只提交结构化决定；状态、结果持久化与续轮由后端负责，切换会话不改变响应归属。 */
  async function SubmitInteraction(response: import('@avery/contracts').AgentInteractionResponse) {
    if (interactionBusy.current.has(response.interactionId)) return;
    interactionBusy.current.add(response.interactionId);
    try {
      await RespondToAgentInteraction(response);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '交互处理失败，请重试');
      try {
        const state = await GetSessionAssistantState(response.sessionId);
        for (const event of state.pendingEvents ?? []) ApplyPendingEvent(event);
      } catch { /* 保留原卡片和错误提示，不能因状态读取失败丢失重试入口。 */ }
    } finally { interactionBusy.current.delete(response.interactionId); }
  }

  async function HandlePendingEdit(approved: boolean) {
    if (!pendingEdit || !activeConversationId) return;
    await SubmitInteraction({ kind: 'approval', sessionId: activeConversationId, requestId: pendingEdit.requestId, interactionId: pendingEdit.confirmationId, approved });
  }

  async function HandlePendingCronTask(approved: boolean) {
    if (!pendingCronTask || !activeConversationId) return;
    await SubmitInteraction({ kind: 'approval', sessionId: activeConversationId, requestId: pendingCronTask.requestId, interactionId: pendingCronTask.confirmationId, approved });
  }

  async function HandlePendingBrowserAction(approved: boolean) {
    if (!pendingBrowserAction?.confirmationId || !activeConversationId) return;
    await SubmitInteraction({ kind: 'approval', sessionId: activeConversationId, requestId: pendingBrowserAction.requestId, interactionId: pendingBrowserAction.confirmationId, approved });
  }

  function SubmitQuestionAnswers() {
    if (!pendingQuestions || !activeConversationId) return;
    const answers = Object.fromEntries(pendingQuestions.questions.map((question) => [question.id,
      questionAnswers[question.id] === '其他' ? otherAnswers[question.id]?.trim() : questionAnswers[question.id]]));
    if (Object.values(answers).some((answer) => !answer)) { ShowNotice('请选择或填写每一道问题的答案'); return; }
    void SubmitInteraction({ kind: 'answer', sessionId: activeConversationId, requestId: pendingQuestions.requestId, interactionId: pendingQuestions.interactionId, answers });
  }

  function CancelPendingQuestions() {
    if (!pendingQuestions || !activeConversationId) return;
    const pending = pendingQuestions;
    void SubmitInteraction({ kind: 'cancel', sessionId: activeConversationId, requestId: pending.requestId, interactionId: pending.interactionId });
  }

  function ContinuePendingQuestions() {
    if (!pendingQuestions) return;
    if (pendingQuestionIndex < pendingQuestions.questions.length - 1) { setPendingQuestionIndex((current) => current + 1); return; }
    SubmitQuestionAnswers();
  }

  const isEmptyConversation = !conversation?.messages.length;
  const isNewThread = isEmptyConversation;
  const shouldShowTodo = !isEmptyConversation && agentTasks.active && agentTodos.length > 0;
  const hasComposerBlocker = Boolean(pendingQuestions || pendingEdit || pendingCronTask || pendingBrowserAction);
  const reasoningEffortOptions = GetReasoningEffortOptions(model);
  const CurrentConfirmation = ConfirmationOptions.find((item) => item.id === permission) ?? ConfirmationOptions[0];
  const CurrentScenario = ScenarioOptions.find((item) => item.id === scenarioId) ?? ScenarioOptions[0];
  const sessionTokenUsage = CreateSessionTokenUsage(usage);
  const cacheSharePercent = sessionTokenUsage ? CalculateTokenSharePercent(sessionTokenUsage.cachedInputTokens, sessionTokenUsage.totalTokens) : null;
  return <div className={`assistant-layout ${isComposerCompact ? 'is-composer-compact' : ''}`} style={{ '--assistant-main-min-width': `${ASSISTANT_MAIN_MIN_WIDTH}px` } as CSSProperties}>
    {assistantView === 'trace' ? <section className="assistant-main assistant-trace" aria-label="当前对话轨迹"><ConversationTrace traces={(observability?.traces ?? []).filter((trace) => trace.sessionId === activeConversationId)} sessionTokenUsage={sessionTokenUsage} title={conversation?.title ?? '新对话'} onSelectTrace={GetAgentTraceEvents} /></section> : <section className={`assistant-main ${isNewThread ? 'is-new-thread' : ''}`}>
      {conversation?.messages.length ? <div key={conversation.id} ref={messageListRef} className="message-list"><div className="message-thread">{conversation.messages.map((message) => <article key={message.id} className={`chat-message ${message.role}`}>{message.role === 'assistant' && <div className="msg-name">Avery</div>}{message.role === 'assistant' ? <ConversationMessage message={message} authorizedResources={conversationResources} onOpenResource={OpenConversationResource} /> : <MarkdownText content={message.content} />}</article>)}</div></div> : <EmptyAssistant name={settings.nickname} />}
      <div className="composer-dock">
        {shouldShowTodo && <div className="task-dock"><div className="task-summary"><span className={`task-status-icon ${GetTodoPresentation(activeTodo?.status ?? 'pending').className}`} aria-hidden="true">{GetTodoPresentation(activeTodo?.status ?? 'pending').symbol}</span><span className="task-summary-copy">{activeTodo?.title ?? '正在处理任务'}</span><span className={`task-summary-status ${GetTodoPresentation(activeTodo?.status ?? 'pending').className}`}>{GetTodoPresentation(activeTodo?.status ?? 'pending').label}</span></div><div className="task-card" aria-label="Todo 列表"><div className="task-card-heading">Todo · {agentTodos.length} 项</div><div className="task-list">{agentTodos.map((todo) => { const presentation = GetTodoPresentation(todo.status); return <div key={todo.id} className={`task-list-item ${presentation.className}`}><span className="task-status-icon" aria-hidden="true">{presentation.symbol}</span><span className="task-list-title">{todo.title}</span><span className="task-list-status">{presentation.label}</span></div>; })}</div></div></div>}
        {pendingQuestions ? <QuestionComposer questions={pendingQuestions.questions} answers={questionAnswers} otherAnswers={otherAnswers} questionIndex={pendingQuestionIndex} onAnswer={(questionId, answer) => setQuestionAnswers((current) => ({ ...current, [questionId]: answer }))} onOtherAnswer={(questionId, answer) => setOtherAnswers((current) => ({ ...current, [questionId]: answer }))} onPrevious={() => setPendingQuestionIndex((current) => Math.max(0, current - 1))} onCancel={CancelPendingQuestions} onContinue={ContinuePendingQuestions} /> : pendingEdit ? <ConfirmationComposer title="确认 Agent 修改简历" description={pendingEdit.reason} preview={pendingEdit.content} confirmLabel="确认并保存" onCancel={() => void HandlePendingEdit(false)} onConfirm={() => void HandlePendingEdit(true)} /> : pendingCronTask ? <ConfirmationComposer title="确认创建无人值守定时任务" description={`${pendingCronTask.summary}\n任务消息：${pendingCronTask.message}`} preview={JSON.stringify(pendingCronTask.schedule, null, 2)} confirmLabel="确认整个周期" onCancel={() => void HandlePendingCronTask(false)} onConfirm={() => void HandlePendingCronTask(true)} /> : pendingBrowserAction ? <ConfirmationComposer title="确认浏览器外部动作" description={`${pendingBrowserAction.summary ?? pendingBrowserAction.toolName}${pendingBrowserAction.url ? `\n目标网站：${pendingBrowserAction.url}` : ''}\n风险级别：${pendingBrowserAction.risk === 'high' ? '高风险' : pendingBrowserAction.risk === 'medium' ? '中风险' : '低风险'}`} confirmLabel="确认执行" onCancel={() => void HandlePendingBrowserAction(false)} onConfirm={() => void HandlePendingBrowserAction(true)} /> : <div className="composer-col">
          {attachments.length > 0 && <div className="ctx">{attachments.map((attachment) => <span className="ctx-item" key={attachment.id} aria-busy={attachment.status === 'uploading'}>{AttachmentUploadStatus(attachment)}<span className="ctx-name">{attachment.name}</span><button className="ctx-x" type="button" aria-label={`移除 ${attachment.name}`} onClick={() => RemoveAttachment(attachment.id)}><Icon name="close" size={11} /></button></span>)}</div>}
          <div ref={composerRef} className="composer">
            <textarea ref={composerTextareaRef} rows={1} value={composer} placeholder={scenarioId === 'application' ? '让 Avery 编辑简历、采集岗位或完成浏览器任务…' : '聊聊你的问题，或让 Avery 分析资料、提供建议…'} onChange={(event) => setComposer(event.target.value)} onKeyDown={HandleKeyDown} />
            <div className="cmp-bar">
              <div className="cmp-tools">
                <input ref={inputRef} className="visually-hidden" type="file" multiple accept=".pdf,.doc,.docx,.txt,image/png,image/jpeg,image/gif,image/webp" onChange={HandleFiles} />
                <button className="cmp-btn icon-only" type="button" aria-label="上传文件" title="上传文件" onClick={() => inputRef.current?.click()}><Icon name="paperclip" size={15} /></button>
                <div className="menu-wrap">
                  <button className="cmp-btn permission-button" type="button" aria-label={`权限范围：${CurrentConfirmation.label}`} aria-haspopup="true" aria-expanded={showPermission} onClick={() => setShowPermission((value) => !value)}><Icon name={CurrentConfirmation.icon} size={15} /><span>{CurrentConfirmation.label}</span><Icon name="chevron-up" className="chev" size={10} /></button>
                  {showPermission && <div className="menu pop" role="menu" aria-label="选择权限范围">
                    <div className="menu-label">权限范围</div>
                    {ConfirmationOptions.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === permission} className={item.id === permission ? 'menu-item sel' : 'menu-item'} onClick={() => { if (item.id === 'fully_trusted') { setShowPermission(false); setShowFullyTrustedWarning(true); } else void ApplyConfirmationMode(item.id); }}>
                      <Icon name={item.icon} size={16} />
                      <span><span className="mt">{item.label}</span><span className="md">{item.description}</span></span>
                      <Icon name="check" className="tick" size={14} />
                    </button>)}
                    <div className="menu-foot">权限越高，Avery 能做的事越多，需要你确认的步骤越少。</div>
                  </div>}
                </div>
                <div className="menu-wrap">
                  <button className="cmp-btn model-button" type="button" aria-label={`模型：${provider} ${model}`} aria-haspopup="true" aria-expanded={showModel} onClick={() => setShowModel((value) => !value)}>{provider === 'DeepSeek' ? <Icon name="deepseek" size={15} /> : provider === 'Z.AI' ? <Icon name="zai" size={15} /> : provider === 'MIMO' ? <Icon name="mimo" size={15} /> : <Icon name="brain" size={15} />}<span>{model}</span><Icon name="chevron-up" className="chev" size={10} /></button>
                  {showModel && <div className="menu pop model-menu" role="menu" aria-label="使用的模型">
                    <div className="menu-label">使用的模型</div>
                    {providerCatalog.map((entry, entryIndex) => <Fragment key={entry.provider}>
                      {entryIndex > 0 && <div className="menu-sep" />}
                      {entry.models.map((availableModel) => <button key={`${entry.provider}:${availableModel}`} type="button" role="menuitemradio" aria-checked={entry.provider === provider && availableModel === model} className={entry.provider === provider && availableModel === model ? 'menu-item sel' : 'menu-item'} onClick={() => HandleSelectModel(entry.provider, availableModel)}>
                        {entry.provider === 'DeepSeek' ? <Icon name="deepseek" size={16} /> : entry.provider === 'Z.AI' ? <Icon name="zai" size={16} /> : entry.provider === 'MIMO' ? <Icon name="mimo" size={16} /> : <Icon name="brain" size={16} />}
                        <span><span className="mt">{availableModel}</span><span className="md">{entry.provider}</span></span>
                        <Icon name="check" className="tick" size={14} />
                      </button>)}
                    </Fragment>)}
                  </div>}
                </div>
                <div className="menu-wrap">
                  <button className="cmp-btn reasoning-effort-button" type="button" aria-label={`思考强度：${ReasoningEffortLabels[reasoningEffort]}`} title="思考强度按会话保存，并在下一轮模型请求生效" aria-haspopup="true" aria-expanded={showReasoningEffort} onClick={() => setShowReasoningEffort((value) => !value)}><Icon name="brain" size={15} /><span>思考 {ReasoningEffortLabels[reasoningEffort]}</span><Icon name="chevron-up" className="chev" size={10} /></button>
                  {showReasoningEffort && <div className="menu pop" role="menu" aria-label="思考强度">
                    <div className="menu-label">思考强度</div>
                    <div className="seg" role="radiogroup" aria-label="思考强度">
                      {reasoningEffortOptions.map((effort) => <button key={effort} type="button" role="radio" aria-checked={effort === reasoningEffort} className={effort === reasoningEffort ? 'seg-i sel' : 'seg-i'} onClick={() => HandleSelectReasoningEffort(effort)}>{ReasoningEffortLabels[effort]}</button>)}
                    </div>
                    <div className="think-d">{ReasoningEffortDescriptions[reasoningEffort]}</div>
                  </div>}
                </div>
              </div>
              <div className="cmp-right">
                <div className="ctx-wrap">
                  <button className="ctx-ring" type="button" aria-label={usagePresentation.title}>
                    <svg viewBox="0 0 22 22" aria-hidden="true" focusable="false">
                      <circle className="track" cx="11" cy="11" r="8" pathLength="100" />
                      <circle className="val" cx="11" cy="11" r="8" pathLength="100" style={{ strokeDashoffset: 100 - usagePresentation.progress }} />
                    </svg>
                    <span className="ctx-pct">{usage.tokens > 0 ? `${usage.percent}%` : '—'}</span>
                  </button>
                  <div className="ctx-pop" role="tooltip">
                    <div className="cp-h">上下文使用</div>
                    <div className="cp-big"><span className="cp-pct">{usage.tokens > 0 ? `${usage.percent}%` : '—'}</span><span className="cp-tok">{usage.tokens > 0 ? `${FormatTokenCount(usage.tokens)} / ${FormatTokenCount(usage.limit)} tokens` : `上限 ${FormatTokenCount(usage.limit)} tokens`}</span></div>
                    <div className="cp-rows">
                      <div className="cp-row"><span>累计请求</span><b>{usage.reportedRequestCount + usage.unreportedRequestCount} 次</b></div>
                      <div className="cp-row dim"><span>剩余可用</span><b>{usage.tokens > 0 ? FormatTokenCount(Math.max(0, usage.limit - usage.tokens)) : '—'}</b></div>
                    </div>
                    <div className="cp-cache">
                      <div className="cp-cache-h">
                        <span><Icon name="lightning" size={13} />缓存命中率</span>
                        <b>{cacheSharePercent === null ? '—' : `${cacheSharePercent}%`}</b>
                      </div>
                      <div className="cp-cache-d">Σ命中输入 token ÷ Σ总 token</div>
                    </div>
                    <div className="cp-note">{usagePresentation.title}</div>
                  </div>
                </div>
                {visibleRequestId ? <button className="send" type="button" onClick={HandleStop} aria-label="停止生成"><Icon name="stop" size={16} /></button> : <button className="send" type="button" disabled={(!composer.trim() && attachments.length === 0) || attachments.some((attachment) => attachment.status === 'uploading')} onClick={() => void HandleSend()} aria-label="发送消息"><Icon name="send" size={16} /></button>}
              </div>
            </div>
          </div>
          {!conversation?.messages.length && <div className="nv-bar">
            <div className="nv-slot">
              <button className="nv-btn" type="button" title="选择一个文件夹作为项目空间" onClick={() => void HandleSelectProject()}>
                <Icon name="folder-simple" size={15} />
                <span>{projectEnvironment ? projectEnvironment.name : '项目空间'}</span>
              </button>
              {projectEnvironment && <button className="nv-x" type="button" aria-label="移除项目空间" title="移除项目空间" onClick={() => setProjectEnvironment(null)}><Icon name="close" size={13} /></button>}
            </div>
            <div className="menu-wrap">
              <button className="nv-btn scenario-button" type="button" aria-label={`场景：${CurrentScenario.label}`} aria-haspopup="true" aria-expanded={showScenario} disabled={Boolean(visibleRequestId)} onClick={() => setShowScenario((value) => !value)}>
                <Icon name={CurrentScenario.icon} size={15} />
                <span>{CurrentScenario.label}</span>
                <Icon name="chevron-up" className="chev" size={9} />
              </button>
              {showScenario && <div className="menu pop nv-menu" role="menu" aria-label="场景选择">
                <div className="menu-label">场景</div>
                {ScenarioOptions.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === scenarioId} className={item.id === scenarioId ? 'menu-item sel' : 'menu-item'} onClick={() => HandleScenarioChange(item.id)}>
                  <Icon name={item.icon} size={16} />
                  <span><span className="mt">{item.label}</span><span className="md">{item.description}</span></span>
                  <Icon name="check" className="tick" size={14} />
                </button>)}
                <div className="menu-foot">场景在整段对话里生效，开始对话后不再显示这两个按钮。</div>
              </div>}
            </div>
          </div>}
          <div className="composer-foot">
            <span>Enter 发送</span><span className="kbd-hint">Shift + Enter</span><span>换行</span>
            <span className="sep" />
            <span>{CurrentConfirmation.note}</span>
          </div>
        </div>}
      </div>
    </section>}
    {resumePanelOpen && <DocSidePanel resourceSelection={resourcePreview} onClearResourceSelection={() => setResourcePreview(null)} onClose={() => { setResourcePreview(null); setResumePanelOpen(false); }} resumes={resumes} currentResumeId={currentResumeId} editing={editing} resumeText={resumeText} canUndo={history.length > 0} panelWidth={panelWidth} contentRef={resumeSideRef} onSelectResume={HandleSelectResume} onEditChange={HandleEditChange} onStartEditing={() => void HandleStartEditing()} onCancelEditing={HandleCancelEditing} onSaveResume={() => void HandleSaveResume()} onUndo={UndoResumeEdit} onPanelWidthChange={setPanelWidth} />}
    <Modal
      open={showFullyTrustedWarning}
      title="开启完全信任模式"
      onClose={() => setShowFullyTrustedWarning(false)}
      footer={<>
        <DialogButton onClick={() => setShowFullyTrustedWarning(false)}>取消</DialogButton>
        <DialogButton tone="accent" onClick={() => { setShowFullyTrustedWarning(false); void ApplyConfirmationMode('fully_trusted'); }}>我了解风险，继续</DialogButton>
      </>}
    >
      开启后，Agent 可在当前场景的工具白名单与数据授权范围内自动执行操作，不再逐项请求确认。此设置不会授予新的工具、文件或账号权限。
    </Modal>
    <Modal
      open={attachmentErrors.length > 0}
      title="附件上传失败"
      onClose={DismissAttachmentError}
      footer={<DialogButton tone="accent" onClick={DismissAttachmentError}>知道了</DialogButton>}
    >
      {attachmentErrors[0] ?? ''}
    </Modal>
  </div>;
}

interface PendingQuestion {
  id: string;
  question: string;
  options: string[];
}

/** Agent 等待用户输入时，使用输入区原位卡片阻断普通消息，避免答复串入另一条任务。 */
function QuestionComposer({ questions, answers, otherAnswers, questionIndex, onAnswer, onOtherAnswer, onPrevious, onCancel, onContinue }: {
  questions: PendingQuestion[];
  answers: Record<string, string>;
  otherAnswers: Record<string, string>;
  questionIndex: number;
  onAnswer: (questionId: string, answer: string) => void;
  onOtherAnswer: (questionId: string, answer: string) => void;
  onPrevious: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const question = questions[questionIndex];
  if (!question) return null;
  const selectedAnswer = answers[question.id] ?? question.options[0] ?? '其他';
  const needsOtherText = selectedAnswer === '其他';
  const canContinue = !needsOtherText || Boolean(otherAnswers[question.id]?.trim());
  const isFinalQuestion = questionIndex === questions.length - 1;
  return <section className="composer confirmation-composer question-composer" aria-label="请先回答 Agent 的问题" aria-live="assertive">
    <header><h2>{question.question}</h2></header>
    <div className="question-choice-list" role="radiogroup" aria-label={question.question}>{question.options.map((option) => <button key={option} type="button" role="radio" aria-checked={selectedAnswer === option} className={selectedAnswer === option ? 'selected' : ''} onClick={() => onAnswer(question.id, option)}><span aria-hidden="true" />{option}</button>)}</div>
    {needsOtherText && <input autoFocus placeholder="请输入其他答案" value={otherAnswers[question.id] ?? ''} onChange={(event) => onOtherAnswer(question.id, event.target.value)} />}
    <footer><div className="confirmation-stepper"><button type="button" disabled={questionIndex === 0} aria-label="上一题" onClick={onPrevious}><Icon name="chevron-up" size={15} /></button><span>{questionIndex + 1}/{questions.length}</span><button type="button" disabled={isFinalQuestion} aria-label="下一题" onClick={onContinue}><Icon name="chevron-down" size={15} /></button></div><div><Button onClick={onCancel}>取消</Button><Button variant="primary" disabled={!canContinue} onClick={onContinue}>{isFinalQuestion ? '确认' : '继续'}</Button></div></footer>
  </section>;
}

/** 外部动作与内容变更沿用同一输入区确认框，取消和确认都是唯一可用动作。 */
function ConfirmationComposer({ title, description, preview, confirmLabel, onCancel, onConfirm }: { title: string; description: string; preview?: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return <section className="composer confirmation-composer" aria-label={title} aria-live="assertive">
    <header><h2>{title}</h2></header>
    <p>{description}</p>
    {preview && <pre>{preview}</pre>}
    <footer><span>请确认或取消后再继续对话。</span><div><Button onClick={onCancel}>取消</Button><Button variant="primary" onClick={onConfirm}>{confirmLabel}</Button></div></footer>
  </section>;
}

/** 新建对话界面：两个场景统一使用原型问候语，与输入框一起垂直居中。 */
function EmptyAssistant({ name }: { name: string }) {
  return <div className="empty"><h1>{name ? `你好${name}，需要什么帮助？` : '你好，需要什么帮助？'}</h1></div>;
}

export { AssistantPage };
