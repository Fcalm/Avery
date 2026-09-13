import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type NoticeTone = 'success' | 'error' | 'pending';
type NoticeAction = { label: string; run: () => void };
type Notice = { id: number; message: string; tone: NoticeTone; action?: NoticeAction; duration?: number };
/* 原型节奏：普通通知 1.9 秒自动消失；带动作的通知停留 5 秒留出点击窗口。 */
const BaseNoticeDuration = 1900;
const ActionNoticeDuration = 5000;

function InferNoticeTone(message: string): NoticeTone {
  if (/失败|错误|无法|请先|不可|冲突|异常|未知|被占用|未获取|缺失/.test(message)) return 'error';
  if (/处理中|测试中|保存中|加载中|同步中|刷新中|迁移中|等待/.test(message)) return 'pending';
  return 'success';
}

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
  developerView: 'logs' | 'evaluation';
  setDeveloperView: (view: 'logs' | 'evaluation') => void;
  notice: Notice | null;
  ShowNotice: (message: string, tone?: NoticeTone, options?: { action?: NoticeAction; duration?: number }) => void;
  HideNotice: () => void;
  profileConflict: boolean;
  setProfileConflict: (open: boolean) => void;
}

const UiStoreContext = createContext<UiStoreValue | null>(null);

function UiStoreProvider({ children }: { children: ReactNode }) {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null);
  const [resumePanelOpen, setResumePanelOpen] = useState(false);
  const [assistantView, setAssistantView] = useState<'chat' | 'trace'>('chat');
  const [developerView, setDeveloperView] = useState<'logs' | 'evaluation'>('logs');
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const noticeIdRef = useRef(0);
  const [profileConflict, setProfileConflict] = useState(false);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  const ShowNotice = useCallback((message: string, tone: NoticeTone = InferNoticeTone(message), options?: { action?: NoticeAction; duration?: number }) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ id: ++noticeIdRef.current, message, tone, action: options?.action, duration: options?.duration });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, options?.duration ?? (options?.action ? ActionNoticeDuration : BaseNoticeDuration));
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
    developerView, setDeveloperView,
    notice, ShowNotice, HideNotice, profileConflict, setProfileConflict,
  }), [activeConversationId, currentResumeId, resumePanelOpen, assistantView, developerView, notice, profileConflict, ShowNotice, HideNotice]);

  return <UiStoreContext.Provider value={value}>{children}</UiStoreContext.Provider>;
}

function useUiStore() {
  const store = useContext(UiStoreContext);
  if (!store) throw new Error('useUiStore 必须在 UiStoreProvider 内使用');
  return store;
}

export { UiStoreProvider, useUiStore };
