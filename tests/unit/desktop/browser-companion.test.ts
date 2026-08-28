import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { setPath: vi.fn(), exit: vi.fn(), whenReady: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(),
  Menu: { setApplicationMenu: vi.fn() },
  session: { defaultSession: {} },
}));

import { IsAllowedBrowserCompanionUrl, IsBrowserCompanionProcess } from '../../../apps/desktop/src/browser-companion';

describe('隔离浏览器伴随进程', () => {
  it('只由固定 companion 标记进入隔离模式', () => {
    expect(IsBrowserCompanionProcess(['OfferGet.exe', '--offerget-browser-companion'])).toBe(true);
    expect(IsBrowserCompanionProcess(['OfferGet.exe', '--offerget-browser-companion=true'])).toBe(false);
    expect(IsBrowserCompanionProcess(['OfferGet.exe'])).toBe(false);
  });

  it('网页 target 拒绝本地协议、脚本协议与内嵌凭据', () => {
    expect(IsAllowedBrowserCompanionUrl('about:blank')).toBe(true);
    expect(IsAllowedBrowserCompanionUrl('https://jobs.example.com/apply')).toBe(true);
    expect(IsAllowedBrowserCompanionUrl('file:///C:/secret.txt')).toBe(false);
    expect(IsAllowedBrowserCompanionUrl('javascript:alert(1)')).toBe(false);
    expect(IsAllowedBrowserCompanionUrl('https://user:pass@example.com')).toBe(false);
  });
});
