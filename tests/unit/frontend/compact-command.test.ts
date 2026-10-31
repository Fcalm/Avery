import { describe, expect, it } from 'vitest';
import { ComposerCommands, ParseCompactCommand, SplitCompactCommandDraft } from '../../../src/features/assistant/composerCommands';

describe('compact 命令边界', () => {
  it('命令与编辑正文分离，移除标签只保留后缀，不损坏缩进或换行', () => {
    expect(SplitCompactCommandDraft('/compact')).toEqual({ prefix: '/compact', text: '' });
    const draft = SplitCompactCommandDraft('/compact   保留教育\n  保留未完成事项');
    expect(draft).toEqual({ prefix: '/compact ', text: '  保留教育\n  保留未完成事项' });
    expect(draft.prefix + draft.text).toBe('/compact   保留教育\n  保留未完成事项');
    for (const text of ['/compactfoo', '请解释 /compact', '```\n/compact\n```']) expect(SplitCompactCommandDraft(text)).toEqual({ prefix: '', text });
  });
  it('支持默认重点、多行后缀，保留普通对话中的命令文字', () => {
    expect(ParseCompactCommand('/compact')).toBe('');
    expect(ParseCompactCommand('/compact  保留教育\n 和未完成事项 ')).toBe('保留教育\n 和未完成事项');
    for (const text of ['/compactfoo', '请解释 /compact', '```\n/compact\n```']) expect(ParseCompactCommand(text)).toBeNull();
    expect(ComposerCommands.find((command) => command.token === '/compact')?.action).toBe('compact');
  });
});
