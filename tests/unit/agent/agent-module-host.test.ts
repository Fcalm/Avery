import { describe, expect, it } from 'vitest';
import type { AgentModules, SlotName } from '../../../packages/agent-sdk/src/index';
import { SlotOrder, SlotToModuleKey } from '../../../packages/agent-sdk/src/index';
import { HostSdkVersion, ModuleResolutionError, ResolveModules } from '../../../packages/agent-module-host/src/resolver';
import { CreateRunSnapshot } from '../../../packages/agent-module-host/src/run-snapshot';
import { BuildDefaultCompiledInstructions, DefaultScenario } from '../../../packages/agent-modules-defaults/src/prompts';
import { CreateRegisteredTool } from './test-helpers';

function CreateModule(slot: SlotName) {
  return {
    packageName: '@avery/test-module',
    name: `test-${slot}`,
    version: '1.2.3',
    sdkVersion: HostSdkVersion,
    slot,
    capabilities: [`capability:${slot}`],
  };
}

function CreateDefaults(): AgentModules {
  const aggregate: Record<string, unknown> = {};
  for (const slot of SlotOrder) aggregate[SlotToModuleKey[slot]] = CreateModule(slot);
  return aggregate as unknown as AgentModules;
}

describe('agent-module-host 模块解析', () => {
  it('按固定六槽顺序解析并生成不受源模块后续修改影响的会话快照', () => {
    const defaults = CreateDefaults();
    const result = ResolveModules({ sessionId: 'session-1', sessionRevision: 7, defaults, createId: () => 'snapshot-1' });

    expect(result.snapshot).toEqual({
      snapshotId: 'snapshot-1',
      sessionId: 'session-1',
      sessionRevision: 7,
      orderedSlots: [...SlotOrder],
      modules: SlotOrder.map((slot) => ({
        slot,
        name: `test-${slot}`,
        version: '1.2.3',
        sdkVersion: HostSdkVersion,
        capabilities: [`capability:${slot}`],
      })),
    });
    defaults.modelProvider.capabilities.push('mutated-after-snapshot');
    expect(result.snapshot.modules[0].capabilities).not.toContain('mutated-after-snapshot');
  });

  it.each([
    ['槽位错配', () => ({ ...CreateModule('tools'), slot: 'interaction' })],
    ['非法版本', () => ({ ...CreateModule('tools'), version: 'latest' })],
    ['SDK 不兼容', () => ({ ...CreateModule('tools'), sdkVersion: '9.9.9' })],
  ])('%s 时拒绝启动且不静默回退', (_name, create) => {
    expect(() => ResolveModules({
      sessionId: 'session-1',
      sessionRevision: 1,
      defaults: CreateDefaults(),
      overrides: { tools: { packageName: 'test', name: 'override', version: '1.0.0', sdkVersion: HostSdkVersion, create } },
      createId: () => 'snapshot-1',
    })).toThrow(ModuleResolutionError);
  });

  it('覆盖工厂异常会携带原因并阻止启动', () => {
    expect(() => ResolveModules({
      sessionId: 'session-1',
      sessionRevision: 1,
      defaults: CreateDefaults(),
      overrides: {
        tools: {
          packageName: 'test', name: 'broken', version: '1.0.0', sdkVersion: HostSdkVersion,
          create: () => { throw new Error('load failed'); },
        },
      },
      createId: () => 'snapshot-1',
    })).toThrow(/load failed/);
  });

  it('将 Scenario、Prompt、工具白名单、数据范围和 Provider 冻结为同一 Run 快照', () => {
    const read = CreateRegisteredTool('Read');
    const atomicSnapshot = CreateRunSnapshot({
      snapshotId: 'run-snapshot-1', sessionId: 'session-1', sessionRevision: 1,
      scenario: { ...DefaultScenario, toolNames: ['Read'] },
      instructions: BuildDefaultCompiledInstructions('tool-hash-1'),
      tools: [read],
      dataScope: { projectId: 'project-1', projectRoot: 'D:\\project', resumeId: 'resume-1', attachmentPaths: ['/attachments/a.txt'] },
      provider: {
        moduleName: 'deepseek', moduleVersion: '0.1.0', model: 'deepseek-chat',
        capabilities: ['provider:deepseek'], contextLimit: 64_000, compressionThreshold: 70,
      },
    });

    expect(atomicSnapshot).toEqual(expect.objectContaining({
      scenario: expect.objectContaining({ toolNames: ['Read'] }),
      instructions: expect.objectContaining({ manifest: expect.any(Object) }),
      toolNames: ['Read'],
      dataScope: expect.objectContaining({ projectId: 'project-1', resumeId: 'resume-1' }),
      provider: expect.objectContaining({ model: 'deepseek-chat', contextLimit: 64_000, compressionThreshold: 70 }),
    }));
    expect(Object.isFrozen(atomicSnapshot)).toBe(true);
    expect(Object.isFrozen(atomicSnapshot.scenario.toolNames)).toBe(true);
    expect(Object.isFrozen(atomicSnapshot.instructions.manifest)).toBe(true);
  });
});
