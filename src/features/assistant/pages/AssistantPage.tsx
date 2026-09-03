import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import type { AgentObservability, AgentStreamEvent, BrowserActionState, ConfirmationMode, ReasoningEffort } from '@avery/contracts';
import { CreateResumeDocumentMarkup } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { WORKSPACE_QUERY_KEY } from '../../../features/workspace/api/workspaceData';
import {
  useAppendConversationMessages, useCompleteConversationMessage, useConversations,
  useCreateConversation, usePatchConversations, useRemoveConversationMessage,
} from '../../../features/conversation/api/conversationQueries';
import { useResumes, useUpsertResume } from '../../../features/resume/api/resumeQueries';
import { useProfiles } from '../../../features/profile/api/profileQueries';
import { useSettings } from '../../../features/settings/api/settingsQueries';
import {
  AcquireResumeEditLock, BindProjectEnvironment, CancelAgentRequest, ConfirmBrowserAction, ConfirmCronTask, ConfirmResumeEdit, GetAgentObservability, GetAgentTraceEvents, GetDeepSeekModels, GetSessionAssistantState, ImportAttachmentFile,
  ReleaseResumeEditLock, ReloadAgentSession, SelectAgentProjectDirectory, SendAgentRequest, SubscribeAgentStream, UpdateAgentConfirmationMode, UpdateAgentReasoningEffort,
} from '../../../features/assistant/api/agentQueries';
import { Button, Modal, Select } from '../../../shared/components/UI';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { FormatTime } from '../../../shared/utils/format';
import { ASSISTANT_MAIN_MIN_WIDTH } from '../../../shared/layoutConstants';
import { CreateSessionUsagePresentation } from '../usagePresentation';
import { TraceViewer } from '../../developer/components/TraceViewer';
import type { ChatMessage, PageId } from '../../../types/domain';

const ScenarioOptions: Array<{ id: 'default' | 'application'; label: string; icon: IconName; description: string }> = [
  { id: 'default', label: '默认场景', icon: 'assistant', description: '读写简历与档案，不执行岗位投递' },
  { id: 'application', label: '浏览器投递', icon: 'applications', description: '使用独立持久化浏览器搜索与投递' },
];
const FallbackDeepSeekModels = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
const FallbackReasoningEfforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ReasoningEffortLabels: Record<ReasoningEffort, string> = {
  low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
};
const ConfirmationOptions: Array<{ id: ConfirmationMode; label: string; description: string }> = [
  { id: 'always_confirm', label: '始终确认', description: '执行任何外部修改前都征求同意' },
  { id: 'allow_low_risk', label: '允许低风险', description: '低风险操作自动执行，其他操作仍确认' },
  { id: 'fully_trusted', label: '完全信任', description: '在当前工具与数据授权范围内自动执行' },
];

function TruncateResumeTitle(title: string) {
  const characters = Array.from(title.trim() || '未命名简历');
  return characters.slice(0, 8).join('');
}

/** 侧栏预览始终复用导出模板：历史内容会安全降级为段落和列表。 */
function ResumePreview({ name, content }: { name: string; content: string }) {
  return <div className="resume-html-preview" dangerouslySetInnerHTML={{ __html: CreateResumeDocumentMarkup({ name, summary: '', content }) }} />;
}
type SessionUsageView = {
  percent: number; threshold: number; compressionCount: number; tokens: number; limit: number;
  source: 'actual' | 'unavailable' | 'legacy_estimate' | 'loading'; promptTokens: number; completionTokens: number; totalTokens: number; reportedRequestCount: number; unreportedRequestCount: number;
};
const EmptyUsage: SessionUsageView = {
  percent: 0, threshold: 80, compressionCount: 0, tokens: 0, limit: 256000,
  source: 'loading', promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0,
};
const ComposerCompactWidth = 640;

function UpgradeDeepSeekModel(model: string | undefined) {
  return model === 'deepseek-chat' || model === 'deepseek-reasoner' || !model ? 'deepseek-v4-flash' : model;
}

/** 官方单模型 Provider 不接受会话遗留的其他模型名；切换供应商后立即归一化本地会话选择。 */
function ResolveProviderModel(provider: string, model: string | undefined) {
  if (provider === 'Z.AI') return 'glm-5.3-flash';
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

interface ComposerAttachment { name: string; path: string; }
interface AgentTodo { id: string; title: string; description: string; status: string; }

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
  const { activeConversationId, setActiveConversationId, currentResumeId, setCurrentResumeId, resumePanelOpen, setResumePanelOpen, setRightPanelWidth, assistantView, ShowNotice } = useUiStore();
  const conversations = useConversations();
  const resumes = useResumes();
  const profiles = useProfiles();
  const settings = useSettings();
  const createConversation = useCreateConversation({ onFailure: () => ShowNotice('会话创建失败，请稍后重试。') });
  const appendMessages = useAppendConversationMessages({ onFailure: () => ShowNotice('消息保存失败，请稍后重试。') });
  const completeMessage = useCompleteConversationMessage({ onFailure: () => ShowNotice('消息保存失败，请稍后重试。') });
  const removeMessage = useRemoveConversationMessage();
  const upsertResume = useUpsertResume({ onConflict: () => ShowNotice('简历已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('简历保存失败，请稍后重试。') });
  const patchConversations = usePatchConversations();
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [projectEnvironment, setProjectEnvironment] = useState<{ projectId: string | null; name: string } | null>(null);
  const [permission, setPermission] = useState<ConfirmationMode>('always_confirm');
  const [showPermission, setShowPermission] = useState(false);
  const [showFullyTrustedWarning, setShowFullyTrustedWarning] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showReasoningEffort, setShowReasoningEffort] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [scenarioId, setScenarioId] = useState<'default' | 'application'>('default');
  const [model, setModel] = useState(ResolveProviderModel(settings.provider, settings.model));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [deepSeekModels, setDeepSeekModels] = useState<string[]>(FallbackDeepSeekModels);
  const [isTaskActive, setIsTaskActive] = useState(false);
  const [panelWidth, setPanelWidth] = useState(430);
  const [isComposerCompact, setIsComposerCompact] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showResumeMenu, setShowResumeMenu] = useState(false);
  const [resumeText, setResumeText] = useState(resumes.find((item) => item.id === currentResumeId)?.content ?? '');
  const [savedText, setSavedText] = useState(resumeText);
  const [history, setHistory] = useState<string[]>([]);
  const [agentTodos, setAgentTodos] = useState<AgentTodo[]>([]);
  const [pendingEdit, setPendingEdit] = useState<{ confirmationId: string; name?: string; content: string; reason: string } | null>(null);
  const [pendingBrowserAction, setPendingBrowserAction] = useState<BrowserActionState | null>(null);
  const [pendingCronTask, setPendingCronTask] = useState<{ confirmationId: string; title: string; message: string; scenarioId: 'default' | 'application'; schedule: unknown; summary: string } | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<Array<{ id: string; question: string; options: string[] }> | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [pendingQuestionIndex, setPendingQuestionIndex] = useState(0);
  const [usage, setUsage] = useState(EmptyUsage);
  const [observability, setObservability] = useState<AgentObservability | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const enteredConversationRef = useRef<string | null>(null);
  const resumeSideRef = useRef<HTMLElement>(null);
  const panelWidthRef = useRef(430);
  const activeRequestRef = useRef<string | null>(null);
  const activePlaceholderRef = useRef<{ conversationId: string; requestId: string; content: string; thinkingContent: string } | null>(null);
  const resumesRef = useRef(resumes);
  // 用户编辑锁：记录持有锁的简历，保存/取消/卸载时释放。
  const editLockRef = useRef<string | null>(null);
  // 最新值 ref：流式订阅只依赖稳定引用，避免每次渲染重订阅。
  const completeMessageRef = useRef(completeMessage);
  const removeMessageRef = useRef(removeMessage);
  const patchConversationsRef = useRef(patchConversations);
  const activeConversationRef = useRef(activeConversationId);
  const sessionLoadVersionRef = useRef(0);
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState(0);
  const queryClient = useQueryClient();
  completeMessageRef.current = completeMessage;
  removeMessageRef.current = removeMessage;
  patchConversationsRef.current = patchConversations;
  activeConversationRef.current = activeConversationId;

  const RefreshConversationTrace = useCallback(async () => {
    setObservability(await GetAgentObservability());
  }, []);

  useEffect(() => {
    if (assistantView === 'trace') void RefreshConversationTrace();
  }, [activeConversationId, assistantView, RefreshConversationTrace]);

  const conversation = useMemo(() => conversations.find((item) => item.id === activeConversationId), [conversations, activeConversationId]);
  const resume = resumes.find((item) => item.id === currentResumeId);
  const usagePresentation = CreateSessionUsagePresentation({
    inputTokens: usage.tokens,
    contextLimit: usage.limit,
    compressionThreshold: usage.threshold,
    source: usage.source,
    reportedRequestCount: usage.reportedRequestCount,
    unreportedRequestCount: usage.unreportedRequestCount,
  });
  const activeTodo = agentTodos.find((item) => GetTodoPresentation(item.status).className === 'is-in-progress') ?? agentTodos.find((item) => GetTodoPresentation(item.status).className === 'is-pending') ?? agentTodos.at(-1);
  const PersistConversationComposerState = useCallback((conversationId: string | null, patch: Partial<StoredConversationComposerState>) => {
    if (!conversationId) return;
    const states = ReadConversationComposerStates();
    const existing: StoredConversationComposerState = states[conversationId] ?? {
      confirmationMode: 'always_confirm' as ConfirmationMode,
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

  /** 以输入栏的实际可用宽度切换紧凑控件，不依赖任一侧栏的拖拽方向或宽度。 */
  useEffect(() => {
    const composerElement = composerRef.current;
    if (!composerElement) return undefined;
    const UpdateComposerDensity = () => setIsComposerCompact(composerElement.clientWidth < ComposerCompactWidth);
    UpdateComposerDensity();
    const observer = new ResizeObserver(UpdateComposerDensity);
    observer.observe(composerElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!showPermission && !showScenario && !showModel && !showReasoningEffort && !showResumeMenu) return undefined;
    const CloseAssistantMenusOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      const composerMenu = target instanceof Element ? target.closest('.menu-wrap') : null;
      const resumeSwitcher = resumeSideRef.current?.querySelector('.resume-switcher');
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
      if (!resumeSwitcher?.contains(target as Node)) setShowResumeMenu(false);
    };
    const CloseAssistantMenusOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowPermission(false);
      setShowScenario(false);
      setShowModel(false);
      setShowReasoningEffort(false);
      setShowResumeMenu(false);
    };
    document.addEventListener('pointerdown', CloseAssistantMenusOnOutsidePointer);
    document.addEventListener('keydown', CloseAssistantMenusOnEscape);
    return () => {
      document.removeEventListener('pointerdown', CloseAssistantMenusOnOutsidePointer);
      document.removeEventListener('keydown', CloseAssistantMenusOnEscape);
    };
  }, [showModel, showPermission, showReasoningEffort, showResumeMenu, showScenario]);

  /** 读取会话专属状态。切换时先清空旧会话数据，迟到响应不得覆盖当前会话。 */
  const RefreshSessionAssistantState = useCallback(async (sessionId: string | null) => {
    const version = ++sessionLoadVersionRef.current;
    if (!sessionId) { setUsage(EmptyUsage); setProjectEnvironment(null); return; }
    setUsage(EmptyUsage);
    setProjectEnvironment(null);
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
        reportedRequestCount: next.usage.reportedRequestCount,
        unreportedRequestCount: next.usage.unreportedRequestCount,
      });
      setProjectEnvironment(next.project);
      setScenarioId(next.scenarioId);
      // 本地选择可能比后端上一次发送快照更新；仅在本地缓存缺失时使用后端恢复值。
      // 这样页面重进不覆盖尚未发送的新选择，清理缓存后仍可由后端恢复。
      const localComposerState = ReadConversationComposerStates()[sessionId];
      if (!localComposerState) {
        setPermission(next.confirmationMode);
        setModel(ResolveProviderModel(settings.provider, next.model));
        setReasoningEffort(next.reasoningEffort);
        PersistConversationComposerState(sessionId, { confirmationMode: next.confirmationMode, model: next.model, reasoningEffort: next.reasoningEffort });
      }
    } catch {
      if (version === sessionLoadVersionRef.current && activeConversationRef.current === sessionId) {
        setUsage({ ...EmptyUsage, source: 'unavailable' });
        ShowNotice('会话状态恢复失败，当前 usage 未知');
      }
    }
  }, [PersistConversationComposerState, ShowNotice, settings.provider]);

  useEffect(() => { void RefreshSessionAssistantState(activeConversationId); }, [activeConversationId, RefreshSessionAssistantState]);

  /** 会话切换、页面重进和设置更新时优先恢复会话选择；没有缓存的旧会话才使用安全默认值。 */
  useEffect(() => {
    const defaultModel = ResolveProviderModel(settings.provider, settings.model);
    if (!activeConversationId) {
      setPermission('always_confirm');
      setModel(defaultModel);
      setReasoningEffort('medium');
      return;
    }
    const stored = ReadConversationComposerStates()[activeConversationId];
    setPermission(stored?.confirmationMode ?? 'always_confirm');
    const restoredModel = ResolveProviderModel(settings.provider, stored?.model ?? defaultModel);
    setModel(restoredModel);
    if (stored && restoredModel !== stored.model) PersistConversationComposerState(activeConversationId, { model: restoredModel });
    setReasoningEffort(stored?.reasoningEffort ?? 'medium');
  }, [activeConversationId, PersistConversationComposerState, settings.model, settings.provider]);
  useEffect(() => {
    if (settings.provider !== 'DeepSeek') return;
    void GetDeepSeekModels().then((result) => { if (result.models.length) setDeepSeekModels(result.models); }).catch(() => undefined);
  }, [settings.provider]);

  // 卸载时释放仍持有的用户编辑锁，避免锁在租约期内阻塞 Agent 编辑。
  useEffect(() => () => { if (editLockRef.current) void ReleaseResumeEditLock(editLockRef.current); }, []);

  useEffect(() => SubscribeAgentStream((event: AgentStreamEvent) => {
    const updatedContent = event.content;
    if (event.type === 'resume_updated' && event.resumeId && typeof updatedContent === 'string') {
      // 后端已落库：失效工作空间聚合缓存并从事件内容同步本地展示。
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
      // 用户正持锁编辑该简历（租约可能已过期）：跳过本地覆盖，避免 Agent 内容覆盖用户未保存编辑。
      if (event.resumeId === currentResumeId && editLockRef.current !== event.resumeId) { setResumeText(updatedContent); setSavedText(updatedContent); setHistory([]); }
      ShowNotice('Agent 已保存简历修改');
      return;
    }
    if (event.type === 'resume_created' && event.resumeId && event.resumeName && typeof updatedContent === 'string') {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
      setCurrentResumeId(event.resumeId);
      setResumeText(updatedContent);
      setSavedText(updatedContent);
      setHistory([]);
      ShowNotice('Agent 已创建并保存简历');
      return;
    }
    if (event.type === 'resume_confirmation' && event.confirmationId && typeof updatedContent === 'string') {
      setPendingEdit({ confirmationId: event.confirmationId, name: event.resumeName, content: updatedContent, reason: event.reason ?? '更新简历内容' });
      return;
    }
    if (event.type === 'browser_confirmation' && event.browserAction?.confirmationId) {
      setPendingBrowserAction(event.browserAction);
      return;
    }
    if (event.type === 'cron_task_confirmation' && event.confirmationId && event.cronTask) {
      setPendingCronTask({
        confirmationId: event.confirmationId, title: event.cronTask.title ?? '定时任务', message: event.cronTask.message ?? '',
        scenarioId: event.cronTask.scenarioId ?? 'default', schedule: event.cronTask.schedule, summary: event.cronTask.summary ?? '该任务将以无人值守模式定时执行。',
      });
      return;
    }
    if (event.type === 'cron_task_changed' || event.type === 'cron_run_completed') { queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }); return; }
    if (event.type === 'browser_action_completed' && event.browserAction) {
      setPendingBrowserAction(null);
      if (event.browserAction.status === 'status_unknown') ShowNotice('浏览器动作结果未知，请先在目标网站核对，不要重复执行');
      else if (event.browserAction.status === 'succeeded') ShowNotice('浏览器动作已执行，Agent 将自动继续');
      return;
    }
    if (event.type === 'browser_user_action') {
      ShowNotice(event.browserAction?.summary ?? '请在可见浏览器中完成登录或验证，然后发送“继续任务”');
      return;
    }
    if ((event.type === 'task_created' || event.type === 'task_updated') && event.task) {
      const task = event.task;
      setAgentTodos((current) => {
        const index = current.findIndex((item) => item.id === task.id);
        if (index < 0) return [...current, task];
        return current.map((item, itemIndex) => itemIndex === index ? task : item);
      });
      setIsTaskActive(true);
      return;
    }
    if (event.type === 'task_deleted' && event.task) {
      const deletedTaskId = event.task.id;
      setAgentTodos((current) => current.filter((item) => item.id !== deletedTaskId));
      return;
    }
    if (event.type === 'question_requested' && event.questions) { setPendingQuestions(event.questions); setQuestionAnswers(Object.fromEntries(event.questions.map((question) => [question.id, question.options[0] ?? '其他']))); setOtherAnswers({}); setPendingQuestionIndex(0); return; }
    if (event.type === 'waiting_user_input' || event.type === 'waiting_confirmation' || event.type === 'paused') {
      const waitingRequestId = activeRequestRef.current;
      if (!waitingRequestId || event.requestId !== waitingRequestId) return;
      const placeholder = activePlaceholderRef.current;
      const waitingSessionId = placeholder?.conversationId ?? null;
      if (placeholder) completeMessageRef.current.mutate({ conversationId: placeholder.conversationId, messageId: `reply-${placeholder.requestId}`, content: placeholder.content, thinkingContent: placeholder.thinkingContent });
      activePlaceholderRef.current = null;
      activeRequestRef.current = null;
      if (event.type === 'paused') ShowNotice('Agent 运行已暂停');
      if (waitingSessionId) void RefreshSessionAssistantState(waitingSessionId);
      return;
    }
    const requestId = activeRequestRef.current;
    if (!requestId || event.requestId !== requestId) return;
    const completedSessionId = activePlaceholderRef.current?.conversationId ?? null;
    if (event.type === 'thinking_delta' || event.type === 'content_delta') {
      const placeholder = activePlaceholderRef.current;
      if (placeholder) {
        const delta = event.delta ?? '';
        activePlaceholderRef.current = {
          ...placeholder,
          content: event.type === 'content_delta' ? `${placeholder.content}${delta}` : placeholder.content,
          thinkingContent: event.type === 'thinking_delta' ? `${placeholder.thinkingContent}${delta}` : placeholder.thinkingContent,
        };
      }
      patchConversationsRef.current((current) => current.map((item) => ({
        ...item,
        messages: item.messages.map((message) => message.id !== `reply-${event.requestId}` ? message : {
          ...message,
          content: event.type === 'content_delta' ? `${message.content}${event.delta ?? ''}` : message.content,
          thinkingContent: event.type === 'thinking_delta' ? `${message.thinkingContent ?? ''}${event.delta ?? ''}` : message.thinkingContent,
        }),
      })));
      return;
    }
    if (event.type === 'completed') {
      const placeholder = activePlaceholderRef.current;
      if (placeholder) completeMessageRef.current.mutate({ conversationId: placeholder.conversationId, messageId: `reply-${placeholder.requestId}`, content: placeholder.content, thinkingContent: placeholder.thinkingContent });
      if (completedSessionId === activeConversationRef.current) setScrollToBottomRequest((current) => current + 1);
      activePlaceholderRef.current = null;
    }
    if (event.type === 'cancelled') {
      const placeholder = activePlaceholderRef.current;
      if (placeholder) completeMessageRef.current.mutate({ conversationId: placeholder.conversationId, messageId: `reply-${placeholder.requestId}`, content: placeholder.content, thinkingContent: placeholder.thinkingContent });
      activePlaceholderRef.current = null;
      ShowNotice('已停止生成');
    }
    if (event.type === 'error') {
      const placeholder = activePlaceholderRef.current;
      if (placeholder) removeMessageRef.current.mutate({ conversationId: placeholder.conversationId, messageId: `reply-${placeholder.requestId}` });
      activePlaceholderRef.current = null;
      ShowNotice(event.message ?? 'Agent 请求失败');
    }
    activeRequestRef.current = null;
    if (completedSessionId) void RefreshSessionAssistantState(completedSessionId);
  }), [ShowNotice, currentResumeId, RefreshSessionAssistantState]);

  async function HandleSend(contentOverride?: string) {
    const text = (contentOverride ?? composer).trim();
    if (text === '/reload' || text === '/reload-session') {
      if (!activeConversationId) { ShowNotice('请先发送一条消息建立会话，再重载会话上下文'); return; }
      const result = await ReloadAgentSession(activeConversationId);
      if (result.reloaded) ShowNotice(`会话上下文已重载（revision ${result.sessionRevision ?? ''}）`);
      else ShowNotice(result.reason === 'busy' ? 'Agent 正在处理，请等待本轮结束后再试' : '会话上下文重载失败');
      return;
    }
    if ((!text && attachments.length === 0) || activeRequestRef.current) return;
    let targetId = activeConversationId;
    if (!targetId) {
      try {
        targetId = await createConversation(text.slice(0, 18) || '新的求职会话');
        enteredConversationRef.current = targetId;
      } catch {
        // 会话创建失败通知已由 mutation onFailure 展示；中止本轮发送。
        return;
      }
    }
    const requestId = `request-${crypto.randomUUID()}`;
    const message: ChatMessage = { id: `message-${Date.now()}`, role: 'user', content: `${text || '请分析我上传的文件'}${attachments.length ? `（附 ${attachments.length} 个附件）` : ''}`, createdAt: Date.now() };
    const placeholder: ChatMessage = { id: `reply-${requestId}`, role: 'assistant', content: '', thinkingContent: '', createdAt: Date.now() };
    patchConversations((current) => current.some((item) => item.id === targetId) ? current.map((item) => item.id === targetId ? { ...item, updatedAt: Date.now(), messages: [...item.messages, message, placeholder] } : item) : [{ id: targetId, title: text.slice(0, 18) || '新的求职会话', updatedAt: Date.now(), messages: [message, placeholder] }, ...current]);
    appendMessages.mutate({ conversationId: targetId, messages: [message, placeholder] });
    // 新会话在首条请求前写入当前选择，后续切回该会话不再丢失模型和确认权限。
    PersistConversationComposerState(targetId, { confirmationMode: permission, model, reasoningEffort });
    setActiveConversationId(targetId);
    activeRequestRef.current = requestId;
    try {
      let boundProject = projectEnvironment;
      if (projectEnvironment?.projectId) {
        const project = await BindProjectEnvironment(targetId, projectEnvironment.projectId);
        boundProject = project ?? projectEnvironment;
        if (activeConversationRef.current === targetId) setProjectEnvironment(boundProject);
      }
      activePlaceholderRef.current = { conversationId: targetId, requestId, content: '', thinkingContent: '' };
      setComposer(''); setAttachments([]); setAgentTodos([]); setIsTaskActive(false);
      await SendAgentRequest({ requestId, sessionId: targetId, content: message.content, model, reasoningEffort, confirmationMode: permission, attachments, projectId: boundProject?.projectId ?? undefined, resumeId: currentResumeId ?? undefined, scenarioId });
    } catch (error) {
      removeMessage.mutate({ conversationId: targetId, messageId: `reply-${requestId}` });
      activePlaceholderRef.current = null;
      activeRequestRef.current = null;
      setIsTaskActive(false);
      ShowNotice(error instanceof Error ? error.message : '无法发起 Agent 请求');
    }
  }

  function HandleStop() { if (activeRequestRef.current) void CancelAgentRequest(activeRequestRef.current); }

  /** 权限切换同时更新在途 Run；完全信任由警告弹窗的显式确认入口调用。 */
  async function ApplyConfirmationMode(next: ConfirmationMode) {
    setPermission(next);
    setShowPermission(false);
    PersistConversationComposerState(activeConversationId, { confirmationMode: next });
    const requestId = activeRequestRef.current;
    if (!requestId) return;
    try {
      await UpdateAgentConfirmationMode(requestId, next);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '确认权限同步失败，将在下一轮任务生效');
    }
  }

  function HandleSelectModel(nextModel: string) {
    const nextEffortOptions = GetReasoningEffortOptions(nextModel);
    const nextReasoningEffort = nextEffortOptions.includes(reasoningEffort) ? reasoningEffort : GetDefaultReasoningEffort(nextEffortOptions);
    setModel(nextModel);
    setReasoningEffort(nextReasoningEffort);
    setShowModel(false);
    PersistConversationComposerState(activeConversationId, { model: nextModel, reasoningEffort: nextReasoningEffort });
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

  async function HandleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    try {
      const selected = await Promise.all(files.map(async (file) => {
        const attachment = await ImportAttachmentFile(file);
        return { name: attachment.name, path: attachment.uri };
      }));
      setAttachments((current) => [...current, ...selected].slice(0, 10));
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '附件导入失败');
    }
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
  function HandleResize(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX; const start = panelWidthRef.current;
    const layoutWidth = resumeSideRef.current?.parentElement?.clientWidth ?? 0;
    // 始终给对话和输入栏保留最低阅读宽度；不足时由 CSS 的窄屏抽屉规则接管。
    const maximum = Math.min(720, Math.max(360, layoutWidth - ASSISTANT_MAIN_MIN_WIDTH));
    document.body.classList.add('is-resizing-resume');
    function HandleMove(moveEvent: globalThis.MouseEvent) {
      const width = Math.min(maximum, Math.max(360, start - (moveEvent.clientX - startX)));
      panelWidthRef.current = width;
      setPanelWidth(width);
      setRightPanelWidth(width);
    }
    function HandleUp() {
      setPanelWidth(panelWidthRef.current);
      setRightPanelWidth(panelWidthRef.current);
      document.body.classList.remove('is-resizing-resume');
      document.removeEventListener('mousemove', HandleMove);
      document.removeEventListener('mouseup', HandleUp);
    }
    document.addEventListener('mousemove', HandleMove); document.addEventListener('mouseup', HandleUp);
  }
  function HandleEditChange(value: string) { setHistory((current) => [...current, resumeText]); setResumeText(value); }
  /** 用户发起手动编辑前获取后端互斥锁；Agent 占用或本轮仍在处理时拒绝进入编辑。 */
  async function HandleStartEditing() {
    if (!resume) return;
    if (activeRequestRef.current) { ShowNotice('Agent 正在处理当前简历，请等待本轮结束后再编辑'); return; }
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
  /** 切换当前简历：释放仍持有的编辑锁并重置编辑态，加载用户在菜单中选定的简历。 */
  function HandleSelectResume(resumeId: string) {
    setShowResumeMenu(false);
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
    if (activeRequestRef.current) { ShowNotice('Agent 正在执行任务，请停止或等待本轮结束后再切换场景'); return; }
    setActiveConversationId(null);
    setIsTaskActive(false);
    setShowScenario(false);
    setScenarioId(nextScenarioId);
    // 场景切换会建立新会话；确认权限不得跨场景沿用，尤其不能把完全信任隐式带入真实网站投递。
    setPermission('always_confirm');
    onNavigate('assistant');
    ShowNotice(`已切换到${ScenarioOptions.find((item) => item.id === nextScenarioId)?.label}的新对话`);
  }

  async function HandlePendingEdit(accepted: boolean) {
    if (!pendingEdit) return;
    try {
      const result = await ConfirmResumeEdit(pendingEdit.confirmationId, accepted);
      ShowNotice(result.applied ? '已确认并保存 Agent 修改' : '已拒绝 Agent 修改');
      setPendingEdit(null);
      void HandleSend(result.applied
        ? '我已确认并保存上述简历修改，请继续任务。'
        : '我拒绝了上述简历修改，请根据我的决定调整方案并继续任务。');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '无法处理简历确认'); }
  }

  async function HandlePendingCronTask(accepted: boolean) {
    if (!pendingCronTask) return;
    try {
      const result = await ConfirmCronTask(pendingCronTask.confirmationId, accepted);
      ShowNotice(result.created ? '定时任务已保存并注册后台唤醒' : '已取消创建定时任务');
      setPendingCronTask(null);
      void HandleSend(result.created
        ? '我已确认创建上述定时任务，任务已经保存，请继续。'
        : '我拒绝创建上述定时任务，请根据我的决定调整方案并继续。');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '无法处理定时任务确认'); }
  }

  async function HandlePendingBrowserAction(accepted: boolean) {
    const confirmationId = pendingBrowserAction?.confirmationId;
    if (!confirmationId) return;
    try {
      const result = await ConfirmBrowserAction(confirmationId, accepted);
      setPendingBrowserAction(null);
      if (result.status === 'succeeded') {
        ShowNotice('浏览器动作已执行，Agent 将自动继续');
        void HandleSend('我已确认上述浏览器操作，操作已执行成功。请重新读取当前页面状态并继续任务。');
      } else if (result.status === 'status_unknown') {
        ShowNotice('动作结果未知，Agent 将重新核对页面');
        void HandleSend('我已确认上述浏览器操作，但执行结果未知。请重新读取当前页面状态，不要重复执行该操作。');
      } else if (result.status === 'failed') {
        ShowNotice('浏览器动作执行失败，Agent 将根据结果继续');
        void HandleSend(`我已确认上述浏览器操作，但执行失败${result.message ? `：${result.message}` : ''}。请根据结果调整方案并继续任务。`);
      } else {
        ShowNotice('已拒绝浏览器动作，Agent 将自动继续');
        void HandleSend('我拒绝执行上述浏览器操作，请根据我的决定调整方案并继续任务。');
      }
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '无法处理浏览器确认'); }
  }

  function SubmitQuestionAnswers() {
    if (!pendingQuestions) return;
    const incomplete = pendingQuestions.some((question) => questionAnswers[question.id] === '其他' && !otherAnswers[question.id]?.trim());
    if (incomplete) { ShowNotice('请选择或填写每一道问题的答案'); return; }
    const answer = pendingQuestions.map((question) => `【${question.question}】${questionAnswers[question.id] === '其他' ? otherAnswers[question.id].trim() : questionAnswers[question.id]}`).join('\n');
    setPendingQuestions(null);
    void HandleSend(answer);
  }

  function CancelPendingQuestions() {
    setPendingQuestions(null);
    setQuestionAnswers({});
    setOtherAnswers({});
    setPendingQuestionIndex(0);
  }

  function ContinuePendingQuestions() {
    if (!pendingQuestions) return;
    if (pendingQuestionIndex < pendingQuestions.length - 1) { setPendingQuestionIndex((current) => current + 1); return; }
    SubmitQuestionAnswers();
  }

  const isEmptyConversation = !conversation?.messages.length;
  const hasComposerBlocker = Boolean(pendingQuestions || pendingEdit || pendingCronTask || pendingBrowserAction);
  const reasoningEffortOptions = GetReasoningEffortOptions(model);
  const reasoningEffortIndex = Math.max(0, reasoningEffortOptions.indexOf(reasoningEffort));
  return <div className={`assistant-layout ${isComposerCompact ? 'is-composer-compact' : ''}`} style={{ '--assistant-main-min-width': `${ASSISTANT_MAIN_MIN_WIDTH}px` } as CSSProperties}>
    {assistantView === 'trace' ? <section className="assistant-main assistant-trace" aria-label="当前对话轨迹"><TraceViewer traces={observability?.traces ?? []} conversations={conversations} focusConversationId={activeConversationId} onSelectTrace={GetAgentTraceEvents} /></section> : <section className={`assistant-main ${isEmptyConversation ? 'is-empty-conversation' : ''}`}>
      {conversation?.messages.length ? <div ref={messageListRef} className="message-list"><div className="message-thread">{conversation.messages.map((message) => <article key={message.id} className={`chat-message ${message.role}`}><div className="message-meta">{message.role === 'assistant' ? <><span className="agent-dot" />AVERY 回信</> : '你'}<time>{FormatTime(message.createdAt)}</time></div>{message.role === 'assistant' && settings.thinkingEnabled && message.thinkingContent && <details className="thinking-block"><summary>思考内容</summary><div className="thinking-content"><MarkdownText content={message.thinkingContent} /></div></details>}<MarkdownText content={message.content} /></article>)}</div></div> : <EmptyAssistant scenarioId={scenarioId} />}
      <div className="composer-dock">
        {isTaskActive && agentTodos.length > 0 && <div className="task-dock"><div className="task-summary"><span className={`task-status-icon ${GetTodoPresentation(activeTodo?.status ?? 'pending').className}`} aria-hidden="true">{GetTodoPresentation(activeTodo?.status ?? 'pending').symbol}</span><span className="task-summary-copy">{activeTodo?.title ?? '正在处理任务'}</span><span className={`task-summary-status ${GetTodoPresentation(activeTodo?.status ?? 'pending').className}`}>{GetTodoPresentation(activeTodo?.status ?? 'pending').label}</span></div><div className="task-card" aria-label="Todo 列表"><div className="task-card-heading">Todo · {agentTodos.length} 项</div><div className="task-list">{agentTodos.map((todo) => { const presentation = GetTodoPresentation(todo.status); return <div key={todo.id} className={`task-list-item ${presentation.className}`}><span className="task-status-icon" aria-hidden="true">{presentation.symbol}</span><span className="task-list-title">{todo.title}</span><span className="task-list-status">{presentation.label}</span></div>; })}</div></div></div>}
        {!hasComposerBlocker && attachments.length > 0 && <div className="attachment-row">{attachments.map((attachment) => <span className="attachment-chip" key={`${attachment.name}-${attachment.path}`}><Icon name="resume" size={14} /><span className="attachment-name">{attachment.name}</span><button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item !== attachment))}><Icon name="close" size={13} /></button></span>)}</div>}
        {!hasComposerBlocker && !conversation?.messages.length && <div className="composer-context-tags"><button className="workspace-tag" type="button" onClick={() => void HandleSelectProject()}><Icon name="jobs" size={16} /><span>{projectEnvironment ? projectEnvironment.name : '选择工作区'}</span></button><div className="menu-wrap"><button className="scenario-button context-scenario-tag" type="button" disabled={Boolean(activeRequestRef.current)} aria-label={`场景：${ScenarioOptions.find((item) => item.id === scenarioId)?.label}`} aria-expanded={showScenario} onClick={() => setShowScenario((value) => !value)}><Icon name={scenarioId === 'application' ? 'applications' : 'assistant'} size={16} /><span className="context-tag-label">场景</span><span className="scenario-label">{ScenarioOptions.find((item) => item.id === scenarioId)?.label}</span><span className="chevron-indicator" aria-hidden="true" /></button>{showScenario && <div className="popup-menu scenario-menu" role="menu" aria-label="切换场景">{ScenarioOptions.map((item) => <button key={item.id} type="button" role="menuitem" className={item.id === scenarioId ? 'selected' : ''} onClick={() => HandleScenarioChange(item.id)}><b><Icon name={item.icon} size={15} />{item.label}</b><small>{item.description}</small></button>)}</div>}</div></div>}
        {pendingQuestions ? <QuestionComposer questions={pendingQuestions} answers={questionAnswers} otherAnswers={otherAnswers} questionIndex={pendingQuestionIndex} onAnswer={(questionId, answer) => setQuestionAnswers((current) => ({ ...current, [questionId]: answer }))} onOtherAnswer={(questionId, answer) => setOtherAnswers((current) => ({ ...current, [questionId]: answer }))} onPrevious={() => setPendingQuestionIndex((current) => Math.max(0, current - 1))} onCancel={CancelPendingQuestions} onContinue={ContinuePendingQuestions} /> : pendingEdit ? <ConfirmationComposer title="确认 Agent 修改简历" description={pendingEdit.reason} preview={pendingEdit.content} confirmLabel="确认并保存" onCancel={() => void HandlePendingEdit(false)} onConfirm={() => void HandlePendingEdit(true)} /> : pendingCronTask ? <ConfirmationComposer title="确认创建无人值守定时任务" description={`${pendingCronTask.summary}\n任务消息：${pendingCronTask.message}`} preview={JSON.stringify(pendingCronTask.schedule, null, 2)} confirmLabel="确认整个周期" onCancel={() => void HandlePendingCronTask(false)} onConfirm={() => void HandlePendingCronTask(true)} /> : pendingBrowserAction ? <ConfirmationComposer title="确认浏览器外部动作" description={`${pendingBrowserAction.summary ?? pendingBrowserAction.toolName}${pendingBrowserAction.url ? `\n目标网站：${pendingBrowserAction.url}` : ''}\n风险级别：${pendingBrowserAction.risk === 'high' ? '高风险' : pendingBrowserAction.risk === 'medium' ? '中风险' : '低风险'}`} confirmLabel="确认执行" onCancel={() => void HandlePendingBrowserAction(false)} onConfirm={() => void HandlePendingBrowserAction(true)} /> : <div ref={composerRef} className="composer">
          <textarea value={composer} placeholder={scenarioId === 'application' ? '写下岗位关键词或粘贴招聘网址，如：搜索上海的前端开发岗位…' : '写下你的需求，如：把这段项目经历写得更突出成果…'} onChange={(event) => setComposer(event.target.value)} onKeyDown={HandleKeyDown} />
          <div className="composer-bar">
            <div>
              <input ref={inputRef} className="visually-hidden" type="file" multiple accept=".pdf,.doc,.docx,.txt,image/png,image/jpeg,image/gif,image/webp" onChange={HandleFiles} />
              <button type="button" aria-label="上传文件" title="上传文件" onClick={() => inputRef.current?.click()}><Icon name="plus" size={18} /></button>
              <div className="menu-wrap">
                <button className="permission-button" type="button" aria-label={`权限：${ConfirmationOptions.find((item) => item.id === permission)?.label}`} aria-expanded={showPermission} onClick={() => setShowPermission((value) => !value)}><Icon name={permission === 'fully_trusted' ? 'user-x' : 'user-check'} size={15} /><span className="permission-label">{ConfirmationOptions.find((item) => item.id === permission)?.label}</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showPermission && <div className="popup-menu">{ConfirmationOptions.map((item) => <button key={item.id} onClick={() => { if (item.id === 'fully_trusted') { setShowPermission(false); setShowFullyTrustedWarning(true); } else void ApplyConfirmationMode(item.id); }}><b>{item.label}</b><small>{item.description}</small></button>)}</div>}
              </div>
            </div>
            <div>
              <div className="composer-usage-ring" role="status" title={usagePresentation.title} aria-label={usagePresentation.title}>
                <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
                  <circle className="composer-usage-ring-track" cx="18" cy="18" r="11.75" pathLength="100" />
                  <circle className="composer-usage-ring-progress" cx="18" cy="18" r="11.75" pathLength="100" style={{ strokeDashoffset: 100 - usagePresentation.progress }} />
                </svg>
              </div>
              <div className="menu-wrap">
                <button className={`model-button ${settings.provider === 'DeepSeek' ? 'is-deepseek' : ''}`} type="button" aria-label={`模型：${model}`} aria-expanded={showModel} onClick={() => setShowModel((value) => !value)}>{settings.provider === 'DeepSeek' && <Icon name="deepseek" size={15} />}<span className="model-label">{model}</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showModel && <div className="popup-menu right">{settings.provider === 'DeepSeek' ? deepSeekModels.map((availableModel) => <button key={availableModel} onClick={() => HandleSelectModel(availableModel)}>{availableModel}</button>) : <button onClick={() => HandleSelectModel(settings.model ?? '')}>{settings.model}</button>}</div>}
              </div>
              <div className="menu-wrap reasoning-effort-wrap">
                <button className="reasoning-effort-button" type="button" aria-label={`思考模式：${ReasoningEffortLabels[reasoningEffort]}`} aria-expanded={showReasoningEffort} title="思考强度按会话保存，并在下一轮模型请求生效" onClick={() => setShowReasoningEffort((value) => !value)}><span>{ReasoningEffortLabels[reasoningEffort]}</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showReasoningEffort && <div className="popup-menu right reasoning-effort-menu" role="group" aria-label="选择思考强度">
                  <span className="reasoning-effort-options" aria-hidden="true">{reasoningEffortOptions.map((effort, index) => <span key={effort} className={index === reasoningEffortIndex ? 'is-active' : ''}>{ReasoningEffortLabels[effort]}</span>)}</span>
                  <div className="reasoning-effort-slider" style={{ '--reasoning-progress': `${(reasoningEffortIndex / Math.max(1, reasoningEffortOptions.length - 1)) * 100}%` } as CSSProperties}>
                    <input type="range" min="0" max={reasoningEffortOptions.length - 1} step="1" value={reasoningEffortIndex} aria-label={`思考模式：${ReasoningEffortLabels[reasoningEffort]}`} aria-valuetext={ReasoningEffortLabels[reasoningEffort]} onChange={(event) => HandleSelectReasoningEffort(reasoningEffortOptions[Number(event.target.value)] ?? GetDefaultReasoningEffort(reasoningEffortOptions))} />
                  </div>
                </div>}
              </div>
              <button type="button" disabled title="即将支持" aria-label="语音输入，即将支持"><Icon name="music" size={16} /></button>
              {activeRequestRef.current ? <button className="send-plane" type="button" onClick={HandleStop} aria-label="停止生成"><Icon name="stop" size={15} /></button> : <button className="send-plane" type="button" onClick={() => void HandleSend()} aria-label="寄出"><Icon name="applications" size={17} /></button>}
            </div>
          </div>
        </div>}
      </div>
      {isEmptyConversation && <QuickStart scenarioId={scenarioId} onUse={setComposer} />}
    </section>}
    <section ref={resumeSideRef} className={`resume-side ${resumePanelOpen ? 'open' : ''}`} aria-hidden={!resumePanelOpen} style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}>{resumePanelOpen && <button className="resume-side-backdrop" aria-label="关闭简历栏" onClick={() => setResumePanelOpen(false)} />}<div className="resize-bar" onMouseDown={HandleResize} /><aside><div className="resume-paper">{editing ? <textarea value={resumeText} onChange={(event) => HandleEditChange(event.target.value)} /> : <ResumePreview name={resume?.name ?? '未命名简历'} content={resumeText} />}</div><div className="resume-bottom-bar"><div className="resume-switcher"><button className="resume-switcher-trigger" type="button" disabled={!resumes.length} aria-haspopup="menu" aria-expanded={showResumeMenu} title={resume?.name ?? '选择简历'} onClick={() => setShowResumeMenu((value) => !value)}><span>{TruncateResumeTitle(resume?.name ?? '选择简历')}</span><Icon name={showResumeMenu ? 'chevron-up' : 'chevron-down'} size={15} /></button>{showResumeMenu && <div className="resume-switcher-menu" role="menu" aria-label="切换简历">{resumes.map((item) => <button key={item.id} type="button" role="menuitem" className={item.id === currentResumeId ? 'selected' : ''} title={item.name} onClick={() => HandleSelectResume(item.id)}>{TruncateResumeTitle(item.name)}</button>)}</div>}</div><div className="resume-action-row"><Button onClick={HandleStartEditing}>编辑</Button><Button disabled={!history.length} onClick={() => { const last = history.at(-1); if (last) { setResumeText(last); setHistory((current) => current.slice(0, -1)); } }}>撤销</Button><Button variant="primary" onClick={() => void HandleSaveResume()}>保存</Button></div></div></aside></section>
    <Modal open={showFullyTrustedWarning} title="开启完全信任模式" onClose={() => setShowFullyTrustedWarning(false)}><p className="modal-copy">开启后，Agent 可在当前场景的工具白名单与数据授权范围内自动执行操作，不再逐项请求确认。此设置不会授予新的工具、文件或账号权限。</p><div className="modal-actions"><Button onClick={() => setShowFullyTrustedWarning(false)}>取消</Button><Button variant="primary" onClick={() => { setShowFullyTrustedWarning(false); void ApplyConfirmationMode('fully_trusted'); }}>我了解风险，继续</Button></div></Modal>
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

function EmptyAssistant({ scenarioId }: { scenarioId: 'default' | 'application' }) {
  if (scenarioId === 'application') {
    return <div className="assistant-empty application-assistant-empty"><div className="assistant-start-island"><p className="eyebrow">AVERY 投递助手 · 公开测试</p><h2>在真实招聘网站上开始求职</h2><p>Agent 可搜索岗位、读取 JD、填写表单和上传已授权材料。登录与验证码由你接管，发送消息、勾选协议和最终提交仍会请求确认。</p></div></div>;
  }
  return <div className="assistant-empty"><div className="assistant-start-island"><p className="eyebrow">AVERY 简历助手</p><h2>今天想从哪里开始？</h2><p>写下一个求职目标，或从下面的常用任务开始。</p></div></div>;
}

function QuickStart({ scenarioId, onUse }: { scenarioId: 'default' | 'application'; onUse: (prompt: string) => void }) {
  const prompts = scenarioId === 'application' ? ['根据我的简历搜索合适的岗位', '读取这个招聘网址并分析 JD', '帮我填写并投递这个岗位'] : ['优化现有简历', '为目标岗位定制简历', '分析一份 JD'];
  return <div className="assistant-quick-start" aria-label="快捷开始">{prompts.map((item) => <button key={item} type="button" onClick={() => onUse(item)}>{item}</button>)}</div>;
}

export { AssistantPage };
