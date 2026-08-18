import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** 跨页面轻量 UI 状态：只存导航、抽屉、当前实体与 Toast 等非事实源状态。 */
interface UiStoreValue {
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  currentResumeId: string | null;
  setCurrentResumeId: (id: string | null) => void;
  resumePanelOpen: boolean;
  setResumePanelOpen: (open: boolean) => void;
  notice: string;
  ShowNotice: (message: string) => void;
  profileConflict: boolean;
  setProfileConflict: (open: boolean) => void;
}

const UiStoreContext = createContext<UiStoreValue | null>(null);

function UiStoreProvider({ children }: { children: ReactNode }) {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null);
  const [resumePanelOpen, setResumePanelOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [profileConflict, setProfileConflict] = useState(false);

  const ShowNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2600);
  }, []);

  const value = useMemo(() => ({
    activeConversationId, setActiveConversationId,
    currentResumeId, setCurrentResumeId,
    resumePanelOpen, setResumePanelOpen,
    notice, ShowNotice, profileConflict, setProfileConflict,
  }), [activeConversationId, currentResumeId, resumePanelOpen, notice, profileConflict, ShowNotice]);

  return <UiStoreContext.Provider value={value}>{children}</UiStoreContext.Provider>;
}

function useUiStore() {
  const store = useContext(UiStoreContext);
  if (!store) throw new Error('useUiStore 必须在 UiStoreProvider 内使用');
  return store;
}

export { UiStoreProvider, useUiStore };
