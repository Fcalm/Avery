'use strict';
const fs = require('node:fs/promises');
const { createClient } = require('./client.cjs');
async function main() {
  const [command, ...args] = process.argv.slice(2), client = await createClient();
  let result;
  if (command === 'list') result = await client.listScenarios();
  else if (command === 'register') result = await client.registerScenario(JSON.parse(await fs.readFile(args[0], 'utf8')));
  else if (command === 'metrics') result = await client.addMetrics(args[0], JSON.parse(await fs.readFile(args[1], 'utf8')));
  else if (command === 'create') result = await client.createRun({ scenarioId: args[0] || 'baseline', goal: args[1] || 'submit', seed: Number(args[2] || 1), ...(args[3] ? { parser: JSON.parse(await fs.readFile(args[3], 'utf8')) } : {}) });
  else if (command === 'state') result = await client.getState(args[0]);
  else if (command === 'events') result = await client.getEvents(args[0], Number(args[1] || 0));
  else if (command === 'end') { result = await client.endRun(args[0], { cleanup: args.includes('--cleanup') }); const output = args.find((value, i) => i > 0 && value !== '--cleanup'); if (output) await fs.writeFile(output, JSON.stringify(result, null, 2)); }
  else if (command === 'cleanup') result = await client.cleanupRun(args[0]);
  else throw new Error('用法：node harness.cjs list | register <案例.json> | create [场景] [fill|preview|submit] [seed] [解析配置.json] | state <id> | events <id> [cursor] | metrics <id> <指标.json> | end <id> [输出.json] [--cleanup] | cleanup <id>');
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
