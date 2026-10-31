'use strict';
const { createClient } = require('./client.cjs');
/** execute 的执行错误默认归为 Agent 失败；创建、同步、指标及结算错误属于测评环境。 */
async function runCase(options) {
  if (!options || typeof options.execute !== 'function') throw new Error('需要 execute 回调来运行待测 Agent');
  let client, task;
  try {
    client = options.client || await createClient();
    task = await client.createRun({ scenarioId: options.scenarioId || 'baseline', goal: options.goal || 'submit', seed: options.seed ?? 1, ...(options.parser ? { parser: options.parser } : {}) });
  } catch (error) { throw environmentError(error, 'RUN_SETUP_FAILED'); }
  let result, stage = 'execute';
  try {
    const response = await options.execute({ id: task.id, url: task.url, input: task.input, attachmentPath: task.attachmentPath, attachmentName: task.attachmentName });
    stage = 'flush';
    if (options.flush) await options.flush(task);
    stage = 'metrics';
    if (response?.metrics) await client.addMetrics(task.id, response.metrics);
  } catch (error) {
    const environment = stage !== 'execute' || error?.category === 'environment';
    const fallbackCode = environment ? stage === 'flush' ? 'FLUSH_FAILED' : stage === 'metrics' ? 'METRICS_REPORT_FAILED' : 'ENVIRONMENT_ERROR' : 'AGENT_EXECUTION_ERROR';
    const failure = { code: /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code || '') ? error.code : fallbackCode, message: String(error?.message ?? error).slice(0, 1000) };
    if (environment) await client.recordEnvironmentFailure(task.id, failure);
    else await client.recordAgentFailure(task.id, failure);
  } finally {
    // 先持久化签名证据再清理活动目录；异常也不能使下一案例继承草稿。
    try { result = await client.endRun(task.id, { cleanup: options.cleanup !== false }); }
    catch (error) { const failure = environmentError(error, 'BENCHMARK_UNAVAILABLE'); failure.runId = task.id; throw failure; }
  }
  return result;
}
function environmentError(error, fallbackCode) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.category = 'environment'; failure.code = failure.code || fallbackCode; return failure;
}
module.exports = { runCase };
