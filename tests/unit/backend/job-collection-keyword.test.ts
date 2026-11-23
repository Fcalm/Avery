import { describe, expect, it } from 'vitest';
import { MatchesCollectionKeyword } from '../../../apps/backend/src/electron/backend/job-collection-keyword';

describe('采集关键词匹配', () => {
  it.each([
    ['AI产品经理实习生', 'ai产品经理'],
    ['ＡＩ产品经理', 'AI产品经理'],
    ['AI\t产品\n经理', 'ai产品经理'],
    ['AI　产品 经理', 'ai产品经理'],
    ['【AI】·产品－经理_实习', 'a.I/产品 经理'],
    ['AI\u200b产品🎯经理', 'ai产品经理'],
    ['数据分析师２', '数据-分析师2'],
    ['任意岗位', ''],
    ['任意岗位', ' ·_-🎯 '],
  ])('%s 匹配 %s', (text, keyword) => {
    expect(MatchesCollectionKeyword(text, keyword)).toBe(true);
  });

  it('保留有意义的文字、数字和顺序，不因跨字段拼接误匹配', () => {
    for (const title of ['算法工程师', 'AI助理产品经理', '产品经理AI']) expect(MatchesCollectionKeyword(title, 'AI产品经理')).toBe(false);
    expect(MatchesCollectionKeyword('数据分析师1', '数据分析师2')).toBe(false);
    expect(MatchesCollectionKeyword(['AI', '产品经理工作室', '业务职责'], 'AI产品经理')).toBe(false);
    expect(MatchesCollectionKeyword(['算法工程师', '企业', '配合 AI·产品经理完成工作'], 'ai产品经理')).toBe(true);
  });
});
