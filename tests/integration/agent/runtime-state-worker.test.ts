import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateObservabilityStoreClient } from '../../../apps/backend/src/infra/observability-store-client';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('运行状态真实 Worker 与进程边界', () => {
  it('迁移、增量提交和幂等确认经真实 Worker 完成，清理 Trace 不影响运行记录', async () => {
    const parent = process.env.AVERY_TEST_ARTIFACT_DIR ?? tmpdir(); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'avery-real-state-')); roots.push(root);
    await writeFile(join(root, 'agent-state.json'), JSON.stringify({ histories: [['s', [{ role: 'user', content: '原文' }]]] }));
    const client = CreateObservabilityStoreClient({ userDataPath: root, workerPath: resolve('apps/backend/dist/workers/observability-worker.js') });
    try {
      await client.ready;
      expect((await client.ReadAgentState()).state.histories).toEqual([['s', [{ role: 'user', content: '原文' }]]]);
      expect(await client.ReadAgentState({ includeHistory: false })).toMatchObject({ state: { histories: [['s', []]] }, unloadedHistories: ['s'] });
      expect(await client.ReadAgentHistory('s')).toEqual([{ role: 'user', content: '原文' }]);
      const patch = { commitId: 'real-worker', expectedRevision: 0, histories: [{ sessionId: 's', from: 1, messages: [{ role: 'assistant', content: '完成' }] }], rows: [{ bucket: 'toolLedger', key: 'action', value: { status: 'succeeded', receipt: 'real-fixture' } }] };
      expect(await client.CommitAgentState(patch)).toEqual({ revision: 1 });
      expect(await client.CommitAgentState(patch)).toEqual({ revision: 1 });
      await client.ClearObservability();
      const restored = await client.ReadAgentState();
      expect(restored.state.histories).toEqual([['s', [{ role: 'user', content: '原文' }, { role: 'assistant', content: '完成' }]]]);
      expect(restored.state.toolLedger).toEqual([['action', { status: 'succeeded', receipt: 'real-fixture' }]]);
    } finally { try { await client.Close(); } finally { client.close(); } }
  });

  it.each(['throw', 'reject'])('真实进程 %s 后只报告一次并以非零状态退出', mode => {
    const entry = resolve('apps/backend/dist/infra/backend-fatal.js');
    const code = `const {InstallBackendFatalHandlers}=require(${JSON.stringify(entry)}); InstallBackendFatalHandlers(message=>process.stdout.write(JSON.stringify(message)+'\\n')); setTimeout(()=>{${mode === 'throw' ? "throw new Error('fixture');" : "Promise.reject(new Error('fixture'));"}},0); setTimeout(()=>process.stdout.write('INVALID_CONTINUATION'),200);`;
    const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(1);
    expect(child.stdout).toContain('backend-fatal');
    expect(child.stdout.match(/backend-fatal/g)).toHaveLength(1);
    expect(child.stdout).not.toContain('INVALID_CONTINUATION');
  });
});
