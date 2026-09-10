#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const AllowedStages = new Set(['status', 'connection', 'create-target', 'task-tab-snapshot', 'attach', 'read', 'semantic-snapshot', 'screenshot', 'click-input', 'type-input', 'search', 'open-job', 'runtime-enable', 'guarded-read', 'navigate']);
const DefaultSeconds = 30;
const MaxSeconds = 120;
const ConnectionTimeoutMs = 60_000;

function Usage() {
  return [
    'Usage: node scripts/diagnose-boss-cdp.mjs <stage> [--seconds 30] [--url https://www.zhipin.com/... ]',
    '',
    'Stages:',
    '  status        只读取 DevToolsActivePort，不建立 CDP 连接',
    '  connection    只连接浏览器级 WebSocket，不附着页面',
    '  create-target 仅通过 Target.createTarget 新建一个 BOSS 标签页，不附着页面',
    '  task-tab-snapshot 创建专用 BOSS 标签页、仅附着该 target 并执行一次语义扫描',
    '  attach        只附着已打开的 BOSS 标签页，不启用页面 CDP 域',
    '  read          附着后执行一次 Runtime.evaluate，再等待观察',
    '  semantic-snapshot 附着后执行一次固定的只读交互元素扫描，不保存页面正文',
    '  screenshot    不执行 Page.enable，直接截取一次当前视口并仅校验 PNG 元数据',
    '  click-input   定位第一个可见文本输入框并用 Input 鼠标事件使其获得焦点',
    '  type-input    聚焦文本输入框后清空并逐字符输入测试关键词，不提交',
    '  search        输入测试关键词并点击搜索框附近的严格匹配搜索控件',
    '  open-job      点击第一个可见的 BOSS 岗位详情链接，不读取详情内容',
    '  runtime-enable 附着后仅执行一次 Runtime.enable，再等待观察',
    '  guarded-read  先拦截页面对调试端口的请求，再执行一次读取',
    '  navigate      使用一次 Page.navigate；URL 省略时导航到当前 BOSS URL',
    '',
    '测试前请关闭 Avery，打开并登录 BOSS，再开启 Chrome 远程调试。每个阶段使用全新 Chrome 会话。',
  ].join('\n');
}

function ParseArgs(argv) {
  const stage = argv[0];
  if (!stage || stage === '--help' || stage === '-h') return { help: true };
  if (!AllowedStages.has(stage)) throw new Error(`Unknown stage: ${stage}`);
  let seconds = DefaultSeconds;
  let url;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--seconds') seconds = Number(argv[++index]);
    else if (value === '--url') url = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MaxSeconds) {
    throw new Error(`--seconds must be an integer between 1 and ${MaxSeconds}.`);
  }
  if (url && !IsBossUrl(url)) throw new Error('--url must use https and the zhipin.com root domain or a subdomain.');
  return { stage, seconds, url };
}

function IsBossUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com'));
  } catch {
    return false;
  }
}

function SafeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '');
  }
}

function Delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function ReadEndpoint() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is unavailable.');
  const portFile = join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
  const [portLine, websocketPath] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(websocketPath || '')) {
    throw new Error('DevToolsActivePort is invalid or does not describe a Chrome approval-mode endpoint.');
  }
  return { port, portFile, websocketUrl: `ws://127.0.0.1:${port}${websocketPath}` };
}

class CdpConnection {
  constructor(websocketUrl) {
    this.websocketUrl = websocketUrl;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.onEvent = null;
  }

  async Connect() {
    await new Promise((resolveConnection, rejectConnection) => {
      const socket = new WebSocket(this.websocketUrl);
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.close();
        rejectConnection(new Error('Chrome did not authorize the CDP connection within 60 seconds.'));
      }, ConnectionTimeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveConnection();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectConnection(new Error('Chrome rejected or closed the CDP WebSocket connection.'));
      }, { once: true });
      socket.addEventListener('message', (event) => this.OnMessage(String(event.data)));
      socket.addEventListener('close', () => {
        for (const { reject, timer: pendingTimer } of this.pending.values()) {
          clearTimeout(pendingTimer);
          reject(new Error('CDP connection closed.'));
        }
        this.pending.clear();
      });
    });
  }

  OnMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message.id) {
      this.onEvent?.(message);
      return;
    }
    if (!this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || 'CDP command failed.'}`));
    else pending.resolve(message.result || {});
  }

  Send(method, params = {}, sessionId) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP WebSocket is not open.'));
    const id = ++this.nextId;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`${method} timed out.`));
      }, 10_000);
      this.pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  Close() {
    this.socket?.close();
  }
}

async function FindBossTarget(cdp) {
  const { targetInfos = [] } = await cdp.Send('Target.getTargets');
  return targetInfos.find((target) => target.type === 'page' && IsBossUrl(target.url));
}

async function Observe(cdp, targetId, seconds, record) {
  const observations = [];
  for (let elapsed = 0; elapsed <= seconds; elapsed += 1) {
    const { targetInfos = [] } = await cdp.Send('Target.getTargets');
    const target = targetInfos.find((candidate) => candidate.targetId === targetId);
    const observation = {
      elapsedSeconds: elapsed,
      present: Boolean(target),
      url: SafeUrl(target?.url),
      boss: IsBossUrl(target?.url),
    };
    const previous = observations.at(-1);
    if (!previous || previous.present !== observation.present || previous.url !== observation.url) {
      observations.push(observation);
      await record('target_changed', observation);
    }
    if (elapsed < seconds) await Delay(1_000);
  }
  return observations;
}

async function Main() {
  const options = ParseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(Usage());
    return;
  }

  const endpoint = await ReadEndpoint();
  if (options.stage === 'status') {
    console.log(JSON.stringify({ stage: options.stage, port: endpoint.port, endpointDiscovered: true, cdpConnectionAttempted: false }));
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDirectory = resolve('artifacts', 'boss-cdp-diagnostics', `${timestamp}-${options.stage}`);
  const eventPath = join(outputDirectory, 'events.jsonl');
  await mkdir(outputDirectory, { recursive: true });
  const record = async (event, detail = {}) => {
    const entry = { at: new Date().toISOString(), event, ...detail };
    await appendFile(eventPath, `${JSON.stringify(entry)}\n`, 'utf8');
    console.log(JSON.stringify(entry));
  };

  const summary = { stage: options.stage, seconds: options.seconds, port: endpoint.port, outputDirectory };
  const cdp = new CdpConnection(endpoint.websocketUrl);
  try {
    await record('connection_requested');
    await cdp.Connect();
    await record('connection_opened');
    const target = await FindBossTarget(cdp);
    if (!target) throw new Error('No open BOSS page target was found. Open and sign in to BOSS before running this stage.');
    summary.targetId = target.targetId;
    summary.initialUrl = SafeUrl(target.url);

    if (options.stage === 'connection') {
      summary.observations = await Observe(cdp, target.targetId, options.seconds, record);
    } else if (options.stage === 'create-target') {
      const destination = options.url || 'https://www.zhipin.com/web/geek/jobs';
      const created = await cdp.Send('Target.createTarget', { url: destination });
      if (typeof created.targetId !== 'string' || !created.targetId) throw new Error('Chrome did not return a targetId for the new BOSS tab.');
      summary.anchorTargetId = target.targetId;
      summary.targetId = created.targetId;
      summary.initialUrl = SafeUrl(destination);
      await record('target_created', { targetId: created.targetId, url: SafeUrl(destination) });
      summary.observations = await Observe(cdp, created.targetId, options.seconds, record);
    } else if (options.stage === 'task-tab-snapshot') {
      const destination = options.url || 'https://www.zhipin.com/web/geek/jobs';
      const created = await cdp.Send('Target.createTarget', { url: destination });
      if (typeof created.targetId !== 'string' || !created.targetId) throw new Error('Chrome did not return a targetId for the new BOSS task tab.');
      summary.anchorTargetId = target.targetId;
      summary.targetId = created.targetId;
      summary.initialUrl = SafeUrl(destination);
      await record('task_target_created', { targetId: created.targetId, url: SafeUrl(destination) });
      const attached = await cdp.Send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
      if (!attached.sessionId) throw new Error('Chrome did not return a sessionId for the BOSS task tab.');
      await record('task_target_attached', { targetId: created.targetId });
      await Delay(2_000);
      const result = await cdp.Send('Runtime.evaluate', {
        expression: `(() => {
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
              && rect.width > 0 && rect.height > 0;
          };
          const candidates = [...document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"]')];
          const visibleItems = candidates.filter((element) => element instanceof HTMLElement && visible(element)).slice(0, 300);
          const pageText = document.body?.innerText || '';
          return {
            url: location.href,
            readyState: document.readyState,
            itemCount: visibleItems.length,
            truncated: visibleItems.length === 300,
            risk: /访问过于频繁|操作过于频繁|请完成安全验证|检测到异常访问|账号(?:存在)?异常|账号访问受限/.test(pageText),
          };
        })()`,
        returnByValue: true,
      }, attached.sessionId);
      const value = result.result?.value || {};
      const taskTabSnapshot = {
        url: SafeUrl(value.url),
        readyState: String(value.readyState || ''),
        itemCount: Number(value.itemCount || 0),
        truncated: value.truncated === true,
        risk: value.risk === true,
      };
      if (!IsBossUrl(value.url) || taskTabSnapshot.itemCount < 1) throw new Error('The BOSS task tab did not produce a usable semantic snapshot.');
      await record('task_tab_snapshot_completed', taskTabSnapshot);
      summary.taskTabSnapshot = taskTabSnapshot;
      summary.observations = await Observe(cdp, created.targetId, options.seconds, record);
    } else {
      const { sessionId } = await cdp.Send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      if (!sessionId) throw new Error('Chrome did not return a page sessionId.');
      await record('target_attached', { targetId: target.targetId });
      let observationTargetId = target.targetId;

      if (options.stage === 'guarded-read') {
        cdp.onEvent = (message) => {
          if (message.method !== 'Fetch.requestPaused' || message.sessionId !== sessionId) return;
          void cdp.Send('Fetch.failRequest', {
            requestId: message.params?.requestId,
            errorReason: 'ConnectionRefused',
          }, sessionId).catch(() => undefined);
        };
        await cdp.Send('Fetch.enable', { patterns: [
          { urlPattern: `http://127.0.0.1:${endpoint.port}/*`, requestStage: 'Request' },
          { urlPattern: `http://localhost:${endpoint.port}/*`, requestStage: 'Request' },
        ] }, sessionId);
        await record('port_guard_enabled');
      }
      if (options.stage === 'read' || options.stage === 'guarded-read') {
        const result = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const text = (document.body?.innerText || '').slice(0, 50000);
            const risk = /访问过于频繁|操作过于频繁|请完成安全验证|检测到异常访问|账号(?:存在)?异常|账号访问受限/.test(text);
            return { url: location.href, readyState: document.readyState, risk };
          })()`,
          returnByValue: true,
        }, sessionId);
        const value = result.result?.value || {};
        await record('single_read_completed', { url: SafeUrl(value.url), readyState: value.readyState, risk: value.risk === true });
        summary.read = { url: SafeUrl(value.url), readyState: value.readyState, risk: value.risk === true };
      }
      if (options.stage === 'semantic-snapshot') {
        const startedAt = Date.now();
        const result = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const normalize = (value, limit = 160) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
            const visible = (element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
                && rect.width > 0 && rect.height > 0;
            };
            const nameOf = (element) => {
              const labelledBy = element.getAttribute('aria-labelledby');
              const labelledText = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
              const explicitLabel = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent : '';
              const wrappingLabel = element.closest('label')?.textContent || '';
              return normalize(element.getAttribute('aria-label') || labelledText || explicitLabel || wrappingLabel
                || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title')
                || element.textContent);
            };
            const roleOf = (element) => {
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
            const candidates = [...document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"]')];
            const items = [];
            for (let index = 0; index < candidates.length && items.length < 300; index += 1) {
              const element = candidates[index];
              if (!(element instanceof HTMLElement) || !visible(element)) continue;
              const rect = element.getBoundingClientRect();
              const href = element instanceof HTMLAnchorElement && element.href ? new URL(element.href, location.href) : null;
              items.push({
                index,
                tag: element.tagName.toLowerCase(),
                role: roleOf(element),
                name: nameOf(element),
                type: normalize(element.getAttribute('type'), 40).toLowerCase(),
                disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
                checked: 'checked' in element ? Boolean(element.checked) : undefined,
                href: href && (href.hostname === 'zhipin.com' || href.hostname.endsWith('.zhipin.com')) ? href.origin + href.pathname : undefined,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
              });
            }
            const roles = {};
            for (const item of items) roles[item.role] = (roles[item.role] || 0) + 1;
            const pageText = document.body?.innerText || '';
            return {
              url: location.href,
              readyState: document.readyState,
              itemCount: items.length,
              roles,
              truncated: candidates.length > items.length,
              risk: /访问过于频繁|操作过于频繁|请完成安全验证|检测到异常访问|账号(?:存在)?异常|账号访问受限/.test(pageText),
              items,
            };
          })()`,
          returnByValue: true,
        }, sessionId);
        const value = result.result?.value || {};
        const snapshot = {
          url: SafeUrl(value.url),
          readyState: value.readyState,
          itemCount: Number(value.itemCount || 0),
          roles: value.roles && typeof value.roles === 'object' ? value.roles : {},
          truncated: value.truncated === true,
          risk: value.risk === true,
          durationMs: Date.now() - startedAt,
        };
        await record('semantic_snapshot_completed', snapshot);
        summary.semanticSnapshot = snapshot;
      }
      if (options.stage === 'screenshot') {
        const startedAt = Date.now();
        const result = await cdp.Send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        }, sessionId);
        if (typeof result.data !== 'string' || !result.data) throw new Error('Page.captureScreenshot did not return image data.');
        const image = Buffer.from(result.data, 'base64');
        const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        const screenshot = {
          byteSize: image.length,
          validPng: image.length >= signature.length && signature.every((value, index) => image[index] === value),
          durationMs: Date.now() - startedAt,
        };
        if (!screenshot.validPng) throw new Error('Page.captureScreenshot returned invalid PNG data.');
        await record('screenshot_validated_and_discarded', screenshot);
        summary.screenshot = screenshot;
      }
      if (options.stage === 'click-input') {
        const located = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const candidates = [...document.querySelectorAll('input:not([type="hidden"]):not([type="password"]),textarea,[contenteditable="true"]')];
            const element = candidates.find((candidate) => {
              if (!(candidate instanceof HTMLElement)) return false;
              const style = getComputedStyle(candidate);
              const rect = candidate.getBoundingClientRect();
              return !candidate.disabled && style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
            });
            if (!element) return null;
            element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const rect = element.getBoundingClientRect();
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              tag: element.tagName.toLowerCase(),
              type: String(element.getAttribute('type') || '').toLowerCase(),
            };
          })()`,
          returnByValue: true,
        }, sessionId);
        const targetInput = located.result?.value;
        if (!targetInput || !Number.isFinite(targetInput.x) || !Number.isFinite(targetInput.y)) {
          throw new Error('No visible non-password text input was available.');
        }
        const point = { x: Math.round(targetInput.x), y: Math.round(targetInput.y) };
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
        await Delay(80);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
        const verified = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const element = document.activeElement;
            const focused = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable === true;
            const pageText = document.body?.innerText || '';
            return {
              focused,
              tag: element?.tagName?.toLowerCase() || '',
              type: element instanceof HTMLInputElement ? String(element.type || '').toLowerCase() : '',
              risk: /访问过于频繁|操作过于频繁|请完成安全验证|检测到异常访问|账号(?:存在)?异常|账号访问受限/.test(pageText),
            };
          })()`,
          returnByValue: true,
        }, sessionId);
        const clickInput = {
          tag: String(verified.result?.value?.tag || targetInput.tag || ''),
          type: String(verified.result?.value?.type || targetInput.type || ''),
          focused: verified.result?.value?.focused === true,
          risk: verified.result?.value?.risk === true,
        };
        if (!clickInput.focused) throw new Error('The text input did not receive focus after the mouse click.');
        await record('input_focused_by_mouse', clickInput);
        summary.clickInput = clickInput;
      }
      if (options.stage === 'type-input') {
        const testText = 'Java';
        const located = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const candidates = [...document.querySelectorAll('input:not([type="hidden"]):not([type="password"]),textarea,[contenteditable="true"]')];
            const element = candidates.find((candidate) => {
              if (!(candidate instanceof HTMLElement)) return false;
              const style = getComputedStyle(candidate);
              const rect = candidate.getBoundingClientRect();
              return !candidate.disabled && style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
            });
            if (!element) return null;
            element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`,
          returnByValue: true,
        }, sessionId);
        const targetInput = located.result?.value;
        if (!targetInput || !Number.isFinite(targetInput.x) || !Number.isFinite(targetInput.y)) {
          throw new Error('No visible non-password text input was available.');
        }
        const point = { x: Math.round(targetInput.x), y: Math.round(targetInput.y) };
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
        await Delay(80);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }, sessionId);

        await cdp.Send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, sessionId);
        await cdp.Send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, sessionId);
        await cdp.Send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId);
        await cdp.Send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId);
        const delays = [80, 95, 70, 85];
        for (let index = 0; index < testText.length; index += 1) {
          await cdp.Send('Input.insertText', { text: testText[index] }, sessionId);
          await Delay(delays[index]);
        }

        const verified = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const element = document.activeElement;
            const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.value
              : element?.isContentEditable ? element.textContent || '' : '';
            const pageText = document.body?.innerText || '';
            return {
              value,
              risk: /访问过于频繁|操作过于频繁|请完成安全验证|检测到异常访问|账号(?:存在)?异常|账号访问受限/.test(pageText),
            };
          })()`,
          returnByValue: true,
        }, sessionId);
        const value = String(verified.result?.value?.value || '');
        const typeInput = {
          expectedLength: testText.length,
          actualLength: value.length,
          matched: value === testText,
          risk: verified.result?.value?.risk === true,
        };
        if (!typeInput.matched) throw new Error('The input value did not match the inserted test text.');
        await record('input_text_inserted_without_submit', typeInput);
        summary.typeInput = typeInput;
      }
      if (options.stage === 'search') {
        const testText = 'Java';
        const locatedInput = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const candidates = [...document.querySelectorAll('input:not([type="hidden"]):not([type="password"]),textarea')];
            const element = candidates.find((candidate) => {
              const style = getComputedStyle(candidate);
              const rect = candidate.getBoundingClientRect();
              return !candidate.disabled && style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
            });
            if (!element) return null;
            element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`,
          returnByValue: true,
        }, sessionId);
        const input = locatedInput.result?.value;
        if (!input || !Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('No visible search input was available.');
        const inputPoint = { x: Math.round(input.x), y: Math.round(input.y) };
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...inputPoint }, sessionId);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mousePressed', ...inputPoint, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
        await Delay(80);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...inputPoint, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
        await cdp.Send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, sessionId);
        await cdp.Send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, sessionId);
        await cdp.Send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId);
        await cdp.Send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId);
        for (const [index, character] of [...testText].entries()) {
          await cdp.Send('Input.insertText', { text: character }, sessionId);
          await Delay([80, 95, 70, 85][index]);
        }

        const locatedButton = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const input = document.activeElement;
            if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return null;
            const inputRect = input.getBoundingClientRect();
            const visible = (element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
                && rect.width > 0 && rect.height > 0;
            };
            const matches = [...document.querySelectorAll('button,[role="button"],a,div,span')]
              .filter((element) => {
                if (!(element instanceof HTMLElement) || !visible(element)) return false;
                const text = String(element.innerText || element.textContent || '').replace(/\\s+/g, '').trim();
                if (!['搜索', '搜索职位', '搜职位'].includes(text)) return false;
                const rect = element.getBoundingClientRect();
                const verticalDistance = Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2));
                const horizontalDistance = Math.abs((rect.left + rect.width / 2) - (inputRect.left + inputRect.width / 2));
                return verticalDistance <= 100 && horizontalDistance <= 600;
              })
              .map((element) => {
                const rect = element.getBoundingClientRect();
                const semanticScore = element.tagName === 'BUTTON' || element.getAttribute('role') === 'button' ? 0 : 1;
                const distance = Math.abs((rect.left + rect.width / 2) - (inputRect.left + inputRect.width / 2));
                return { element, rect, semanticScore, distance };
              })
              .sort((left, right) => left.semanticScore - right.semanticScore || left.distance - right.distance);
            if (!matches.length) return null;
            const target = matches[0];
            return {
              x: target.rect.left + target.rect.width / 2,
              y: target.rect.top + target.rect.height / 2,
              tag: target.element.tagName.toLowerCase(),
              role: String(target.element.getAttribute('role') || ''),
            };
          })()`,
          returnByValue: true,
        }, sessionId);
        const button = locatedButton.result?.value;
        if (!button || !Number.isFinite(button.x) || !Number.isFinite(button.y)) throw new Error('A nearby strict-match search control was not found.');
        const buttonPoint = { x: Math.round(button.x), y: Math.round(button.y) };
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...buttonPoint }, sessionId);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mousePressed', ...buttonPoint, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
        await Delay(90);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...buttonPoint, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
        await Delay(3_000);

        const verified = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const pageText = document.body?.innerText || '';
            return {
              url: location.href,
              readyState: document.readyState,
              risk: /访问过于频繁|操作过于频繁|请完成安全验证|检测到异常访问|账号(?:存在)?异常|账号访问受限/.test(pageText),
            };
          })()`,
          returnByValue: true,
        }, sessionId);
        const search = {
          inputLength: testText.length,
          clickedTag: String(button.tag || ''),
          clickedRole: String(button.role || ''),
          url: SafeUrl(verified.result?.value?.url),
          readyState: String(verified.result?.value?.readyState || ''),
          risk: verified.result?.value?.risk === true,
        };
        await record('search_clicked', search);
        summary.search = search;
      }
      if (options.stage === 'open-job') {
        const beforeTargets = await cdp.Send('Target.getTargets');
        const beforeIds = new Set((beforeTargets.targetInfos || []).map((candidate) => candidate.targetId));
        const located = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const visible = (element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
                && rect.width > 0 && rect.height > 0;
            };
            const seen = new Set();
            const links = [...document.querySelectorAll('a[href]')].filter((candidate) => {
              if (!(candidate instanceof HTMLAnchorElement) || !visible(candidate)) return false;
              try {
                const url = new URL(candidate.href, location.href);
                if (!((url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com')) && /\\/job_detail\\//.test(url.pathname))) return false;
                const key = url.origin + url.pathname;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              } catch { return false; }
            });
            const link = links[1];
            if (!link) return null;
            link.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const rect = link.getBoundingClientRect();
            const url = new URL(link.href, location.href);
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
              return hit === link || (hit instanceof Node && link.contains(hit));
            });
            if (!point) return { href: url.href, hitVerified: false };
            const text = String(document.body?.innerText || '').slice(0, 100000);
            let hash = 2166136261;
            for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
            return {
              x: point[0],
              y: point[1],
              href: url.href,
              hitVerified: true,
              pageFingerprint: hash.toString(16),
            };
          })()`,
          returnByValue: true,
        }, sessionId);
        const jobLink = located.result?.value;
        if (!jobLink || jobLink.hitVerified !== true || !Number.isFinite(jobLink.x) || !Number.isFinite(jobLink.y) || !IsBossUrl(jobLink.href)) {
          throw new Error('No verified clickable point was available on the second BOSS job-detail link.');
        }
        const jobUrl = new URL(jobLink.href);
        if (!/\/job_detail\//.test(jobUrl.pathname)) throw new Error('The selected link was not a BOSS job-detail URL.');
        const point = { x: Math.round(jobLink.x), y: Math.round(jobLink.y) };
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
        await Delay(90);
        await cdp.Send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
        await Delay(3_000);

        const pageState = await cdp.Send('Runtime.evaluate', {
          expression: `(() => {
            const text = String(document.body?.innerText || '').slice(0, 100000);
            let hash = 2166136261;
            for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
            return {
              url: location.href,
              pageFingerprint: hash.toString(16),
              risk: /访问过于频繁|操作过于频繁|请完成安全验证|检测到异常访问|账号(?:存在)?异常|账号访问受限/.test(text),
            };
          })()`,
          returnByValue: true,
        }, sessionId);

        const afterTargets = await cdp.Send('Target.getTargets');
        const pages = (afterTargets.targetInfos || []).filter((candidate) => candidate.type === 'page' && IsBossUrl(candidate.url));
        const newDetail = pages.find((candidate) => !beforeIds.has(candidate.targetId) && /\/job_detail\//.test(new URL(candidate.url).pathname));
        const original = pages.find((candidate) => candidate.targetId === target.targetId);
        const sameDetail = original && /\/job_detail\//.test(new URL(original.url).pathname) ? original : undefined;
        const opened = newDetail || sameDetail || original;
        if (!opened) throw new Error('The BOSS page target disappeared after the job click.');
        const fingerprintChanged = pageState.result?.value?.pageFingerprint !== jobLink.pageFingerprint;
        if (!newDetail && !sameDetail && !fingerprintChanged) throw new Error('The verified job click produced no target, URL, or page-structure change.');
        observationTargetId = opened.targetId;
        const openJob = {
          disposition: newDetail ? 'new_tab' : sameDetail ? 'same_tab_navigation' : 'dynamic_panel',
          url: SafeUrl(opened.url),
          riskUrl: /\/web\/user\/safe|captcha|verify|security[-_]?check/i.test(opened.url),
          hitVerified: true,
          fingerprintChanged,
          riskText: pageState.result?.value?.risk === true,
        };
        await record('job_detail_opened', openJob);
        summary.openJob = openJob;
      }
      if (options.stage === 'runtime-enable') {
        await cdp.Send('Runtime.enable', {}, sessionId);
        await record('runtime_enabled');
      }
      if (options.stage === 'navigate') {
        const destination = options.url || target.url;
        await cdp.Send('Page.navigate', { url: destination }, sessionId);
        await record('single_navigation_sent', { url: SafeUrl(destination) });
      }
      summary.observations = await Observe(cdp, observationTargetId, options.seconds, record);
    }

    const last = summary.observations.at(-1);
    summary.finalUrl = last?.url || summary.initialUrl;
    summary.targetPresent = last?.present !== false;
    summary.leftBoss = last?.boss === false;
    summary.completed = true;
  } catch (error) {
    summary.completed = false;
    summary.error = error instanceof Error ? error.message : String(error);
    await record('failed', { message: summary.error });
    process.exitCode = 1;
  } finally {
    cdp.Close();
    await writeFile(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ summaryPath: join(outputDirectory, 'summary.json') }));
  }
}

Main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
