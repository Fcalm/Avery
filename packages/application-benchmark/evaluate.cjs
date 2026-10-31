'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyEnvelope } = require('./run-store.cjs');
const { score } = require('./scorer.cjs');
const { createScenario } = require('./scenarios.cjs');
const DEFAULT_PUBLIC_KEY = path.resolve(__dirname, '../output/career-portal-runtime-v2/signing-public.pem');
async function evaluateFile(file, keyPath = DEFAULT_PUBLIC_KEY) {
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  if (envelope.format !== 'career-portal-result-v2') {
    const scenario = createScenario('baseline');
    return { ...score(scenario, { state: envelope.application, events: [], files: {} }, false), explanation: '旧版快照或任意 JSON 不包含受信附件、事件与回执证据，不能获得认证分数。请通过本地 Runner 创建轮次并导出签名结果。' };
  }
  let key;
  try { key = await fs.readFile(keyPath, 'utf8'); } catch { return { verified: false, passed: false, score: null, outcome: 'unverified', explanation: '找不到受信公钥。请通过第二个参数指定创建本轮服务的 signing-public.pem，不能使用导出文件自带的任意公钥。' }; }
  if (!verifyEnvelope(envelope, key)) return { verified: false, passed: false, score: null, outcome: 'invalid_signature', explanation: '签名不匹配，记录可能被修改或并非来自受信服务。' };
  return score(envelope.payload.scenario, envelope.payload.evidence, true);
}
if (require.main === module) {
  if (!process.argv[2]) { console.error('用法：node evaluate.cjs <签名结果.json> [受信 signing-public.pem]'); process.exitCode = 1; }
  else evaluateFile(process.argv[2], process.argv[3]).then(result => { console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 2; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { evaluateFile };
