import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PersonalBrowserCdpError,
  PersonalBrowserCdpRuntime,
  type PersonalBrowserCommandOptions,
} from '../../../apps/backend/src/electron/backend/personal-browser-cdp-runtime';

type Listener = (event: any) => void;
const LongBossPhrasePreview = `发送常用语：${'长'.repeat(200)}…【部分内容已截断】`;
type ResponseVariant = 'unknown-envelope' | 'unknown-runtime-remote';

class TranscriptSocket {
  readyState = 0;
  targetClosed = false;
  readonly sent: Array<{ id: number; method: string; params: Record<string, any>; sessionId?: string }> = [];
  readonly sentOptions: PersonalBrowserCommandOptions[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    private readonly anchorUrl = 'https://www.zhipin.com/web/geek/job',
    private readonly chatControls = false,
    private readonly semanticMarker?: string,
    private readonly plainPage = false,
    private readonly snapshotVariant?: 'exception' | 'undefined' | 'null' | 'array' | 'invalid-ready-state' | 'invalid-items' | 'invalid-item' | 'loading',
    private readonly responseVariant?: ResponseVariant,
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

  send(data: string, options?: PersonalBrowserCommandOptions): void {
    const message = JSON.parse(data);
    this.sent.push(message);
    this.sentOptions.push(options ?? {});
    queueMicrotask(() => {
      const response: Record<string, any> = this.targetClosed && message.method === 'Target.getTargetInfo'
        ? { id: message.id, error: { message: 'No target with given id found' } }
        : { id: message.id, result: this.Result(message) };
      const isHostEvaluation = message.method === 'Runtime.evaluate'
        && String(message.params?.expression ?? '').includes('__host_test__');
      if (this.responseVariant === 'unknown-envelope' && isHostEvaluation) response.untrusted = true;
      if (this.responseVariant === 'unknown-runtime-remote' && isHostEvaluation && response.result) {
        response.result = {
          ...response.result,
          result: response.result.result ? { ...response.result.result, untrusted: true } : response.result.result,
        };
      }
      this.Emit('message', { data: JSON.stringify(response) });
    });
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
      if (expression.includes('__host_test__')) return { result: { type: 'object', value: { ok: true } } };
      // SnapshotExpression itself now reports readyState, so recognize the
      // candidate collector before the small readiness probe.
      if (expression.includes('const candidates =')) {
        if (this.snapshotVariant === 'exception') return { exceptionDetails: { text: 'fixture exception' } };
        if (this.snapshotVariant === 'undefined') return { result: { type: 'undefined' } };
        if (this.snapshotVariant === 'null') return { result: { type: 'object', value: null } };
        if (this.snapshotVariant === 'array') return { result: { type: 'object', value: [] } };
        if (this.snapshotVariant === 'invalid-ready-state') return { result: { type: 'object', value: {
          url: this.anchorUrl, title: 'invalid', readyState: 'interactive-ish', items: [],
        } } };
        if (this.snapshotVariant === 'invalid-items') return { result: { type: 'object', value: {
          url: this.anchorUrl, title: 'invalid', readyState: 'complete', items: {},
        } } };
        if (this.snapshotVariant === 'invalid-item') return { result: { type: 'object', value: {
          url: this.anchorUrl, title: 'invalid', readyState: 'complete', items: [{ selector: '#invalid' }],
        } } };
        return { result: { type: 'object', value: {
        url: this.anchorUrl,
        title: this.chatControls ? '聊天' : '岗位列表',
        readyState: this.snapshotVariant === 'loading' ? 'loading' : 'complete',
        items: this.plainPage ? [] : this.semanticMarker ? [
          { selector: '#semantic', tag: 'input', role: 'textbox', type: this.semanticMarker === '出生日期' ? 'date' : 'text', name: this.semanticMarker, ariaLabel: this.semanticMarker },
        ] : this.chatControls ? [
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
      }
      if (expression.includes('readyState: document.readyState')) return { result: { type: 'object', value: { url: this.anchorUrl, readyState: 'complete' } } };
      if (expression.includes("element.type !== 'file'")) return { result: { type: 'object', objectId: 'boss-file-input' } };
      if (expression.includes("element.type !== 'date'")) return { result: { type: 'object', value: { filled: true, value: '2000-01-15' } } };
      if (expression.includes('elementFromPoint')) {
        const input = expression.includes('"tag":"input"');
        const date = expression.includes('"type":"date"');
        return { result: { type: 'object', value: { stale: false, x: input ? 100 : 200, y: 60, tag: input ? 'input' : 'button', type: input ? (date ? 'date' : 'search') : '', disabled: false } } };
      }
    }
    if (message.method === 'Page.captureScreenshot') return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') };
    return {};
  }
}

class SelectorDomElement {
  readonly children: SelectorDomElement[] = [];
  readonly attributes = new Map<string, string>();
  parentElement: SelectorDomElement | null = null;
  className = '';
  textContent = '';
  innerText = '';
  value = '';
  checked = false;
  disabled = false;
  required = false;
  readOnly = false;
  isContentEditable = false;
  readonly classList = { contains: (_value: string) => false };

  constructor(readonly tagName: string, attributes: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  append<T extends SelectorDomElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  get id(): string { return this.getAttribute('id') ?? ''; }
  get type(): string { return this.getAttribute('type') ?? ''; }
  get previousElementSibling(): SelectorDomElement | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  closest(_selector: string): SelectorDomElement | null { return null; }
  querySelector(_selector: string): SelectorDomElement | null { return null; }
  querySelectorAll(_selector: string): SelectorDomElement[] { return []; }
  matches(_selector: string): boolean { return false; }
  getBoundingClientRect(): { width: number; height: number } { return { width: 120, height: 28 }; }
  checkValidity(): boolean { return true; }
}

class SelectorDomAnchorElement extends SelectorDomElement {}
class SelectorDomSelectElement extends SelectorDomElement {}

class SelectorDomDocument {
  readonly documentElement = new SelectorDomElement('HTML');
  readonly body = this.documentElement.append(new SelectorDomElement('BODY'));
  readonly controls: SelectorDomElement[] = [];
  title = '深层表单';

  querySelectorAll(selector: string): SelectorDomElement[] {
    if (selector === 'a[href],button,input,textarea,select,[role],[contenteditable="true"]') return this.controls;
    if (!selector.startsWith('html')) return [];
    const parts = selector.split(' > ');
    if (parts.shift() !== 'html') return [];
    let current: SelectorDomElement[] = [this.documentElement];
    for (const part of parts) {
      const match = part.match(/^([a-z0-9-]+):nth-of-type\((\d+)\)$/);
      if (!match) return [];
      const tag = match[1].toUpperCase();
      const index = Number(match[2]);
      current = current.flatMap((parent) => parent.children.filter((child) => child.tagName.toUpperCase() === tag)[index - 1] ?? []);
    }
    return current;
  }

  querySelector(_selector: string): SelectorDomElement | null { return null; }
  getElementById(_id: string): SelectorDomElement | null { return null; }
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
    expect(snapshotExpression).toContain("['html', ...parts].join(' > ')");
    expect(snapshotExpression).not.toContain('depth < 10');
    expect(evaluated).toMatchObject({ success: true, data: { result: { ok: true } } });
    expect(socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes('__host_test__'))?.params.awaitPromise).toBe(true);
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
    expect(socket.sentOptions.length).toBe(socket.sent.length);
    expect(socket.sentOptions.every((options) => Number.isFinite(options.deadline) && options.deadline! > Date.now())).toBe(true);
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

  it('原生日期输入使用 value setter 写入并校验，不把 ISO 日期当作键盘文本', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket('https://example.com/form', false, '出生日期'); return socket; },
      delay: async () => undefined,
    });

    await runtime.Run(['snapshot']);
    await expect(runtime.Run(['fill', '@e1', '2000-01-15'])).resolves.toMatchObject({
      success: true,
      data: { filled: true, textLength: 10 },
    });

    const dateEvaluation = socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes("element.type !== 'date'"));
    expect(dateEvaluation?.params.expression).toContain("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')");
    expect(dateEvaluation?.params.expression).toContain("new Event('change', { bubbles: true })");
    expect(socket.sent.some((message) => message.method === 'Input.insertText')).toBe(false);
    await runtime.Close();
  });

  it('连接阶段只读取可用页面作为导航锚点，不创建或附着任何 target', async () => {
    const socket = new TranscriptSocket('https://example.com/private');
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => socket,
    });

    await expect(runtime.Connect()).resolves.toEqual({ anchorUrl: 'https://example.com/private' });
    expect(socket.sent.map((message) => message.method)).toEqual(['Target.getTargets']);
    await runtime.Close();
  });

  it('ready 的纯文本页面没有交互 refs 时仍返回成功的空 Snapshot', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket('https://example.com/static-child', false, undefined, true); return socket; },
      delay: async () => undefined,
    });

    await expect(runtime.Run(['snapshot'])).resolves.toMatchObject({
      success: true,
      data: { url: 'https://example.com/static-child', refs: {}, snapshot: '', truncated: false },
    });
    const expression = String(socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes('const candidates ='))?.params.expression ?? '');
    expect(expression).toContain('readyState: document.readyState');
    await runtime.Close();
  });

  it.each([
    ['exceptionDetails', 'exception' as const, 'BROWSER_COMMAND_FAILED', 'Runtime.evaluate returned exceptionDetails'],
    ['undefined value', 'undefined' as const, 'BROWSER_OUTPUT_INVALID', 'did not return a value'],
    ['null value', 'null' as const, 'BROWSER_OUTPUT_INVALID', 'non-object value'],
    ['array value', 'array' as const, 'BROWSER_OUTPUT_INVALID', 'non-object value'],
    ['invalid readyState', 'invalid-ready-state' as const, 'BROWSER_OUTPUT_INVALID', 'invalid readyState'],
    ['invalid items container', 'invalid-items' as const, 'BROWSER_OUTPUT_INVALID', 'invalid items'],
    ['invalid item structure', 'invalid-item' as const, 'BROWSER_OUTPUT_INVALID', 'invalid items'],
  ])('rejects malformed Runtime.evaluate Snapshot output: %s', async (_label, variant, code, message) => {
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => new TranscriptSocket('https://example.com/static-child', false, undefined, false, variant),
      delay: async () => undefined,
    });

    await expect(runtime.Run(['snapshot'])).rejects.toMatchObject<Partial<PersonalBrowserCdpError>>({
      code,
      message: expect.stringContaining(message),
    });
    await runtime.Close();
  });

  it.each([
    ['unknown CDP envelope field', 'unknown-envelope' as const, 'response envelope contains unknown or invalid fields'],
    ['unknown Runtime.RemoteObject field', 'unknown-runtime-remote' as const, 'unknown or invalid remote object'],
  ])('rejects %s instead of passing it to the Host', async (_label, variant, message) => {
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => new TranscriptSocket('https://example.com/static-child', false, undefined, false, undefined, variant),
      delay: async () => undefined,
    });

    const encoded = Buffer.from('({ marker: "__host_test__" })', 'utf8').toString('base64');
    let caught: unknown;
    try { await runtime.Run(['eval', '-b', encoded]); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject<Partial<PersonalBrowserCdpError>>({ code: 'BROWSER_OUTPUT_INVALID' });
    expect(caught).toBeInstanceOf(PersonalBrowserCdpError);
    expect((caught as Error).message).toContain(message);
    await runtime.Close();
  });

  it('accepts audited Runtime.RemoteObject fields with null prototypes but rejects inherited envelopes', () => {
    const runtime = new PersonalBrowserCdpRuntime({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id' });
    const remote = Object.assign(Object.create(null), { type: 'object', value: { ok: true }, description: 'safe' });
    const valid = Object.assign(Object.create(null), { result: remote });
    expect((runtime as any).Value(valid)).toEqual({ ok: true });

    const inherited = Object.create({ result: remote });
    expect(() => (runtime as any).Value(inherited)).toThrowError(PersonalBrowserCdpError);

    const forgedPrototype = Object.create(null);
    Object.defineProperties(forgedPrototype, {
      constructor: { configurable: true, value: Object },
      hasOwnProperty: { configurable: true, value: Object.prototype.hasOwnProperty },
      toString: { configurable: true, value: Object.prototype.toString },
    });
    const forged = Object.assign(Object.create(forgedPrototype), { result: remote });
    expect(() => (runtime as any).Value(forged)).toThrowError(PersonalBrowserCdpError);
  });

  it('Snapshot validators require plain own data fields and reject prototype/accessor pollution', async () => {
    const runtime = new PersonalBrowserCdpRuntime({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id' });
    const validItem = {
      selector: '#name', tag: 'input', role: 'textbox', type: 'text', name: 'Name',
      options: [{ label: 'A', value: 'a', selected: true }],
    };
    const validEnvelope = () => ({
      result: {
        type: 'object',
        value: { readyState: 'complete', items: [validItem], url: 'https://example.com/', title: 'Example' },
      },
    });
    await expect(Promise.resolve((runtime as any).SnapshotValue(validEnvelope()))).resolves.toMatchObject({
      readyState: 'complete', items: [expect.objectContaining({ selector: '#name' })],
    });

    const unknownOwn = { ...validItem, unexpected: true };
    expect(() => (runtime as any).SnapshotValue({ ...validEnvelope(), result: { ...validEnvelope().result, value: {
      ...validEnvelope().result.value, items: [unknownOwn],
    } } })).toThrowError(PersonalBrowserCdpError);

    const customPrototype = Object.assign(Object.create({ inherited: true }), validItem);
    expect(() => (runtime as any).SnapshotValue({ ...validEnvelope(), result: { ...validEnvelope().result, value: {
      ...validEnvelope().result.value, items: [customPrototype],
    } } })).toThrowError(PersonalBrowserCdpError);

    const inheritedRequired = { ...validItem } as Record<string, unknown>;
    delete inheritedRequired.selector;
    Object.defineProperty(Object.prototype, 'selector', { configurable: true, value: '#polluted-selector' });
    try {
      expect(() => (runtime as any).SnapshotValue({ ...validEnvelope(), result: { ...validEnvelope().result, value: {
        ...validEnvelope().result.value, items: [inheritedRequired],
      } } })).toThrowError(PersonalBrowserCdpError);
    } finally {
      delete (Object.prototype as Record<string, unknown>).selector;
    }

    let getterReads = 0;
    const accessorItem = { ...validItem } as Record<string, unknown>;
    Object.defineProperty(accessorItem, 'name', {
      configurable: true,
      get() { getterReads += 1; throw new Error('unexpected getter execution'); },
    });
    expect(() => (runtime as any).SnapshotValue({ ...validEnvelope(), result: { ...validEnvelope().result, value: {
      ...validEnvelope().result.value, items: [accessorItem],
    } } })).toThrowError(PersonalBrowserCdpError);
    expect(getterReads).toBe(0);
  });

  it('TargetInfo validator accepts standard plain targets and rejects unknown/inherited/accessor identities', async () => {
    const runtime = new PersonalBrowserCdpRuntime({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id' });
    const target = { targetId: 'task', type: 'page', url: 'https://example.com/', attached: false };
    (runtime as any).Send = async () => ({ targetInfos: [target] });
    await expect((runtime as any).GetTargets({})).resolves.toEqual([target]);

    const rejectsTarget = async (value: unknown) => {
      (runtime as any).Send = async () => ({ targetInfos: [value] });
      await expect((runtime as any).GetTargets({})).rejects.toMatchObject({ code: 'BROWSER_OUTPUT_INVALID' });
    };
    await rejectsTarget({ ...target, unexpected: true });
    await rejectsTarget(Object.assign(Object.create({ inherited: true }), target));
    const inheritedRequired = { type: 'page', url: target.url } as Record<string, unknown>;
    Object.defineProperty(Object.prototype, 'targetId', { configurable: true, value: 'polluted-target' });
    try { await rejectsTarget(inheritedRequired); }
    finally { delete (Object.prototype as Record<string, unknown>).targetId; }
    let getterReads = 0;
    const accessorTarget = { ...target } as Record<string, unknown>;
    Object.defineProperty(accessorTarget, 'targetId', {
      configurable: true,
      get() { getterReads += 1; throw new Error('unexpected getter execution'); },
    });
    await rejectsTarget(accessorTarget);
    expect(getterReads).toBe(0);
  });

  it('loading Snapshot 在有界 deadline 内持续轮询，最终按 readyState timeout', async () => {
    let clock = 10_000;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      now: () => clock,
      webSocketFactory: () => new TranscriptSocket('https://example.com/loading-child', false, undefined, false, 'loading'),
      delay: async (milliseconds) => { clock += milliseconds; },
    });

    await expect(runtime.Run(['snapshot'], { deadline: clock + 250 })).rejects.toMatchObject<Partial<PersonalBrowserCdpError>>({
      code: 'BROWSER_COMMAND_TIMEOUT',
      message: 'The task page did not become ready for a semantic snapshot in time.',
    });
    await runtime.Close();
  });

  it('完整保留表单检查器的长字段特征包并用于元素重定位', async () => {
    const marker = `__avery_field__${'a'.repeat(900)}`;
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket('https://example.com/form', false, marker); return socket; },
      delay: async () => undefined,
    });

    const snapshot = await runtime.Run(['snapshot']);
    await runtime.Run(['fill', '@e1', 'test']);

    expect(snapshot.data.refs.e1).toMatchObject({ name: marker, ariaLabel: marker });
    const expressions = socket.sent.filter((message) => message.method === 'Runtime.evaluate')
      .map((message) => String(message.params.expression ?? ''));
    expect(expressions.some((expression) => expression.includes("text.startsWith('__avery_field__') ? text.slice(0, 4096)"))).toBe(true);
    expect(expressions.some((expression) => expression.includes("String(expected.name || '').startsWith('__avery_field__')"))).toBe(true);
    await runtime.Close();
  });

  it('深层同构控件的 Snapshot selector 从文档根生成并唯一回指原元素', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket('https://example.com/form'); return socket; },
      delay: async () => undefined,
    });
    await runtime.Run(['snapshot']);
    const expression = String(socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes('const candidates ='))?.params.expression ?? '');
    expect(expression).not.toBe('');

    const document = new SelectorDomDocument();
    const controls = [1, 2].map((sectionIndex) => {
      const section = document.body.append(new SelectorDomElement('SECTION'));
      let container = section;
      // 超过十层且两组 DOM 结构完全同构，局部 selector 会命中两组中的同一位置。
      for (let depth = 0; depth < 12; depth += 1) container = container.append(new SelectorDomElement('DIV'));
      const input = container.append(new SelectorDomElement('INPUT', { type: 'text', name: `field-${sectionIndex}` }));
      document.controls.push(input);
      return input;
    });
    const getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' });
    const evaluate = new Function(
      'document', 'location', 'getComputedStyle', 'HTMLElement', 'HTMLAnchorElement', 'HTMLSelectElement', 'CSS', 'URL', `return ${expression};`,
    ) as (document: SelectorDomDocument, location: Record<string, string>, getComputedStyle: () => Record<string, string>, HTMLElement: typeof SelectorDomElement, HTMLAnchorElement: typeof SelectorDomElement, HTMLSelectElement: typeof SelectorDomElement, CSS: { escape: (value: string) => string }, URL: typeof URL) => any;
    const snapshot = evaluate(document, { href: 'https://example.com/form', hostname: 'example.com', pathname: '/form' }, getComputedStyle, SelectorDomElement, SelectorDomAnchorElement, SelectorDomSelectElement, { escape: (value) => value }, URL);

    expect(snapshot.items).toHaveLength(2);
    const selectors = snapshot.items.map((item: { selector: string }) => item.selector);
    expect(new Set(selectors).size).toBe(2);
    for (const [index, selector] of selectors.entries()) {
      expect(selector.split(' > ').length).toBeGreaterThan(10);
      expect(document.querySelectorAll(selector)).toEqual([controls[index]]);
    }
    await runtime.Close();
  });

  it('Snapshot 暴露关联可见上传区域的隐藏文件输入并排除无语义隐藏输入', async () => {
    let socket!: TranscriptSocket;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
      webSocketFactory: () => { socket = new TranscriptSocket(); return socket; },
      delay: async () => undefined,
    });
    await runtime.Run(['snapshot']);
    const expression = String(socket.sent.find((message) => message.method === 'Runtime.evaluate'
      && String(message.params.expression ?? '').includes('const candidates ='))?.params.expression ?? '');
    expect(expression).not.toBe('');

    const document = new SelectorDomDocument();
    const uploadSurface = document.body.append(new SelectorDomElement('DIV'));
    uploadSurface.className = 'standard-file-uploader dropzone';
    uploadSurface.textContent = '上传简历';
    uploadSurface.innerText = '上传简历';
    const resumeInput = uploadSurface.append(new SelectorDomElement('INPUT', { type: 'file', accept: '.pdf,.doc,.docx' }));
    const unrelatedContainer = document.body.append(new SelectorDomElement('DIV'));
    const unrelatedInput = unrelatedContainer.append(new SelectorDomElement('INPUT', { type: 'file' }));
    document.controls.push(resumeInput, unrelatedInput);
    const getComputedStyle = (element: SelectorDomElement) => ({
      display: element === resumeInput || element === unrelatedInput ? 'none' : 'block',
      visibility: 'visible', opacity: '1', cursor: element === uploadSurface ? 'pointer' : 'default',
    });
    const evaluate = new Function(
      'document', 'location', 'getComputedStyle', 'HTMLElement', 'HTMLAnchorElement', 'HTMLSelectElement', 'CSS', 'URL', `return ${expression};`,
    ) as (document: SelectorDomDocument, location: Record<string, string>, getComputedStyle: (element: SelectorDomElement) => Record<string, string>, HTMLElement: typeof SelectorDomElement, HTMLAnchorElement: typeof SelectorDomElement, HTMLSelectElement: typeof SelectorDomElement, CSS: { escape: (value: string) => string }, URL: typeof URL) => any;
    const snapshot = evaluate(document, { href: 'https://iflytek.zhiye.com/form', hostname: 'iflytek.zhiye.com', pathname: '/form' }, getComputedStyle, SelectorDomElement, SelectorDomAnchorElement, SelectorDomSelectElement, { escape: (value) => value }, URL);

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ tag: 'input', role: 'filechooser', type: 'file', name: '上传简历' });
    expect(snapshot.items[0].selector).toContain('html > body:nth-of-type(1)');
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
