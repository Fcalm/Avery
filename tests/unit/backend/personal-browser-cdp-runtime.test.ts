import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PersonalBrowserCdpError,
  PersonalBrowserCdpRuntime,
} from '../../../apps/backend/src/electron/backend/personal-browser-cdp-runtime';

type Listener = (event: any) => void;
const LongBossPhrasePreview = `发送常用语：${'长'.repeat(200)}…【部分内容已截断】`;

class TranscriptSocket {
  readyState = 0;
  targetClosed = false;
  readonly sent: Array<{ id: number; method: string; params: Record<string, any>; sessionId?: string }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    private readonly anchorUrl = 'https://www.zhipin.com/web/geek/job',
    private readonly chatControls = false,
  ) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.Emit('open', {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }

  send(data: string): void {
    const message = JSON.parse(data);
    this.sent.push(message);
    queueMicrotask(() => this.Emit('message', { data: JSON.stringify(this.targetClosed && message.method === 'Target.getTargetInfo'
      ? { id: message.id, error: { message: 'No target with given id found' } }
      : { id: message.id, result: this.Result(message) }) }));
  }

  close(): void {
    this.readyState = 3;
    this.Emit('close', { code: 1000 });
  }

  private Emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private Result(message: { method: string; params: Record<string, any> }): Record<string, any> {
    if (message.method === 'Target.getTargets') return { targetInfos: [{ targetId: 'anchor', type: 'page', url: this.anchorUrl }] };
    if (message.method === 'Target.createTarget') { this.targetClosed = false; return { targetId: 'task' }; }
    if (message.method === 'Target.attachToTarget') return { sessionId: 'task-session' };
    if (message.method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'task', type: 'page', url: this.anchorUrl } };
    if (message.method === 'Runtime.evaluate') {
      const expression = String(message.params.expression ?? '');
      if (expression.includes('__host_test__')) return { result: { value: { ok: true } } };
      if (expression.includes('readyState: document.readyState')) return { result: { value: { url: this.anchorUrl, readyState: 'complete' } } };
      if (expression.includes('const candidates =')) return { result: { value: {
        url: this.anchorUrl,
        title: this.chatControls ? '聊天' : '岗位列表',
        items: this.chatControls ? [
          { selector: '.btn-dict', tag: 'div', role: 'button', type: '', name: '常用语' },
          { selector: '.sentence-item', tag: 'li', role: 'button', type: '', name: LongBossPhrasePreview, textTruncated: true },
          { selector: '.btn-sendimg input', tag: 'input', role: 'filechooser', type: 'file', name: '发送图片' },
        ] : [
          {
            selector: '#search', tag: 'input', role: 'searchbox', type: 'search', name: '搜索职位',
            rawLabel: '职位关键词', id: 'search', placeholder: '请输入职位', ariaLabel: '搜索职位', section: '求职意向',
            nearbyTexts: ['职位关键词'], precedingLabels: ['工作城市'], followingLabels: ['职位类别'], groupHeading: '求职意向', recordIndex: 0,
          },
          { selector: '#submit', tag: 'button', role: 'button', type: '', name: '搜索' },
        ],
      } } };
      if (expression.includes("element.type !== 'file'")) return { result: { objectId: 'boss-file-input' } };
      if (expression.includes('elementFromPoint')) {
        const input = expression.includes('"tag":"input"');
        return { result: { value: { stale: false, x: input ? 100 : 200, y: 60, tag: input ? 'input' : 'button', type: input ? 'search' : '', disabled: false } } };
      }
    }
    if (message.method === 'Page.captureScreenshot') return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') };
    return {};
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PersonalBrowserCdpRuntime', () => {
  it('只用允许的原始 CDP 方法完成任务页、Snapshot、输入、点击和截图', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket(); return socket; },
      delay: async () => undefined,
    });
    const root = await mkdtemp(join(tmpdir(), 'avery-personal-cdp-'));
    roots.push(root);
    const screenshotPath = join(root, 'shot.png');

    const step = async <T>(label: string, task: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          task,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} did not settle after ${socket.sent.map((message) => message.method).join(', ')}`)), 1_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const snapshot = await step('snapshot', runtime.Run(['snapshot']));
    const evaluated = await step('eval', runtime.Run(['eval', '-b', Buffer.from('({ marker: "__host_test__" })', 'utf8').toString('base64')]));
    await step('fill', runtime.Run(['fill', '@e1', 'AI Agent']));
    await step('click', runtime.Run(['click', '@e2']));
    await step('screenshot', runtime.Run(['screenshot', screenshotPath]));

    expect(snapshot.data.refs).toMatchObject({
      e1: {
        role: 'searchbox', name: '搜索职位', rawLabel: '职位关键词', id: 'search', placeholder: '请输入职位', ariaLabel: '搜索职位', section: '求职意向',
        nearbyTexts: ['职位关键词'], precedingLabels: ['工作城市'], followingLabels: ['职位类别'], groupHeading: '求职意向', recordIndex: 0,
      },
      e2: { role: 'button', name: '搜索' },
    });
    const snapshotExpression = String(socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes('const candidates ='))?.params.expression ?? '');
    expect(() => new Function(snapshotExpression)).not.toThrow();
    expect(snapshotExpression).toContain('split(/\\s+/)');
    expect(snapshotExpression).toContain("element.classList.contains('disabled')");
    expect(snapshotExpression).toContain('const fileInputSurfaceOf =');
    expect(snapshotExpression).toContain("if (type === 'file') return 'filechooser'");
    expect(snapshotExpression).toContain('hiddenFileInputSurface');
    expect(evaluated).toMatchObject({ success: true, data: { result: { ok: true } } });
    await expect(runtime.Run(['eval', '-b', '%%%'])).rejects.toMatchObject<Partial<PersonalBrowserCdpError>>({ code: 'BROWSER_ARGUMENT_INVALID' });
    await expect(access(screenshotPath)).resolves.toBeUndefined();
    expect(socket.sent.map((message) => message.method)).toEqual(expect.arrayContaining([
      'Target.getTargets', 'Target.createTarget', 'Target.attachToTarget', 'Target.activateTarget',
      'Target.getTargetInfo', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent',
      'Input.insertText', 'Page.captureScreenshot',
    ]));
    expect(socket.sent.map((message) => message.method)).not.toEqual(expect.arrayContaining([
      'Runtime.enable', 'Page.enable', 'Network.enable', 'WebMCP.enable', 'Target.setAutoAttach',
    ]));
    const firstMouseMove = socket.sent.findIndex((message) => message.method === 'Input.dispatchMouseEvent'
      && message.params.type === 'mouseMoved');
    expect(firstMouseMove).toBeGreaterThan(0);
    expect(socket.sent[firstMouseMove - 1]).toMatchObject({
      method: 'Target.activateTarget',
      params: { targetId: 'task' },
    });
    expect(socket.sent.filter((message) => message.sessionId).every((message) => message.sessionId === 'task-session')).toBe(true);
    await runtime.Close();
  });

  it('连接中找不到 BOSS 页面时不创建或附着任何 target', async () => {
    const socket = new TranscriptSocket('https://example.com/private');
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => socket,
    });

    await expect(runtime.Connect()).rejects.toMatchObject<Partial<PersonalBrowserCdpError>>({ code: 'BROWSER_BOSS_TAB_REQUIRED' });
    expect(socket.sent.map((message) => message.method)).toEqual(['Target.getTargets']);
    await runtime.Close();
  });

  it('授权连接仍存活时，导航可重建被用户关闭的专用任务页', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket(); return socket; },
      delay: async () => undefined,
    });

    await runtime.Run(['snapshot']);
    socket.targetClosed = true;
    await expect(runtime.Run(['open', 'https://www.zhipin.com/web/geek/job?query=agent'])).resolves.toMatchObject({ success: true });
    expect(socket.sent.filter((message) => message.method === 'Target.createTarget')).toHaveLength(2);
    await runtime.Close();
  });

  it('允许 Snapshot 已认证的通用隐藏文件输入直接绑定授权文件', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket(); return socket; },
      delay: async () => undefined,
    });
    await runtime.Run(['snapshot']);
    (runtime as any).refs.set('e99', {
      selector: 'html > body:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)',
      tag: 'input', role: 'filechooser', type: 'file', name: '上传简历',
    });

    await expect(runtime.Run(['upload', '@e99', 'D:\\authorized\\resume.pdf'])).resolves.toMatchObject({
      success: true,
      data: { uploaded: true },
    });
    const uploadEvaluation = socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes("element.type !== 'file'"));
    expect(uploadEvaluation?.params.expression).toContain('hasVisibleUploadSurface');
    expect(socket.sent).toContainEqual(expect.objectContaining({
      method: 'DOM.setFileInputFiles',
      params: { files: ['D:\\authorized\\resume.pdf'], objectId: 'boss-file-input' },
      sessionId: 'task-session',
    }));
    await runtime.Close();
  });

  it('BOSS 聊天页暴露常用语条目并允许授权文件绑定隐藏图片输入框', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => {
        socket = new TranscriptSocket('https://www.zhipin.com/web/geek/chat', true);
        return socket;
      },
      delay: async () => undefined,
    });

    const snapshot = await runtime.Run(['snapshot']);
    expect(snapshot.data.refs).toMatchObject({
      e1: { role: 'button', name: '常用语' },
      e2: { role: 'button', name: LongBossPhrasePreview, textTruncated: true },
      e3: { role: 'filechooser', type: 'file', name: '发送图片' },
    });
    expect(snapshot.data).toMatchObject({ partialTextTruncated: true });
    expect(snapshot.data.snapshot).toContain('【部分内容已截断】');
    const snapshotExpression = String(socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes('const candidates ='))?.params.expression ?? '');
    expect(snapshotExpression).not.toContain('text.length > 200');
    expect(snapshotExpression).toContain('【部分内容已截断】');

    await expect(runtime.Run(['upload', '@e3', 'D:\\authorized\\resume.png'])).resolves.toMatchObject({
      success: true,
      data: { uploaded: true },
    });
    expect(socket.sent).toContainEqual(expect.objectContaining({
      method: 'DOM.setFileInputFiles',
      params: { files: ['D:\\authorized\\resume.png'], objectId: 'boss-file-input' },
      sessionId: 'task-session',
    }));
    const uploadStart = socket.sent.findIndex((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes("element.type !== 'file'"));
    expect(socket.sent.slice(uploadStart, uploadStart + 2).map((message) => message.method)).toEqual([
      'Runtime.evaluate', 'DOM.setFileInputFiles',
    ]);
    await runtime.Close();
  });
});
