import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateRpcWorker, RestartDelayMs, type RpcWorker } from '../../../apps/backend/src/infra/worker-rpc';

const workers: RpcWorker[] = [], roots: string[] = [];
afterEach(async () => { workers.splice(0).forEach(worker => worker.Close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function Fixture(source: string, options: { startupTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avery-rpc-recovery-')); roots.push(root);
  const workerPath = join(root, 'worker.cjs');
  await writeFile(workerPath, `const {parentPort,workerData}=require('node:worker_threads');${source}`);
  const rpc = CreateRpcWorker({ workerPath, workerData: {}, ...options }); workers.push(rpc);
  return rpc;
}
describe('存储 Worker 故障恢复', () => {
  it('启动前退出立即拒绝 Ready，关闭可结束重启等待', async () => {
    const rpc = await Fixture('process.exit(0);');
    await expect(rpc.Ready()).rejects.toThrow('Worker exited');
    const waiting = rpc.Call('Read'); rpc.Close();
    await expect(waiting).rejects.toThrow('closing');
  });
  it('启动未响应有截止时间；确定的初始化错误保留错误码', async () => {
    const silent = await Fixture('setInterval(()=>{},1000);', { startupTimeoutMs: 50 });
    await expect(silent.Ready()).rejects.toThrow('启动超时');
    const failed = await Fixture("parentPort.postMessage({type:'error',code:'DATABASE_INVALID',message:'invalid database'});");
    await expect(failed.Ready()).rejects.toMatchObject({ code: 'DATABASE_INVALID' });
  });
  it.each(['throw', 'exit'])('运行中 %s 后不重放旧请求，下一代可接受新请求', async failure => {
    const action = failure === 'throw' ? "throw new Error('runtime crash')" : 'process.exit(0)';
    const rpc = await Fixture(`parentPort.postMessage({type:'ready',methods:['Read','Crash']});parentPort.on('message',m=>{if(m.method==='Crash'){${action}}else parentPort.postMessage({type:'response',id:m.id,ok:true,data:'new result'});});`);
    await rpc.Ready();
    await expect(rpc.Call('Crash')).rejects.toThrow();
    await expect(rpc.Call('Read')).resolves.toBe('new result');
  });
  it('请求无响应有截止时间，迟到结果不结算下一条请求', async () => {
    const rpc = await Fixture("parentPort.postMessage({type:'ready',methods:['Read']});let n=0;parentPort.on('message',m=>{n++;if(n===1)setTimeout(()=>parentPort.postMessage({type:'response',id:m.id,ok:true,data:'late'}),100);else parentPort.postMessage({type:'response',id:m.id,ok:true,data:'current'});});", { requestTimeoutMs: 40 });
    await rpc.Ready();
    await expect(rpc.Call('Read')).rejects.toMatchObject({ details: { reason: 'WORKER_RPC_TIMEOUT', statusUnknown: true }, retryable: false });
    await expect(rpc.Call('Read')).resolves.toBe('current');
  });
  it('关闭会拒绝已发送请求，重启延迟指数增长且有上限', async () => {
    const rpc = await Fixture("parentPort.postMessage({type:'ready',methods:['Read']});parentPort.on('message',()=>{});");
    await rpc.Ready(); const pending = rpc.Call('Read');
    await Promise.resolve(); rpc.Close();
    await expect(pending).rejects.toThrow('closing');
    expect([0, 1, 2, 10].map(RestartDelayMs)).toEqual([1000, 2000, 4000, 30000]);
  });
});
