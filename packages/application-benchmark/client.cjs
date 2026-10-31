'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const DEFAULT_CONTROL_PATH = path.resolve(__dirname, '../output/career-portal-runtime-v2/control.json');
/** Avery 的控制进程使用此客户端；不将控制令牌传入被测浏览器或模型上下文。 */
async function createClient(options = {}) {
  const config = options.baseUrl && options.token ? options : { ...JSON.parse(await fs.readFile(options.controlPath || process.env.CAREER_CONTROL_PATH || DEFAULT_CONTROL_PATH, 'utf8')), ...options };
  async function request(route, method = 'GET', body) {
    const response = await fetch(config.baseUrl + route, { method, headers: { Authorization: 'Bearer ' + config.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.message || '本地测评接口失败'); error.code = result.error?.code; error.status = response.status; throw error; }
    return result;
  }
  return {
    listScenarios: () => request('/api/scenarios'),
    registerScenario: scenario => request('/api/scenarios', 'POST', scenario),
    createRun: options => request('/api/runs', 'POST', options),
    getState: id => request(`/api/runs/${id}/state`),
    getEvents: (id, after = 0) => request(`/api/runs/${id}/events?after=${after}`),
    addMetrics: (id, metrics) => request(`/api/runs/${id}/metrics`, 'POST', metrics),
    recordEnvironmentFailure: (id, failure) => request(`/api/runs/${id}/failures`, 'POST', failure),
    recordAgentFailure: (id, failure) => request(`/api/runs/${id}/agent-failures`, 'POST', failure),
    endRun: (id, options = {}) => request(`/api/runs/${id}/end`, 'POST', options),
    cleanupRun: id => request(`/api/runs/${id}/cleanup`, 'POST', {}),
    getResult: id => request(`/api/runs/${id}/result`),
    publicKeyPath: config.publicKeyPath,
  };
}
module.exports = { createClient, DEFAULT_CONTROL_PATH };
