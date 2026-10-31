import { describe, expect, it } from 'vitest';
import { BrowserSnapshotPresenter } from '../../../packages/agent-modules-defaults/src/browser-snapshot';
import { CreateToolContext } from './test-helpers';
import type { BrowserAutomationPort } from '@avery/agent-sdk';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { CreateKernelHarness, CreateRegisteredTool } from './test-helpers';

function Setup() {
  const presenter = new BrowserSnapshotPresenter();
  const browser = {} as BrowserAutomationPort;
  const seen = new Set<string>();
  const context = CreateToolContext({ hasToolResultInContext: (id) => seen.has(id) });
  const refs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`e${index + 1}`, {
    role: 'textbox', name: `教育经历字段${index + 1}`, value: '', valueLength: 0,
    nearbyTexts: [], selector: '#private', disabled: false,
  }]));
  const data = { documentId: 'page:1', url: 'https://example.com/form', title: '申请', pageRevision: 1, refs, tabs: [{ tabId: 'page' }] };
  const present = (callId: string, input = data, full = false) => {
    const result = presenter.Present(browser, context, callId, input, full);
    seen.add(callId);
    return result;
  };
  return { presenter, browser, context, data, present };
}

describe('面向模型的浏览器快照', () => {
  it('首次全量去掉重复正文与内部匹配字段，保留可操作状态', () => {
    const { present } = Setup();
    const result = present('first');
    expect(result.mode).toBe('full');
    expect(result).not.toHaveProperty('snapshot');
    expect(result).not.toHaveProperty('documentId');
    expect((result.refs as Record<string, unknown>).e1).toEqual({ role: 'textbox', name: '教育经历字段1', value: '', valueLength: 0 });
  });

  it('新增、修改、删除均显式报告，等长输入变化不能遗漏', () => {
    const { present, data } = Setup();
    data.refs.e1.value = '本科';
    data.refs.e1.valueLength = 2;
    const first = present('first');
    const refs = { ...data.refs, e1: { ...data.refs.e1, value: '硕士' }, e31: { ...data.refs.e2, name: '新增学校' } };
    delete (refs as Record<string, unknown>).e2;
    const result = present('second', { ...data, refs, pageRevision: 2 });
    expect(result).toMatchObject({ mode: 'delta', baseSnapshotId: first.snapshotId, pageRevision: 2,
      added: { e31: { name: '新增学校' } }, updated: { e1: { value: '硕士' } }, removed: ['e2'] });
  });

  it('没有变化也返回当前版本，不能让模型沿用旧 pageRevision', () => {
    const { present, data } = Setup();
    present('first');
    expect(present('second', { ...data, pageRevision: 4 })).toMatchObject({ mode: 'unchanged', pageRevision: 4 });
  });

  it('同名输入框保留区分字段所需的邻近标签', () => {
    const { present, data } = Setup();
    Object.assign(data.refs.e1, { name: '请输入', precedingLabels: ['学校名称'] });
    expect(present('first').refs).toMatchObject({ e1: { name: '请输入', label: '学校名称' } });
  });

  it('只重排原节点也报告最新顺序', () => {
    const { present, data } = Setup();
    present('first');
    const refs = Object.fromEntries(Object.entries(data.refs).reverse());
    expect(present('reorder', { ...data, refs })).toMatchObject({ mode: 'delta', order: Object.keys(refs), added: {}, updated: {}, removed: [] });
  });

  it('同 URL 换文档仍全量；不同 URL、新请求和显式 full 均全量', () => {
    const { present, data, context } = Setup();
    present('first');
    expect(present('new-document', { ...data, documentId: 'page:2' }).mode).toBe('full');
    expect(present('new-url', { ...data, url: 'https://example.com/other' }).mode).toBe('full');
    expect(present('reset', data, true).mode).toBe('full');
    context.requestId = 'another-request';
    expect(present('new-request').mode).toBe('full');
  });

  it('截断快照不推断删除，也不成为后续增量基线', () => {
    const { present, data } = Setup();
    present('first');
    const truncated = { ...data, truncated: true };
    expect(present('partial', truncated).mode).toBe('full');
    expect(present('after-partial').mode).toBe('full');
  });

  it('大量变化时回退更短的全量', () => {
    const { present, data } = Setup();
    present('first');
    const refs = Object.fromEntries(Object.entries(data.refs).map(([ref, value]) => [`new-${ref}`, value]));
    expect(present('changed', { ...data, refs }).mode).toBe('full');
  });

  it('输入值被裁剪时不把未观测到的尾部变化报告为无变化', () => {
    const { present, data } = Setup();
    Object.assign(data.refs.e1, { valueTruncated: true });
    expect(present('first').mode).toBe('full');
    expect(present('second').mode).toBe('full');
  });

  it('Kernel 在实际回执进入模型上下文后才允许下一次观察使用增量', async () => {
    const { presenter, browser, data } = Setup();
    const modes: unknown[] = [];
    const call = (id: string) => ({ content: '', toolCalls: [{ id, type: 'function' as const, function: { name: 'BrowserSnapshot', arguments: '{}' } }] });
    const harness = CreateKernelHarness({
      tools: [CreateRegisteredTool('BrowserSnapshot')],
      completions: [call('first'), call('second'), { content: 'done', toolCalls: [] }],
      executeTool: async (call, context) => {
        const projected = presenter.Present(browser, context, call.id, data, false);
        modes.push(projected.mode);
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, data: projected }) };
      },
    });
    expect((await RunAgentLoop(harness.input)).outcome).toBe('completed');
    expect(modes).toEqual(['full', 'unchanged']);
  });
});
