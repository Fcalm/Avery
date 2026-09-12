import { writeFile } from 'node:fs/promises';
import { setTimeout as Delay } from 'node:timers/promises';

const SocketOpen = 1;
const DefaultTimeoutMs = 60_000;
const MaxSnapshotElements = 300;
const MaxSnapshotChars = 50_000;
const MaxReadChars = 50_000;
const BossChatPhrasePrefix = '发送常用语：';
const BossChatPhraseTextLimit = 200;
const BossChatPhraseTruncationMarker = '…【部分内容已截断】';
const BossChatPhrasePanelSelector = '.sentence-panel';
const BossChatPhraseControlSelector = '.chat-controls .btn-dict[aria-label="常用语"]';
const BossChatImageControlSelector = '.chat-controls .btn-sendimg[aria-label="发送图片"]';
const BossChatImageInputSelector = `${BossChatImageControlSelector} input[type="file"]`;

const BrowserMethods = new Set([
  'Target.getTargets',
  'Target.createTarget',
  'Target.attachToTarget',
  'Target.activateTarget',
  'Target.getTargetInfo',
]);

const PageMethods = new Set([
  'Page.navigate',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.captureScreenshot',
  'Runtime.evaluate',
  'Runtime.releaseObject',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'DOM.setFileInputFiles',
]);

const AllowedMethods = new Set([...BrowserMethods, ...PageMethods]);

type BrowserSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};

type CdpTargetInfo = {
  targetId: string;
  type?: string;
  url?: string;
};

type PendingCommand = {
  method: string;
  sideEffect: boolean;
  resolve: (value: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
};

type ElementFingerprint = {
  selector: string;
  tag: string;
  role: string;
  type: string;
  name: string;
};

export type PersonalBrowserCommandResult = { success: true; data: Record<string, any> };

export interface PersonalBrowserRuntimePort {
  Connect(options?: PersonalBrowserCommandOptions): Promise<{ anchorUrl: string }>;
  Run(command: string[], options?: PersonalBrowserCommandOptions & { stdin?: string }): Promise<PersonalBrowserCommandResult>;
  ResetReferences(): void;
  IsConnected(): boolean;
  Close(): Promise<void>;
}

export type PersonalBrowserCommandOptions = {
  signal?: AbortSignal;
  deadline?: number;
};

export interface PersonalBrowserCdpRuntimeOptions {
  endpoint: string;
  anchorUrl?: string;
  now?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  webSocketFactory?: (url: string) => BrowserSocket;
}

export class PersonalBrowserCdpError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusUnknown = false) {
    super(message);
    this.name = 'PersonalBrowserCdpError';
  }
}

function IsBossUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return ['http:', 'https:'].includes(url.protocol)
      && (hostname === 'zhipin.com' || hostname.endsWith('.zhipin.com'));
  } catch {
    return false;
  }
}

function RequireText(value: unknown, field: string, maxLength = 20_000): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', `${field} is invalid.`);
  }
  return value;
}

function SafeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

const SnapshotExpression = `(() => {
  const normalizedText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const normalize = (value, limit = 180) => normalizedText(value).slice(0, limit);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const bossChatPage = (location.hostname === 'zhipin.com' || location.hostname.endsWith('.zhipin.com'))
    && location.pathname === '/web/geek/chat';
  const bossChatNameOf = (element) => {
    if (!bossChatPage) return '';
    if (element.matches(${JSON.stringify(BossChatPhraseControlSelector)})) return '常用语';
    if (element.matches(${JSON.stringify(BossChatImageInputSelector)})) return '发送图片';
    if (element.closest(${JSON.stringify(BossChatPhrasePanelSelector)})) {
      const fullPhrase = normalizedText(element.innerText || element.textContent);
      const phrase = fullPhrase.slice(0, ${BossChatPhraseTextLimit});
      if (phrase) return ${JSON.stringify(BossChatPhrasePrefix)} + phrase
        + (fullPhrase.length > ${BossChatPhraseTextLimit} ? ${JSON.stringify(BossChatPhraseTruncationMarker)} : '');
    }
    return '';
  };
  const nameOf = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledText = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
    const explicitLabel = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent : '';
    return bossChatNameOf(element) || normalize(element.getAttribute('aria-label') || labelledText || explicitLabel || element.closest('label')?.textContent
      || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.textContent);
  };
  const labelOf = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledText = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
    const explicitLabel = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent : '';
    return normalize(labelledText || explicitLabel || element.closest('label')?.textContent);
  };
  const roleOf = (element) => {
    if (bossChatPage && element.matches(${JSON.stringify(BossChatPhraseControlSelector)})) return 'button';
    if (bossChatPage && element.matches(${JSON.stringify(BossChatImageInputSelector)})) return 'filechooser';
    if (bossChatPage && bossChatNameOf(element).startsWith(${JSON.stringify(BossChatPhrasePrefix)})) return 'button';
    const explicit = normalize(element.getAttribute('role'), 40).toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = String(element.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      return type === 'search' ? 'searchbox' : 'textbox';
    }
    return element.isContentEditable ? 'textbox' : 'generic';
  };
  const sectionOf = (element) => {
    const fieldset = element.closest('fieldset');
    const legend = fieldset?.querySelector(':scope > legend')?.textContent;
    if (legend) return normalize(legend);
    let current = element.parentElement;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const labelledBy = current.getAttribute('aria-labelledby');
      const labelled = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
      if (labelled) return normalize(labelled);
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (/^H[1-6]$/.test(sibling.tagName)) return normalize(sibling.textContent);
        sibling = sibling.previousElementSibling;
      }
    }
    return '';
  };
  const contextOf = (element) => {
    const container = element.closest('label,fieldset,[class*="form-item" i],[class*="formitem" i],[class*="field" i],[class*="row" i]') || element.parentElement;
    const nearbyTexts = container
      ? [...container.querySelectorAll('label,legend,[class*="label" i],[class*="title" i]')]
        .filter((candidate) => candidate !== element && !candidate.contains(element) && !candidate.closest('nav,header,footer'))
        .map((candidate) => normalize(candidate.textContent)).filter(Boolean).slice(0, 8)
      : [];
    const siblings = container?.parentElement ? [...container.parentElement.children] : [];
    const index = container ? siblings.indexOf(container) : -1;
    const labelsFrom = (items) => items.flatMap((candidate) => [...candidate.querySelectorAll('label,legend,[class*="label" i]')]
      .filter((label) => !label.closest('nav,header,footer')).map((label) => normalize(label.textContent))).filter(Boolean).slice(0, 4);
    const group = element.closest('fieldset,[class*="education" i],[class*="school" i],[class*="work" i],[class*="project" i],[class*="experience" i]');
    const peerGroups = group?.parentElement ? [...group.parentElement.children].filter((candidate) => candidate.tagName === group.tagName && candidate.className === group.className) : [];
    return {
      nearbyTexts,
      precedingLabels: index > 0 ? labelsFrom(siblings.slice(Math.max(0, index - 2), index)) : [],
      followingLabels: index >= 0 ? labelsFrom(siblings.slice(index + 1, index + 3)) : [],
      groupHeading: normalize(group?.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,[class*="title" i]')?.textContent),
      recordIndex: group && peerGroups.length > 1 ? Math.max(0, peerGroups.indexOf(group)) : undefined,
    };
  };
  const selectorOf = (element) => {
    if (element.id) {
      const selector = '#' + CSS.escape(element.id);
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    const parts = [];
    let current = element;
    for (let depth = 0; current && current !== document.documentElement && depth < 10; depth += 1) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [];
      const index = Math.max(1, siblings.indexOf(current) + 1);
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const standardCandidates = [...document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"]')];
  const bossPhraseCandidates = bossChatPage ? [...document.querySelectorAll(${JSON.stringify(`${BossChatPhrasePanelSelector} *`)})]
    .filter((element) => {
      if (!(element instanceof HTMLElement) || !visible(element)) return false;
      const text = normalize(element.innerText || element.textContent, 220);
      if (!text || /^(添加常用语|管理常用语|编辑|删除|关闭|取消)$/.test(text)) return false;
      const interactive = ['A', 'BUTTON', 'LI'].includes(element.tagName)
        || typeof element.onclick === 'function' || getComputedStyle(element).cursor === 'pointer';
      if (!interactive) return false;
      return ![...element.querySelectorAll('*')].some((child) => child instanceof HTMLElement && visible(child)
        && normalize(child.innerText || child.textContent, 220) === text
        && (['A', 'BUTTON', 'LI'].includes(child.tagName) || typeof child.onclick === 'function' || getComputedStyle(child).cursor === 'pointer'));
    }) : [];
  const bossCandidates = bossChatPage
    ? [...document.querySelectorAll(${JSON.stringify(`${BossChatPhraseControlSelector},${BossChatImageInputSelector}`)}), ...bossPhraseCandidates]
    : [];
  // 聊天动作必须优先进入有限快照，避免长会话页面的普通控件先耗尽元素上限。
  const candidates = [...new Set([...bossCandidates, ...standardCandidates])];
  const items = [];
  for (const element of candidates) {
    if (items.length >= ${MaxSnapshotElements}) break;
    if (!(element instanceof HTMLElement)) continue;
    const tag = element.tagName.toLowerCase();
    const type = normalize(element.getAttribute('type'), 40).toLowerCase();
    const bossHiddenImageInput = bossChatPage && element.matches(${JSON.stringify(BossChatImageInputSelector)})
      && element.closest(${JSON.stringify(BossChatImageControlSelector)}) instanceof HTMLElement
      && visible(element.closest(${JSON.stringify(BossChatImageControlSelector)}));
    if (!visible(element) && !bossHiddenImageInput) continue;
    if (tag === 'input' && type === 'hidden') continue;
    let href;
    if (element instanceof HTMLAnchorElement && element.href) {
      try {
        const url = new URL(element.href, location.href);
        if (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com')) href = url.href.slice(0, 2000);
      } catch {}
    }
    const context = contextOf(element);
    const bossPhraseText = bossChatPage && element.closest(${JSON.stringify(BossChatPhrasePanelSelector)})
      ? normalizedText(element.innerText || element.textContent)
      : '';
    items.push({
      selector: selectorOf(element),
      tag,
      role: roleOf(element),
      type,
      name: nameOf(element),
      textTruncated: bossPhraseText.length > ${BossChatPhraseTextLimit},
      rawLabel: labelOf(element),
      section: sectionOf(element),
      fieldName: normalize(element.getAttribute('name'), 180),
      id: normalize(element.id, 180),
      placeholder: normalize(element.getAttribute('placeholder'), 180),
      ariaLabel: normalize(element.getAttribute('aria-label'), 180),
      ariaLabelledBy: normalize(element.getAttribute('aria-labelledby'), 180),
      nearbyTexts: context.nearbyTexts,
      precedingLabels: context.precedingLabels,
      followingLabels: context.followingLabels,
      groupHeading: context.groupHeading,
      recordIndex: context.recordIndex,
      formExcluded: Boolean(element.closest('nav,header,footer,[role="navigation"]')),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.classList.contains('disabled')),
      required: Boolean(element.required || element.getAttribute('aria-required') === 'true'),
      readOnly: Boolean(element.readOnly),
      autocomplete: normalize(element.getAttribute('autocomplete'), 80),
      valueLength: typeof element.value === 'string' ? element.value.length : undefined,
      valid: typeof element.checkValidity === 'function' ? element.checkValidity() : undefined,
      validationMessage: typeof element.validationMessage === 'string' ? normalize(element.validationMessage, 300) : undefined,
      checked: 'checked' in element ? Boolean(element.checked) : undefined,
      options: element instanceof HTMLSelectElement
        ? [...element.options].slice(0, 50).map((option) => ({ label: normalize(option.textContent, 120), value: normalize(option.value, 120), selected: option.selected }))
        : undefined,
      href,
    });
  }
  return {
    url: location.href,
    title: normalize(document.title, 300),
    items,
    truncated: items.length === ${MaxSnapshotElements},
  };
})()`;

const ReadExpression = `(() => {
  const text = String(document.body?.innerText || '');
  return {
    url: location.href,
    title: String(document.title || '').slice(0, 300),
    text: text.slice(0, ${MaxReadChars}),
    truncated: text.length > ${MaxReadChars},
  };
})()`;

/** 个人浏览器只使用固定原始 CDP 命令，不启用会暴露调试状态的页面域。 */
export class PersonalBrowserCdpRuntime implements PersonalBrowserRuntimePort {
  private readonly endpoint: string;
  private readonly preferredAnchorUrl?: string;
  private readonly now: () => number;
  private readonly delay: NonNullable<PersonalBrowserCdpRuntimeOptions['delay']>;
  private readonly webSocketFactory: NonNullable<PersonalBrowserCdpRuntimeOptions['webSocketFactory']>;
  private socket: BrowserSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingCommand>();
  private anchorUrl: string | null = null;
  private taskTargetId: string | null = null;
  private taskSessionId: string | null = null;
  private refs = new Map<string, ElementFingerprint>();
  private closing = false;

  constructor(options: PersonalBrowserCdpRuntimeOptions) {
    this.endpoint = options.endpoint;
    this.preferredAnchorUrl = options.anchorUrl;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((milliseconds, signal) => Delay(milliseconds, undefined, signal ? { signal } : undefined));
    this.webSocketFactory = options.webSocketFactory ?? ((url) => {
      const Constructor = globalThis.WebSocket as unknown as new (endpoint: string) => BrowserSocket;
      if (!Constructor) throw new PersonalBrowserCdpError('BROWSER_RUNTIME_UNAVAILABLE', 'The runtime does not provide a WebSocket client.');
      return new Constructor(url);
    });
    this.ValidateEndpoint();
  }

  private ValidateEndpoint(): void {
    let endpoint: URL;
    try { endpoint = new URL(this.endpoint); }
    catch { throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The personal-browser CDP endpoint is invalid.'); }
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !Number(endpoint.port)
      || !/^\/devtools\/browser(?:\/[a-zA-Z0-9-]+)?$/.test(endpoint.pathname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The personal-browser CDP endpoint is outside the allowed local browser boundary.');
    }
  }

  IsConnected(): boolean { return this.socket?.readyState === SocketOpen; }

  async Connect(options: PersonalBrowserCommandOptions = {}): Promise<{ anchorUrl: string }> {
    if (this.IsConnected() && this.anchorUrl) return { anchorUrl: this.anchorUrl };
    if (!this.IsConnected()) await this.OpenSocket(options);
    const targets = await this.GetTargets(options);
    const preferred = this.preferredAnchorUrl
      ? targets.find((target) => target.type === 'page' && target.url === this.preferredAnchorUrl)
      : undefined;
    const anchor = preferred ?? targets.find((target) => target.type === 'page' && IsBossUrl(target.url));
    if (!anchor || !IsBossUrl(anchor.url)) {
      throw new PersonalBrowserCdpError('BROWSER_BOSS_TAB_REQUIRED', 'The browser is connected, but no open BOSS tab was found. Open and sign in to zhipin.com, then try again.');
    }
    this.anchorUrl = anchor.url;
    return { anchorUrl: anchor.url };
  }

  private async OpenSocket(options: PersonalBrowserCommandOptions): Promise<void> {
    if (options.signal?.aborted) throw new PersonalBrowserCdpError('CANCELLED', 'Browser connection was cancelled.');
    this.closing = false;
    const timeoutMs = this.Timeout(options);
    await new Promise<void>((resolveConnection, rejectConnection) => {
      let settled = false;
      let socket: BrowserSocket;
      try { socket = this.webSocketFactory(this.endpoint); }
      catch (error) { rejectConnection(error); return; }
      this.socket = socket;
      const Finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', Abort);
        if (error) rejectConnection(error); else resolveConnection();
      };
      const Abort = () => {
        try { socket.close(); } catch {}
        Finish(new PersonalBrowserCdpError('CANCELLED', 'Browser connection was cancelled.'));
      };
      const timer = setTimeout(() => {
        try { socket.close(); } catch {}
        Finish(new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The selected browser did not authorize the debugging connection in time.'));
      }, timeoutMs);
      options.signal?.addEventListener('abort', Abort, { once: true });
      socket.addEventListener('open', () => Finish(), { once: true });
      socket.addEventListener('error', () => Finish(new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'The selected browser rejected the debugging connection.')), { once: true });
      socket.addEventListener('message', (event) => this.OnMessage(event));
      socket.addEventListener('close', (event) => this.OnClose(event));
    });
  }

  private OnMessage(event: { data?: unknown }): void {
    let message: any;
    try { message = JSON.parse(String(event.data ?? '')); }
    catch { return; }
    if (!Number.isSafeInteger(message?.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.abort) pending.abort();
    if (message.error) {
      pending.reject(new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', `${pending.method}: ${String(message.error.message ?? 'CDP command failed.').slice(0, 400)}`, pending.sideEffect));
    } else {
      pending.resolve(message.result && typeof message.result === 'object' ? message.result : {});
    }
  }

  private OnClose(event: { code?: number; reason?: string }): void {
    const intentional = this.closing;
    this.socket = null;
    this.anchorUrl = null;
    this.taskSessionId = null;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.abort) pending.abort();
      pending.reject(new PersonalBrowserCdpError(
        intentional ? 'CANCELLED' : 'BROWSER_COMMAND_FAILED',
        intentional ? 'Browser connection was closed.' : `The selected browser closed the debugging connection${event.code ? ` (${event.code})` : ''}.`,
        pending.sideEffect,
      ));
    }
  }

  private Timeout(options: PersonalBrowserCommandOptions): number {
    return Math.max(1, Math.min(DefaultTimeoutMs, (options.deadline ?? this.now() + DefaultTimeoutMs) - this.now()));
  }

  private async Pause(milliseconds: number, options: PersonalBrowserCommandOptions, statusUnknown = false): Promise<void> {
    try { await this.delay(milliseconds, options.signal); }
    catch {
      if (options.signal?.aborted) throw new PersonalBrowserCdpError('CANCELLED', 'Browser command was cancelled.', statusUnknown);
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'Browser action delay failed.', statusUnknown);
    }
  }

  private Send(method: string, params: Record<string, unknown>, sessionId: string | undefined, options: PersonalBrowserCommandOptions, sideEffect = false): Promise<Record<string, any>> {
    if (!AllowedMethods.has(method)) throw new PersonalBrowserCdpError('BROWSER_COMMAND_NOT_ALLOWED', `CDP method ${method} is not allowed.`);
    if (PageMethods.has(method) && !sessionId) throw new PersonalBrowserCdpError('BROWSER_COMMAND_NOT_ALLOWED', `${method} requires the bound BOSS task target.`);
    if (!this.socket || this.socket.readyState !== SocketOpen) throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'The personal-browser CDP connection is not open.', sideEffect);
    if (options.signal?.aborted) throw new PersonalBrowserCdpError('CANCELLED', 'Browser command was cancelled.', sideEffect);
    const id = ++this.nextId;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        options.signal?.removeEventListener('abort', Abort);
        rejectCommand(new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', `${method} timed out.`, sideEffect));
      }, this.Timeout(options));
      const Abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectCommand(new PersonalBrowserCdpError('CANCELLED', 'Browser command was cancelled.', sideEffect));
      };
      options.signal?.addEventListener('abort', Abort, { once: true });
      this.pending.set(id, {
        method,
        sideEffect,
        resolve: resolveCommand,
        reject: rejectCommand,
        timer,
        abort: options.signal ? () => options.signal?.removeEventListener('abort', Abort) : undefined,
      });
      try {
        this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', Abort);
        rejectCommand(new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', `${method} could not be sent.`, sideEffect));
      }
    });
  }

  private async GetTargets(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo[]> {
    const result = await this.Send('Target.getTargets', {}, undefined, options);
    return Array.isArray(result.targetInfos) ? result.targetInfos.filter((target: any) => target && typeof target.targetId === 'string') : [];
  }

  private async EnsureTaskTarget(initialUrl: string | undefined, options: PersonalBrowserCommandOptions): Promise<void> {
    if (!this.IsConnected()) await this.Connect(options);
    if (this.taskTargetId && this.taskSessionId) {
      try {
        await this.AssertTaskTarget(options);
        return;
      } catch (error) {
        if (!(error instanceof PersonalBrowserCdpError) || error.code !== 'BROWSER_TAB_NOT_FOUND') throw error;
        this.taskTargetId = null;
        this.taskSessionId = null;
      }
    }
    if (this.taskTargetId && !this.taskSessionId) {
      try {
        await this.AssertTaskTarget(options);
        const attached = await this.Send('Target.attachToTarget', { targetId: this.taskTargetId, flatten: true }, undefined, options);
        if (typeof attached.sessionId === 'string' && attached.sessionId) {
          this.taskSessionId = attached.sessionId;
          await this.Send('Target.activateTarget', { targetId: this.taskTargetId }, undefined, options);
          return;
        }
      } catch (error) {
        if (error instanceof PersonalBrowserCdpError && error.code === 'CANCELLED') throw error;
        // 原任务页已关闭或不可附着时，创建新的受控任务页。
      }
      this.taskTargetId = null;
      this.taskSessionId = null;
    }
    const destination = initialUrl ?? this.anchorUrl;
    if (!IsBossUrl(destination)) throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'A BOSS task tab can only be created from an allowed zhipin.com URL.');
    const created = await this.Send('Target.createTarget', { url: destination }, undefined, options);
    if (typeof created.targetId !== 'string' || !created.targetId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The selected browser did not create the BOSS task tab.');
    const attached = await this.Send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, undefined, options);
    if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The selected browser did not attach the BOSS task tab.');
    this.taskTargetId = created.targetId;
    this.taskSessionId = attached.sessionId;
    await this.Send('Target.activateTarget', { targetId: created.targetId }, undefined, options);
    await this.WaitForBossTarget(options);
    await this.WaitForBossDocument(options);
  }

  private async TargetInfo(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo> {
    if (!this.taskTargetId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The BOSS task target is unavailable.');
    let result: Record<string, any>;
    try { result = await this.Send('Target.getTargetInfo', { targetId: this.taskTargetId }, undefined, options); }
    catch (error) {
      if (error instanceof PersonalBrowserCdpError && error.code === 'BROWSER_COMMAND_FAILED') {
        throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'The BOSS task tab is no longer available.');
      }
      throw error;
    }
    const info = result.targetInfo as CdpTargetInfo | undefined;
    if (!info || typeof info.targetId !== 'string') throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'The BOSS task tab is no longer available.');
    return info;
  }

  private async AssertTaskTarget(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo> {
    const info = await this.TargetInfo(options);
    if (!IsBossUrl(info.url)) {
      throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'The personal-browser task tab left zhipin.com. Avery stopped before reading or interacting with it.');
    }
    return info;
  }

  private async WaitForBossTarget(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo> {
    let latest: CdpTargetInfo | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      latest = await this.TargetInfo(options);
      if (IsBossUrl(latest.url)) return latest;
      await this.Pause(100, options, true);
    }
    throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', `The task tab did not reach an allowed BOSS URL${latest?.url ? ` (${latest.url})` : ''}.`);
  }

  /** target URL 可能早于渲染文档提交更新；固定轮询真实 location，避免在 about:blank 上读取。 */
  private async WaitForBossDocument(options: PersonalBrowserCommandOptions, previousUrl?: string): Promise<{ url: string; readyState: string }> {
    const end = Math.min(options.deadline ?? this.now() + 15_000, this.now() + 15_000);
    let lastError: unknown;
    while (this.now() < end) {
      try {
        const value = this.Value(await this.Evaluate(`(() => ({ url: location.href, readyState: document.readyState }))()`, options));
        if (value && IsBossUrl(value.url) && value.readyState !== 'loading' && (!previousUrl || value.url !== previousUrl)) {
          return { url: value.url, readyState: String(value.readyState) };
        }
      } catch (error) {
        if (error instanceof PersonalBrowserCdpError && error.code === 'CANCELLED') throw error;
        lastError = error;
      }
      await this.Pause(100, options, true);
    }
    if (lastError instanceof PersonalBrowserCdpError && lastError.code === 'BROWSER_NAVIGATION_DENIED') throw lastError;
    throw new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The BOSS task document did not become ready in time.', true);
  }

  private async Evaluate(expression: string, options: PersonalBrowserCommandOptions, returnByValue = true, sideEffect = false): Promise<Record<string, any>> {
    await this.AssertTaskTarget(options);
    return this.Send('Runtime.evaluate', { expression, returnByValue }, this.taskSessionId ?? undefined, options, sideEffect);
  }

  private Value(result: Record<string, any>): any {
    if (result.exceptionDetails) throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'The fixed browser expression failed.');
    return result.result?.value;
  }

  private async Snapshot(options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const end = Math.min(options.deadline ?? this.now() + 10_000, this.now() + 10_000);
    let value: any;
    while (this.now() < end) {
      value = this.Value(await this.Evaluate(SnapshotExpression, options));
      if (!value || !IsBossUrl(value.url) || !Array.isArray(value.items)) {
        throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The BOSS semantic snapshot is invalid.');
      }
      if (value.items.length > 0) break;
      await this.Pause(100, options);
    }
    if (!value?.items?.length) throw new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The BOSS page did not expose interactive elements in time.');
    this.refs.clear();
    const refs: Record<string, Record<string, unknown>> = {};
    const lines: string[] = [];
    for (const [index, raw] of value.items.slice(0, MaxSnapshotElements).entries()) {
      if (!raw || typeof raw !== 'object' || typeof raw.selector !== 'string') continue;
      const ref = `e${index + 1}`;
      const fingerprint: ElementFingerprint = {
        selector: raw.selector,
        tag: String(raw.tag ?? ''),
        role: String(raw.role ?? ''),
        type: String(raw.type ?? ''),
        name: String(raw.name ?? ''),
      };
      this.refs.set(ref, fingerprint);
      refs[ref] = {
        tag: fingerprint.tag,
        role: fingerprint.role,
        name: fingerprint.name,
        ...(typeof raw.section === 'string' && raw.section ? { section: raw.section } : {}),
        ...(typeof raw.fieldName === 'string' && raw.fieldName ? { fieldName: raw.fieldName } : {}),
        ...(typeof raw.rawLabel === 'string' && raw.rawLabel ? { rawLabel: raw.rawLabel } : {}),
        ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
        ...(typeof raw.placeholder === 'string' && raw.placeholder ? { placeholder: raw.placeholder } : {}),
        ...(typeof raw.ariaLabel === 'string' && raw.ariaLabel ? { ariaLabel: raw.ariaLabel } : {}),
        ...(typeof raw.ariaLabelledBy === 'string' && raw.ariaLabelledBy ? { ariaLabelledBy: raw.ariaLabelledBy } : {}),
        ...(Array.isArray(raw.nearbyTexts) ? { nearbyTexts: raw.nearbyTexts.slice(0, 8) } : {}),
        ...(Array.isArray(raw.precedingLabels) ? { precedingLabels: raw.precedingLabels.slice(0, 4) } : {}),
        ...(Array.isArray(raw.followingLabels) ? { followingLabels: raw.followingLabels.slice(0, 4) } : {}),
        ...(typeof raw.groupHeading === 'string' && raw.groupHeading ? { groupHeading: raw.groupHeading } : {}),
        ...(Number.isSafeInteger(raw.recordIndex) ? { recordIndex: raw.recordIndex } : {}),
        type: fingerprint.type,
        disabled: raw.disabled === true,
        required: raw.required === true,
        readOnly: raw.readOnly === true,
        ...(typeof raw.autocomplete === 'string' && raw.autocomplete ? { autocomplete: raw.autocomplete } : {}),
        ...(Number.isSafeInteger(raw.valueLength) ? { valueLength: raw.valueLength } : {}),
        ...(typeof raw.valid === 'boolean' ? { valid: raw.valid } : {}),
        ...(typeof raw.validationMessage === 'string' && raw.validationMessage ? { validationMessage: raw.validationMessage } : {}),
        ...(typeof raw.checked === 'boolean' ? { checked: raw.checked } : {}),
        ...(raw.textTruncated === true ? { textTruncated: true } : {}),
        ...(Array.isArray(raw.options) ? { options: raw.options.slice(0, 50) } : {}),
        ...(IsBossUrl(raw.href) ? { href: raw.href } : {}),
      };
      const suffix = [fingerprint.type ? `type=${fingerprint.type}` : '', IsBossUrl(raw.href) ? `href=${raw.href}` : ''].filter(Boolean).join(' ');
      lines.push(`- ${fingerprint.role || fingerprint.tag} ${JSON.stringify(fingerprint.name)} [ref=${ref}]${suffix ? ` ${suffix}` : ''}`);
    }
    return {
      url: value.url,
      title: String(value.title ?? ''),
      snapshot: lines.join('\n').slice(0, MaxSnapshotChars),
      refs,
      partialTextTruncated: value.items.some((item: any) => item?.textTruncated === true),
      truncated: value.truncated === true || lines.join('\n').length > MaxSnapshotChars,
    };
  }

  private Ref(value: unknown): ElementFingerprint {
    const ref = RequireText(value, 'ref', 100).replace(/^@/, '');
    const locator = this.refs.get(ref);
    if (!locator) throw new PersonalBrowserCdpError('BROWSER_STALE_PAGE_REF', 'The browser element reference is unavailable. Take a new snapshot.');
    return locator;
  }

  private LocateExpression(locator: ElementFingerprint): string {
    return `(() => {
      const expected = ${SafeJson(locator)};
      const normalizedText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const normalize = (value, limit = 180) => normalizedText(value).slice(0, limit);
      const bossChatPage = (location.hostname === 'zhipin.com' || location.hostname.endsWith('.zhipin.com'))
        && location.pathname === '/web/geek/chat';
      const bossChatNameOf = (element) => {
        if (!bossChatPage) return '';
        if (element.matches(${JSON.stringify(BossChatPhraseControlSelector)})) return '常用语';
        if (element.matches(${JSON.stringify(BossChatImageInputSelector)})) return '发送图片';
        if (element.closest(${JSON.stringify(BossChatPhrasePanelSelector)})) {
          const fullPhrase = normalizedText(element.innerText || element.textContent);
          const phrase = fullPhrase.slice(0, ${BossChatPhraseTextLimit});
          if (phrase) return ${JSON.stringify(BossChatPhrasePrefix)} + phrase
            + (fullPhrase.length > ${BossChatPhraseTextLimit} ? ${JSON.stringify(BossChatPhraseTruncationMarker)} : '');
        }
        return '';
      };
      const nameOf = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        const labelledText = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
        const explicitLabel = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent : '';
        return bossChatNameOf(element) || normalize(element.getAttribute('aria-label') || labelledText || explicitLabel || element.closest('label')?.textContent
          || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.textContent);
      };
      const roleOf = (element) => {
        if (bossChatPage && element.matches(${JSON.stringify(BossChatPhraseControlSelector)})) return 'button';
        if (bossChatPage && element.matches(${JSON.stringify(BossChatImageInputSelector)})) return 'filechooser';
        if (bossChatPage && bossChatNameOf(element).startsWith(${JSON.stringify(BossChatPhrasePrefix)})) return 'button';
        const explicit = normalize(element.getAttribute('role'), 40).toLowerCase();
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'input') {
          const type = String(element.type || 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (['button', 'submit', 'reset'].includes(type)) return 'button';
          return type === 'search' ? 'searchbox' : 'textbox';
        }
        return element.isContentEditable ? 'textbox' : 'generic';
      };
      let element;
      try { element = document.querySelector(expected.selector); } catch { return { stale: true }; }
      if (!(element instanceof HTMLElement)) return { stale: true };
      const actual = {
        tag: element.tagName.toLowerCase(),
        role: roleOf(element),
        type: normalize(element.getAttribute('type'), 40).toLowerCase(),
        name: nameOf(element),
      };
      if (actual.tag !== expected.tag || actual.role !== expected.role || actual.type !== expected.type || actual.name !== expected.name) return { stale: true };
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0 || rect.width <= 0 || rect.height <= 0) return { stale: true };
      const left = Math.max(1, rect.left + 2);
      const right = Math.min(innerWidth - 1, rect.right - 2);
      const top = Math.max(1, rect.top + 2);
      const bottom = Math.min(innerHeight - 1, rect.bottom - 2);
      const points = [
        [(left + right) / 2, (top + bottom) / 2],
        [left + (right - left) * 0.25, (top + bottom) / 2],
        [left + (right - left) * 0.75, (top + bottom) / 2],
      ];
      const point = points.find(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || (hit instanceof Node && element.contains(hit));
      });
      return {
        stale: !point,
        x: point?.[0],
        y: point?.[1],
        tag: actual.tag,
        type: actual.type,
        checked: 'checked' in element ? Boolean(element.checked) : undefined,
        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.classList.contains('disabled')),
        contentEditable: element.isContentEditable,
      };
    })()`;
  }

  private async Locate(locator: ElementFingerprint, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const value = this.Value(await this.Evaluate(this.LocateExpression(locator), options));
    if (!value || value.stale === true || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
      throw new PersonalBrowserCdpError('BROWSER_STALE_PAGE_REF', 'The browser element changed or is no longer clickable. Take a new snapshot.');
    }
    if (value.disabled === true) throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The browser element is disabled.');
    return value;
  }

  private async ClickPoint(point: { x: number; y: number }, options: PersonalBrowserCommandOptions): Promise<void> {
    const sessionId = this.taskSessionId ?? undefined;
    // BOSS 在标签页失去激活状态时可能静默丢弃 CDP 鼠标事件，动作前重新激活专用任务页。
    if (this.taskTargetId) await this.Send('Target.activateTarget', { targetId: this.taskTargetId }, undefined, options);
    await this.Send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(point.x), y: Math.round(point.y), button: 'none', pointerType: 'mouse' }, sessionId, options);
    await this.Send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(point.x), y: Math.round(point.y), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, sessionId, options, true);
    await this.Pause(80, options, true);
    await this.Send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(point.x), y: Math.round(point.y), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, sessionId, options, true);
  }

  private async Click(ref: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const locator = this.Ref(ref);
    const point = await this.Locate(locator, options);
    await this.ClickPoint(point as { x: number; y: number }, options);
    return { clicked: true };
  }

  private async ClearFocused(options: PersonalBrowserCommandOptions): Promise<void> {
    const sessionId = this.taskSessionId ?? undefined;
    await this.Send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, sessionId, options, true);
    await this.Send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, sessionId, options, true);
    await this.Send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId, options, true);
    await this.Send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId, options, true);
  }

  private async InsertText(text: string, options: PersonalBrowserCommandOptions): Promise<void> {
    const chunks = text.length <= 120 ? [...text] : text.match(/[\s\S]{1,8}/g) ?? [];
    const waits = [37, 53, 41, 67];
    for (const [index, chunk] of chunks.entries()) {
      await this.Send('Input.insertText', { text: chunk }, this.taskSessionId ?? undefined, options, true);
      if (index < chunks.length - 1) await this.Pause(text.length <= 120 ? waits[index % waits.length] : 20, options, true);
    }
  }

  private async Fill(ref: unknown, text: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const value = RequireText(text, 'text');
    const locator = this.Ref(ref);
    const point = await this.Locate(locator, options);
    if (point.type === 'password') throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'Password inputs cannot be filled by the personal-browser driver.');
    if (!['input', 'textarea'].includes(point.tag) && point.contentEditable !== true) throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'BrowserFill requires a text input.');
    await this.ClickPoint(point as { x: number; y: number }, options);
    await this.ClearFocused(options);
    await this.InsertText(value, options);
    return { filled: true, textLength: value.length };
  }

  private async Select(ref: unknown, requested: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const locator = this.Ref(ref);
    await this.Locate(locator, options);
    const value = RequireText(requested, 'value', 2_000);
    const expression = `(() => {
      const expected = ${SafeJson(locator)};
      const requested = ${SafeJson(value)};
      let element;
      try { element = document.querySelector(expected.selector); } catch { return { stale: true }; }
      if (!(element instanceof HTMLSelectElement)) return { unsupported: true };
      const option = [...element.options].find((candidate) => candidate.value === requested || String(candidate.textContent || '').trim() === requested);
      if (!option) return { missing: true };
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: true };
    })()`;
    const result = this.Value(await this.Evaluate(expression, options, true, true));
    if (result?.stale) throw new PersonalBrowserCdpError('BROWSER_STALE_PAGE_REF', 'The select element is unavailable. Take a new snapshot.');
    if (result?.unsupported) throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'BrowserSelect only supports native select elements; use BrowserClick for custom dropdowns.');
    if (result?.missing) throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The requested select option is unavailable.');
    return { selected: true };
  }

  private async SetChecked(ref: unknown, checked: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    if (typeof checked !== 'boolean') throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'checked must be a boolean.');
    const locator = this.Ref(ref);
    const point = await this.Locate(locator, options);
    if (!['checkbox', 'radio'].includes(locator.role) && !['checkbox', 'radio'].includes(point.type)) {
      throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'BrowserSetChecked requires a checkbox or radio input.');
    }
    if (point.checked !== checked) await this.ClickPoint(point as { x: number; y: number }, options);
    return { checked };
  }

  private async PressKey(key: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const value = RequireText(key, 'key', 50);
    const keys: Record<string, { key: string; code: string; virtualKey: number; text?: string }> = {
      Enter: { key: 'Enter', code: 'Enter', virtualKey: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', virtualKey: 9, text: '\t' },
      Escape: { key: 'Escape', code: 'Escape', virtualKey: 27 },
      Space: { key: ' ', code: 'Space', virtualKey: 32, text: ' ' },
      PageDown: { key: 'PageDown', code: 'PageDown', virtualKey: 34 },
      PageUp: { key: 'PageUp', code: 'PageUp', virtualKey: 33 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', virtualKey: 40 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', virtualKey: 38 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKey: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', virtualKey: 39 },
      Home: { key: 'Home', code: 'Home', virtualKey: 36 },
      End: { key: 'End', code: 'End', virtualKey: 35 },
    };
    const mapped = keys[value];
    if (!mapped) throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The browser key is not allowed.');
    const params = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.virtualKey, nativeVirtualKeyCode: mapped.virtualKey, ...(mapped.text ? { text: mapped.text } : {}) };
    await this.Send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params }, this.taskSessionId ?? undefined, options, true);
    await this.Send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, this.taskSessionId ?? undefined, options, true);
    return { key: value };
  }

  private async Upload(ref: unknown, filePath: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const locator = this.Ref(ref);
    const path = RequireText(filePath, 'filePath', 4_000);
    const bossHiddenImageInput = locator.tag === 'input' && locator.type === 'file'
      && locator.role === 'filechooser' && locator.name === '发送图片';
    if (!bossHiddenImageInput) await this.Locate(locator, options);
    const expression = `(() => {
      const expected = ${SafeJson(locator)};
      let element;
      try { element = document.querySelector(expected.selector); } catch { return null; }
      if (!(element instanceof HTMLInputElement) || element.type !== 'file') return null;
      if (${JSON.stringify(bossHiddenImageInput)}) {
        const onBossChat = (location.hostname === 'zhipin.com' || location.hostname.endsWith('.zhipin.com'))
          && location.pathname === '/web/geek/chat';
        const control = element.closest(${JSON.stringify(BossChatImageControlSelector)});
        if (!onBossChat || !(control instanceof HTMLElement) || element.disabled) return null;
        const style = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0 || rect.width <= 0 || rect.height <= 0) return null;
      }
      return element;
    })()`;
    const evaluated = await this.Evaluate(expression, options, false);
    const objectId = evaluated.result?.objectId;
    if (typeof objectId !== 'string' || !objectId) throw new PersonalBrowserCdpError('BROWSER_STALE_PAGE_REF', 'The file input is unavailable. Take a new snapshot.');
    try {
      await this.Send('DOM.setFileInputFiles', { files: [path], objectId }, this.taskSessionId ?? undefined, options, true);
    } finally {
      await this.Send('Runtime.releaseObject', { objectId }, this.taskSessionId ?? undefined, options).catch(() => undefined);
    }
    return { uploaded: true };
  }

  private async Wait(kindValue: unknown, targetValue: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const kind = RequireText(kindValue, 'kind', 20);
    const value = RequireText(targetValue, 'value', 2_000);
    const end = Math.min(options.deadline ?? this.now() + 25_000, this.now() + 25_000);
    let previousFingerprint: string | undefined;
    let stableSince = 0;
    while (this.now() < end) {
      const expression = `(() => {
        const kind = ${SafeJson(kind)};
        const expected = ${SafeJson(value)};
        const text = String(document.body?.innerText || '');
        let matched = false;
        if (kind === 'selector') { try { matched = Boolean(document.querySelector(expected)); } catch { return { invalid: true }; } }
        else if (kind === 'text') matched = text.includes(expected);
        else if (kind === 'url') matched = location.href.includes(expected);
        else if (kind === 'load') matched = expected === 'domcontentloaded' ? document.readyState !== 'loading' : document.readyState === 'complete';
        let hash = 2166136261;
        const sample = text.slice(0, 100000);
        for (let index = 0; index < sample.length; index += 1) hash = Math.imul(hash ^ sample.charCodeAt(index), 16777619) >>> 0;
        return { matched, fingerprint: hash.toString(16), readyState: document.readyState };
      })()`;
      const result = this.Value(await this.Evaluate(expression, options));
      if (result?.invalid) throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The browser wait selector is invalid.');
      if (kind === 'load' && value === 'networkidle') {
        if (result?.readyState === 'complete' && result.fingerprint === previousFingerprint) {
          if (!stableSince) stableSince = this.now();
          if (this.now() - stableSince >= 500) return { matched: true, waitMode: 'dom_stable' };
        } else stableSince = 0;
        previousFingerprint = result?.fingerprint;
      } else if (result?.matched === true) return { matched: true };
      await this.Pause(100, options);
    }
    throw new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The browser wait condition timed out.');
  }

  private async Navigate(url: unknown, options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const destination = RequireText(url, 'url', 2_048);
    if (!IsBossUrl(destination)) throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'Personal-browser navigation is restricted to zhipin.com.');
    if (!this.taskTargetId || !this.taskSessionId) {
      await this.EnsureTaskTarget(destination, options);
    } else {
      let previousUrl: string;
      try { previousUrl = (await this.AssertTaskTarget(options)).url ?? '';
      } catch (error) {
        if (!(error instanceof PersonalBrowserCdpError) || error.code !== 'BROWSER_TAB_NOT_FOUND') throw error;
        this.taskTargetId = null;
        this.taskSessionId = null;
        await this.EnsureTaskTarget(destination, options);
        this.refs.clear();
        return { url: (await this.AssertTaskTarget(options)).url };
      }
      await this.Send('Page.navigate', { url: destination }, this.taskSessionId, options, true);
      await this.WaitForBossTarget(options);
      if (previousUrl !== destination) await this.WaitForBossDocument(options, previousUrl);
      else await this.WaitForBossDocument(options);
    }
    this.refs.clear();
    return { url: (await this.AssertTaskTarget(options)).url };
  }

  private async GoBack(options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const previousUrl = (await this.AssertTaskTarget(options)).url;
    const history = await this.Send('Page.getNavigationHistory', {}, this.taskSessionId ?? undefined, options);
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const currentIndex = Number(history.currentIndex);
    if (!Number.isInteger(currentIndex) || currentIndex <= 0 || !entries[currentIndex - 1]) {
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'The BOSS task tab has no previous history entry.');
    }
    const entry = entries[currentIndex - 1];
    if (!IsBossUrl(entry.url)) throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'BrowserGoBack would leave zhipin.com.');
    await this.Send('Page.navigateToHistoryEntry', { entryId: entry.id }, this.taskSessionId ?? undefined, options, true);
    this.refs.clear();
    await this.WaitForBossTarget(options);
    return { url: (await this.WaitForBossDocument(options, previousUrl)).url };
  }

  async Run(command: string[], options: PersonalBrowserCommandOptions & { stdin?: string } = {}): Promise<PersonalBrowserCommandResult> {
    await this.Connect(options);
    const [name, ...args] = command;
    if (name === 'open') return { success: true, data: await this.Navigate(args[0], options) };
    await this.EnsureTaskTarget(undefined, options);
    if (name === 'get' && args[0] === 'url') return { success: true, data: { url: (await this.AssertTaskTarget(options)).url } };
    if (name === 'snapshot') return { success: true, data: await this.Snapshot(options) };
    if (name === 'eval') {
      if (args.length !== 2 || args[0] !== '-b' || !/^[A-Za-z0-9+/]+={0,2}$/.test(args[1] ?? '')) {
        throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The Host browser expression is invalid.');
      }
      const encoded = args[1];
      if (encoded.length > 350_000) throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The Host browser expression is too large.');
      let expression: string;
      try {
        expression = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
      } catch {
        throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The Host browser expression is not valid UTF-8.');
      }
      if (!expression.trim() || Buffer.byteLength(expression, 'utf8') > 256_000) {
        throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The Host browser expression is invalid.');
      }
      return { success: true, data: { result: this.Value(await this.Evaluate(expression, options)) } };
    }
    if (name === 'read') {
      const value = this.Value(await this.Evaluate(ReadExpression, options));
      if (!value || !IsBossUrl(value.url)) throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The BOSS page read result is invalid.');
      return { success: true, data: value };
    }
    if (name === 'screenshot') {
      const path = RequireText(args[0], 'screenshotPath', 4_000);
      const result = await this.Send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, this.taskSessionId ?? undefined, options);
      if (typeof result.data !== 'string' || !result.data) throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The selected browser did not return screenshot data.');
      await writeFile(path, Buffer.from(result.data, 'base64'));
      return { success: true, data: { path } };
    }
    if (name === 'click') return { success: true, data: await this.Click(args[0], options) };
    if (name === 'fill') return { success: true, data: await this.Fill(args[0], args[1], options) };
    if (name === 'batch') {
      let commands: unknown;
      try { commands = JSON.parse(options.stdin ?? ''); }
      catch { throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'BrowserFillForm batch input is invalid.'); }
      if (!Array.isArray(commands) || commands.length < 1 || commands.length > 30
        || commands.some((item) => !Array.isArray(item) || !(
          (item.length === 3 && ['fill', 'select'].includes(String(item[0])))
          || (item.length === 2 && item[0] === 'check')
        ))) {
        throw new PersonalBrowserCdpError('BROWSER_COMMAND_NOT_ALLOWED', 'The personal-browser batch only accepts one to thirty Host-planned fill, select, or radio-check commands.');
      }
      for (const item of commands) await this.Locate(this.Ref(item[1]), options);
      for (const item of commands) {
        if (item[0] === 'fill') await this.Fill(item[1], item[2], options);
        else if (item[0] === 'select') await this.Select(item[1], item[2], options);
        else await this.SetChecked(item[1], true, options);
      }
      return { success: true, data: { results: commands.map(() => ({ success: true })) } };
    }
    if (name === 'select') return { success: true, data: await this.Select(args[0], args[1], options) };
    if (name === 'check' || name === 'uncheck') return { success: true, data: await this.SetChecked(args[0], name === 'check', options) };
    if (name === 'press') return { success: true, data: await this.PressKey(args[0], options) };
    if (name === 'upload') return { success: true, data: await this.Upload(args[0], args[1], options) };
    if (name === 'wait') {
      if (args[0] === '--text') return { success: true, data: await this.Wait('text', args[1], options) };
      if (args[0] === '--url') return { success: true, data: await this.Wait('url', args[1], options) };
      if (args[0] === '--load') return { success: true, data: await this.Wait('load', args[1], options) };
      return { success: true, data: await this.Wait('selector', args[0], options) };
    }
    if (name === 'tab') {
      if (args.length && args[0] !== 'task') throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'Only the dedicated BOSS task tab is registered in personal-browser mode.');
      if (args[0] === 'task') await this.Send('Target.activateTarget', { targetId: this.taskTargetId }, undefined, options);
      const info = await this.AssertTaskTarget(options);
      return { success: true, data: { tabs: [{ tabId: 'task', url: info.url, active: true }] } };
    }
    if (name === 'back') return { success: true, data: await this.GoBack(options) };
    throw new PersonalBrowserCdpError('BROWSER_COMMAND_NOT_ALLOWED', 'Browser command is not allowed in personal-browser mode.');
  }

  ResetReferences(): void { this.refs.clear(); }

  async Close(): Promise<void> {
    this.closing = true;
    this.refs.clear();
    this.taskTargetId = null;
    this.taskSessionId = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch {}
    }
  }
}
