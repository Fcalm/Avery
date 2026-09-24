import { writeFile } from 'node:fs/promises';
import { setTimeout as Delay } from 'node:timers/promises';
import type { BrowserExtensionTargetInfo } from './browser-extension-bridge';

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
  send(data: string, options?: PersonalBrowserCommandOptions): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};

type CdpTargetInfo = BrowserExtensionTargetInfo;

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
  /** Extension-backed runtimes expose the task identity for close_task routing. */
  GetBrowserTaskId?(): string | undefined;
  Close(): Promise<void>;
}

export type PersonalBrowserCommandOptions = {
  signal?: AbortSignal;
  deadline?: number;
};

export interface PersonalBrowserCdpRuntimeOptions {
  endpoint: string;
  anchorUrl?: string;
  /** Present only for the extension transport; direct CDP keeps its legacy single-target behavior. */
  browserTaskId?: string;
  now?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  webSocketFactory?: (url: string, options?: PersonalBrowserCommandOptions) => BrowserSocket;
}

export class PersonalBrowserCdpError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusUnknown = false) {
    super(message);
    this.name = 'PersonalBrowserCdpError';
  }
}

function IsTaskWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
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

const SnapshotReadyStates = new Set(['loading', 'interactive', 'complete']);

// Runtime.evaluate 的语义快照不是通用 JSON 通道。保留 url/title/truncated
// 只是兼容旧扩展；除此之外不得把任意网页字段带入 Host 契约。
const SnapshotResultKeys = new Set(['readyState', 'items', 'url', 'title', 'truncated']);

// Runtime.evaluate 的 CDP 返回 envelope 只有这两个字段。不要把任意
// Runtime/扩展自定义字段透传到 SnapshotValue；新增协议字段必须先审计。
const RuntimeEvaluateResultKeys = new Set(['result', 'exceptionDetails']);

// CDP command response envelope 只允许 id + result/error；扩展 transport
// 的 statusUnknown 是 error 上明确审计过的兼容字段，其他字段一律拒绝。
const CdpResponseKeys = new Set(['id', 'result', 'error']);
const CdpErrorKeys = new Set(['code', 'message', 'data', 'statusUnknown']);
const TargetGetTargetsResultKeys = new Set(['targetInfos']);
const TargetInfoResultKeys = new Set(['targetInfo']);

// CDP Runtime.RemoteObject 的公开字段 allowlist。Snapshot 只接受
// returnByValue 的 object/value，但仍需拒绝 remote object 上混入的扩展字段。
const RemoteObjectKeys = new Set([
  'type', 'subtype', 'className', 'value', 'unserializableValue', 'description',
  'deepSerializedValue', 'objectId', 'preview', 'customPreview',
]);

function IsRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

type OwnData = { present: true; value: unknown } | { present: false };

/**
 * 读取不可信协议对象时只接受 own data descriptor，不触发 getter。
 * CDP 通常经 JSON.parse 到达，但扩展 socket 和测试 mock 也共用此边界，
 * getter 绝不能在这里变成浏览器副作用。
 */
function ReadOwnData(value: unknown, key: string): OwnData {
  if (!value || typeof value !== 'object') return { present: false };
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { return { present: false }; }
  if (!descriptor || !Object.getOwnPropertyDescriptor(descriptor, 'value')) return { present: false };
  return { present: true, value: descriptor.value };
}

function IsPlainRecord(value: unknown): value is Record<string, any> {
  if (!IsRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  } catch {
    return false;
  }
}

/** 只检查 data descriptor，并要求对象处于明确 allowlist 的 plain 原型边界。 */
function IsPlainDataRecord(value: unknown, allowedKeys: ReadonlySet<string>): value is Record<string, any> {
  if (!IsPlainRecord(value)) return false;
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.getOwnPropertyNames(value).every((key) => {
      if (!allowedKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && Object.getOwnPropertyDescriptor(descriptor, 'value'));
    });
  } catch {
    return false;
  }
}

const ArrayPrototype = Array.prototype;
const SnapshotOptionKeys = new Set(['label', 'value', 'selected']);

function IsArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
}

/** 数组也是协议容器：拒绝洞、任意原型和 accessor 元素。 */
function ReadOwnArrayValues(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== ArrayPrototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.getOwnPropertyDescriptor(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
    const length = lengthDescriptor.value as number;
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key !== 'length' && (!IsArrayIndexKey(key) || Number(key) >= length)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.getOwnPropertyDescriptor(descriptor, 'value')) return null;
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = ReadOwnData(value, String(index));
      if (!item.present) return null;
      values.push(item.value);
    }
    return values;
  } catch {
    return null;
  }
}

const SnapshotItemKeys = new Set([
  'selector', 'tag', 'role', 'type', 'name',
  'rawLabel', 'section', 'fieldName', 'id', 'placeholder', 'ariaLabel', 'ariaLabelledBy',
  'nearbyTexts', 'precedingLabels', 'followingLabels', 'groupHeading', 'recordIndex',
  'formExcluded', 'disabled', 'required', 'readOnly', 'autocomplete', 'valueLength',
  'valid', 'validationMessage', 'checked', 'options', 'href', 'textTruncated',
]);

function IsStringArray(value: unknown): value is string[] {
  const values = ReadOwnArrayValues(value);
  return values !== null && values.every((item) => typeof item === 'string');
}

function IsSnapshotOption(value: unknown): boolean {
  if (!IsPlainDataRecord(value, SnapshotOptionKeys)) return false;
  const label = ReadOwnData(value, 'label');
  const optionValue = ReadOwnData(value, 'value');
  const selected = ReadOwnData(value, 'selected');
  return label.present && typeof label.value === 'string'
    && optionValue.present && typeof optionValue.value === 'string'
    && selected.present && typeof selected.value === 'boolean';
}

function IsSnapshotOptions(value: unknown): boolean {
  const options = ReadOwnArrayValues(value);
  return options !== null && options.every((option) => IsSnapshotOption(option));
}

function CopyOwnDataRecord(value: Record<string, any>): Record<string, any> {
  const copy = Object.create(null) as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const field = ReadOwnData(value, key);
    if (field.present) copy[key] = field.value;
  }
  return copy;
}

function NormalizeSnapshotItem(value: Record<string, any>): Record<string, any> {
  const copy = CopyOwnDataRecord(value);
  for (const field of ['nearbyTexts', 'precedingLabels', 'followingLabels']) {
    const array = ReadOwnData(value, field);
    if (array.present && array.value !== undefined) copy[field] = ReadOwnArrayValues(array.value) ?? [];
  }
  const options = ReadOwnData(value, 'options');
  if (options.present && options.value !== undefined) {
    copy.options = (ReadOwnArrayValues(options.value) ?? []).map((option) => CopyOwnDataRecord(option as Record<string, any>));
  }
  return copy;
}

function IsSnapshotItem(value: unknown): value is Record<string, any> {
  if (!IsPlainDataRecord(value, SnapshotItemKeys)) return false;
  const required = ['selector', 'tag', 'role', 'type', 'name'].map((key) => [key, ReadOwnData(value, key)] as const);
  if (required.some(([, field]) => !field.present || typeof field.value !== 'string')) return false;
  const selector = ReadOwnData(value, 'selector');
  if (!selector.present || typeof selector.value !== 'string' || selector.value.length === 0) return false;
  const stringFields = ['rawLabel', 'section', 'fieldName', 'id', 'placeholder', 'ariaLabel', 'ariaLabelledBy', 'groupHeading', 'autocomplete', 'validationMessage', 'href'];
  if (stringFields.some((field) => {
    const valueField = ReadOwnData(value, field);
    return valueField.present && valueField.value !== undefined && typeof valueField.value !== 'string';
  })) return false;
  const arrayFields = ['nearbyTexts', 'precedingLabels', 'followingLabels'];
  if (arrayFields.some((field) => {
    const valueField = ReadOwnData(value, field);
    return valueField.present && valueField.value !== undefined && !IsStringArray(valueField.value);
  })) return false;
  const booleanFields = ['formExcluded', 'disabled', 'required', 'readOnly', 'valid', 'checked', 'textTruncated'];
  if (booleanFields.some((field) => {
    const valueField = ReadOwnData(value, field);
    return valueField.present && valueField.value !== undefined && typeof valueField.value !== 'boolean';
  })) return false;
  const recordIndex = ReadOwnData(value, 'recordIndex');
  if (recordIndex.present && recordIndex.value !== undefined
    && (!Number.isSafeInteger(recordIndex.value) || (recordIndex.value as number) < 0)) return false;
  const valueLength = ReadOwnData(value, 'valueLength');
  if (valueLength.present && valueLength.value !== undefined
    && (!Number.isSafeInteger(valueLength.value) || (valueLength.value as number) < 0)) return false;
  const options = ReadOwnData(value, 'options');
  return !options.present || options.value === undefined || IsSnapshotOptions(options.value);
}

const TargetInfoKeys = new Set([
  // Chrome DevTools Protocol Target.TargetInfo fields.
  'targetId', 'type', 'title', 'url', 'attached', 'canAccessOpener', 'openerId', 'openerFrameId', 'browserContextId', 'subtype',
  // Extension transport's raw tab identity fields.
  'tabId', 'windowId', 'openerTabId', 'active',
  // Fixture/bridge compatibility metadata; it is validated but never used as
  // the task identity or as a navigation fallback.
  'readyState',
]);

function IsTargetInfo(value: unknown, requireTabId = false): value is CdpTargetInfo {
  if (!IsPlainDataRecord(value, TargetInfoKeys)) return false;
  const targetId = ReadOwnData(value, 'targetId');
  if (!targetId.present || typeof targetId.value !== 'string' || targetId.value.length === 0) return false;
  const stringFields = ['type', 'title', 'url', 'openerId', 'openerFrameId', 'browserContextId', 'subtype', 'readyState'];
  if (stringFields.some((key) => {
    const field = ReadOwnData(value, key);
    return field.present && typeof field.value !== 'string';
  })) return false;
  const booleanFields = ['attached', 'active', 'canAccessOpener'];
  if (booleanFields.some((key) => {
    const field = ReadOwnData(value, key);
    return field.present && typeof field.value !== 'boolean';
  })) return false;
  const tabId = ReadOwnData(value, 'tabId');
  const windowId = ReadOwnData(value, 'windowId');
  const openerTabId = ReadOwnData(value, 'openerTabId');
  if (requireTabId && (!tabId.present || !Number.isSafeInteger(tabId.value) || (tabId.value as number) < 0
    || !windowId.present || !Number.isSafeInteger(windowId.value) || (windowId.value as number) < 0
    || !openerTabId.present || !(openerTabId.value === null
      || (Number.isSafeInteger(openerTabId.value) && (openerTabId.value as number) >= 0)))) return false;
  if (!requireTabId && tabId.present && (!Number.isSafeInteger(tabId.value) || (tabId.value as number) < 0)) return false;
  if (!requireTabId && windowId.present && (!Number.isSafeInteger(windowId.value) || (windowId.value as number) < 0)) return false;
  if (!requireTabId && openerTabId.present && !(openerTabId.value === null
    || (Number.isSafeInteger(openerTabId.value) && (openerTabId.value as number) >= 0))) return false;
  return true;
}

function NormalizeTargetInfo(value: CdpTargetInfo): CdpTargetInfo {
  const copy = Object.create(null) as CdpTargetInfo & Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const field = ReadOwnData(value, key);
    if (field.present) copy[key] = field.value;
  }
  return copy;
}

const SnapshotExpression = `(() => {
  const normalizedText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const normalize = (value, limit = 180) => normalizedText(value).slice(0, limit);
  // 表单检查器会把固定结构的字段特征包临时写入 aria-label。仅对此内部标记保留完整内容，
  // 普通页面文本仍按原上限裁剪，避免扩大 Snapshot 输出。
  const accessibleName = (value) => {
    const text = normalizedText(value);
    return text.startsWith('__avery_field__') ? text.slice(0, 4096) : text.slice(0, 180);
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const fileInputSurfaceOf = (element) => {
    if (element.tagName !== 'INPUT' || String(element.type || '').toLowerCase() !== 'file') return null;
    const explicitLabel = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]') : null;
    const candidates = [];
    if (explicitLabel instanceof HTMLElement) candidates.push(explicitLabel);
    let current = element.parentElement;
    for (let depth = 0; current && depth < 6 && current !== document.body && current !== document.documentElement; depth += 1) {
      candidates.push(current);
      current = current.parentElement;
    }
    return candidates.find((candidate) => {
      if (!(candidate instanceof HTMLElement) || !visible(candidate)) return false;
      const identity = normalizedText([
        candidate.id,
        typeof candidate.className === 'string' ? candidate.className : '',
        candidate.getAttribute('role'),
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('title'),
        candidate.innerText || candidate.textContent,
      ].join(' ')).slice(0, 600);
      return /(上传|简历|附件|文件|(?:^|[\\s_-])(?:upload|resume|attachment|file|dropzone)(?:$|[\\s_-]))/i.test(identity);
    }) || null;
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
    const fileInputSurface = fileInputSurfaceOf(element);
    return bossChatNameOf(element) || accessibleName(element.getAttribute('aria-label') || labelledText || explicitLabel || element.closest('label')?.textContent
      || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title')
      || fileInputSurface?.innerText || fileInputSurface?.textContent || element.textContent);
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
      if (type === 'file') return 'filechooser';
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
    while (current && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [];
      const index = Math.max(1, siblings.indexOf(current) + 1);
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      current = current.parentElement;
    }
    // 北森表单嵌套超过十层且各区块结构相似；局部路径会命中其他字段，必须锚定文档根。
    return current === document.documentElement ? ['html', ...parts].join(' > ') : '';
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
    const hiddenFileInputSurface = type === 'file' ? fileInputSurfaceOf(element) : null;
    if (!visible(element) && !bossHiddenImageInput && !hiddenFileInputSurface) continue;
    if (tag === 'input' && type === 'hidden') continue;
    let href;
    if (element instanceof HTMLAnchorElement && element.href) {
      try {
        const url = new URL(element.href, location.href);
        if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href.slice(0, 2000);
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
      ariaLabel: accessibleName(element.getAttribute('aria-label')),
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
    // A ready document is a valid read-only snapshot even when it has no
    // interactive controls.  Keep readiness in the semantic result so the
    // transport can distinguish that state from a page that is still loading.
    readyState: document.readyState,
    items,
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
  private readonly browserTaskId?: string;
  private readonly taskScoped: boolean;
  private readonly now: () => number;
  private readonly delay: NonNullable<PersonalBrowserCdpRuntimeOptions['delay']>;
  private readonly webSocketFactory: NonNullable<PersonalBrowserCdpRuntimeOptions['webSocketFactory']>;
  private socket: BrowserSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingCommand>();
  private anchorUrl: string | null = null;
  private taskTargetId: string | null = null;
  private taskSessionId: string | null = null;
  private taskTabs = new Map<string, CdpTargetInfo>();
  private refs = new Map<string, ElementFingerprint>();
  private closing = false;

  constructor(options: PersonalBrowserCdpRuntimeOptions) {
    this.endpoint = options.endpoint;
    this.preferredAnchorUrl = options.anchorUrl;
    this.browserTaskId = options.browserTaskId;
    this.taskScoped = Boolean(options.browserTaskId);
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

  GetBrowserTaskId(): string | undefined { return this.browserTaskId; }

  async Connect(options: PersonalBrowserCommandOptions = {}): Promise<{ anchorUrl: string }> {
    if (this.IsConnected() && this.anchorUrl) return { anchorUrl: this.anchorUrl };
    if (!this.IsConnected()) await this.OpenSocket(options);
    const targets = await this.GetTargets(options);
    const preferred = this.preferredAnchorUrl
      ? targets.find((target) => target.type === 'page' && target.url === this.preferredAnchorUrl)
      : undefined;
    const anchor = preferred ?? targets.find((target) => target.type === 'page' && IsTaskWebUrl(target.url));
    this.anchorUrl = anchor && IsTaskWebUrl(anchor.url) ? anchor.url : null;
    return { anchorUrl: this.anchorUrl ?? '' };
  }

  private async OpenSocket(options: PersonalBrowserCommandOptions): Promise<void> {
    if (options.signal?.aborted) throw new PersonalBrowserCdpError('CANCELLED', 'Browser connection was cancelled.');
    this.closing = false;
    const effectiveOptions = this.EffectiveOptions(options);
    if (this.now() >= (effectiveOptions.deadline ?? Number.POSITIVE_INFINITY)) {
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The personal-browser connection deadline has expired.');
    }
    const connectionController = new AbortController();
    const connectionSignal = effectiveOptions.signal
      ? AbortSignal.any([effectiveOptions.signal, connectionController.signal])
      : connectionController.signal;
    const connectionOptions = { ...effectiveOptions, signal: connectionSignal };
    const timeoutMs = this.Timeout(effectiveOptions);
    await new Promise<void>((resolveConnection, rejectConnection) => {
      let settled = false;
      let timedOut = false;
      let socket: BrowserSocket;
      try { socket = this.webSocketFactory(this.endpoint, connectionOptions); }
      catch (error) { rejectConnection(error); return; }
      this.socket = socket;
      const Finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connectionSignal.removeEventListener('abort', Abort);
        if (error) rejectConnection(error); else resolveConnection();
      };
      const Abort = () => {
        if (timedOut) return;
        try { socket.close(); } catch {}
        Finish(new PersonalBrowserCdpError('CANCELLED', 'Browser connection was cancelled.'));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        connectionController.abort();
        try { socket.close(); } catch {}
        Finish(new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The selected browser did not authorize the debugging connection in time.'));
      }, timeoutMs);
      connectionSignal.addEventListener('abort', Abort, { once: true });
      socket.addEventListener('open', () => Finish(), { once: true });
      socket.addEventListener('error', (event) => {
        const cause = event?.error;
        Finish(cause instanceof PersonalBrowserCdpError
          ? cause
          : new PersonalBrowserCdpError(
            typeof cause?.code === 'string' ? cause.code : 'BROWSER_COMMAND_FAILED',
            cause instanceof Error ? cause.message : 'The selected browser rejected the Avery extension connection.',
            cause?.statusUnknown === true,
          ));
      }, { once: true });
      socket.addEventListener('message', (event) => this.OnMessage(event));
      socket.addEventListener('close', (event) => this.OnClose(event));
    });
  }

  private OnMessage(event: { data?: unknown }): void {
    let message: any;
    try { message = JSON.parse(String(event.data ?? '')); }
    catch { return; }
    const idField = ReadOwnData(message, 'id');
    const hasOwnId = IsPlainRecord(message) && idField.present;
    const responseId = hasOwnId && Number.isSafeInteger(idField.value) ? idField.value as number : null;
    const candidatePending = responseId === null ? undefined : this.pending.get(responseId);
    const RejectInvalid = (reason: string) => {
      if (!candidatePending || responseId === null) return;
      this.pending.delete(responseId);
      clearTimeout(candidatePending.timer);
      candidatePending.abort?.();
      candidatePending.reject(new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', reason, candidatePending.sideEffect));
    };
    const resultField = ReadOwnData(message, 'result');
    const errorField = ReadOwnData(message, 'error');
    const hasResult = IsPlainRecord(message) && resultField.present;
    const hasError = IsPlainRecord(message) && errorField.present;
    const validError = !hasError || (IsPlainDataRecord(errorField.value, CdpErrorKeys)
      && (() => {
        const code = ReadOwnData(errorField.value, 'code');
        const errorMessage = ReadOwnData(errorField.value, 'message');
        const statusUnknown = ReadOwnData(errorField.value, 'statusUnknown');
        return (!code.present || typeof code.value === 'string' || Number.isSafeInteger(code.value))
          && (!errorMessage.present || typeof errorMessage.value === 'string')
          && (!statusUnknown.present || typeof statusUnknown.value === 'boolean');
      })());
    const validEnvelope = IsPlainDataRecord(message, CdpResponseKeys)
      && hasOwnId
      && hasResult !== hasError
      && (!hasResult || IsPlainRecord(resultField.value))
      && validError;
    if (!validEnvelope) {
      RejectInvalid('The CDP response envelope contains unknown or invalid fields.');
      return;
    }
    if (responseId === null) return;
    const resolvedPending = this.pending.get(responseId);
    if (!resolvedPending) return;
    this.pending.delete(responseId);
    clearTimeout(resolvedPending.timer);
    if (resolvedPending.abort) resolvedPending.abort();
    const pending = resolvedPending;
    if (hasError) {
      const error = (errorField.present ? errorField.value : {}) as Record<string, any>;
      const errorCode = ReadOwnData(error, 'code');
      const errorMessage = ReadOwnData(error, 'message');
      const statusUnknown = ReadOwnData(error, 'statusUnknown');
      const codeValue = errorCode.present ? errorCode.value : undefined;
      const messageValue = errorMessage.present ? errorMessage.value : undefined;
      const statusUnknownValue = statusUnknown.present ? statusUnknown.value : undefined;
      const code = typeof codeValue === 'string' && /^(BROWSER_|CANCELLED$)/.test(codeValue)
        ? codeValue
        : 'BROWSER_COMMAND_FAILED';
      pending.reject(new PersonalBrowserCdpError(code, `${pending.method}: ${String(messageValue ?? 'CDP command failed.').slice(0, 400)}`, statusUnknownValue === true || pending.sideEffect));
    } else {
      pending.resolve(resultField.present && resultField.value && typeof resultField.value === 'object' ? resultField.value as Record<string, any> : {});
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

  /** 每条 CDP 消息都必须把 Runtime 的本地最早截止时间传到实际传输层。 */
  private EffectiveOptions(options: PersonalBrowserCommandOptions): PersonalBrowserCommandOptions {
    const localDeadline = this.now() + DefaultTimeoutMs;
    const deadline = Math.min(options.deadline ?? localDeadline, localDeadline);
    return { ...options, deadline };
  }

  private async Pause(milliseconds: number, options: PersonalBrowserCommandOptions, statusUnknown = false): Promise<void> {
    try { await this.delay(milliseconds, options.signal); }
    catch {
      if (options.signal?.aborted) throw new PersonalBrowserCdpError('CANCELLED', 'Browser command was cancelled.', statusUnknown);
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'Browser action delay failed.', statusUnknown);
    }
  }

  private Send(method: string, params: Record<string, unknown>, sessionId: string | undefined, options: PersonalBrowserCommandOptions, sideEffect = false): Promise<Record<string, any>> {
    const effectiveOptions = this.EffectiveOptions(options);
    if (!AllowedMethods.has(method)) throw new PersonalBrowserCdpError('BROWSER_COMMAND_NOT_ALLOWED', `CDP method ${method} is not allowed.`);
    if (PageMethods.has(method) && !sessionId) throw new PersonalBrowserCdpError('BROWSER_COMMAND_NOT_ALLOWED', `${method} requires the bound Avery task target.`);
    if (!this.socket || this.socket.readyState !== SocketOpen) throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'The personal-browser CDP connection is not open.', sideEffect);
    if (effectiveOptions.signal?.aborted) throw new PersonalBrowserCdpError('CANCELLED', 'Browser command was cancelled.', sideEffect);
    if (this.now() >= (effectiveOptions.deadline ?? Number.POSITIVE_INFINITY)) {
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'Browser command expired before it was sent.', false);
    }
    const commandController = new AbortController();
    const transportSignal = effectiveOptions.signal
      ? AbortSignal.any([effectiveOptions.signal, commandController.signal])
      : commandController.signal;
    const transportOptions = { ...effectiveOptions, signal: transportSignal };
    const id = ++this.nextId;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        commandController.abort();
        effectiveOptions.signal?.removeEventListener('abort', Abort);
        rejectCommand(new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', `${method} timed out.`, sideEffect));
      }, this.Timeout(effectiveOptions));
      const Abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectCommand(new PersonalBrowserCdpError('CANCELLED', 'Browser command was cancelled.', sideEffect));
      };
      effectiveOptions.signal?.addEventListener('abort', Abort, { once: true });
      this.pending.set(id, {
        method,
        sideEffect,
        resolve: resolveCommand,
        reject: rejectCommand,
        timer,
        abort: () => {
          commandController.abort();
          effectiveOptions.signal?.removeEventListener('abort', Abort);
        },
      });
      try {
        // BrowserExtensionSocket 将这两个选项继续传给 Bridge；不能让 Runtime
        // 的取消/截止时间在 WebSocket 边界丢失，导致 Host 已返回后扩展仍执行命令。
        this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), transportOptions);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        commandController.abort();
        effectiveOptions.signal?.removeEventListener('abort', Abort);
        rejectCommand(new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', `${method} could not be sent.`, sideEffect));
      }
    });
  }

  private async GetTargets(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo[]> {
    const result = await this.Send('Target.getTargets', {}, undefined, options);
    if (!IsPlainDataRecord(result, TargetGetTargetsResultKeys)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser target list response contains unknown or invalid fields.');
    }
    const targetInfos = ReadOwnData(result, 'targetInfos');
    const targetValues = ReadOwnArrayValues(targetInfos.present ? targetInfos.value : undefined);
    if (targetValues === null) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser target list is invalid.');
    }
    // 扩展任务的 target identity 必须始终来自 Chrome tabs 原始字段。
    // 不再根据 targetId 形状猜测是否需要 raw 字段；猜测会让缺失
    // windowId/tabId 的恶意或损坏响应绕过 task-scoped 边界。
    const requireRawTabId = this.taskScoped;
    if (targetValues.some((target) => !IsTargetInfo(target, requireRawTabId))) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser target list contains an invalid raw target identity.');
    }
    const targets = targetValues.map((target) => NormalizeTargetInfo(target as CdpTargetInfo));
    if (this.taskScoped) this.taskTabs = new Map(targets.map((target) => [target.targetId, target]));
    return targets;
  }

  private async EnsureTaskTarget(initialUrl: string | undefined, options: PersonalBrowserCommandOptions): Promise<void> {
    if (!this.IsConnected()) await this.Connect(options);
    if (this.taskScoped) {
      // 扩展 worker 只返回本 browserTaskId 的 targets；重连后刷新列表即可恢复
      // parent/child 页面，而不会从浏览器全局 active tab 猜测身份。
      const targets = await this.GetTargets(options);
      if (this.taskTargetId) {
        const current = targets.find((target) => target.targetId === this.taskTargetId);
        if (current) {
          try {
            await this.AssertTaskTarget(options);
            if (this.taskSessionId) return;
            const attached = await this.Send('Target.attachToTarget', { targetId: current.targetId, flatten: true }, undefined, options);
            if (typeof attached.sessionId === 'string' && attached.sessionId) {
              this.taskSessionId = attached.sessionId;
              await this.Send('Target.activateTarget', { targetId: current.targetId }, undefined, options);
              return;
            }
          } catch (error) {
            if (error instanceof PersonalBrowserCdpError && error.code === 'CANCELLED') throw error;
          }
        }
        this.taskTargetId = null;
        this.taskSessionId = null;
      }
      const candidate = targets.find((target) => target.active === true)
        ?? targets.find((target) => target.type === 'page' && IsTaskWebUrl(target.url));
      if (candidate) {
        this.taskTargetId = candidate.targetId;
        this.taskSessionId = null;
        try {
          await this.AssertTaskTarget(options);
          const attached = await this.Send('Target.attachToTarget', { targetId: candidate.targetId, flatten: true }, undefined, options);
          if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The selected browser did not attach the Avery task tab.');
          this.taskSessionId = attached.sessionId;
          await this.Send('Target.activateTarget', { targetId: candidate.targetId }, undefined, options);
          return;
        } catch (error) {
          if (error instanceof PersonalBrowserCdpError && error.code === 'CANCELLED') throw error;
          this.taskTargetId = null;
          this.taskSessionId = null;
        }
      }
    }
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
    if (!IsTaskWebUrl(destination)) throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'An Avery task tab can only be created from an http/https URL without embedded credentials.');
    const created = await this.Send('Target.createTarget', { url: destination }, undefined, options);
    if (typeof created.targetId !== 'string' || !created.targetId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The selected browser did not create the Avery task tab.');
    const attached = await this.Send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, undefined, options);
    if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The selected browser did not attach the Avery task tab.');
    this.taskTargetId = created.targetId;
    this.taskSessionId = attached.sessionId;
    await this.Send('Target.activateTarget', { targetId: created.targetId }, undefined, options);
    await this.WaitForTaskTarget(options);
    await this.WaitForTaskDocument(options);
  }

  private async TargetInfo(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo> {
    if (!this.taskTargetId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The Avery task target is unavailable.');
    let result: Record<string, any>;
    try { result = await this.Send('Target.getTargetInfo', { targetId: this.taskTargetId }, undefined, options); }
    catch (error) {
      if (error instanceof PersonalBrowserCdpError && ['BROWSER_COMMAND_FAILED', 'BROWSER_TAB_NOT_FOUND'].includes(error.code)) {
        throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'The Avery task tab is no longer available.');
      }
      throw error;
    }
    if (!IsPlainDataRecord(result, TargetInfoResultKeys)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser target info response contains unknown or invalid fields.');
    }
    const targetInfo = ReadOwnData(result, 'targetInfo');
    const info = targetInfo.present ? targetInfo.value as CdpTargetInfo : undefined;
    if (!IsTargetInfo(info, this.taskScoped && Boolean(this.taskTargetId))) throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'The Avery task tab is no longer available.');
    return NormalizeTargetInfo(info);
  }

  private TabData(target: CdpTargetInfo, active = target.active === true): Record<string, unknown> {
    return {
      ...(Number.isSafeInteger(target.tabId) ? { tabId: target.tabId } : {}),
      targetId: target.targetId,
      ...(Number.isSafeInteger(target.windowId) ? { windowId: target.windowId } : {}),
      ...(target.openerTabId === null || Number.isSafeInteger(target.openerTabId) ? { openerTabId: target.openerTabId ?? null } : {}),
      ...(typeof target.url === 'string' ? { url: target.url } : {}),
      active,
    };
  }

  private async AssertTaskTarget(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo> {
    const info = await this.TargetInfo(options);
    if (!IsTaskWebUrl(info.url)) {
      throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'The personal-browser task tab left the allowed http/https boundary. Avery stopped before reading or interacting with it.');
    }
    return info;
  }

  private async WaitForTaskTarget(options: PersonalBrowserCommandOptions): Promise<CdpTargetInfo> {
    let latest: CdpTargetInfo | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      latest = await this.TargetInfo(options);
      if (IsTaskWebUrl(latest.url)) return latest;
      await this.Pause(100, options, true);
    }
    throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', `The task tab did not reach an allowed http/https URL${latest?.url ? ` (${latest.url})` : ''}.`);
  }

  /** target URL 可能早于渲染文档提交更新；固定轮询真实 location，避免在 about:blank 上读取。 */
  private async WaitForTaskDocument(options: PersonalBrowserCommandOptions, previousUrl?: string): Promise<{ url: string; readyState: string }> {
    const end = Math.min(options.deadline ?? this.now() + 15_000, this.now() + 15_000);
    let lastError: unknown;
    while (this.now() < end) {
      try {
        const value = this.Value(await this.Evaluate(`(() => ({ url: location.href, readyState: document.readyState }))()`, options));
        if (value && IsTaskWebUrl(value.url) && value.readyState !== 'loading' && (!previousUrl || value.url !== previousUrl)) {
          return { url: value.url, readyState: String(value.readyState) };
        }
      } catch (error) {
        if (error instanceof PersonalBrowserCdpError && error.code === 'CANCELLED') throw error;
        lastError = error;
      }
      await this.Pause(100, options, true);
    }
    if (lastError instanceof PersonalBrowserCdpError && lastError.code === 'BROWSER_NAVIGATION_DENIED') throw lastError;
    throw new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The Avery task document did not become ready in time.', true);
  }

  private async Evaluate(expression: string, options: PersonalBrowserCommandOptions, returnByValue = true, sideEffect = false, awaitPromise = false): Promise<Record<string, any>> {
    await this.AssertTaskTarget(options);
    return this.Send('Runtime.evaluate', {
      expression,
      returnByValue,
      ...(awaitPromise ? { awaitPromise: true } : {}),
    }, this.taskSessionId ?? undefined, options, sideEffect);
  }

  private Value(result: Record<string, any>): any {
    if (!IsPlainDataRecord(result, RuntimeEvaluateResultKeys)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'Runtime.evaluate returned an unknown or invalid response envelope.');
    }
    const exceptionDetails = ReadOwnData(result, 'exceptionDetails');
    if (exceptionDetails.present && exceptionDetails.value) throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'The fixed browser expression failed.');
    const remoteField = ReadOwnData(result, 'result');
    const remote = remoteField.present ? remoteField.value : undefined;
    const remoteType = ReadOwnData(remote, 'type');
    if (!remoteField.present || !IsPlainDataRecord(remote, RemoteObjectKeys)
      || !remoteType.present
      || typeof remoteType.value !== 'string') {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'Runtime.evaluate returned an unknown or invalid remote object.');
    }
    const remoteValue = ReadOwnData(remote, 'value');
    return remoteValue.present ? remoteValue.value : undefined;
  }

  private SnapshotValue(result: Record<string, any>): Record<string, any> {
    if (!IsPlainDataRecord(result, RuntimeEvaluateResultKeys)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'Runtime.evaluate returned an invalid response for the browser semantic snapshot.');
    }
    const exceptionDetails = ReadOwnData(result, 'exceptionDetails');
    if (exceptionDetails.present && exceptionDetails.value !== undefined && exceptionDetails.value !== null) {
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'Runtime.evaluate returned exceptionDetails for the browser semantic snapshot.');
    }
    const remoteField = ReadOwnData(result, 'result');
    const remote = remoteField.present ? remoteField.value : undefined;
    const remoteType = ReadOwnData(remote, 'type');
    const remoteValue = ReadOwnData(remote, 'value');
    if (!remoteField.present || !IsPlainDataRecord(remote, RemoteObjectKeys)
      || !remoteType.present || remoteType.value !== 'object' || !remoteValue.present) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'Runtime.evaluate did not return a value for the browser semantic snapshot.');
    }
    if (!IsPlainDataRecord(remoteValue.value, SnapshotResultKeys)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'Runtime.evaluate returned a non-object value for the browser semantic snapshot.');
    }
    const value = remoteValue.value as Record<string, any>;
    const readyState = ReadOwnData(value, 'readyState');
    const items = ReadOwnData(value, 'items');
    if (!readyState.present || typeof readyState.value !== 'string' || !SnapshotReadyStates.has(readyState.value)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser semantic snapshot has an invalid readyState.');
    }
    const itemValues = ReadOwnArrayValues(items.present ? items.value : undefined);
    if (itemValues === null || itemValues.some((item: unknown) => !IsSnapshotItem(item))) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser semantic snapshot has invalid items.');
    }
    if (itemValues.length > MaxSnapshotElements) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser semantic snapshot contains too many items.');
    }
    const url = ReadOwnData(value, 'url');
    if (url.present && url.value !== undefined && !IsTaskWebUrl(url.value)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser semantic snapshot has an invalid URL.');
    }
    const title = ReadOwnData(value, 'title');
    if (title.present && title.value !== undefined && typeof title.value !== 'string') {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser semantic snapshot has an invalid title.');
    }
    const truncated = ReadOwnData(value, 'truncated');
    if (truncated.present && truncated.value !== undefined && typeof truncated.value !== 'boolean') {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser semantic snapshot has an invalid truncated flag.');
    }
    // 返回全新的 data-only 对象，后续 Snapshot 格式化不能再看到传输层
    // 注入的 getter 或原型字段。
    const normalized = Object.create(null) as Record<string, any>;
    normalized.readyState = readyState.value;
    normalized.items = itemValues.map((item) => NormalizeSnapshotItem(item as Record<string, any>));
    if (url.present && url.value !== undefined) normalized.url = url.value;
    if (title.present && title.value !== undefined) normalized.title = title.value;
    if (truncated.present && truncated.value !== undefined) normalized.truncated = truncated.value;
    return normalized;
  }

  private async Snapshot(options: PersonalBrowserCommandOptions): Promise<Record<string, any>> {
    const end = Math.min(options.deadline ?? this.now() + 10_000, this.now() + 10_000);
    // 未提供调用方 deadline 时也必须把同一个十秒边界传给每条 Runtime.evaluate，
    // 否则单条传输默认 60 秒超时会把 loading 轮询变成无界等待。
    const snapshotOptions = { ...options, deadline: end };
    let value: any;
    for (let attempt = 0; attempt < 100 && this.now() < end; attempt += 1) {
      value = this.SnapshotValue(await this.Evaluate(SnapshotExpression, snapshotOptions));
      // A static document containing only headings/paragraphs has no refs,
      // but BrowserSnapshot must still return its URL/title.  Continue to
      // poll while the document is still loading, even if a partial DOM has
      // already exposed controls.  Interactive/complete pages, including an
      // interactive page with no refs, are valid successful snapshots.
      if (value.readyState !== 'loading') break;
      await this.Pause(100, snapshotOptions);
    }
    if (!value || value.readyState === 'loading') {
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'The task page did not become ready for a semantic snapshot in time.');
    }
    // 新扩展可只返回 readyState/items；URL/title 由已绑定任务 target 提供，
    // 避免把 Runtime.evaluate 的通用返回字段扩成未审计的页面对象。
    const target = (!IsTaskWebUrl(value.url) || typeof value.title !== 'string')
      ? await this.AssertTaskTarget(snapshotOptions)
      : undefined;
    const snapshotUrl = IsTaskWebUrl(value.url) ? value.url : target?.url;
    if (!IsTaskWebUrl(snapshotUrl)) {
      throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The browser semantic snapshot has no valid task URL.');
    }
    this.refs.clear();
    const refs: Record<string, Record<string, unknown>> = {};
    const lines: string[] = [];
    for (const [index, raw] of value.items.slice(0, MaxSnapshotElements).entries()) {
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
        ...(IsTaskWebUrl(raw.href) ? { href: raw.href } : {}),
      };
      const suffix = [fingerprint.type ? `type=${fingerprint.type}` : '', IsTaskWebUrl(raw.href) ? `href=${raw.href}` : ''].filter(Boolean).join(' ');
      lines.push(`- ${fingerprint.role || fingerprint.tag} ${JSON.stringify(fingerprint.name)} [ref=${ref}]${suffix ? ` ${suffix}` : ''}`);
    }
    return {
      url: snapshotUrl,
      title: String(value.title ?? target?.title ?? ''),
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
      const accessibleName = (value) => {
        const text = normalizedText(value);
        return text.startsWith('__avery_field__') ? text.slice(0, 4096) : text.slice(0, 180);
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
        return bossChatNameOf(element) || accessibleName(element.getAttribute('aria-label') || labelledText || explicitLabel || element.closest('label')?.textContent
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
      // BrowserInspectForm 在快照后会清理临时字段特征包；这类 ref 依靠唯一 DOM 路径与稳定控件类型重定位。
      // 普通 Snapshot 仍校验可访问名称，避免页面更新后误操作同路径下的新元素。
      const temporaryFormName = String(expected.name || '').startsWith('__avery_field__');
      if (actual.tag !== expected.tag || actual.type !== expected.type
        || (!temporaryFormName && (actual.role !== expected.role || actual.name !== expected.name))) return { stale: true };
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
    if (point.tag === 'input' && point.type === 'date') {
      const expression = `(() => {
        const expected = ${SafeJson(locator)};
        const requested = ${SafeJson(value)};
        let element;
        try { element = document.querySelector(expected.selector); } catch { return { stale: true }; }
        if (!(element instanceof HTMLInputElement) || element.type !== 'date') return { stale: true };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return { unsupported: true };
        setter.call(element, requested);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: element.value === requested, value: element.value };
      })()`;
      const result = this.Value(await this.Evaluate(expression, options, true, true));
      if (result?.stale) throw new PersonalBrowserCdpError('BROWSER_STALE_PAGE_REF', 'The browser date input changed. Take a new snapshot.');
      if (result?.unsupported || result?.filled !== true) {
        throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The browser rejected the requested date value.');
      }
      return { filled: true, textLength: value.length };
    }
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
    const snapshotFileInput = locator.tag === 'input' && locator.type === 'file' && locator.role === 'filechooser';
    if (!snapshotFileInput) await this.Locate(locator, options);
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
      } else if (${JSON.stringify(snapshotFileInput)}) {
        if (element.disabled) return null;
        const visible = (candidate) => {
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
            && rect.width > 0 && rect.height > 0;
        };
        if (!visible(element)) {
          const normalizedText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const explicitLabel = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]') : null;
          const surfaces = [];
          if (explicitLabel instanceof HTMLElement) surfaces.push(explicitLabel);
          let current = element.parentElement;
          for (let depth = 0; current && depth < 6 && current !== document.body && current !== document.documentElement; depth += 1) {
            surfaces.push(current);
            current = current.parentElement;
          }
          const hasVisibleUploadSurface = surfaces.some((candidate) => {
            if (!(candidate instanceof HTMLElement) || !visible(candidate)) return false;
            const identity = normalizedText([
              candidate.id,
              typeof candidate.className === 'string' ? candidate.className : '',
              candidate.getAttribute('role'),
              candidate.getAttribute('aria-label'),
              candidate.getAttribute('title'),
              candidate.innerText || candidate.textContent,
            ].join(' ')).slice(0, 600);
            return /(上传|简历|附件|文件|(?:^|[\\s_-])(?:upload|resume|attachment|file|dropzone)(?:$|[\\s_-]))/i.test(identity);
          });
          if (!hasVisibleUploadSurface) return null;
        }
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
    if (!IsTaskWebUrl(destination)) throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'Personal-browser navigation only accepts http/https URLs without embedded credentials.');
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
      await this.WaitForTaskTarget(options);
      if (previousUrl !== destination) await this.WaitForTaskDocument(options, previousUrl);
      else await this.WaitForTaskDocument(options);
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
      throw new PersonalBrowserCdpError('BROWSER_COMMAND_FAILED', 'The Avery task tab has no previous history entry.');
    }
    const entry = entries[currentIndex - 1];
    if (!IsTaskWebUrl(entry.url)) throw new PersonalBrowserCdpError('BROWSER_NAVIGATION_DENIED', 'BrowserGoBack would leave the allowed http/https boundary.');
    await this.Send('Page.navigateToHistoryEntry', { entryId: entry.id }, this.taskSessionId ?? undefined, options, true);
    this.refs.clear();
    await this.WaitForTaskTarget(options);
    return { url: (await this.WaitForTaskDocument(options, previousUrl)).url };
  }

  async Run(command: string[], options: PersonalBrowserCommandOptions & { stdin?: string } = {}): Promise<PersonalBrowserCommandResult> {
    await this.Connect(options);
    const [name, ...args] = command;
    if (name === 'tab') {
      if (!this.taskScoped) {
        if (!args.length) {
          // 无参 tab 只是读取当前专用任务页；不能为了补充列表重新附着/激活，
          // 否则上层 Snapshot 刚写入的 refs 会在同一只读操作中被清空。
          if (!this.taskTargetId) return { success: true, data: { tabs: [] } };
          const targets = await this.GetTargets(options);
          const target = targets.find((candidate) => candidate.targetId === this.taskTargetId);
          return {
            success: true,
            data: {
              tabs: target ? [{
                tabId: 'task', targetId: target.targetId,
                ...(Number.isSafeInteger(target.windowId) ? { windowId: target.windowId } : {}),
                ...(Number.isSafeInteger(target.openerTabId) ? { openerTabId: target.openerTabId } : {}),
                ...(typeof target.url === 'string' ? { url: target.url } : {}), active: target.active === true,
              }] : [],
            },
          };
        }
        if (args[0] !== 'task') throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'Only the dedicated Avery task tab is registered in personal-browser mode.');
        if (!this.taskTargetId) throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'The dedicated Avery task tab is not registered in this session.');
        await this.AssertTaskTarget(options);
        if (!this.taskSessionId) {
          const attached = await this.Send('Target.attachToTarget', { targetId: this.taskTargetId, flatten: true }, undefined, options);
          if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The selected browser did not attach the Avery task tab.');
          this.taskSessionId = attached.sessionId;
        }
        await this.Send('Target.activateTarget', { targetId: this.taskTargetId }, undefined, options);
        this.refs.clear();
        const info = await this.AssertTaskTarget(options);
        return { success: true, data: { tabs: [{ tabId: 'task', targetId: info.targetId, url: info.url, active: true }] } };
      }
      const targets = await this.GetTargets(options);
      if (!args.length) {
        // 这是 Snapshot 后的只读补充查询：保持 taskTargetId、taskSessionId 和 refs
        // 原样，且只返回扩展按 browserTaskId 过滤后的任务标签页。
        return { success: true, data: { tabs: targets.map((target) => this.TabData(target)) } };
      }
      const requestedId = String(args[0]);
      const selectedTarget = targets.find((target) => Number.isSafeInteger(target.tabId) && String(target.tabId) === requestedId);
      if (!selectedTarget) throw new PersonalBrowserCdpError('BROWSER_TAB_NOT_FOUND', 'The browser tab is not registered in this task.');
      const selectedId = selectedTarget.targetId;
      this.taskTargetId = selectedId;
      this.taskSessionId = null;
      const attached = await this.Send('Target.attachToTarget', { targetId: selectedId, flatten: true }, undefined, options);
      if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw new PersonalBrowserCdpError('BROWSER_START_FAILED', 'The selected browser did not attach the Avery task tab.');
      this.taskSessionId = attached.sessionId;
      await this.Send('Target.activateTarget', { targetId: selectedId }, undefined, options);
      this.refs.clear();
      return { success: true, data: { tabs: targets.map((target) => this.TabData(target, target.targetId === selectedId)) } };
    }
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
      return { success: true, data: { result: this.Value(await this.Evaluate(expression, options, true, false, true)) } };
    }
    if (name === 'read') {
      const value = this.Value(await this.Evaluate(ReadExpression, options));
      if (!value || !IsTaskWebUrl(value.url)) throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The task page read result is invalid.');
      return { success: true, data: value };
    }
    if (name === 'screenshot') {
      const path = RequireText(args[0], 'screenshotPath', 4_000);
      const result = await this.Send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, this.taskSessionId ?? undefined, options);
      if (typeof result.data !== 'string' || !result.data) throw new PersonalBrowserCdpError('BROWSER_OUTPUT_INVALID', 'The selected browser did not return screenshot data.');
      await writeFile(path, Buffer.from(result.data, 'base64'));
      return { success: true, data: { path } };
    }
    if (name === 'scrollintoview') {
      await this.Locate(this.Ref(args[0]), options);
      return { success: true, data: { scrolled: true } };
    }
    if (name === 'scroll') {
      const direction = args[0];
      const distance = Number(args[1]);
      if (!['up', 'down'].includes(direction) || !Number.isFinite(distance) || distance < 1 || distance > 4_000) {
        throw new PersonalBrowserCdpError('BROWSER_ARGUMENT_INVALID', 'The browser scroll command is invalid.');
      }
      const delta = Math.round(distance) * (direction === 'up' ? -1 : 1);
      this.Value(await this.Evaluate(`(() => { window.scrollBy(0, ${delta}); return { scrolled: true }; })()`, options, true, true));
      return { success: true, data: { scrolled: true } };
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
    if (name === 'back') return { success: true, data: await this.GoBack(options) };
    throw new PersonalBrowserCdpError('BROWSER_COMMAND_NOT_ALLOWED', 'Browser command is not allowed in personal-browser mode.');
  }

  ResetReferences(): void { this.refs.clear(); }

  async Close(): Promise<void> {
    this.closing = true;
    this.refs.clear();
    this.taskTargetId = null;
    this.taskSessionId = null;
    this.taskTabs.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch {}
    }
  }
}
