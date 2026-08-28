import { describe, expect, it, vi } from 'vitest';
import type { BrowserActionProposal } from '../../../packages/agent-sdk/src/index';
import { CreateToolsModule } from '../../../packages/agent-modules-defaults/src/tools';
import { CreateToolContext } from './test-helpers';

function CreatePorts() {
  return { getConfig: vi.fn(async () => null), saveConfig: vi.fn(async () => undefined), getStoredSettings: vi.fn(async () => ({})) };
}

function Proposal(overrides: Partial<BrowserActionProposal> = {}): BrowserActionProposal {
  return {
    proposalHash: 'proposal-hash', toolName: 'BrowserClick', canonicalArguments: { ref: '@e1', pageRevision: 1 },
    summary: '点击下一步', risk: 'medium', forceConfirmation: false, pageRevision: 1, url: 'https://example.com/jobs', resourceIds: ['browser:offerget-default'],
    ...overrides,
  };
}

describe('浏览器工具 Harness', () => {
  it('未加入当前 Run 的文件不能进入 Runtime', async () => {
    const browser = { Prepare: vi.fn(), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', pendingBrowserActions: new Map(), ports: { ...base.ports, browser } });
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'upload-1', type: 'function', function: { name: 'BrowserUploadFile', arguments: JSON.stringify({ ref: '@e1', pageRevision: 1, fileId: 'attachment://not-authorized.pdf' }) },
    }, context);

    expect(browser.Prepare).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'BROWSER_FILE_NOT_AUTHORIZED' });
  });

  it('强制确认不受 fully_trusted 绕过，确认前 CLI 调用次数为零', async () => {
    const browser = { Prepare: vi.fn(async () => Proposal({ forceConfirmation: true, risk: 'high', summary: '提交申请' })), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const pendingBrowserActions = new Map<string, unknown>();
    const context = CreateToolContext({ scenarioId: 'application', confirmationMode: 'fully_trusted', pendingBrowserActions, ports: { ...base.ports, browser } });
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'click-submit', type: 'function', function: { name: 'BrowserClick', arguments: JSON.stringify({ ref: '@e1', pageRevision: 1 }) },
    }, context);

    expect(browser.Execute).not.toHaveBeenCalled();
    expect(result.disposition).toBe('wait_confirmation');
    expect(pendingBrowserActions.size).toBe(1);
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_confirmation' }));
  });

  it('已开始的浏览器写动作取消后进入 status_unknown，不返回可重试取消', async () => {
    const controller = new AbortController();
    const browser = { Prepare: vi.fn(async () => Proposal()), Execute: vi.fn(() => new Promise<never>(() => undefined)), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', signal: controller.signal, ports: { ...base.ports, browser } });
    const execution = CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'click-cancel', type: 'function', function: { name: 'BrowserClick', arguments: JSON.stringify({ ref: '@e1', pageRevision: 1 }) },
    }, context);
    await vi.waitFor(() => expect(browser.Execute).toHaveBeenCalledOnce());
    controller.abort(new Error('user stopped'));
    const result = await execution;

    expect(result.disposition).toBe('pause');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'STATUS_UNKNOWN', retryable: false });
    expect(context.ledger?.Finish).toHaveBeenCalledWith(expect.any(String), 'status_unknown', expect.objectContaining({ errorCode: 'CANCELLED' }));
  });
});
