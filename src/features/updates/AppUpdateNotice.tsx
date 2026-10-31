import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppUpdateState } from '@avery/contracts';
import { useUiStore } from '../../app/UiStore';
import { Icon } from '../../shared/components/Icon';
import { DownloadAppUpdate, InstallAppUpdate, ReadAppUpdate, SubscribeAppUpdates } from './appUpdates';
import './appUpdates.css';

const HiddenVersionKey = 'avery-hidden-update-version';

/** 收起按版本保存；切换页面不重复展开同一更新，新版本仍提醒。 */
export function AppUpdateNotice() {
  const [state, SetState] = useState<AppUpdateState | null>(null);
  const [hiddenVersion, SetHiddenVersion] = useState(() => {
    try { return localStorage.getItem(HiddenVersionKey); } catch { return null; }
  });
  const [busy, SetBusy] = useState(false);
  const { ShowNotice } = useUiStore();
  useEffect(() => {
    if (!window.averyUpdates) return;
    let active = true;
    const receive = (next: AppUpdateState) => {
      if (active) SetState(previous => !previous || next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = SubscribeAppUpdates(receive);
    void ReadAppUpdate().then(receive).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);
  if (!state?.version || !['available', 'downloading', 'downloaded', 'installing', 'error'].includes(state.status)) return null;

  function SetHidden(hide: boolean) {
    const version = hide ? state!.version! : null;
    SetHiddenVersion(version);
    try {
      if (version) localStorage.setItem(HiddenVersionKey, version);
      else localStorage.removeItem(HiddenVersionKey);
    } catch { /* 存储不可用时仍可在当前页面收起。 */ }
  }
  async function Act() {
    if (busy || !state) return;
    SetBusy(true);
    try {
      if (state.status === 'downloaded') await InstallAppUpdate();
      else {
        const next = await DownloadAppUpdate();
        SetState(previous => !previous || next.revision >= previous.revision ? next : previous);
      }
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '更新操作失败，请稍后重试。'); }
    finally { SetBusy(false); }
  }
  const compact = hiddenVersion === state.version;
  const downloaded = state.status === 'downloaded';
  const title = downloaded ? '更新已就绪' : state.status === 'downloading' ? `正在下载 ${state.progress ?? 0}%` : state.status === 'installing' ? '正在重启安装' : state.status === 'error' ? '更新下载失败' : '发现新版本';
  const noticeIcon = downloaded ? 'check-circle' : state.status === 'error' ? 'warning-circle' : 'bell-simple-ringing';
  // 与抽屉共用 body 浮层，脱离导航栏的裁剪和动画；收起只由用户操作决定。
  return createPortal(<div className="app-update-position">
    {compact ? <button className="app-update-compact" type="button" title={`${title} · v${state.version}`} aria-label="展开更新提醒" onClick={() => SetHidden(false)}><Icon name={noticeIcon} size={16} /><span>{title}</span><Icon name="chevron-up" size={12} /></button> : <section className="app-update-notice" aria-label="版本更新">
    <div className="app-update-heading"><span className="app-update-title"><Icon name={noticeIcon} size={18} /><strong>{title}</strong><span className="app-update-version" title={`v${state.version}`}>v{state.version}</span></span><button className="icon-btn sm" type="button" aria-label="收起更新提醒" title="收起" onClick={() => SetHidden(true)}><Icon name="close" size={13} /></button></div>
    {state.status === 'downloading' && <progress max={100} value={state.progress ?? 0} aria-label="更新下载进度" />}
    {state.status === 'error' && <p role="status">{state.message}</p>}
    {!['downloading', 'installing'].includes(state.status) && <button className="app-update-action" type="button" disabled={busy} onClick={() => void Act()}><Icon name={downloaded ? 'refresh' : 'download-simple'} size={16} />{downloaded ? '重启安装' : state.status === 'error' ? '重试下载' : '下载更新'}</button>}
  </section>}
  </div>, document.body);
}
