import { describe, expect, it } from 'vitest';
import { GetNextEnabledOption, GetSelectMenuLayout } from '../../../src/shared/components/selectMenuLayout';

const viewport = { left: 0, top: 0, width: 900, height: 600 };

describe('共享选择菜单边界', () => {
  it('底部不足时向上展开，仍与触发器保持间距', () => {
    const anchor = { left: 100, top: 530, bottom: 562, width: 200 };
    const result = GetSelectMenuLayout(anchor, viewport, { width: 240, height: 180 });
    expect(result.placement).toBe('up');
    expect(result.top).toBeGreaterThanOrEqual(8);
    expect(result.top + 180).toBeLessThan(anchor.top);
  });

  it('优先向上但顶部不足时改为向下，不固守调用方方向', () => {
    const anchor = { left: 100, top: 20, bottom: 52, width: 200 };
    const result = GetSelectMenuLayout(anchor, viewport, { width: 240, height: 180 }, true);
    expect(result.placement).toBe('down');
    expect(result.top).toBeGreaterThan(anchor.bottom);
    expect(result.top + 180).toBeLessThanOrEqual(viewport.height - 8);
  });

  it('长选项可宽于触发器，右侧和左侧都不越出视口', () => {
    for (const left of [-20, 10, 830]) {
      const result = GetSelectMenuLayout({ left, top: 100, bottom: 132, width: 100 }, viewport, { width: 400, height: 180 });
      expect(result.width).toBe(400);
      expect(result.left).toBeGreaterThanOrEqual(8);
      expect(result.left + result.width).toBeLessThanOrEqual(viewport.width - 8);
    }
  });

  it('小窗口、长列表、缩放偏移下限制内部高度与宽度', () => {
    for (const width of [240, 500, 1200]) {
      for (const height of [180, 360, 900]) {
        const view = { left: 12, top: 18, width, height };
        const anchor = { left: 12 + width - 100, top: 18 + height / 2, bottom: 18 + height / 2 + 32, width: 160 };
        const result = GetSelectMenuLayout(anchor, view, { width: 1500, height: 10000 });
        expect(result.width).toBeLessThanOrEqual(width - 16);
        expect(result.maxHeight).toBeLessThanOrEqual(240);
        expect(result.maxHeight).toBeGreaterThanOrEqual(0);
        expect(result.left).toBeGreaterThanOrEqual(view.left + 8);
        expect(result.left + result.width).toBeLessThanOrEqual(view.left + width - 8);
        expect(result.top).toBeGreaterThanOrEqual(view.top + 8);
        expect(result.top + result.maxHeight).toBeLessThanOrEqual(view.top + height - 8);
      }
    }
  });

  it('触发器宽于窗口也不能让菜单溢出', () => {
    const result = GetSelectMenuLayout({ left: 0, top: 100, bottom: 132, width: 2000 }, viewport, { width: 100, height: 50 });
    expect(result.width).toBe(viewport.width - 16);
    expect(result.left).toBe(8);
  });
});

describe('禁用选项的键盘导航', () => {
  const options = [{}, { disabled: true }, {}, { disabled: true }];
  it('上下移动跳过禁用项，并在可用项之间循环', () => {
    expect(GetNextEnabledOption(options, 0, 1)).toBe(2);
    expect(GetNextEnabledOption(options, 2, 1)).toBe(0);
    expect(GetNextEnabledOption(options, 0, -1)).toBe(2);
  });
  it('初始位置或旧位置失效时从对应边界开始', () => {
    expect(GetNextEnabledOption(options, -1, 1)).toBe(0);
    expect(GetNextEnabledOption(options, -1, -1)).toBe(2);
    expect(GetNextEnabledOption(options, 99, -1)).toBe(2);
  });
  it('空列表和全部禁用时不返回可选择位置', () => {
    expect(GetNextEnabledOption([], -1, 1)).toBe(-1);
    expect(GetNextEnabledOption([{ disabled: true }], -1, 1)).toBe(-1);
  });
});
