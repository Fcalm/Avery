import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  BuildPb03PreflightEvidence,
  CanRestorePb03Pairing,
  ClassifyPb03Preflight,
  CreatePb03BrowserLaunchGuard,
  ResetPb03RestoreState,
  RestorePb03Pairing,
  WaitForPb03Handshake,
} from '../../../scripts/fixtures/pb03-preflight.mjs';

const projectRoot = process.cwd();

function Extension(overrides: Record<string, unknown> = {}) {
  return {
    helloReceived: true,
    online: true,
    state: 'online',
    protocolRevisionMatches: true,
    ...overrides,
  };
}

describe('PB-03 attach-only browser preflight', () => {
  it('等待同一 Bridge 的 poll 握手并记录 source/等待证据，不触发 Request 或浏览器动作', async () => {
    let statusReads = 0;
    const bridge = {
      Start: vi.fn(async () => undefined),
      Status: vi.fn(() => {
        statusReads += 1;
        return statusReads < 3
          ? { state: 'offline', connected: false, handshakeReceived: false }
          : { state: 'online', connected: true, handshakeReceived: true, handshakeSource: 'poll', actualVersion: '0.2.0', actualProtocolRevision: 'avery-browser-extension-bridge-v3' };
      }),
      Request: vi.fn(),
      Launch: vi.fn(),
    };
    const result = await WaitForPb03Handshake({ bridge, intervalMs: 100, timeoutMs: 1_000, sleep: async () => undefined });
    expect(result).toMatchObject({ ready: true, status: 'ready', handshakeReceived: true, source: 'poll', actualVersion: '0.2.0', actualProtocolRevision: 'avery-browser-extension-bridge-v3', attempts: 3 });
    expect(bridge.Start).toHaveBeenCalledTimes(1);
    expect(bridge.Request).not.toHaveBeenCalled();
    expect(bridge.Launch).not.toHaveBeenCalled();
  });

  it('stale 立即阻断，offline 才等待到 timeout，并支持取消清理', async () => {
    const stale = await WaitForPb03Handshake({
      bridge: { Status: () => ({ state: 'stale', connected: false, handshakeReceived: false, actualVersion: '0.1.0', actualProtocolRevision: 'old' }) },
      timeoutMs: 20_000,
      // 验证立即返回分支，不让实时时钟跨毫秒造成 waitedMs=0 的偶发失败。
      now: () => 1_000,
      sleep: async () => undefined,
    });
    expect(stale).toMatchObject({ ready: false, status: 'stale', waitedMs: 0, attempts: 1, lastState: 'stale' });

    const timeout = await WaitForPb03Handshake({
      bridge: { Status: () => ({ state: 'offline', connected: false, handshakeReceived: false }) },
      timeoutMs: 0,
      sleep: async () => undefined,
    });
    expect(timeout).toMatchObject({ ready: false, status: 'timeout', waitedMs: 0, attempts: 1, blocked: true });

    const controller = new AbortController();
    const cancelled = WaitForPb03Handshake({
      bridge: { Status: () => ({ state: 'offline', connected: false, handshakeReceived: false }) },
      timeoutMs: 1_000,
      intervalMs: 100,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    await expect(cancelled).resolves.toMatchObject({ ready: false, status: 'cancelled' });
  });

  it('classifies offline, stale, and online states before any Host/provider work', () => {
    expect(ClassifyPb03Preflight({ bridge: { listening: true }, extension: Extension({ helloReceived: false, online: false }) })).toMatchObject({
      blocked: true,
      status: 'blocked_extension_not_connected',
    });
    expect(ClassifyPb03Preflight({ bridge: { listening: true }, extension: Extension({ state: 'stale', protocolRevisionMatches: false }) })).toMatchObject({
      blocked: true,
      status: 'blocked_extension_stale',
    });
    expect(ClassifyPb03Preflight({ bridge: { listening: true }, extension: Extension() })).toEqual({
      blocked: false,
      status: 'ready',
      action: null,
    });
  });

  it('online preflight needs no launcher or pairing callback', () => {
    const launchBrowser = vi.fn();
    const online = ClassifyPb03Preflight({ bridge: { listening: true }, extension: Extension() });
    expect(online.blocked).toBe(false);
    expect(launchBrowser).not.toHaveBeenCalled();
    expect(BuildPb03PreflightEvidence({ launchState: {}, browser: { extension: Extension() } })).toMatchObject({
      browserProcess: { launched: false },
      pairPageOpened: false,
      preflightNoSideEffects: true,
    });
  });

  it('does not launch or open /pair by default, even when Chrome is already running', async () => {
    const spawnBrowser = vi.fn();
    const state: Record<string, unknown> = { browserProcessRunning: true };
    const guard = CreatePb03BrowserLaunchGuard({ allowBrowserLaunch: false, state, spawnBrowser });

    await expect(guard('chrome', 'http://127.0.0.1:17653/pair#token=redacted')).rejects.toMatchObject({
      code: 'PB03_BROWSER_LAUNCH_DISABLED',
    });
    expect(spawnBrowser).not.toHaveBeenCalled();
    expect(BuildPb03PreflightEvidence({
      browserProcessRunning: true,
      launchState: state,
      browser: { extension: Extension({ helloReceived: false, online: false }) },
    })).toMatchObject({
      browserProcess: { running: true, launched: false },
      pairPageOpened: false,
      preflightNoSideEffects: true,
    });
  });

  it('keeps launcher capability explicit and opt-in only', async () => {
    const spawnBrowser = vi.fn(async () => undefined);
    const state: Record<string, unknown> = { preflightSucceeded: true };
    const guard = CreatePb03BrowserLaunchGuard({ allowBrowserLaunch: true, state, spawnBrowser });

    await guard('chrome', 'http://127.0.0.1:17653/pair#token=redacted');
    expect(spawnBrowser).toHaveBeenCalledTimes(1);
    expect(BuildPb03PreflightEvidence({ launchState: state })).toMatchObject({
      browserProcess: { launched: true },
      pairPageOpened: true,
      preflightNoSideEffects: false,
    });
  });

  it('leaves stale preflight tool events and ledger empty', () => {
    const preflight = ClassifyPb03Preflight({ bridge: { listening: true }, extension: Extension({ state: 'stale', protocolRevisionMatches: false }) });
    const artifact = {
      status: preflight.status,
      browser: BuildPb03PreflightEvidence({ launchState: {}, browser: { extension: Extension({ state: 'stale', protocolRevisionMatches: false }) } }),
      toolEvents: [],
      ledger: [],
    };
    expect(artifact).toMatchObject({ status: 'blocked_extension_stale', toolEvents: [], ledger: [] });
    expect(artifact.browser.preflightNoSideEffects).toBe(true);
  });

  it.each([
    ['stale', { preflightSucceeded: false, sideEffectPerformed: false }],
    ['offline', { preflightSucceeded: false, sideEffectPerformed: false }],
  ])('%s + allowBrowserLaunch + restore-port never opens a pairing page', async (_label, flags) => {
    const spawnBrowser = vi.fn(async () => undefined);
    const state: Record<string, unknown> = { ...flags, pairPageOpened: false, restorePerformed: false };
    const restore = await RestorePb03Pairing({
      restorePort: 17653,
      token: 'a'.repeat(64),
      allowBrowserLaunch: true,
      preflightSucceeded: state.preflightSucceeded === true,
      sideEffectPerformed: state.sideEffectPerformed === true,
      state,
      spawnBrowser,
    });
    expect(restore).toMatchObject({ performed: false, reason: 'preflight_failed' });
    expect(spawnBrowser).not.toHaveBeenCalled();
    expect(state.pairPageOpened).toBe(false);
    expect(CanRestorePb03Pairing({ restorePort: 17653, allowBrowserLaunch: true, ...flags })).toBe(false);
  });

  it('normal explicit startup restores exactly once after a successful preflight and side effect', async () => {
    const spawnBrowser = vi.fn(async () => undefined);
    const state: Record<string, unknown> = { preflightSucceeded: true, sideEffectPerformed: true, pairPageOpened: true, restorePerformed: false };
    const options = {
      restorePort: 17653,
      token: 'b'.repeat(64),
      allowBrowserLaunch: true,
      preflightSucceeded: true,
      sideEffectPerformed: true,
      state,
      spawnBrowser,
    };
    expect((await RestorePb03Pairing(options)).performed).toBe(true);
    expect((await RestorePb03Pairing(options)).performed).toBe(false);
    expect(spawnBrowser).toHaveBeenCalledTimes(1);
    expect(state.restorePerformed).toBe(true);
  });

  it('claims before await so concurrent restores share one promise and one spawn', async () => {
    let release!: () => void;
    const spawnBrowser = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const state: Record<string, unknown> = { preflightSucceeded: true, sideEffectPerformed: true, pairPageOpened: true };
    const options = {
      restorePort: 17653,
      token: 'c'.repeat(64),
      allowBrowserLaunch: true,
      preflightSucceeded: true,
      sideEffectPerformed: true,
      state,
      spawnBrowser,
    };
    const first = RestorePb03Pairing(options);
    const second = RestorePb03Pairing(options);
    expect(second).toBe(first);
    expect(spawnBrowser).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ performed: true });
    expect(state.restorePerformed).toBe(true);
    expect(state.restoreInFlight).toBeNull();
    expect((await RestorePb03Pairing(options))).toMatchObject({ performed: false, reason: 'already_performed' });
    expect(spawnBrowser).toHaveBeenCalledTimes(1);
  });

  it('rejected spawn is terminal until an explicit lifecycle reset', async () => {
    const failure = Object.assign(new Error('spawn failed'), { code: 'SPAWN_FAILED' });
    const spawnBrowser = vi.fn(async () => { throw failure; });
    const state: Record<string, unknown> = { preflightSucceeded: true, sideEffectPerformed: true, pairPageOpened: true };
    const options = {
      restorePort: 17653,
      token: 'd'.repeat(64),
      allowBrowserLaunch: true,
      preflightSucceeded: true,
      sideEffectPerformed: true,
      state,
      spawnBrowser,
    };
    const first = RestorePb03Pairing(options);
    const second = RestorePb03Pairing(options);
    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(spawnBrowser).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ restoreClaimed: true, restoreFailed: true, restorePerformed: false, pairPageOpened: true });
    expect(state.restoreInFlight).toBeNull();
    expect((await RestorePb03Pairing(options))).toMatchObject({ performed: false, reason: 'restore_failed_no_retry' });
    expect(spawnBrowser).toHaveBeenCalledTimes(1);

    ResetPb03RestoreState(state);
    spawnBrowser.mockResolvedValue(undefined);
    const afterReset = await RestorePb03Pairing(options);
    expect(afterReset).toMatchObject({ performed: true });
    expect(spawnBrowser).toHaveBeenCalledTimes(2);
  });

  it('both PB-03 live scripts wire the guarded preflight before Host/provider creation', async () => {
    const [smoke, migration] = await Promise.all([
      readFile(resolve(projectRoot, 'scripts/smoke-browser-extension.mjs'), 'utf8'),
      readFile(resolve(projectRoot, 'scripts/smoke-browser-migration-pb03.mjs'), 'utf8'),
    ]);
    for (const source of [smoke, migration]) {
      expect(source).toContain("./fixtures/pb03-preflight.mjs");
      expect(source).toContain('CreatePb03BrowserLaunchGuard');
      expect(source).toContain('allow-browser-launch');
      expect(source).toContain('pairPageOpened');
      expect(source).toContain('preflightNoSideEffects');
      expect(source).toContain('RestorePb03Pairing');
      expect(source).toContain('CanRestorePb03Pairing');
      expect(source).toContain('sideEffectPerformed');
      expect(source).toContain('preflightSucceeded');
    }
    const smokePreflightIndex = smoke.indexOf('const initialPreflight = ClassifyPb03Preflight');
    expect(smokePreflightIndex).toBeGreaterThanOrEqual(0);
    expect(smokePreflightIndex).toBeLessThan(smoke.indexOf('host = new AgentHost(', smokePreflightIndex));
    const migrationPreflightIndex = migration.indexOf('const preflight = await RunLivePreflight');
    expect(migrationPreflightIndex).toBeGreaterThanOrEqual(0);
    expect(migrationPreflightIndex).toBeLessThan(migration.indexOf('const harness = await CreateLiveHarness(', migrationPreflightIndex));
    expect(migration).toMatch(/restorePort > 0[\s\S]{0,160}allowBrowserLaunch/);
    expect(migration).toMatch(/CreateLiveBrowser\(\{[\s\S]{0,220}attachments, events, allowBrowserLaunch/);
  });
});
