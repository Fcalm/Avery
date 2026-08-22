import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEventHandler } from 'react';
import { Icon } from '../../../shared/components/Icon';

type BrowserSidePanelProps = {
  open: boolean;
  panelWidth: number;
  onClose: () => void;
  onResizeStart: MouseEventHandler<HTMLDivElement>;
  onNotice: (message: string) => void;
};

/** 右侧浏览器仅提供壳与工具栏；真实网页由 Main 进程的受限 WebContentsView 承载。 */
function BrowserSidePanel({ open, panelWidth, onClose, onResizeStart, onNotice }: BrowserSidePanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState('');

  useEffect(() => {
    const browser = window.offergetBrowser;
    if (!open || !browser) { if (!open) void browser?.Hide(); return undefined; }
    let frame = 0;
    const UpdateBounds = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const rect = viewport.getBoundingClientRect();
        void browser.Show({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
      });
    };
    const observer = new ResizeObserver(UpdateBounds);
    if (viewportRef.current) observer.observe(viewportRef.current);
    UpdateBounds();
    window.addEventListener('resize', UpdateBounds);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', UpdateBounds);
      void browser.Hide();
    };
  }, [open, panelWidth]);

  async function Navigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = address.trim();
    if (!value) { onNotice('请输入要打开的网址'); return; }
    const result = await window.offergetBrowser?.Navigate(value);
    if (!result?.accepted) { onNotice(result?.reason ?? '内置浏览器仅能在桌面客户端中使用'); return; }
    setAddress(result.url ?? value);
  }

  return <section className={`resume-side browser-side ${open ? 'open' : ''}`} aria-hidden={!open} style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}>
    <div className="resize-bar" onMouseDown={onResizeStart} />
    <aside>
      <header><div><p className="eyebrow">CHROMIUM 内核</p><h2>内置浏览器</h2></div><button type="button" aria-label="关闭内置浏览器" onClick={onClose}><Icon name="close" size={18} /></button></header>
      <form className="browser-toolbar" onSubmit={Navigate}>
        <button type="button" aria-label="后退" title="后退" onClick={() => void window.offergetBrowser?.GoBack()}>←</button>
        <button type="button" aria-label="前进" title="前进" onClick={() => void window.offergetBrowser?.GoForward()}>→</button>
        <button type="button" aria-label="刷新" title="刷新" onClick={() => void window.offergetBrowser?.Reload()}><Icon name="refresh" size={15} /></button>
        <input aria-label="网页地址" autoCapitalize="none" autoCorrect="off" inputMode="url" placeholder="输入网址，例如 example.com" value={address} onChange={(event) => setAddress(event.target.value)} />
        <button className="browser-go" type="submit">打开</button>
      </form>
      <div ref={viewportRef} className="browser-viewport">{!window.offergetBrowser && <p>内置浏览器仅在桌面客户端中可用。</p>}</div>
      <p className="browser-safety-note">网页运行在隔离的 Chromium 进程中；下载、弹窗和设备权限默认关闭。</p>
    </aside>
  </section>;
}

export { BrowserSidePanel };
