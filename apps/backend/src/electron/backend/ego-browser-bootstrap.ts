/**
 * 固定的 ego 原生桥接脚本，在 ego 内置 Node 中执行，不加载 Skill 或执行模型脚本。
 * 本函数会序列化给 CLI，所有依赖必须在函数内获取，不得引用外部运行时变量。
 */
export async function EgoBrowserBootstrap(config: {
  port: number;
  token: string;
  name: string;
  closeTabs?: boolean;
  recoverable?: boolean;
  resume?: { id: number; targetId?: string; ownedTargetIds?: string[] };
  userApproved?: boolean;
}): Promise<void> {
  const { connect } = await import('node:net');
  const { createInterface } = await import('node:readline');
  type NativeResult = { error?: string; error_code?: string; [key: string]: unknown };
  type NativeTab = { targetId: string; title?: string; url?: string; active?: boolean };
  const native = (globalThis as unknown as { ego: {
    createTaskSpace(name: string): Promise<NativeResult>;
    useTaskSpace(id: number): Promise<unknown>;
    listTabs(): Promise<NativeResult & { tabs: NativeTab[] }>;
    listTaskSpaces(): Promise<NativeResult & { taskSpaces: Array<{ id: number; name?: string; ownership?: string }> }>;
    handOffTaskSpace(): Promise<unknown>;
    takeOverTaskSpace(): Promise<unknown>;
    claimTaskSpace(id: number): Promise<unknown>;
    createTab(url: string): Promise<NativeResult & { targetId: string }>;
    closeTaskSpace(): Promise<unknown>;
    completeTaskSpace(): Promise<unknown>;
    sendCDPMessage(data: string): void;
    onCDPMessage?: (data: string) => void;
    onSendCDPMessageError?: (message: string, code?: string) => void;
  } }).ego;
  const socket = connect({ host: '127.0.0.1', port: config.port });
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const send = (value: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  const check = <T>(value: T): T => {
    const result = value as NativeResult | null;
    if (result && typeof result === 'object' && result.error) {
      throw Object.assign(new Error(result.error), { code: result.error_code });
    }
    return value;
  };
  const codeOf = (error: unknown) => {
    const code = String((error as { code?: string })?.code ?? '');
    if (code === 'BROWSER_COMMAND_TIMEOUT' || code === 'BROWSER_TAB_NOT_FOUND') return code;
    return /USER_IN_CONTROL/.test(code) ? 'BROWSER_VISIBLE_USER_ACTION_REQUIRED'
      : /NOT_FOUND|NOT_EXIST/.test(code) ? 'BROWSER_TASK_RETIRED' : 'BROWSER_COMMAND_FAILED';
  };
  let spaceId: number | undefined;
  let nextNativeId = 0;
  const sessions = new Map<string, string>();
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const raw = (method: string, params: Record<string, unknown>, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextNativeId;
    // 截图没有网页副作用。先于工具层的截止时间释放串行桥接，避免截图回包缺失时阻塞页面读取和清理。
    const screenshot = method === 'Page.captureScreenshot';
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error(screenshot ? 'ego did not return a native screenshot response.' : 'ego CDP command timed out.');
      reject(screenshot ? Object.assign(error, { code: 'BROWSER_COMMAND_TIMEOUT' }) : error);
    }, screenshot ? 8_000 : 60_000);
    pending.set(id, { resolve, reject, timer });
    try { native.sendCDPMessage(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
  });
  native.onCDPMessage = (payload) => {
    const message = JSON.parse(payload) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    if (typeof message.id !== 'number') return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? 'ego CDP command failed.'));
    else request.resolve(message.result ?? {});
  };
  native.onSendCDPMessageError = (message, code) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Object.assign(new Error(message), { code })); }
    pending.clear();
  };
  // 与 PersonalBrowserCdpRuntime 保持同一窄协议；禁止 Browser.*、任意目标和其他 CDP 扩权。
  const pageMethods = new Set(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Page.navigate', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry', 'Page.captureScreenshot',
    'Runtime.evaluate', 'Runtime.releaseObject', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'DOM.setFileInputFiles']);
  let retiredSpace = false;
  let ready = false;
  let lastTargetId = config.resume?.targetId;
  const ownedTargets = new Set(config.resume?.ownedTargetIds ?? []);
  const findSpace = async () => check(await native.listTaskSpaces()).taskSpaces.find((space) => space.id === spaceId);
  const detach = async () => {
    // 释放调试会话后用户才能在原窗口接管，超时仍由宿主核对所有权。
    for (const sessionId of sessions.keys()) await raw('Target.detachFromTarget', { sessionId });
    sessions.clear();
  };
  let closeTabs = config.closeTabs !== false;
  const select = async (requireAgent = true) => {
    if (spaceId === undefined || retiredSpace) throw Object.assign(new Error('The Avery ego task space is no longer available.'), { code: 'EGO_TASK_SPACE_NOT_FOUND' });
    if (config.recoverable && requireAgent) {
      const current = await findSpace();
      if (current?.name !== config.name) throw Object.assign(new Error('The original workspace is no longer available.'), { code: 'EGO_TASK_SPACE_NOT_FOUND' });
      if (current.ownership !== 'agent') throw Object.assign(new Error('The user controls the original workspace.'), { code: 'EGO_USER_IN_CONTROL' });
    }
    check(await native.useTaskSpace(spaceId));
  };
  const targets = async () => {
    await select();
    // listTabs 原生限定当前空间；绝不能使用全局 Target.getTargets 作为回退。
    return check(await native.listTabs()).tabs.map((tab) => ({ targetId: tab.targetId, type: 'page', title: tab.title ?? '', url: tab.url ?? '', active: tab.active === true }));
  };
  const execute = async (message: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }) => {
    const { method, sessionId } = message;
    const params = message.params ?? {};
    if (method === 'Target.getTargets') return { targetInfos: await targets() };
    if (method === 'Target.createTarget') {
      await select();
      const url = new URL(String(params.url));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only authorized http/https task pages can be created.');
      const { targetId } = check(await native.createTab(url.toString()));
      ownedTargets.add(targetId);
      return { targetId };
    }
    const listed = await targets();
    const targetId = method.startsWith('Target.') ? String(params.targetId ?? '') : sessions.get(sessionId ?? '');
    const target = listed.find((item) => item.targetId === targetId);
    if (!target) throw Object.assign(new Error('The target is outside the Avery task space.'), { code: 'EGO_TASK_SPACE_NOT_FOUND' });
    if (method === 'Target.getTargetInfo') return { targetInfo: target };
    if (method === 'Target.attachToTarget') {
      const result = await raw(method, { targetId, flatten: true });
      if (typeof result.sessionId !== 'string') throw new Error('ego did not return a CDP session.');
      sessions.set(result.sessionId, target.targetId);
      return result;
    }
    if (method === 'Target.activateTarget') {
      const result = await raw(method, { targetId });
      lastTargetId = target.targetId;
      return result;
    }
    if (!pageMethods.has(method) || !sessionId) throw new Error('This CDP method is not allowed.');
    return raw(method, params, sessionId);
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    send({ token: config.token });
    // 握手先于任何创建；宿主取消后不能在已关闭连接上留下迟到的新空间。
    const first = await lines[Symbol.asyncIterator]().next();
    if (first.done || first.value !== 'accepted') throw new Error('Avery ego bridge authentication failed.');
    if (config.resume) {
      spaceId = config.resume.id;
      const existing = await findSpace();
      if (existing?.name !== config.name) throw Object.assign(new Error('The original Avery workspace is no longer available.'), { code: 'EGO_TASK_SPACE_NOT_FOUND' });
      if (existing.ownership !== 'agent') {
        if (!config.userApproved || !['agentDelegatedToUser', 'user'].includes(existing.ownership ?? '')) {
          throw Object.assign(new Error('The original workspace needs user confirmation before Avery can resume it.'), { code: 'EGO_USER_IN_CONTROL' });
        }
        if (existing.ownership === 'agentDelegatedToUser') {
          await select(false);
          check(await native.takeOverTaskSpace());
        } else check(await native.claimTaskSpace(spaceId));
        if ((await findSpace())?.ownership !== 'agent') throw Object.assign(new Error('Ego did not return control of the original workspace.'), { code: 'EGO_USER_IN_CONTROL' });
      }
      if (lastTargetId) {
        const original = (await targets()).find((tab) => tab.targetId === lastTargetId);
        if (!original) throw Object.assign(new Error('The original task tab is no longer available.'), { code: 'BROWSER_TAB_NOT_FOUND' });
        await raw('Target.activateTarget', { targetId: original.targetId });
      }
    } else {
      const created = check(await native.createTaskSpace(config.name));
      if (!Number.isSafeInteger(created.id) || Number(created.id) <= 0) throw new Error('ego returned an invalid task-space identity.');
      spaceId = Number(created.id);
      await select();
      if (config.recoverable) {
        for (const target of await targets()) ownedTargets.add(target.targetId);
      }
    }
    if (socket.destroyed) return;
    send({ ready: true, spaceId, ...(config.recoverable ? { ownedTargetIds: [...ownedTargets] } : {}) });
    ready = true;
    // 单空间串行执行，原生路由始终由本进程选中的空间决定。
    for await (const line of lines) {
      const message = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string; close?: boolean; closeTabs?: boolean; handoff?: boolean };
      if (message.close || message.handoff) {
        closeTabs = !message.handoff && (message.closeTabs ?? closeTabs);
        const tabs = await targets();
        // 归属无法验证的标签页可能是用户在接管期间打开的，保留整个空间。
        if (config.recoverable && tabs.some((tab) => !ownedTargets.has(tab.targetId))) closeTabs = false;
        if (!closeTabs) {
          await detach();
          if (message.handoff) check(await native.handOffTaskSpace());
          else check(await native.completeTaskSpace());
        } else check(await native.closeTaskSpace());
        retiredSpace = true;
        const expectedOwner = message.handoff ? 'agentDelegatedToUser' : 'user';
        // 原生回执可能早于空间表更新；用实际所有权确认交接。
        const deadline = Date.now() + 2_000;
        while (true) {
          const space = await findSpace();
          if (closeTabs ? !space : space?.ownership === expectedOwner) break;
          if (Date.now() >= deadline) throw new Error(closeTabs ? 'ego acknowledged closing but the task space is still present.' : 'ego task-space handoff could not be confirmed.');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        send({ closed: true, closedTabs: closeTabs ? tabs.length : 0, ...(!closeTabs ? { retainedTabs: tabs.length } : {}) });
        break;
      }
      try {
        const result = await execute(message);
        send({ id: message.id, result,
          ...(message.method === 'Target.activateTarget' ? { workspaceTarget: lastTargetId } : {}),
          ...(config.recoverable && message.method === 'Target.createTarget' ? { ownedTargetIds: [...ownedTargets] } : {}),
        });
      }
      catch (error) { send({ id: message.id, error: { code: codeOf(error), message: error instanceof Error ? error.message : 'ego command failed.' } }); }
    }
  } catch (error) {
    send({ failure: true, code: codeOf(error), message: error instanceof Error ? error.message : 'ego bridge failed.' });
  } finally {
    if (spaceId !== undefined && !retiredSpace) {
      try {
        // 已交付的空间属于任务，传输中断只解除调试。未完成握手的新空间仍由本进程回收。
        if (config.resume || (config.recoverable && ready)) await detach();
        else {
          await select();
          if (closeTabs) check(await native.closeTaskSpace());
          else {
            await detach();
            check(await native.completeTaskSpace());
          }
        }
      } catch { /* 宿主将连接丢失记录为结果未知。 */ }
    }
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('ego bridge closed.')); }
    pending.clear();
    lines.close();
    socket.destroy();
  }
}
