import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NoticePresentation, type NoticeTone } from './noticePresentation';

type NoticeAction = { label: string; run: () => void };
type Notice = { id: number; message: string; tone: NoticeTone; action?: NoticeAction; duration?: number };
/* 带动作的通知至少停留 5 秒，留出操作窗口。 */
const ActionNoticeDuration = 5000;

/** 跨页面轻量 UI 状态：只存导航、抽屉、当前实体与 Toast 等非事实源状态。 */
interface UiStoreValue {
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  currentResumeId: string | null;
  setCurrentResumeId: (id: string | null) => void;
  resumePanelOpen: boolean;
  setResumePanelOpen: (open: boolean) => void;
  assistantView: 'chat' | 'trace';
  setAssistantView: (view: 'chat' | 'trace') => void;
  notice: Notice | null;
  ShowNotice: (message: string, tone: NoticeTone, options?: { action?: NoticeAction; duration?: number }) => void;
  HideNotice: () => void;
  profileConflict: boolean;
  setProfileConflict: (open: boolean) => void;
  /** 跨页输入框预填：简历页「让Avery保存简历」写入，助手页消费后立即置空，避免再次进入时重复填入。 */
  composerSeed: string | null;
  setComposerSeed: (text: string | null) => void;
}

const UiStoreContext = createContext<UiStoreValue | null>(null);

function UiStoreProvider({ children }: { children: ReactNode }) {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null);
  const [resumePanelOpen, setResumePanelOpen] = useState(false);
  const [assistantView, setAssistantView] = useState<'chat' | 'trace'>('chat');
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const noticeIdRef = useRef(0);
  const [profileConflict, setProfileConflict] = useState(false);
  const [composerSeed, setComposerSeed] = useState<string | null>(null);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  const ShowNotice = useCallback((message: string, tone: NoticeTone, options?: { action?: NoticeAction; duration?: number }) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ id: ++noticeIdRef.current, message, tone, action: options?.action, duration: options?.duration });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, options?.duration ?? (options?.action ? Math.max(ActionNoticeDuration, NoticePresentation[tone].duration) : NoticePresentation[tone].duration));
  }, []);
  const HideNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) { window.clearTimeout(noticeTimerRef.current); noticeTimerRef.current = null; }
    setNotice(null);
  }, []);

  const value = useMemo(() => ({
    activeConversationId, setActiveConversationId,
    currentResumeId, setCurrentResumeId,
    resumePanelOpen, setResumePanelOpen,
    assistantView, setAssistantView,
    notice, ShowNotice, HideNotice, profileConflict, setProfileConflict,
    composerSeed, setComposerSeed,
  }), [activeConversationId, currentResumeId, resumePanelOpen, assistantView, notice, profileConflict, composerSeed, ShowNotice, HideNotice]);

  return <UiStoreContext.Provider value={value}>{children}</UiStoreContext.Provider>;
}

function useUiStore() {
  const store = useContext(UiStoreContext);
  if (!store) throw new Error('useUiStore 必须在 UiStoreProvider 内使用');
  return store;
}

export { UiStoreProvider, useUiStore };
