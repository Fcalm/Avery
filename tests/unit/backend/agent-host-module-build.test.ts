import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const { AgentSdkContractVersion } = require(resolve(projectRoot, 'packages/agent-sdk/dist/index.js'));
const { HostSdkVersion } = require(resolve(projectRoot, 'packages/agent-module-host/dist/index.js'));
const { CreateDefaultModules } = require(resolve(projectRoot, 'packages/agent-modules-defaults/dist/index.js'));
const { AgentHost } = require(resolve(projectRoot, 'apps/backend/dist/electron/backend/agent-host.js'));
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function HostOptions(root: string, createDefaultModules?: (ports: any) => any) {
  return {
    userDataPath: join(root, 'user-data'), workspacePath: root, Emit: () => undefined,
    business: { GetStoredSettings: async () => ({}) }, observability: {},
    credentialPort: { Load: async () => null, Save: async () => undefined },
    browserRuntime: { Close: async () => undefined },
    ...(createDefaultModules ? { createDefaultModules } : {}),
  };
}

describe('AgentHost built module contract', () => {
  it('loads the built model-provider, rejects an incompatible SDK tag, and smoke-initializes without launching Chrome', async () => {
    expect(HostSdkVersion).toBe(AgentSdkContractVersion);
    const ports = {
      getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}),
      file: {}, resumeRead: {}, resumeWrite: {}, observabilityStore: null,
    };
    const builtModules = CreateDefaultModules(ports);
    expect(builtModules.modelProvider.sdkVersion).toBe(HostSdkVersion);

    const root = await mkdtemp(join(tmpdir(), 'avery-agent-host-built-module-'));
    roots.push(root);
    const host = new AgentHost(HostOptions(root));
    try {
      expect(host.GetModuleConfiguration()).toMatchObject({ status: 'default' });
      expect(host.GetModuleConfiguration().modules).toContainEqual(expect.objectContaining({
        slot: 'model-provider', sdkVersion: HostSdkVersion,
      }));
    } finally {
      await host.Close();
    }

    const incompatibleRoot = await mkdtemp(join(tmpdir(), 'avery-agent-host-incompatible-module-'));
    roots.push(incompatibleRoot);
    expect(() => new AgentHost(HostOptions(incompatibleRoot, (modulePorts) => {
      const defaults = CreateDefaultModules(modulePorts);
      return { ...defaults, modelProvider: { ...defaults.modelProvider, sdkVersion: '0.2.0' } };
    }))).toThrow(`Slot model-provider module sdkVersion 0.2.0 is incompatible with ${HostSdkVersion}.`);

    const smoke = execFileSync(process.execPath, [resolve(projectRoot, 'scripts/smoke-browser-extension.mjs'), '--host-init-only'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 30_000,
    });
    const summary = JSON.parse(smoke.trim().split(/\r?\n/).at(-1)!);
    expect(summary.status).toBe('host_init_only_not_pb03');
    expect(summary.hostInitialization).toEqual({
      initialized: true, modelProviderSdkVersion: HostSdkVersion, hostSdkVersion: HostSdkVersion,
    });
    expect(summary.browser).toMatchObject({
      bridge: { listening: true }, browserProcess: { launched: false },
      extension: {
        helloReceived: false, handshakeReceived: false, handshakeSource: 'skipped_test_mode',
        state: 'host_init_only_not_pb03',
      },
      handshakeReceived: false, handshakeSource: 'skipped_test_mode', preflightGate: 'not_evaluated',
      pb03Eligible: false, evidenceTier: 'test_only',
    });
    expect(summary.handshakeReceived).toBe(false);
    expect(summary.handshakeSource).toBe('skipped_test_mode');
    expect(summary.preflightGate).toBe('not_evaluated');
    expect(summary.pb03Eligible).toBe(false);
    expect(summary.evidenceTier).toBe('test_only');
  }, 30_000);
});
