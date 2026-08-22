import { describe, expect, it } from 'vitest';
import { NormalizeBrowserAddress, NormalizeBrowserBounds } from '../../../apps/desktop/src/browser-policy';

describe('内置浏览器安全策略', () => {
  it('仅接受 http 与 https 地址，并补全省略的 https 协议', () => {
    expect(NormalizeBrowserAddress('example.com')).toBe('https://example.com/');
    expect(NormalizeBrowserAddress('http://example.com/path')).toBe('http://example.com/path');
    expect(NormalizeBrowserAddress('file:///C:/secret.txt')).toBeNull();
    expect(NormalizeBrowserAddress('https://user:password@example.com')).toBeNull();
  });

  it('拒绝越出窗口或面积不足的网页视图边界', () => {
    expect(NormalizeBrowserBounds({ x: 800.4, y: 36.3, width: 320.2, height: 600.6 }, [1_200, 800])).toEqual({ x: 800, y: 36, width: 320, height: 601 });
    expect(NormalizeBrowserBounds({ x: -1, y: 0, width: 320, height: 600 }, [1_200, 800])).toBeNull();
    expect(NormalizeBrowserBounds({ x: 1_000, y: 0, width: 320, height: 600 }, [1_200, 800])).toBeNull();
    expect(NormalizeBrowserBounds({ x: 0, y: 0, width: 119, height: 600 }, [1_200, 800])).toBeNull();
  });
});
