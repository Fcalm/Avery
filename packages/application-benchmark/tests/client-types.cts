import { createClient, type Goal, type AgentMetrics } from '../client.cjs';
import { runCase } from '../runner.cjs';
async function verifyClientContract() {
  const client = await createClient({ controlPath: 'control.json' });
  const goal: Goal = 'preview';
  const run = await client.createRun({ goal, scenarioId: 'baseline', seed: 42 });
  const view = await client.getState(run.id);
  const email: string | undefined = view.state.personal.email;
  const metrics: AgentMetrics = { tokens: { input: 200, output: 100 }, retries: 1 };
  await client.addMetrics(run.id, metrics);
  await client.endRun(run.id, { cleanup: true });
  await runCase({ client, goal: 'fill', execute: async task => { const url: string = task.url; void url; return { metrics }; } });
  // @ts-expect-error 不允许未定义的完成目标。
  await client.createRun({ goal: 'done' });
  // @ts-expect-error Token 上报值不能是字符串。
  await client.addMetrics(run.id, { tokens: { input: '100' } });
  // @ts-expect-error 待测 Agent 的任务上下文不包含控制令牌或评分答案。
  await runCase({ execute: async task => { console.log(task.expected); } });
  void email;
}
void verifyClientContract;
