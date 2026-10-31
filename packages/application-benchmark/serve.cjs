'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { RunStore, ApiError, definitions, RUN_ID } = require('./run-store.cjs');
const ROOT = __dirname;
const DEFAULT_DATA_ROOT = path.resolve(ROOT, '../output/career-portal-runtime-v2');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'engine.js', 'runtime-client.js', 'sync-state.js', 'mark.svg']);
function sameToken(a, b) { if (!a || !b) return false; return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest()); }
async function readJson(request, max = 2 * 1024 * 1024) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', '请求必须使用 application/json');
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > max) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new ApiError(400, 'INVALID_JSON', '请求 JSON 无效'); }
}
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); }
/** 控制令牌仅交给本地 Runner，页面只拿到单轮能力令牌；两类接口均不启用跨站访问。 */
async function startServer(options = {}) {
  const dataRoot = options.dataRoot || process.env.CAREER_DATA_ROOT || DEFAULT_DATA_ROOT;
  const store = await new RunStore(dataRoot).init();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, store.baseUrl || 'http://127.0.0.1');
      if (request.headers.host !== new URL(store.baseUrl).host) throw new ApiError(403, 'INVALID_HOST', '仅接受本机服务地址');
      if (request.headers.origin && request.headers.origin !== store.baseUrl) throw new ApiError(403, 'CROSS_ORIGIN_DENIED', '拒绝跨来源请求');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/api/health' && request.method === 'GET') { json(response, 200, { ok: true, version: '2.0.0' }); return; }
      const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
      const admin = sameToken(token, store.adminToken);
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/scenarios' && request.method === 'GET') { if (!admin) throw new ApiError(401, 'CONTROLLER_AUTH_REQUIRED', '需要控制端认证'); json(response, 200, store.listScenarios()); return; }
        if (pathname === '/api/scenarios' && request.method === 'POST') { if (!admin) throw new ApiError(401, 'CONTROLLER_AUTH_REQUIRED', '需要控制端认证'); json(response, 201, await store.registerCase(await readJson(request, 17 * 1024 * 1024))); return; }
        if (pathname === '/api/runs' && request.method === 'POST') { if (!admin) throw new ApiError(401, 'CONTROLLER_AUTH_REQUIRED', '需要控制端认证'); json(response, 201, await store.create(await readJson(request))); return; }
        const match = pathname.match(/^\/api\/runs\/([^/]+)(?:\/(.*))?$/);
        if (!match || !RUN_ID.test(match[1])) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
        const [, id, action = 'state'] = match;
        if (action === 'result' && request.method === 'GET' && admin) { try { json(response, 200, JSON.parse(await fs.readFile(path.join(store.root, 'results', `${id}.json`), 'utf8'))); } catch (error) { if (error.code === 'ENOENT') throw new ApiError(404, 'RESULT_NOT_FOUND', '本轮结果不存在或尚未结束'); throw error; } return; }
        const run = store.get(id), authorized = admin || sameToken(token, run.access);
        if (!authorized) throw new ApiError(401, 'RUN_AUTH_REQUIRED', '需要本轮访问令牌');
        if (['metrics', 'failures', 'agent-failures', 'end', 'cleanup', 'result'].includes(action) && !admin) throw new ApiError(403, 'CONTROLLER_ONLY', '此接口仅允许控制端访问');
        if (action === 'state' && request.method === 'GET') json(response, 200, store.view(run));
        else if (action === 'events' && request.method === 'GET') {
          const after = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, 'INVALID_CURSOR', '事件游标无效');
          json(response, 200, { events: run.events.filter(event => event.sequence > after), cursor: run.events.length });
        } else if (action === 'state' && request.method === 'PUT') json(response, 200, await store.save(id, await readJson(request)));
        else if (action === 'context' && request.method === 'POST') json(response, 200, await store.context(id, await readJson(request)));
        else if (/^files\/(resume|portfolio)$/.test(action) && request.method === 'POST') {
          const data = await readJson(request, 29 * 1024 * 1024);
          if (typeof data.base64 !== 'string' || data.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || Buffer.from(data.base64, 'base64').toString('base64') !== data.base64) throw new ApiError(400, 'INVALID_BASE64', '附件编码无效');
          json(response, 200, await store.upload(id, action.split('/')[1], Buffer.from(data.base64, 'base64'), data.name));
        } else if (/^files\/(resume|portfolio)$/.test(action) && request.method === 'DELETE') json(response, 200, await store.removeFile(id, action.split('/')[1]));
        else if (action === 'preview' && request.method === 'POST') { const body = await readJson(request); json(response, 200, await store.preview(id, body.revision)); }
        else if (action === 'submit' && request.method === 'POST') json(response, 200, await store.submit(id, await readJson(request)));
        else if (action === 'metrics' && request.method === 'POST') json(response, 200, await store.metrics(id, await readJson(request)));
        else if (action === 'failures' && request.method === 'POST') json(response, 200, await store.environmentFailure(id, await readJson(request)));
        else if (action === 'agent-failures' && request.method === 'POST') json(response, 200, await store.agentFailure(id, await readJson(request)));
        else if (action === 'end' && request.method === 'POST') { const body = await readJson(request); if (body.metrics) await store.metrics(id, body.metrics); const result = await store.end(id); if (body.cleanup) await store.cleanup(id); json(response, 200, result); }
        else if (action === 'cleanup' && request.method === 'POST') { await readJson(request); json(response, 200, await store.cleanup(id)); }
        else if (action === 'result' && request.method === 'GET') { if (!run.endedAt) throw new ApiError(409, 'END_REQUIRED', '请先结束本轮'); json(response, 200, JSON.parse(await fs.readFile(path.join(store.root, 'results', `${id}.json`), 'utf8'))); }
        else throw new ApiError(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
      if (pathname === '/') {
        if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
        const created = await store.create({ scenarioId: url.searchParams.get('scenario') || 'baseline', goal: url.searchParams.get('goal') || 'submit', seed: 1 });
        response.writeHead(302, { Location: created.url, 'Cache-Control': 'no-store' }); response.end(); return;
      }
      const route = pathname.match(/^\/runs\/([^/]+)\/(.*)$/);
      let resource;
      if (route && RUN_ID.test(route[1])) {
        const run = store.get(route[1]); resource = route[2] || 'index.html';
        if (resource === 'attachment') { const bytes = await fs.readFile(run.scenario.attachmentPath); response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(run.scenario.attachmentName)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(request.method === 'HEAD' ? undefined : bytes); return; }
      }
      else resource = pathname.slice(1);
      if (!PUBLIC_FILES.has(resource)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
      const file = await fs.readFile(path.join(ROOT, resource));
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(resource)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch (error) {
      json(response, error instanceof ApiError ? error.status : 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : '本地服务发生错误', ...(error.details ? { details: error.details } : {}) } });
      if (!(error instanceof ApiError)) console.error(error);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.PORT || 4178), '127.0.0.1', resolve); });
  store.baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(store.root, 'control.json'), JSON.stringify({ baseUrl: store.baseUrl, token: store.adminToken, publicKeyPath: path.join(store.root, 'signing-public.pem') }), { mode: 0o600 });
  server.on('close', () => store.close());
  return { server, store, baseUrl: store.baseUrl };
}
if (require.main === module) startServer().then(({ baseUrl, store }) => console.log(`离线网申测评平台 v2：${baseUrl}\n控制端配置：${path.join(store.root, 'control.json')}\n按 Ctrl+C 停止。`)).catch(error => { console.error('本地服务无法启动：' + error.message); process.exitCode = 1; });
module.exports = { startServer, DEFAULT_DATA_ROOT };
