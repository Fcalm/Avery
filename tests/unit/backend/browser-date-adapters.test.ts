import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BrowserAtsDetectionExpression, BrowserDateAdapterSelectionScript } from '../../../apps/backend/src/electron/backend/browser-date-adapters';

/** 仅模拟识别用的类名匹配与祖先关系；ATS 路由执行生产脚本。 */
class Element {
  constructor(readonly classes: string[], readonly parentElement: Element | null = null) {}
  matches(selector: string): boolean {
    return selector.split(',').some(part => part.startsWith('.') ? this.classes.includes(part.slice(1))
      : Boolean(part.match(/^\[class\*="([^"]+)"\]$/)?.[1]
        && this.classes.some(name => name.includes(part.match(/^\[class\*="([^"]+)"\]$/)![1]))));
  }
}

function Context(hostname: string, elements: Element[]) {
  return { location: { hostname }, document: { querySelector: (selector: string) => elements.find(element => element.matches(selector)) ?? null } };
}

describe('ATS 日期适配器选择', () => {
  it.each([
    ['hr-jobs.sensetime.com', ['atsx-date-picker'], 'feishu'],
    ['quvideo.jobs.feishu.cn', ['atsx-date-picker'], 'feishu'],
    ['yingzi.zhiye.com', ['phoenix-select'], 'beisen'],
    ['careers.example.com', ['phoenix-calendar-month-calendar'], 'beisen'],
    ['careers.example.com', ['atsx-date-picker-dropdown'], 'feishu'],
    ['yingzi.zhiye.com', ['atsx-date-picker'], 'feishu'],
    ['app.mokahr.com', ['apply-block-currentHash'], 'moka'],
    ['careers.example.com', ['sd-panal-menu-wrapper-changedHash'], 'moka'],
  ])('%s 根据实际组件选择 %s', (hostname, classes, ats) => {
    const result = runInNewContext(BrowserAtsDetectionExpression, Context(hostname, [new Element(classes)]));
    expect(result.ats).toBe(ats);
    expect(Array.from(result.matchedAdapters)).toEqual([ats]);
  });

  it.each(['careers.example.com', 'fakejobs.feishu.cn', 'jobs.feishu.cn.example.com', 'evilzhiye.com'])('未知域名 %s 不误用已知 ATS', hostname => {
    const result = runInNewContext(BrowserAtsDetectionExpression, Context(hostname, []));
    expect(result.ats).toBe('unknown');
    expect(Array.from(result.matchedAdapters)).toEqual([]);
  });

  it('域名属于已知 ATS，但没有匹配控件时保留通用路径', () => {
    const target = new Element(['calendar']);
    const context = { ...Context('quvideo.jobs.feishu.cn', [target]), target };
    const result = runInNewContext(`(() => { ${BrowserDateAdapterSelectionScript} return { ats, adapter: dateAdapterFor(target) }; })()`, context);
    expect(result).toMatchObject({ ats: 'feishu', adapter: 'generic' });
  });

  it('混合页面按目标最近的组件选择，不把整页锁定为同一种 ATS', () => {
    const feishu = new Element(['atsx-date-picker']);
    const beisen = new Element(['phoenix-select'], feishu);
    const target = new Element(['input'], beisen);
    const result = runInNewContext(`(() => { ${BrowserDateAdapterSelectionScript} return { ats, adapter: dateAdapterFor(target), outer: dateAdapterFor(feishu) }; })()`, {
      ...Context('jobs.feishu.cn', [feishu, beisen]), target, feishu,
    });
    expect(result).toMatchObject({ ats: 'mixed', adapter: 'beisen', outer: 'feishu' });
  });

  it('同一控件同时匹配两种组件时保留通用路径', () => {
    const target = new Element(['atsx-date-picker', 'phoenix-select']);
    const result = runInNewContext(`(() => { ${BrowserDateAdapterSelectionScript} return dateAdapterFor(target); })()`, {
      ...Context('careers.example.com', [target]), target,
    });
    expect(result).toBe('generic');
  });

  it('导航后重新识别，不沿用上个页面的平台', () => {
    const context = Context('quvideo.jobs.feishu.cn', [new Element(['atsx-date-picker'])]);
    expect(runInNewContext(BrowserAtsDetectionExpression, context).ats).toBe('feishu');
    context.location.hostname = 'careers.example.com';
    context.document.querySelector = () => null;
    expect(runInNewContext(BrowserAtsDetectionExpression, context).ats).toBe('unknown');
  });
});
