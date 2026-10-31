/**
 * 固定的 ego 原生桥接脚本，在 ego 内置 Node 中执行，不加载 Skill 或执行模型脚本。
 * 本函数会序列化给 CLI，所有依赖必须在函数内获取，不得引用外部运行时变量。
 */
export async function EgoBrowserBootstrap(config: { port: number; token: string; name: string; closeTabs?: boolean }): Promise<void> {
  const { connect } = await import('node:net');
  const { createInterface } = await import('node:readline');
  type NativeResult = { error?: string; error_code?: string; [key: string]: unknown };
  type NativeTab = { targetId: string; title?: string; url?: string; active?: boolean };
  const native = (globalThis as unknown as { ego: {
    createTaskSpace(name: string): Promise<NativeResult>;
    useTaskSpace(id: number): Promise<unknown>;
    listTabs(): Promise<NativeResult & { tabs: NativeTab[] }>;
    listTaskSpaces(): Promise<NativeResult & { taskSpaces: Array<{ id: number; ownership?: string }> }>;
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
    return /USER_IN_CONTROL/.test(code) ? 'BROWSER_VISIBLE_USER_ACTION_REQUIRED'
      : /NOT_FOUND|NOT_EXIST/.test(code) ? 'BROWSER_TASK_RETIRED' : 'BROWSER_COMMAND_FAILED';
  };
  let spaceId: number | undefined;
  let nextNativeId = 0;
  const sessions = new Map<string, string>();
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const raw = (method: string, params: Record<string, unknown>, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextNativeId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('ego CDP command timed out.')); }, 60_000);
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
  let closeTabs = config.closeTabs !== false;
  const select = async () => {
    if (spaceId === undefined || retiredSpace) throw Object.assign(new Error('The Avery ego task space is no longer available.'), { code: 'EGO_TASK_SPACE_NOT_FOUND' });
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
    await select();
    if (method === 'Target.getTargets') return { targetInfos: await targets() };
    if (method === 'Target.createTarget') {
      const url = new URL(String(params.url));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only authorized http/https task pages can be created.');
      return { targetId: check(await native.createTab(url.toString())).targetId };
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
    if (method === 'Target.activateTarget') return raw(method, { targetId });
    if (!pageMethods.has(method) || !sessionId) throw new Error('This CDP method is not allowed.');
    return raw(method, params, sessionId);
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    send({ token: config.token });
    // 握手先于任何创建；宿主取消后不能在已关闭连接上留下迟到的新空间。
    const first = await lines[Symbol.asyncIterator]().next();
    if (first.done || first.value !== 'accepted') throw new Error('Avery ego bridge authentication failed.');
    const created = check(await native.createTaskSpace(config.name));
    if (!Number.isSafeInteger(created.id) || Number(created.id) <= 0) throw new Error('ego returned an invalid task-space identity.');
    spaceId = Number(created.id);
    await select();
    send({ ready: true, spaceId });
    // 单空间串行执行，原生路由始终由本进程选中的空间决定。
    for await (const line of lines) {
      const message = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string; close?: boolean; closeTabs?: boolean };
      if (message.close) {
        closeTabs = message.closeTabs ?? closeTabs;
        const tabs = await targets();
        if (!closeTabs) {
          // 保留页面也必须结束本任务的调试会话，不能让旧引用在交还用户后继续生效。
          for (const sessionId of sessions.keys()) await raw('Target.detachFromTarget', { sessionId });
          sessions.clear();
          check(await native.completeTaskSpace());
        } else check(await native.closeTaskSpace());
        retiredSpace = true;
        // 原生回执可能早于空间表更新；关闭须确认消失，保留须确认已交还用户。
        const deadline = Date.now() + 2_000;
        while (true) {
          const space = check(await native.listTaskSpaces()).taskSpaces.find((space) => space.id === spaceId);
          if (closeTabs ? !space : space?.ownership === 'user') break;
          if (Date.now() >= deadline) throw new Error(closeTabs ? 'ego acknowledged closing but the task space is still present.' : 'ego task-space handoff could not be confirmed.');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        send({ closed: true, closedTabs: closeTabs ? tabs.length : 0, ...(!closeTabs ? { retainedTabs: tabs.length } : {}) });
        break;
      }
      try { send({ id: message.id, result: await execute(message) }); }
      catch (error) { send({ id: message.id, error: { code: codeOf(error), message: error instanceof Error ? error.message : 'ego command failed.' } }); }
    }
  } catch (error) {
    send({ failure: true, code: codeOf(error), message: error instanceof Error ? error.message : 'ego bridge failed.' });
  } finally {
    if (spaceId !== undefined && !retiredSpace) {
      // 只清理由本进程创建的空间；用户接管或空间丢失时原生会拒绝，不夺取权限。
      try {
        await select();
        if (closeTabs) check(await native.closeTaskSpace());
        else {
          for (const sessionId of sessions.keys()) await raw('Target.detachFromTarget', { sessionId });
          sessions.clear();
          check(await native.completeTaskSpace());
        }
      } catch { /* 宿主将连接丢失记录为结果未知。 */ }
    }
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('ego bridge closed.')); }
    pending.clear();
    lines.close();
    socket.destroy();
  }
}
