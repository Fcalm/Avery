/**
 * PB-03 live-browser preflight helpers.  The formal smoke path is attach-only:
 * a missing/stale extension is an actionable block, never a reason to launch a
 * browser or open a pairing page.  A caller may opt into the launcher only for
 * explicit developer diagnostics.
 */

export function CreatePb03BrowserLaunchGuard({ allowBrowserLaunch = false, state = {}, spawnBrowser = async () => undefined } = {}) {
  return async (engine, pairUrl) => {
    if (allowBrowserLaunch !== true || state.preflightSucceeded !== true) {
      state.launchDenied = true;
      throw Object.assign(new Error('PB-03 attach-only preflight will not launch the browser or open a pairing page before a successful existing-browser preflight. Start Chrome with the Avery extension, then rerun.'), {
        code: 'PB03_BROWSER_LAUNCH_DISABLED',
      });
    }
    state.launchRequested = true;
    await spawnBrowser(engine, pairUrl);
    state.attempted = true;
    state.sideEffectPerformed = true;
    state.pairPageOpened = true;
  };
}

export function ClassifyPb03Preflight({ bridge = {}, extension = {} } = {}) {
  const stale = extension.state === 'stale'
    || (extension.handshakeReceived === true && extension.versionMatches === false)
    || (extension.handshakeReceived === true && extension.protocolRevisionMatches === false)
    || (extension.helloReceived === true && extension.protocolRevisionMatches === false);
  if (stale) {
    return {
      blocked: true,
      status: 'blocked_extension_stale',
      action: 'Open chrome://extensions, reload the Avery extension, and rerun the attach-only smoke.',
    };
  }
  if (bridge.listening !== true) {
    return {
      blocked: true,
      status: 'blocked_bridge_not_listening',
      action: 'Start the existing browser/extension Bridge owner, then rerun the attach-only smoke.',
    };
  }
  const handshakeReceived = extension.handshakeReceived === true
    || (extension.handshakeReceived === undefined && extension.helloReceived === true);
  const versionMatches = extension.versionMatches === undefined || extension.versionMatches === true;
  if (!handshakeReceived || extension.online !== true || !versionMatches || extension.protocolRevisionMatches !== true) {
    return {
      blocked: true,
      status: 'blocked_extension_not_connected',
      action: 'Start Chrome with the Avery extension enabled (or reload it from chrome://extensions), then rerun; this smoke will not launch Chrome or open /pair.',
    };
  }
  return { blocked: false, status: 'ready', action: null };
}

function HandshakeStatus(status, expectedVersion, expectedProtocolRevision) {
  const actualVersion = typeof status?.actualVersion === 'string'
    ? status.actualVersion
    : typeof status?.version === 'string' ? status.version : null;
  const actualProtocolRevision = typeof status?.actualProtocolRevision === 'string'
    ? status.actualProtocolRevision
    : typeof status?.protocolRevision === 'string' ? status.protocolRevision : null;
  const source = status?.handshakeSource === 'hello' || status?.handshakeSource === 'poll'
    ? status.handshakeSource
    : status?.source === 'hello' || status?.source === 'poll' ? status.source : null;
  return {
    handshakeReceived: status?.handshakeReceived === true,
    source,
    actualVersion,
    actualProtocolRevision,
    expectedVersion,
    expectedProtocolRevision,
    state: status?.state === 'stale' ? 'stale' : status?.state || 'offline',
    online: status?.connected === true && status?.state !== 'stale',
    versionMatches: actualVersion === expectedVersion,
    protocolRevisionMatches: actualProtocolRevision === expectedProtocolRevision && status?.state !== 'stale',
  };
}

/**
 * 只观察同一个 Bridge 的状态，等待权威 hello/poll 握手；不会创建 Runtime、
 * 发 CDP/Request，也不会启动浏览器或打开 /pair。stale 立即返回，offline
 * 才等待到 deadline。等待使用可取消的一次性 timer，避免忙循环和残留句柄。
 */
export async function WaitForPb03Handshake({
  bridge,
  expectedVersion = '0.2.0',
  expectedProtocolRevision = 'avery-browser-extension-bridge-v1',
  timeoutMs = 20_000,
  intervalMs = 100,
  signal,
  now = Date.now,
  sleep,
  startBridge = true,
} = {}) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 20_000;
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 100;
  const startedAt = now();
  let waitedMs = 0;
  let attempts = 0;
  let last = HandshakeStatus(null, expectedVersion, expectedProtocolRevision);

  const result = (status, extra = {}) => ({
    ready: status === 'ready',
    status,
    blocked: status !== 'ready',
    ...last,
    lastState: last.state,
    waitedMs: Math.min(timeout, Math.max(waitedMs, Math.max(0, now() - startedAt))),
    waitDurationMs: Math.min(timeout, Math.max(waitedMs, Math.max(0, now() - startedAt))),
    attempts,
    ...extra,
  });
  if (signal?.aborted) return result('cancelled');
  if (startBridge && typeof bridge?.Start === 'function') await bridge.Start();
  const wait = async (milliseconds) => {
    if (typeof sleep === 'function') {
      const pending = Promise.resolve().then(() => sleep(milliseconds, signal));
      if (!signal) return pending;
      await new Promise((resolveWait, rejectWait) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          if (error) rejectWait(error); else resolveWait();
        };
        const abort = () => finish(Object.assign(new Error('PB-03 handshake wait was cancelled.'), { code: 'CANCELLED' }));
        pending.then(() => finish(), (error) => finish(error));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return;
    }
    await new Promise((resolveWait, rejectWait) => {
      let timer = setTimeout(() => {
        timer = null;
        signal?.removeEventListener('abort', abort);
        resolveWait();
      }, milliseconds);
      const abort = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', abort);
        rejectWait(Object.assign(new Error('PB-03 handshake wait was cancelled.'), { code: 'CANCELLED' }));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  };

  while (true) {
    if (signal?.aborted) return result('cancelled');
    attempts += 1;
    try {
      last = HandshakeStatus(bridge?.Status?.(), expectedVersion, expectedProtocolRevision);
    } catch (error) {
      last = { ...HandshakeStatus(null, expectedVersion, expectedProtocolRevision), lastError: String(error?.message || error) };
    }
    if (last.state === 'stale'
      || (last.state === 'online' && (!last.handshakeReceived || !last.versionMatches || !last.protocolRevisionMatches))
      || (last.handshakeReceived && (!last.versionMatches || !last.protocolRevisionMatches))) return result('stale');
    if (last.handshakeReceived && last.online && last.versionMatches && last.protocolRevisionMatches && last.source) return result('ready');
    if (waitedMs >= timeout) return result('timeout');
    const remaining = timeout - waitedMs;
    const delay = Math.min(interval, remaining);
    try { await wait(delay); }
    catch (error) { if (signal?.aborted || error?.code === 'CANCELLED') return result('cancelled'); throw error; }
    waitedMs = Math.min(timeout, Math.max(waitedMs + delay, Math.max(0, now() - startedAt)));
  }
}

export function BuildPb03PreflightEvidence({ browserProcessRunning = false, launchState = {}, browser = {} } = {}) {
  const launched = launchState.sideEffectPerformed === true;
  const pairPageOpened = launchState.pairPageOpened === true;
  const extension = browser.extension && typeof browser.extension === 'object' ? browser.extension : {};
  return {
    ...browser,
    handshakeReceived: browser.handshakeReceived === true || extension.handshakeReceived === true,
    handshakeSource: browser.handshakeSource ?? browser.source ?? extension.handshakeSource ?? extension.source ?? null,
    actualVersion: browser.actualVersion ?? extension.actualVersion ?? extension.version ?? null,
    actualProtocolRevision: browser.actualProtocolRevision ?? extension.actualProtocolRevision ?? extension.protocolRevision ?? null,
    handshakeWaitedMs: browser.handshakeWaitedMs ?? browser.waitedMs ?? 0,
    handshakeWaitDurationMs: browser.handshakeWaitDurationMs ?? browser.waitDurationMs ?? browser.handshakeWaitedMs ?? browser.waitedMs ?? 0,
    handshakeAttempts: browser.handshakeAttempts ?? browser.attempts ?? 0,
    browserProcess: {
      ...(browser.browserProcess ?? {}),
      running: browserProcessRunning === true,
      launched,
    },
    pairPageOpened,
    preflightNoSideEffects: launched === false && pairPageOpened === false,
  };
}

export function CanRestorePb03Pairing({ restorePort = 0, allowBrowserLaunch = false, preflightSucceeded = false, sideEffectPerformed = false, restorePerformed = false, restoreClaimed = false, restoreFailed = false } = {}) {
  return allowBrowserLaunch === true
    && Number.isSafeInteger(restorePort)
    && restorePort > 0
    && restorePort <= 65_535
    && preflightSucceeded === true
    && sideEffectPerformed === true
    && restorePerformed !== true
    && restoreClaimed !== true
    && restoreFailed !== true;
}

export function RestorePb03Pairing({ restorePort = 0, token = '', allowBrowserLaunch = false, preflightSucceeded = false, sideEffectPerformed = false, state = {}, spawnBrowser = async () => undefined } = {}) {
  // Claim/in-flight checks happen synchronously before the first await. This
  // makes concurrent callers share exactly one promise and one spawn attempt.
  if (state.restoreInFlight && typeof state.restoreInFlight.then === 'function') return state.restoreInFlight;
  if (state.restoreClaimed === true) return Promise.resolve({ performed: false, reason: state.restoreFailed === true ? 'restore_failed_no_retry' : state.restorePerformed === true ? 'already_performed' : 'restore_claimed' });
  if (!CanRestorePb03Pairing({ restorePort, allowBrowserLaunch, preflightSucceeded, sideEffectPerformed, restorePerformed: state.restorePerformed === true, restoreClaimed: state.restoreClaimed === true, restoreFailed: state.restoreFailed === true })) {
    return Promise.resolve({ performed: false, reason: allowBrowserLaunch !== true ? 'browser_launch_disabled' : preflightSucceeded !== true ? 'preflight_failed' : sideEffectPerformed !== true ? 'no_side_effect_performed' : state.restorePerformed === true ? 'already_performed' : state.restoreFailed === true ? 'restore_failed_no_retry' : 'invalid_restore_port' });
  }
  if (!/^[a-f0-9]{64}$/.test(String(token))) return Promise.resolve({ performed: false, reason: 'missing_bridge_token' });
  const pairUrl = `http://127.0.0.1:${restorePort}/pair#token=${token}&port=${restorePort}`;
  state.restoreClaimed = true;
  state.restorePerformed = false;
  const inFlight = (async () => {
    try {
      await spawnBrowser(pairUrl);
      state.restorePerformed = true;
      state.attempted = true;
      state.sideEffectPerformed = true;
      state.pairPageOpened = true;
      return { performed: true, pairUrl };
    } catch (error) {
      state.restoreFailed = true;
      state.restoreFailure = {
        code: typeof error?.code === 'string' ? error.code : 'PB03_RESTORE_PAIRING_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  })();
  state.restoreInFlight = inFlight;
  // Clear only the transient in-flight slot after settlement. The permanent
  // claim/failed/performed flags still prevent an automatic second spawn.
  inFlight.then(
    () => { if (state.restoreInFlight === inFlight) state.restoreInFlight = null; },
    () => { if (state.restoreInFlight === inFlight) state.restoreInFlight = null; },
  );
  return inFlight;
}

export function ResetPb03RestoreState(state = {}) {
  state.restoreInFlight = null;
  state.restoreClaimed = false;
  state.restoreFailed = false;
  state.restoreFailure = null;
  state.restorePerformed = false;
  return state;
}
