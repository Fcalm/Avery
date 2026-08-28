import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import type { AgentObservability, AgentStreamEvent, BrowserActionState, ConfirmationMode } from '@offerget/contracts';
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
  AcquireResumeEditLock, BindProjectEnvironment, CancelAgentRequest, ConfirmBrowserAction, ConfirmResumeEdit, GetAgentObservability, GetAgentTraceEvents, GetDeepSeekModels, GetSessionAssistantState, ImportAttachmentFile,
  ReleaseResumeEditLock, ReloadAgentSession, SelectAgentProjectDirectory, SendAgentRequest, SubscribeAgentStream, UpdateAgentConfirmationMode,
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
const ConfirmationOptions: Array<{ id: ConfirmationMode; label: string; description: string }> = [
  { id: 'always_confirm', label: '始终确认', description: '执行任何外部修改前都征求同意' },
  { id: 'allow_low_risk', label: '允许低风险', description: '低风险操作自动执行，其他操作仍确认' },
  { id: 'fully_trusted', label: '完全信任', description: '在当前工具与数据授权范围内自动执行' },
];

const ResumeHtmlTags = new Set(['a', 'b', 'blockquote', 'br', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'li', 'ol', 'p', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
const ResumeHtmlDiscardTags = new Set(['embed', 'iframe', 'link', 'meta', 'object', 'script', 'style']);

function TruncateResumeTitle(title: string) {
  const characters = Array.from(title.trim() || '未命名简历');
  return characters.slice(0, 8).join('');
}

/** 仅保留简历展示所需的基础 HTML，移除脚本、事件属性和非安全链接。 */
function SanitizeResumeHtml(content: string) {
  const documentNode = new DOMParser().parseFromString(content, 'text/html');
  for (const element of [...documentNode.body.querySelectorAll('*')]) {
    const tagName = element.tagName.toLowerCase();
    if (ResumeHtmlDiscardTags.has(tagName)) { element.remove(); continue; }
    if (!ResumeHtmlTags.has(tagName)) { element.replaceWith(...element.childNodes); continue; }
    for (const attribute of [...element.attributes]) {
      if (tagName === 'a' && attribute.name === 'href') {
        try {
          const url = new URL(attribute.value, 'https://offerget.local');
          if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') continue;
        } catch { /* 无效链接按普通文本展示。 */ }
      }
      element.removeAttribute(attribute.name);
    }
    if (tagName === 'a' && element.hasAttribute('href')) { element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noreferrer'); }
  }
  return documentNode.body.innerHTML;
}

function ResumePreview({ content }: { content: string }) {
  if (!/<\/?[a-z][^>]*>/i.test(content)) return <pre>{content}</pre>;
  return <div className="resume-html-preview" dangerouslySetInnerHTML={{ __html: SanitizeResumeHtml(content) }} />;
}
type SessionUsageView = {
  percent: number; threshold: number; compressionCount: number; tokens: number; limit: number;
  source: 'actual' | 'unavailable' | 'legacy_estimate' | 'loading'; promptTokens: number; completionTokens: number; totalTokens: number; reportedRequestCount: number; unreportedRequestCount: number;
};
const EmptyUsage: SessionUsageView = {
  percent: 0, threshold: 80, compressionCount: 0, tokens: 0, limit: 64000,
  source: 'loading', promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0,
};
const ComposerCompactWidth = 640;

function UpgradeDeepSeekModel(model: string | undefined) {
  return model === 'deepseek-chat' || model === 'deepseek-reasoner' || !model ? 'deepseek-v4-flash' : model;
}

interface ComposerAttachment { name: string; path: string; }

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
  const [showScenario, setShowScenario] = useState(false);
  const [scenarioId, setScenarioId] = useState<'default' | 'application'>('default');
  const [model, setModel] = useState(UpgradeDeepSeekModel(settings.model));
  const [deepSeekModels, setDeepSeekModels] = useState<string[]>(FallbackDeepSeekModels);
  const [isTaskActive, setIsTaskActive] = useState(false);
  const [panelWidth, setPanelWidth] = useState(430);
  const [isComposerCompact, setIsComposerCompact] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showResumeMenu, setShowResumeMenu] = useState(false);
  const [resumeText, setResumeText] = useState(resumes.find((item) => item.id === currentResumeId)?.content ?? '');
  const [savedText, setSavedText] = useState(resumeText);
  const [history, setHistory] = useState<string[]>([]);
  const [agentTask, setAgentTask] = useState<{ id: string; title: string; description: string; status: string } | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ confirmationId: string; name?: string; content: string; reason: string } | null>(null);
  const [pendingBrowserAction, setPendingBrowserAction] = useState<BrowserActionState | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<Array<{ id: string; question: string; options: string[] }> | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
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
    } catch {
      if (version === sessionLoadVersionRef.current && activeConversationRef.current === sessionId) {
        setUsage({ ...EmptyUsage, source: 'unavailable' });
        ShowNotice('会话状态恢复失败，当前 usage 未知');
      }
    }
  }, [ShowNotice]);

  useEffect(() => { void RefreshSessionAssistantState(activeConversationId); }, [activeConversationId, RefreshSessionAssistantState]);

  useEffect(() => { setModel(UpgradeDeepSeekModel(settings.model)); }, [settings.model]);
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
    if (event.type === 'browser_action_completed' && event.browserAction) {
      setPendingBrowserAction(null);
      if (event.browserAction.status === 'status_unknown') ShowNotice('浏览器动作结果未知，请先在目标网站核对，不要重复执行');
      else if (event.browserAction.status === 'succeeded') ShowNotice('浏览器动作已执行；可发送“继续任务”让 Agent 重新读取页面');
      return;
    }
    if (event.type === 'browser_user_action') {
      ShowNotice(event.browserAction?.summary ?? '请在可见浏览器中完成登录或验证，然后发送“继续任务”');
      return;
    }
    if ((event.type === 'task_created' || event.type === 'task_updated') && event.task) { setAgentTask(event.task); setIsTaskActive(true); return; }
    if (event.type === 'question_requested' && event.questions) { setPendingQuestions(event.questions); setQuestionAnswers(Object.fromEntries(event.questions.map((question) => [question.id, question.options[0] ?? '其他']))); setOtherAnswers({}); return; }
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
      setComposer(''); setAttachments([]); setAgentTask(null); setIsTaskActive(false);
      await SendAgentRequest({ requestId, sessionId: targetId, content: message.content, model, confirmationMode: permission, attachments, projectId: boundProject?.projectId ?? undefined, resumeId: currentResumeId ?? undefined, scenarioId });
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
    const requestId = activeRequestRef.current;
    if (!requestId) return;
    try {
      await UpdateAgentConfirmationMode(requestId, next);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '确认权限同步失败，将在下一轮任务生效');
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
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '无法处理简历确认'); }
  }

  async function HandlePendingBrowserAction(accepted: boolean) {
    const confirmationId = pendingBrowserAction?.confirmationId;
    if (!confirmationId) return;
    try {
      const result = await ConfirmBrowserAction(confirmationId, accepted);
      setPendingBrowserAction(null);
      if (result.status === 'succeeded') ShowNotice('浏览器动作已执行；发送“继续任务”即可恢复 Agent');
      else if (result.status === 'status_unknown') ShowNotice('动作结果未知，请在网站中核对后再继续');
      else ShowNotice('已拒绝浏览器动作');
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

  return <div className={`assistant-layout ${isComposerCompact ? 'is-composer-compact' : ''}`} style={{ '--assistant-main-min-width': `${ASSISTANT_MAIN_MIN_WIDTH}px` } as CSSProperties}>
    {assistantView === 'trace' ? <section className="assistant-main assistant-trace" aria-label="当前对话轨迹"><TraceViewer traces={observability?.traces ?? []} conversations={conversations} focusConversationId={activeConversationId} onSelectTrace={GetAgentTraceEvents} /></section> : <section className="assistant-main">
      {conversation?.messages.length ? <div ref={messageListRef} className="message-list"><div className="message-thread">{conversation.messages.map((message) => <article key={message.id} className={`chat-message ${message.role}`}><div className="message-meta">{message.role === 'assistant' ? <><span className="agent-dot" />OFFERGET 回信</> : '你'}<time>{FormatTime(message.createdAt)}</time></div>{message.role === 'assistant' && settings.thinkingEnabled && message.thinkingContent && <details className="thinking-block"><summary>思考内容</summary><div className="thinking-content"><MarkdownText content={message.thinkingContent} /></div></details>}<MarkdownText content={message.content} /></article>)}</div></div> : <EmptyAssistant scenarioId={scenarioId} onUse={setComposer} onOpenApplication={() => HandleScenarioChange('application')} />}
      <div className="composer-dock">
        {isTaskActive && <div className="task-dock"><button className="task-summary" type="button" onClick={() => setIsTaskActive(false)}><span>●</span> 当前正在做：{agentTask?.title ?? '生成求职助手回复'} <small>{agentTask?.status === 'in_progress' ? '进行中' : '点击收起任务'}</small></button><div className="task-card"><div><strong>{agentTask?.title ?? '正在处理本轮请求'}</strong><em>{agentTask?.status === 'in_progress' ? '进行中' : '处理中'}</em></div><p className="doing">● {agentTask?.description || '正在根据当前简历与档案组织回复'}</p></div></div>}
        {attachments.length > 0 && <div className="attachment-row">{attachments.map((attachment) => <span key={`${attachment.name}-${attachment.path}`}><Icon name="resume" size={14} />{attachment.name}<button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item !== attachment))}><Icon name="close" size={13} /></button></span>)}</div>}
        <div className="project-environment-row"><button type="button" onClick={() => void HandleSelectProject()}><Icon name="jobs" size={14} />{projectEnvironment ? projectEnvironment.name : '选择项目环境'}</button></div>
        <div ref={composerRef} className="composer">
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
              <button className={`composer-usage ${usagePresentation.tone}`} type="button" title={usagePresentation.title} aria-label={usagePresentation.title}>{usage.source === 'actual' && <span className="usage-dot" aria-hidden="true">·</span>}{usagePresentation.display}</button>
              <div className="menu-wrap">
                <button className="scenario-button" type="button" disabled={Boolean(activeRequestRef.current)} aria-label={`场景：${ScenarioOptions.find((item) => item.id === scenarioId)?.label}`} aria-expanded={showScenario} onClick={() => setShowScenario((value) => !value)}><Icon name={scenarioId === 'application' ? 'applications' : 'assistant'} size={15} /><span className="scenario-label">{ScenarioOptions.find((item) => item.id === scenarioId)?.label}</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showScenario && <div className="popup-menu right scenario-menu">{ScenarioOptions.map((item) => <button key={item.id} onClick={() => HandleScenarioChange(item.id)}><b><Icon name={item.icon} size={15} />{item.label}</b><small>{item.description}</small></button>)}</div>}
              </div>
              <div className="menu-wrap">
                <button className={`model-button ${settings.provider === 'DeepSeek' ? 'is-deepseek' : ''}`} type="button" aria-label={`模型：${model}`} aria-expanded={showModel} onClick={() => setShowModel((value) => !value)}>{settings.provider === 'DeepSeek' && <Icon name="deepseek" size={15} />}<span className="model-label">{model}</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showModel && <div className="popup-menu right">{settings.provider === 'DeepSeek' ? deepSeekModels.map((availableModel) => <button key={availableModel} onClick={() => { setModel(availableModel); setShowModel(false); }}>{availableModel}</button>) : <button onClick={() => setShowModel(false)}>{settings.model}</button>}</div>}
              </div>
              <button type="button" disabled title="即将支持" aria-label="语音输入，即将支持"><Icon name="music" size={16} /></button>
              {activeRequestRef.current ? <button className="send-plane" type="button" onClick={HandleStop} aria-label="停止生成"><Icon name="stop" size={15} /></button> : <button className="send-plane" type="button" onClick={() => void HandleSend()} aria-label="寄出"><Icon name="applications" size={17} /></button>}
            </div>
          </div>
        </div>
      </div>
    </section>}
    <section ref={resumeSideRef} className={`resume-side ${resumePanelOpen ? 'open' : ''}`} aria-hidden={!resumePanelOpen} style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}>{resumePanelOpen && <button className="resume-side-backdrop" aria-label="关闭简历栏" onClick={() => setResumePanelOpen(false)} />}<div className="resize-bar" onMouseDown={HandleResize} /><aside><div className="resume-paper">{editing ? <textarea value={resumeText} onChange={(event) => HandleEditChange(event.target.value)} /> : <ResumePreview content={savedText} />}</div><div className="resume-bottom-bar"><div className="resume-switcher"><button className="resume-switcher-trigger" type="button" disabled={!resumes.length} aria-haspopup="menu" aria-expanded={showResumeMenu} title={resume?.name ?? '选择简历'} onClick={() => setShowResumeMenu((value) => !value)}><span>{TruncateResumeTitle(resume?.name ?? '选择简历')}</span><Icon name={showResumeMenu ? 'chevron-up' : 'chevron-down'} size={15} /></button>{showResumeMenu && <div className="resume-switcher-menu" role="menu" aria-label="切换简历">{resumes.map((item) => <button key={item.id} type="button" role="menuitem" className={item.id === currentResumeId ? 'selected' : ''} title={item.name} onClick={() => HandleSelectResume(item.id)}>{TruncateResumeTitle(item.name)}</button>)}</div>}</div><div className="resume-action-row"><Button onClick={HandleStartEditing}>编辑</Button><Button disabled={!history.length} onClick={() => { const last = history.at(-1); if (last) { setResumeText(last); setHistory((current) => current.slice(0, -1)); } }}>撤销</Button><Button variant="primary" onClick={() => void HandleSaveResume()}>保存</Button></div></div></aside></section>
    <Modal open={showFullyTrustedWarning} title="开启完全信任模式" onClose={() => setShowFullyTrustedWarning(false)}><p className="modal-copy">开启后，Agent 可在当前场景的工具白名单与数据授权范围内自动执行操作，不再逐项请求确认。此设置不会授予新的工具、文件或账号权限。</p><div className="modal-actions"><Button onClick={() => setShowFullyTrustedWarning(false)}>取消</Button><Button variant="primary" onClick={() => { setShowFullyTrustedWarning(false); void ApplyConfirmationMode('fully_trusted'); }}>我了解风险，继续</Button></div></Modal>
    <Modal open={Boolean(pendingEdit)} title="确认 Agent 修改简历" onClose={() => void HandlePendingEdit(false)}><p className="modal-copy">{pendingEdit?.reason}</p><pre className="confirmation-preview">{pendingEdit?.content}</pre><div className="modal-actions"><Button onClick={() => void HandlePendingEdit(false)}>拒绝</Button><Button variant="primary" onClick={() => void HandlePendingEdit(true)}>确认并保存</Button></div></Modal>
    <Modal open={Boolean(pendingBrowserAction)} title="确认浏览器外部动作" onClose={() => void HandlePendingBrowserAction(false)}><div className="browser-confirmation-card"><p><strong>{pendingBrowserAction?.summary ?? pendingBrowserAction?.toolName}</strong></p>{pendingBrowserAction?.url && <p className="modal-copy">目标网站：{pendingBrowserAction.url}</p>}<p className="modal-copy">风险级别：{pendingBrowserAction?.risk === 'high' ? '高风险' : pendingBrowserAction?.risk === 'medium' ? '中风险' : '低风险'}。确认后只会执行这份已冻结的动作；若页面或目标元素改变，后端会拒绝执行。</p></div><div className="modal-actions"><Button onClick={() => void HandlePendingBrowserAction(false)}>拒绝</Button><Button variant="primary" onClick={() => void HandlePendingBrowserAction(true)}>确认执行</Button></div></Modal>
    <Modal open={Boolean(pendingQuestions)} title="Agent 需要补充信息" onClose={() => setPendingQuestions(null)}><div className="question-card-list">{pendingQuestions?.map((question) => <label key={question.id} className="form-field"><span>{question.question}</span><Select value={questionAnswers[question.id] ?? question.options[0]} onChange={(answer) => setQuestionAnswers((current) => ({ ...current, [question.id]: answer }))} ariaLabel={question.question} options={question.options.map((option) => ({ value: option, label: option }))} />{questionAnswers[question.id] === '其他' && <input placeholder="请输入其他答案" value={otherAnswers[question.id] ?? ''} onChange={(event) => setOtherAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</label>)}</div><div className="modal-actions"><Button onClick={() => setPendingQuestions(null)}>取消</Button><Button variant="primary" onClick={SubmitQuestionAnswers}>提交答案</Button></div></Modal>
  </div>;
}

function EmptyAssistant({ scenarioId, onUse, onOpenApplication }: { scenarioId: 'default' | 'application'; onUse: (prompt: string) => void; onOpenApplication: () => void }) {
  if (scenarioId === 'application') {
    return <div className="assistant-empty application-assistant-empty"><div className="assistant-start-island"><p className="eyebrow">OFFERGET 投递助手 · 公开测试</p><h2>在真实招聘网站上开始求职</h2><p>Agent 可搜索岗位、读取 JD、填写表单和上传已授权材料。登录与验证码由你接管，发送消息、勾选协议和最终提交仍会请求确认。</p><div>{['根据我的简历搜索合适的岗位', '读取这个招聘网址并分析 JD', '帮我填写并投递这个岗位'].map((item) => <button key={item} type="button" onClick={() => onUse(item)}>{item}</button>)}</div></div></div>;
  }
  return <div className="assistant-empty"><div className="assistant-start-island"><p className="eyebrow">OFFERGET 简历助手</p><h2>今天想从哪里开始？</h2><p>写下一个求职目标，或从下面的常用任务开始。</p><div>{['优化现有简历', '为目标岗位定制简历', '分析一份 JD'].map((item) => <button key={item} type="button" onClick={() => onUse(item)}>{item}</button>)}</div><button className="application-scenario-entry" type="button" onClick={onOpenApplication}><Icon name="browser" size={17} /><span><b>进入真实网站投递</b><small>使用隔离浏览器搜索岗位、填写表单并投递</small></span></button></div></div>;
}

export { AssistantPage };
