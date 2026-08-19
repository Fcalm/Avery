import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import type { AgentStreamEvent } from '@offerget/contracts';
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
  AcquireResumeEditLock, BindProjectEnvironment, CancelAgentRequest, ConfirmResumeEdit, GetDeepSeekModels, GetSessionAssistantState, ImportAttachmentFile,
  ReleaseResumeEditLock, ReloadAgentSession, SelectAgentProjectDirectory, SendAgentRequest, SubscribeAgentStream,
} from '../../../features/assistant/api/agentQueries';
import { Button, Modal } from '../../../shared/components/UI';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { FormatTime } from '../../../shared/utils/format';
import { ASSISTANT_MAIN_MIN_WIDTH } from '../../../shared/layoutConstants';
import type { ChatMessage, PageId } from '../../../types/domain';

const ScenarioOptions: Array<{ id: Extract<PageId, 'assistant' | 'jobs' | 'applications'>; label: string; icon: IconName; description: string }> = [
  { id: 'assistant', label: '求职助手', icon: 'assistant', description: '起草与优化简历' },
  { id: 'jobs', label: '岗位库', icon: 'jobs', description: '管理已保存岗位' },
  { id: 'applications', label: '投递管理', icon: 'applications', description: '跟进投递进度' },
];
const FallbackDeepSeekModels = ['deepseek-v4-flash', 'deepseek-v4-pro'];
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
  const { activeConversationId, setActiveConversationId, currentResumeId, setCurrentResumeId, resumePanelOpen, setResumePanelOpen, ShowNotice } = useUiStore();
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
  const [permission, setPermission] = useState<'需要确认' | '无需确认'>('需要确认');
  const [showPermission, setShowPermission] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [model, setModel] = useState(UpgradeDeepSeekModel(settings.model));
  const [deepSeekModels, setDeepSeekModels] = useState<string[]>(FallbackDeepSeekModels);
  const [isTaskActive, setIsTaskActive] = useState(false);
  const [panelWidth, setPanelWidth] = useState(420);
  const [isComposerCompact, setIsComposerCompact] = useState(false);
  const [editing, setEditing] = useState(false);
  const [resumeText, setResumeText] = useState(resumes.find((item) => item.id === currentResumeId)?.content ?? '');
  const [savedText, setSavedText] = useState(resumeText);
  const [history, setHistory] = useState<string[]>([]);
  const [agentTask, setAgentTask] = useState<{ id: string; title: string; description: string; status: string } | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ confirmationId: string; name?: string; content: string; reason: string } | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<Array<{ id: string; question: string; options: string[] }> | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState(EmptyUsage);
  const inputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const enteredConversationRef = useRef<string | null>(null);
  const resumeSideRef = useRef<HTMLElement>(null);
  const panelWidthRef = useRef(420);
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

  const conversation = useMemo(() => conversations.find((item) => item.id === activeConversationId), [conversations, activeConversationId]);
  const resume = resumes.find((item) => item.id === currentResumeId);
  const usageTone = usage.percent < 50 ? 'is-safe' : usage.percent < 70 ? 'is-warning' : 'is-danger';
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
    if ((event.type === 'task_created' || event.type === 'task_updated') && event.task) { setAgentTask(event.task); setIsTaskActive(true); return; }
    if (event.type === 'question_requested' && event.questions) { setPendingQuestions(event.questions); setQuestionAnswers(Object.fromEntries(event.questions.map((question) => [question.id, question.options[0] ?? '其他']))); setOtherAnswers({}); return; }
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
    if (text === '/reload-session') {
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
      await SendAgentRequest({ requestId, sessionId: targetId, content: message.content, model, confirmationMode: permission, attachments, projectId: boundProject?.projectId ?? undefined, resumeId: currentResumeId ?? undefined });
    } catch (error) {
      removeMessage.mutate({ conversationId: targetId, messageId: `reply-${requestId}` });
      activePlaceholderRef.current = null;
      activeRequestRef.current = null;
      setIsTaskActive(false);
      ShowNotice(error instanceof Error ? error.message : '无法发起 Agent 请求');
    }
  }

  function HandleStop() { if (activeRequestRef.current) void CancelAgentRequest(activeRequestRef.current); }

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
    }
    function HandleUp() {
      setPanelWidth(panelWidthRef.current);
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
  /** 切换当前简历：释放仍持有的编辑锁并重置编辑态，加载目标简历内容（避免把编辑中的文本带进另一份简历）。 */
  function HandleSwitchResume() {
    if (editLockRef.current) { void ReleaseResumeEditLock(editLockRef.current); editLockRef.current = null; }
    setEditing(false);
    setHistory([]);
    const nextResume = resumes.find((item) => item.id !== currentResumeId);
    if (nextResume) { setResumeText(nextResume.content); setSavedText(nextResume.content); setCurrentResumeId(nextResume.id); }
  }
  function HandleScenarioChange(page: Extract<PageId, 'assistant' | 'jobs' | 'applications'>) {
    setActiveConversationId(null);
    setIsTaskActive(false);
    setShowScenario(false);
    onNavigate('assistant');
    ShowNotice(`已切换到${ScenarioOptions.find((item) => item.id === page)?.label}的新对话`);
  }

  async function HandlePendingEdit(accepted: boolean) {
    if (!pendingEdit) return;
    try {
      const result = await ConfirmResumeEdit(pendingEdit.confirmationId, accepted);
      ShowNotice(result.applied ? '已确认并保存 Agent 修改' : '已拒绝 Agent 修改');
      setPendingEdit(null);
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '无法处理简历确认'); }
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
    <section className="assistant-main">
      {conversation?.messages.length ? <div ref={messageListRef} className="message-list"><div className="message-thread">{conversation.messages.map((message) => <article key={message.id} className={`chat-message ${message.role}`}><div className="message-meta">{message.role === 'assistant' ? <><span className="agent-dot" />OFFERGET 回信</> : '你'}<time>{FormatTime(message.createdAt)}</time></div>{message.role === 'assistant' && settings.thinkingEnabled && message.thinkingContent && <details className="thinking-block"><summary>思考内容<small>展开查看</small></summary><div className="thinking-content"><MarkdownText content={message.thinkingContent} /></div></details>}<MarkdownText content={message.content} /></article>)}</div></div> : <EmptyAssistant onUse={setComposer} />}
      <div className="composer-dock">
        {isTaskActive && <div className="task-dock"><button className="task-summary" type="button" onClick={() => setIsTaskActive(false)}><span>●</span> 当前正在做：{agentTask?.title ?? '生成求职助手回复'} <small>{agentTask?.status === 'in_progress' ? '进行中' : '点击收起任务'}</small></button><div className="task-card"><div><strong>{agentTask?.title ?? '正在处理本轮请求'}</strong><em>{agentTask?.status === 'in_progress' ? '进行中' : '处理中'}</em></div><p className="doing">● {agentTask?.description || '正在根据当前简历与档案组织回复'}</p></div></div>}
        {attachments.length > 0 && <div className="attachment-row">{attachments.map((attachment) => <span key={`${attachment.name}-${attachment.path}`}><Icon name="resume" size={16} />{attachment.name}<button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item !== attachment))}><Icon name="close" size={12} /></button></span>)}</div>}
        <div className="project-environment-row"><button type="button" onClick={() => void HandleSelectProject()}><Icon name="jobs" size={16} />{projectEnvironment ? projectEnvironment.name : '选择项目环境'}</button></div>
        <div ref={composerRef} className="composer">
          <textarea value={composer} placeholder="写下你的需求，如：把这段项目经历写得更突出成果…" onChange={(event) => setComposer(event.target.value)} onKeyDown={HandleKeyDown} />
          <div className="composer-bar">
            <div>
              <input ref={inputRef} className="visually-hidden" type="file" multiple accept=".pdf,.doc,.docx,.txt,image/png,image/jpeg" onChange={HandleFiles} />
              <button type="button" aria-label="上传文件" title="上传文件" onClick={() => inputRef.current?.click()}><Icon name="plus" size={20} /></button>
              <div className="menu-wrap">
                <button className="permission-button" type="button" aria-label={`权限：${permission}`} aria-expanded={showPermission} onClick={() => setShowPermission((value) => !value)}><Icon name={permission === '需要确认' ? 'user-check' : 'user-x'} size={16} /><span className="permission-label">{permission}</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showPermission && <div className="popup-menu"><button onClick={() => { setPermission('需要确认'); setShowPermission(false); }}><b>需要确认</b><small>修改简历前征求同意</small></button><button onClick={() => { setPermission('无需确认'); setShowPermission(false); }}><b>无需确认</b><small>仅作为前端状态演示</small></button></div>}
              </div>
            </div>
            <div>
              {settings.developerMode && <button className={`composer-usage ${usageTone}`} type="button" title={usage.source === 'actual'
                ? `真实 usage · 最新输入 ${usage.tokens.toLocaleString()} / ${usage.limit.toLocaleString()} tokens · 累计输入 ${usage.promptTokens.toLocaleString()} · 累计输出 ${usage.completionTokens.toLocaleString()} · 累计 ${usage.totalTokens.toLocaleString()} · 已报告 ${usage.reportedRequestCount} 次${usage.unreportedRequestCount ? ` · ${usage.unreportedRequestCount} 次未返回 usage` : ''} · 压缩阈值 ${usage.threshold}% · 已压缩 ${usage.compressionCount} 次`
                : usage.source === 'legacy_estimate'
                  ? `历史版本仅保存了估算值，不能作为真实 usage 使用；完成下一次模型请求后将以模型返回为准`
                  : usage.source === 'loading'
                    ? '正在恢复此会话的 usage'
                    : `当前会话尚未收到模型返回的 usage；不会用本地估算替代`}>{usage.source === 'actual' && <span className="usage-dot" aria-hidden="true">·</span>}{usage.source === 'actual' ? `${usage.percent}%` : '—'}</button>}
              <div className="menu-wrap">
                <button className="scenario-button" type="button" aria-label="选择场景" aria-expanded={showScenario} onClick={() => setShowScenario((value) => !value)}><Icon name="assistant" size={16} /><span className="scenario-label">场景</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showScenario && <div className="popup-menu right scenario-menu">{ScenarioOptions.map((item) => <button key={item.id} onClick={() => HandleScenarioChange(item.id)}><b><Icon name={item.icon} size={16} />{item.label}</b><small>{item.description}</small></button>)}</div>}
              </div>
              <div className="menu-wrap">
                <button className={`model-button ${settings.provider === 'DeepSeek' ? 'is-deepseek' : ''}`} type="button" aria-label={`模型：${model}`} aria-expanded={showModel} onClick={() => setShowModel((value) => !value)}>{settings.provider === 'DeepSeek' && <Icon name="deepseek" size={16} />}<span className="model-label">{model}</span><span className="chevron-indicator" aria-hidden="true" /></button>
                {showModel && <div className="popup-menu right">{settings.provider === 'DeepSeek' ? deepSeekModels.map((availableModel) => <button key={availableModel} onClick={() => { setModel(availableModel); setShowModel(false); }}>{availableModel}</button>) : <button onClick={() => setShowModel(false)}>{settings.model}</button>}</div>}
              </div>
              <button type="button" disabled title="即将支持" aria-label="语音输入，即将支持"><Icon name="music" size={16} /></button>
              {activeRequestRef.current ? <button className="send-plane" type="button" onClick={HandleStop} aria-label="停止生成"><Icon name="stop" size={20} /></button> : <button className="send-plane" type="button" onClick={() => void HandleSend()} aria-label="寄出"><Icon name="applications" size={20} /></button>}
            </div>
          </div>
        </div>
      </div>
    </section>
    <section ref={resumeSideRef} className={`resume-side ${resumePanelOpen ? 'open' : ''}`} aria-hidden={!resumePanelOpen} style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}>{resumePanelOpen && <button className="resume-side-backdrop" aria-label="关闭简历栏" onClick={() => setResumePanelOpen(false)} />}<div className="resize-bar" onMouseDown={HandleResize} /><aside><header><div><p className="eyebrow">当前简历</p><h2>{resume?.name ?? '尚未选择简历'}</h2></div><button type="button" aria-label="关闭简历栏" onClick={() => setResumePanelOpen(false)}><Icon name="close" size={20} /></button></header><div className="resume-paper">{editing ? <textarea value={resumeText} onChange={(event) => HandleEditChange(event.target.value)} /> : <pre>{savedText}</pre>}</div><div className="resume-action-row"><Button onClick={HandleStartEditing}>编辑</Button><Button disabled={!history.length} onClick={() => { const last = history.at(-1); if (last) { setResumeText(last); setHistory((current) => current.slice(0, -1)); } }}>撤销</Button><Button variant="primary" onClick={() => void HandleSaveResume()}>保存</Button></div><button className="switch-resume" type="button" onClick={HandleSwitchResume}>切换至另一份简历</button></aside></section>
    <Modal open={Boolean(pendingEdit)} title="确认 Agent 修改简历" onClose={() => void HandlePendingEdit(false)}><p className="modal-copy">{pendingEdit?.reason}</p><pre className="confirmation-preview">{pendingEdit?.content}</pre><div className="modal-actions"><Button onClick={() => void HandlePendingEdit(false)}>拒绝</Button><Button variant="primary" onClick={() => void HandlePendingEdit(true)}>确认并保存</Button></div></Modal>
    <Modal open={Boolean(pendingQuestions)} title="Agent 需要补充信息" onClose={() => setPendingQuestions(null)}><div className="question-card-list">{pendingQuestions?.map((question) => <label key={question.id} className="form-field"><span>{question.question}</span><select value={questionAnswers[question.id] ?? question.options[0]} onChange={(event) => setQuestionAnswers((current) => ({ ...current, [question.id]: event.target.value }))}>{question.options.map((option) => <option key={option}>{option}</option>)}</select>{questionAnswers[question.id] === '其他' && <input placeholder="请输入其他答案" value={otherAnswers[question.id] ?? ''} onChange={(event) => setOtherAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</label>)}</div><div className="modal-actions"><Button onClick={() => setPendingQuestions(null)}>取消</Button><Button variant="primary" onClick={SubmitQuestionAnswers}>提交答案</Button></div></Modal>
  </div>;
}

function EmptyAssistant({ onUse }: { onUse: (prompt: string) => void }) {
  return <div className="assistant-empty"><div className="assistant-start-island"><p className="eyebrow">OFFERGET 简历助手</p><h2>今天想从哪里开始？</h2><p>写下一个求职目标，或从下面的常用任务开始。</p><div>{['优化现有简历', '为目标岗位定制简历', '分析一份 JD'].map((item) => <button key={item} type="button" onClick={() => onUse(item)}>{item}</button>)}</div></div></div>;
}

export { AssistantPage };
