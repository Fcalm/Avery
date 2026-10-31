'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const E = require('./engine.js');
const { createScenario, definitions, hash, clone, profiles, candidateInput, validateParser } = require('./scenarios.cjs');
const { score, digestState, SCORER_VERSION } = require('./scorer.cjs');
const { createResumePdf } = require('./resume-pdf.cjs');
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_EVENTS = new Set(['field_change', 'cascade_reset', 'combo_commit', 'combo_blur_discard', 'month_commit', 'no_work_toggle', 'entry_add', 'entry_remove', 'skills_change', 'upload_reject', 'upload_error', 'action_retry']);
const SCHEMA_KEYS = new Map();
for (const kind of ['实习', '全职']) {
  const state = E.initialState(); state.intention.kind = kind;
  for (const field of E.fields(state)) {
    const keys = field.path.split('.'), section = keys[0];
    if (!SCHEMA_KEYS.has(section)) SCHEMA_KEYS.set(section, new Set());
    SCHEMA_KEYS.get(section).add(keys.at(-1));
  }
}
class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
function validateShape(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail(400, 'INVALID_STATE', 'state 必须是表单对象');
  const rootKeys = new Set(Object.keys(E.initialState()).concat('atsProfile'));
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  function walk(value, depth = 0) {
    if (depth > 8) fail(400, 'INVALID_STATE', '对象层级过深');
    if (typeof value === 'string' && value.length > 10000) fail(400, 'INVALID_STATE', '字段内容过长');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (forbidden.has(key)) fail(400, 'INVALID_STATE', '不允许的对象字段'); walk(child, depth + 1); }
  }
  walk(state);
  if (Object.keys(state).some(key => !rootKeys.has(key))) fail(400, 'INVALID_STATE', '包含未知根字段');
  for (const key of ['intention', 'personal', 'additional', 'files']) if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) fail(400, 'INVALID_STATE', key + ' 必须是对象');
  for (const type of ['education', 'work', 'projects']) {
    if (!Array.isArray(state[type]) || state[type].length > 8 || state[type].some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) fail(400, 'INVALID_STATE', '经历数组格式无效或超过 8 段');
  }
  for (const key of ['noWork', 'truth', 'privacy']) if (typeof state[key] !== 'boolean') fail(400, 'INVALID_STATE', key + ' 必须是布尔值');
  if (!Array.isArray(state.additional.skills) || state.additional.skills.some(item => typeof item !== 'string')) fail(400, 'INVALID_STATE', '专业技能必须是字符串数组');
  for (const key of ['intention', 'personal', 'additional']) for (const [field, value] of Object.entries(state[key])) if (field !== 'skills' && typeof value !== 'string') fail(400, 'INVALID_STATE', key + '.' + field + ' 必须是文本');
  for (const section of ['intention', 'personal', 'additional']) for (const key of Object.keys(state[section])) if (!SCHEMA_KEYS.get(section).has(key)) fail(400, 'INVALID_STATE', '未知字段：' + section + '.' + key);
  for (const type of ['education', 'work', 'projects']) for (const entry of state[type]) for (const [key, value] of Object.entries(entry)) {
    if (key === 'current') { if (typeof value !== 'boolean') fail(400, 'INVALID_STATE', 'current 必须是布尔值'); }
    else if (key === '_committed') { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) fail(400, 'INVALID_STATE', '确认值格式错误'); }
    else if (typeof value !== 'string') fail(400, 'INVALID_STATE', '经历字段必须是文本');
    if (!['id', 'current', '_committed'].includes(key) && !SCHEMA_KEYS.get(type).has(key)) fail(400, 'INVALID_STATE', '未知经历字段：' + key);
  }
}
function verifyFile(bytes, name, kind) {
  const error = E.validateFile({ name, size: bytes.length }, kind); if (error) fail(400, 'INVALID_FILE', error);
  const ext = name.split('.').pop().toLowerCase();
  const valid = ext === 'pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : ext === 'doc' ? bytes.subarray(0, 4).equals(Buffer.from([208, 207, 17, 224])) : bytes[0] === 80 && bytes[1] === 75;
  if (!valid) fail(400, 'FILE_SIGNATURE_MISMATCH', '文件内容与扩展名不符');
}
/** 每轮独立目录及串行队列；解析、保存、上传和提交在同一队列执行，避免时间竞争改坏证据。 */
class RunStore {
  constructor(root) { this.root = path.resolve(root); this.runs = new Map(); this.queues = new Map(); this.timers = new Map(); this.cases = new Map(); this.baseUrl = ''; }
  async init() {
    await fs.mkdir(path.join(this.root, 'runs'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'results'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'cases'), { recursive: true });
    for (const key of await fs.readdir(path.join(this.root, 'cases'))) if (/^custom-[a-z0-9-]+@\d+\.\d+\.\d+$/.test(key)) this.cases.set(key, JSON.parse(await fs.readFile(path.join(this.root, 'cases', key, 'case.json'), 'utf8')));
    const secretPath = path.join(this.root, 'signing-private.pem');
    try { this.privateKey = await fs.readFile(secretPath, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const pair = crypto.generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      await fs.writeFile(secretPath, this.privateKey, { mode: 0o600, flag: 'wx' });
    }
    this.publicKey = crypto.createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' }).toString();
    await fs.writeFile(path.join(this.root, 'signing-public.pem'), this.publicKey);
    const tokenPath = path.join(this.root, 'controller-token');
    try { this.adminToken = (await fs.readFile(tokenPath, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.adminToken = crypto.randomBytes(32).toString('base64url'); await fs.writeFile(tokenPath, this.adminToken, { mode: 0o600, flag: 'wx' }); }
    const entries = await fs.readdir(path.join(this.root, 'runs'));
    for (const id of entries.filter(id => RUN_ID.test(id))) {
      const run = JSON.parse(await fs.readFile(path.join(this.runPath(id), 'run.json'), 'utf8'));
      this.runs.set(id, run);
      if (!run.endedAt) this.scheduleParser(run);
    }
    return this;
  }
  runPath(id) { if (!RUN_ID.test(id)) fail(400, 'INVALID_RUN_ID', '无效轮次编号'); return path.join(this.root, 'runs', id); }
  get(id) { const run = this.runs.get(id); if (!run) fail(404, 'RUN_NOT_FOUND', '测评轮次不存在或已清理'); return run; }
  active(run) { if (run.endedAt) fail(409, 'RUN_ENDED', '本轮已经结束'); if (run.receipt) fail(409, 'RUN_SUBMITTED', '申请已提交，不可继续修改'); }
  serial(id, action) {
    const previous = this.queues.get(id) || Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.queues.set(id, current); return current.finally(() => { if (this.queues.get(id) === current) this.queues.delete(id); });
  }
  async persist(run) {
    const dir = this.runPath(run.id); await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `run-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify(run)); await fs.rename(temp, path.join(dir, 'run.json'));
  }
  event(run, type, data = {}, actor = 'server') {
    const previous = run.events.at(-1);
    // 附件元数据也有 type（MIME）；不能覆盖事件类型、来源与序号等证据字段。
    const event = { ...data, sequence: run.events.length + 1, at: new Date().toISOString(), actor, type, previousHash: previous?.hash || null };
    event.hash = hash(event); run.events.push(event); return event;
  }
  async create(options = {}) {
    if (this.runs.size >= 1000) fail(409, 'RUN_LIMIT', '请先清理不需要的轮次');
    let scenario;
    try {
      if (this.cases.has(options.scenarioId)) {
        scenario = clone(this.cases.get(options.scenarioId));
        scenario.goal = options.goal ?? 'submit'; scenario.seed = options.seed ?? 1;
        if (!['fill', 'preview', 'submit'].includes(scenario.goal) || !Number.isInteger(scenario.seed) || scenario.seed < 0 || scenario.seed > 4294967295) throw new Error('goal 或 seed 无效');
        scenario.expected.truth = scenario.expected.privacy = scenario.goal !== 'fill' && scenario.expectedMissing.length === 0;
        if (options.parser !== undefined) scenario.parser = validateParser(scenario.expected, options.parser);
        scenario.input = (scenario.customInput ? scenario.customInput + '\n\n' : '') + candidateInput(scenario);
        scenario.inputHash = hash(scenario.input); scenario.hash = hash({ ...scenario, attachmentPath: undefined, hash: undefined });
      } else scenario = createScenario(options.scenarioId, options.goal, options.seed ?? 1, options.parser);
    }
    catch (error) { fail(400, 'INVALID_SCENARIO', error.message); }
    const bytes = this.cases.has(scenario.id) ? await fs.readFile(scenario.attachmentPath) : createResumePdf(scenario.expected);
    scenario.attachmentHash = hash(bytes); scenario.attachmentSize = bytes.length;
    scenario.hash = hash({ definitionHash: scenario.hash, attachmentHash: scenario.attachmentHash });
    const id = crypto.randomUUID(), access = crypto.randomBytes(32).toString('base64url');
    if (!this.cases.has(scenario.id)) {
      await fs.mkdir(this.runPath(id), { recursive: true });
      scenario.attachmentPath = path.join(this.runPath(id), 'input-resume.pdf');
      await fs.writeFile(scenario.attachmentPath, bytes);
    }
    const run = { id, access, scenario, state: clone(scenario.initial), revision: 0, files: {}, events: [], createdAt: new Date().toISOString(), endedAt: null, preview: null, receipt: null, environmentFailures: [], agentFailures: [], browserEnvironment: null, metrics: {}, parser: { generation: 0, jobs: [] }, touched: [] };
    this.event(run, 'run_created', { scenarioId: scenario.id, goal: scenario.goal, seed: scenario.seed, scenarioHash: scenario.hash });
    await this.persist(run); this.runs.set(id, run);
    return { id, url: `${this.baseUrl}/runs/${id}/#access=${access}`, accessToken: access, manifest: this.manifest(run), input: scenario.input, attachmentPath: scenario.attachmentPath, attachmentName: scenario.attachmentName, attachmentUrl: `${this.baseUrl}/runs/${id}/attachment` };
  }
  manifest(run) { const s = run.scenario; return { benchmarkVersion: '2.0.0', scorerVersion: SCORER_VERSION, runId: run.id, scenarioId: s.id, scenarioVersion: s.version, scenarioHash: s.hash, inputHash: s.inputHash, attachmentHash: s.attachmentHash, seed: s.seed, goal: s.goal, referenceDate: s.referenceDate, profileId: s.profileId, createdAt: run.createdAt, endedAt: run.endedAt, environment: { node: process.version, platform: process.platform, browser: run.browserEnvironment || null }, parser: { enabled: s.parser.enabled, stages: s.parser.stages.map(stage => ({ delayMs: stage.delayMs, mode: stage.mode })) } }; }
  listScenarios() { return { scenarios: definitions.map(({ id, title, profile }) => ({ id, title, profile, version: '2.0.0' })).concat([...this.cases.values()].map(s => ({ id: s.id, title: s.title, profile: s.profileId, version: s.version }))) }; }
  async registerCase(body) {
    if (typeof body.id !== 'string' || !/^custom-[a-z0-9][a-z0-9-]{0,39}$/.test(body.id) || typeof body.version !== 'string' || body.version.length > 30 || !/^\d+\.\d+\.\d+$/.test(body.version)) fail(400, 'INVALID_CASE', '自定义 id 以 custom- 开头，version 使用 x.y.z');
    if (typeof body.title !== 'string' || body.title.length > 100 || (body.input !== undefined && (typeof body.input !== 'string' || body.input.length > 50000))) fail(400, 'INVALID_CASE', '标题或输入资料无效');
    if (!profiles[body.profileId]) fail(400, 'INVALID_CASE', 'profileId 必须为 feishu、beisen 或 moka');
    validateShape(body.expected); validateShape(body.initial || E.initialState());
    const key = body.id + '@' + body.version;
    if (this.cases.has(key)) fail(409, 'CASE_VERSION_EXISTS', '已存在相同版本，请发布新版本，不能覆盖历史资料');
    const expected = clone(body.expected), initial = clone(body.initial || E.initialState());
    for (const state of [expected, initial]) { state.files = {}; state.events = []; state.status = 'draft'; state.submission = null; state.atsProfile = body.profileId; for (const f of E.fields(state)) if (f.type === 'combo' && !E.isEmpty(E.get(state, f.path))) E.commitCombo(state, f.path, E.get(state, f.path)); }
    const paths = new Set(E.fields(expected).map(f => f.path));
    for (const name of ['expectedMissing', 'preserve']) if (body[name] !== undefined && (!Array.isArray(body[name]) || body[name].some(value => !paths.has(value)))) fail(400, 'INVALID_CASE', name + ' 包含无效字段');
    const expectedMissing = body.expectedMissing || [];
    const requiredPaths = new Set(E.fields(expected).filter(f => f.required && !f.disabled).map(f => f.path));
    if (expectedMissing.some(key => !requiredPaths.has(key))) fail(400, 'INVALID_CASE', 'expectedMissing 只能包含真实缺失的必填字段');
    if (expectedMissing.some(key => !E.isEmpty(E.get(expected, key)))) fail(400, 'INVALID_CASE', 'expectedMissing 对应的期望值必须留空');
    for (const key of body.preserve || []) if (!equalValue(E.get(initial, key), E.get(expected, key))) fail(400, 'INVALID_CASE', '保留字段的初始值与期望值不一致：' + key);
    const acceptedTexts = body.acceptedTexts || {};
    const textPaths = new Set(E.fields(expected).filter(f => f.type === 'textarea').map(f => f.path));
    if (!acceptedTexts || typeof acceptedTexts !== 'object' || Array.isArray(acceptedTexts) || Object.entries(acceptedTexts).some(([key, values]) => !textPaths.has(key) || !Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string' || value.length > 3000))) fail(400, 'INVALID_CASE', 'acceptedTexts 必须为正文文本域到认可文本数组的映射');
    if (!body.attachment || typeof body.attachment.base64 !== 'string' || body.attachment.base64.length > 15 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.attachment.base64) || typeof body.attachment.name !== 'string' || /[\\/\u0000-\u001f]/.test(body.attachment.name) || body.attachment.name.length > 200) fail(400, 'INVALID_CASE', '需要合法的合成附件 name 与 base64');
    const bytes = Buffer.from(body.attachment.base64, 'base64'); verifyFile(bytes, body.attachment.name, 'resume');
    const scenario = { id: key, version: body.version, title: body.title, referenceDate: '2026-10-30', profileId: body.profileId, profile: clone(profiles[body.profileId]), initial, expected, expectedMissing, preserve: body.preserve || [], acceptedTexts: clone(acceptedTexts), customInput: body.input || '', attachmentName: body.attachment.name, parser: { enabled: false, stages: [] } };
    try { if (body.parser) scenario.parser = validateParser(expected, body.parser); } catch (error) { fail(400, 'INVALID_CASE', error.message); }
    expected.files.resume = { name: body.attachment.name, size: bytes.length };
    const invalid = Object.keys(E.validate(expected)).filter(key => !expectedMissing.includes(key) && !['truth', 'privacy'].includes(key)); delete expected.files.resume;
    if (invalid.length) fail(400, 'INVALID_EXPECTATION', '期望资料不符合表单规则', invalid);
    const dir = path.join(this.root, 'cases', key); await fs.mkdir(dir, { recursive: true });
    scenario.attachmentPath = path.join(dir, body.attachment.name);
    await fs.writeFile(scenario.attachmentPath, bytes); await fs.writeFile(path.join(dir, 'case.json'), JSON.stringify(scenario)); this.cases.set(key, scenario);
    return { scenarioId: key, version: body.version, registered: true };
  }
  async context(id, data) { return this.serial(id, async () => {
    const run = this.get(id); this.active(run);
    if (!data || typeof data.userAgent !== 'string' || data.userAgent.length > 500 || !Number.isInteger(data.width) || data.width < 0 || data.width > 10000 || !Number.isInteger(data.height) || data.height < 0 || data.height > 10000 || !Number.isFinite(data.dpr) || data.dpr < 0.1 || data.dpr > 10) fail(400, 'INVALID_CONTEXT', '浏览器环境记录无效');
    run.browserEnvironment = { userAgent: data.userAgent, width: data.width, height: data.height, dpr: data.dpr };
    this.event(run, 'browser_context_reported', run.browserEnvironment, 'client'); await this.persist(run); return { recorded: true };
  }); }
  view(run) { return { manifest: this.manifest(run), revision: run.revision, state: { ...clone(run.state), events: clone(run.events) }, profile: run.scenario.profile, parserPending: run.parser.jobs.some(job => job.status === 'pending'), preview: run.preview, receipt: run.receipt }; }
  checkRevision(run, revision) { if (!Number.isInteger(revision) || revision !== run.revision) fail(409, 'REVISION_CONFLICT', '资料已由解析或其他页面更新，请核对最新资料', this.view(run)); }
  async save(id, body) { return this.serial(id, async () => {
    const run = this.get(id); this.active(run);
    if (body.revision !== run.revision) { this.event(run, 'state_conflict', { receivedRevision: body.revision ?? null, revision: run.revision }); await this.persist(run); }
    this.checkRevision(run, body.revision); validateShape(body.state);
    if (!Array.isArray(body.events || []) || (body.events || []).length > 2000) fail(400, 'INVALID_EVENTS', '每次最多发送 2000 条事件');
    const events = (body.events || []).map(event => {
      if (!event || !CLIENT_EVENTS.has(event.type)) fail(400, 'FORGED_EVENT', '客户端不能声明提交、回执或解析事件');
      const data = {};
      for (const key of ['path', 'kind', 'source', 'reason']) if (event[key] !== undefined) { if (typeof event[key] !== 'string' || event[key].length > 300) fail(400, 'INVALID_EVENT', '事件字段无效'); data[key] = event[key]; }
      if (event.queryLength !== undefined) { if (!Number.isInteger(event.queryLength) || event.queryLength < 0 || event.queryLength > 10000) fail(400, 'INVALID_EVENT', '查询长度无效'); data.queryLength = event.queryLength; }
      if (event.id !== undefined && (typeof event.id !== 'string' || !RUN_ID.test(event.id))) fail(400, 'INVALID_EVENT', '事件编号无效');
      return { type: event.type, data, id: event.id };
    });
    const next = clone(body.state); next.files = clone(run.files); next.events = []; next.status = 'draft'; next.submission = null; next.atsProfile = run.scenario.profileId;
    const old = run.state;
    const touchPaths = E.fields(next).map(f => f.path).concat(...['work', 'projects'].map(type => next[type].map((_, i) => `${type}.${i}.current`)));
    for (const fieldPath of touchPaths) if (!equalValue(E.get(old, fieldPath), E.get(next, fieldPath)) && !run.touched.includes(fieldPath)) run.touched.push(fieldPath);
    if (digestState(next) !== digestState(old)) { run.state = next; run.revision++; run.preview = null; this.event(run, 'state_saved', { revision: run.revision, digest: digestState(next) }); }
    const recordedIds = new Set(run.events.filter(event => event.actor === 'client' && event.clientEventId).map(event => event.clientEventId));
    for (const event of events) {
      if (event.id && recordedIds.has(event.id)) continue;
      this.event(run, event.type, { ...event.data, ...(event.id ? { clientEventId: event.id } : {}) }, 'client');
      if (event.id) recordedIds.add(event.id);
    }
    await this.persist(run); return this.view(run);
  }); }
  async upload(id, kind, bytes, name) { return this.serial(id, async () => {
    const run = this.get(id); this.active(run); if (!['resume', 'portfolio'].includes(kind)) fail(400, 'INVALID_FILE_KIND', '不支持的附件类型');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\\/\u0000-\u001f]/.test(name)) fail(400, 'INVALID_FILE_NAME', '文件名无效');
    verifyFile(bytes, name, kind);
    const metadata = { name, size: bytes.length, sha256: hash(bytes), type: name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' };
    await fs.writeFile(path.join(this.runPath(id), `${kind}.bin`), bytes);
    run.files[kind] = metadata; run.state.files = clone(run.files); run.revision++; run.preview = null;
    this.event(run, 'upload_verified', { kind, ...metadata, mimeType: metadata.type });
    if (kind === 'resume') {
      this.cancelParser(run); run.parser.generation++;
      if (run.scenario.parser.enabled) {
        const start = Date.now();
        run.parser.jobs = run.scenario.parser.stages.map((stage, index) => ({ id: crypto.randomUUID(), index, generation: run.parser.generation, dueAt: start + stage.delayMs, status: 'pending' }));
        this.event(run, 'parser_scheduled', { generation: run.parser.generation, jobs: run.parser.jobs.map(job => ({ id: job.id, dueAt: job.dueAt })) });
      }
    }
    await this.persist(run); this.scheduleParser(run); return this.view(run);
  }); }
  async removeFile(id, kind) { return this.serial(id, async () => {
    const run = this.get(id); this.active(run); if (!['resume', 'portfolio'].includes(kind)) fail(400, 'INVALID_FILE_KIND', '不支持的附件类型');
    await fs.rm(path.join(this.runPath(id), `${kind}.bin`), { force: true });
    delete run.files[kind]; run.state.files = clone(run.files); run.revision++; run.preview = null;
    if (kind === 'resume') { this.cancelParser(run); run.parser.generation++; }
    this.event(run, 'upload_removed', { kind }); await this.persist(run); return this.view(run);
  }); }
  cancelParser(run) {
    for (const job of run.parser.jobs) if (job.status === 'pending') { job.status = 'cancelled'; clearTimeout(this.timers.get(job.id)); this.timers.delete(job.id); this.event(run, 'parser_cancelled', { jobId: job.id }); }
  }
  scheduleParser(run) {
    for (const job of run.parser.jobs) {
      if (job.status !== 'pending' || this.timers.has(job.id)) continue;
      const timer = setTimeout(() => {
        this.timers.delete(job.id);
        this.serial(run.id, () => this.applyParse(run.id, job.id)).catch(async error => {
          if (this.runs.has(run.id)) { run.environmentFailures.push({ code: 'PARSER_RUNTIME_FAILURE', message: error.message }); await this.persist(run).catch(() => undefined); }
        });
      }, Math.max(0, job.dueAt - Date.now()));
      timer.unref(); this.timers.set(job.id, timer);
    }
  }
  async applyParse(id, jobId) {
    const run = this.get(id), job = run.parser.jobs.find(item => item.id === jobId);
    if (!job || job.status !== 'pending' || run.endedAt || run.receipt || job.generation !== run.parser.generation) return;
    const stage = run.scenario.parser.stages[job.index], changed = [], skipped = [];
    for (const [fieldPath, value] of Object.entries(stage.values)) {
      const parts = fieldPath.split('.');
      if (['education', 'work', 'projects'].includes(parts[0])) {
        const index = Number(parts[1]);
        while (run.state[parts[0]].length <= index) run.state[parts[0]].push(E.emptyEntry(parts[0], `${parts[0]}-parsed-${run.state[parts[0]].length}`));
      }
      if ((stage.mode === 'fill-empty' && !E.isEmpty(E.get(run.state, fieldPath))) || (stage.mode === 'untouched-only' && run.touched.includes(fieldPath))) { skipped.push(fieldPath); continue; }
      const oldValue = E.get(run.state, fieldPath);
      const f = E.fields(run.state).find(item => item.path === fieldPath);
      if (f?.type === 'combo') E.commitCombo(run.state, fieldPath, clone(value)); else E.set(run.state, fieldPath, clone(value));
      changed.push({ path: fieldPath, previous: oldValue ?? '', value: clone(value), overwrote: !E.isEmpty(oldValue) && !equalValue(oldValue, value) });
    }
    job.status = 'applied'; run.revision++; run.preview = null;
    this.event(run, 'parser_applied', { jobId: job.id, mode: stage.mode, revision: run.revision, changed, skipped });
    await this.persist(run);
  }
  async filesEvidence(run) {
    const evidence = {};
    for (const [kind, metadata] of Object.entries(run.files)) {
      try { const bytes = await fs.readFile(path.join(this.runPath(run.id), `${kind}.bin`)); evidence[kind] = { ...metadata, exists: true, sha256: hash(bytes), size: bytes.length }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; evidence[kind] = { ...metadata, exists: false, sha256: null }; }
    }
    return evidence;
  }
  async validateForPreview(run) {
    if (run.parser.jobs.some(job => job.status === 'pending')) fail(409, 'PARSER_PENDING', '简历仍在解析，请待解析结束后核对资料');
    const errors = E.validate(run.state); if (Object.keys(errors).length) fail(422, 'FORM_INVALID', '请先完成表单校验', errors);
    const files = await this.filesEvidence(run);
    if (!files.resume?.exists || Object.entries(files).some(([kind, file]) => !file.exists || file.sha256 !== run.files[kind].sha256)) fail(422, 'FILE_NOT_PROVEN', '附件本体缺失或内容发生变化，请重新上传');
    return files;
  }
  async preview(id, revision) { return this.serial(id, async () => {
    const run = this.get(id); this.active(run); this.checkRevision(run, revision);
    this.event(run, 'preview_attempt');
    try { await this.validateForPreview(run); }
    catch (error) { this.event(run, 'preview_rejected', { code: error.code }); await this.persist(run); throw error; }
    run.preview = { id: crypto.randomUUID(), digest: digestState(run.state), revision: run.revision, at: new Date().toISOString() };
    this.event(run, 'preview_validated', { previewId: run.preview.id, digest: run.preview.digest, revision: run.revision });
    await this.persist(run); return this.view(run);
  }); }
  async submit(id, body) { return this.serial(id, async () => {
    const run = this.get(id); if (run.endedAt) fail(409, 'RUN_ENDED', '本轮已经结束');
    if (run.receipt) { if (body.previewId !== run.receipt.previewId) fail(409, 'PREVIEW_MISMATCH', '预览编号不匹配'); return this.view(run); }
    this.checkRevision(run, body.revision); await this.validateForPreview(run);
    if (!run.preview || body.previewId !== run.preview.id || run.preview.digest !== digestState(run.state)) fail(409, 'PREVIEW_REQUIRED', '请先打开当前资料的有效预览');
    run.receipt = { id: 'SG-' + crypto.randomUUID(), runId: id, previewId: run.preview.id, digest: run.preview.digest, fileHashes: Object.fromEntries(Object.entries(run.files).map(([kind, file]) => [kind, file.sha256])), at: new Date().toISOString() };
    run.state.status = 'submitted'; run.state.submission = clone(run.receipt);
    this.event(run, 'submission_success', { receiptId: run.receipt.id, previewId: run.preview.id, digest: run.receipt.digest, revision: run.revision });
    await this.persist(run); return this.view(run);
  }); }
  async metrics(id, data) { return this.serial(id, async () => {
    const run = this.get(id); if (run.endedAt) fail(409, 'RUN_ENDED', '本轮已经结束');
    const allowed = new Set(['tokens', 'retries', 'agent', 'model']);
    if (!data || Object.keys(data).some(key => !allowed.has(key))) fail(400, 'INVALID_METRICS', '只允许 tokens、retries、agent、model');
    if (data.tokens !== undefined && (!data.tokens || Object.keys(data.tokens).some(key => !['input', 'output', 'cached'].includes(key)) || Object.values(data.tokens).some(value => !Number.isSafeInteger(value) || value < 0))) fail(400, 'INVALID_METRICS', 'Token 必须是非负整数');
    if (data.retries !== undefined && (!Number.isSafeInteger(data.retries) || data.retries < 0)) fail(400, 'INVALID_METRICS', '重试次数必须是非负整数');
    for (const key of ['agent', 'model']) if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > 200)) fail(400, 'INVALID_METRICS', 'Agent 或模型名称无效');
    Object.assign(run.metrics, data); this.event(run, 'metrics_reported', { ...data, source: 'controller' }); await this.persist(run); return clone(run.metrics);
  }); }
  async environmentFailure(id, data) { return this.serial(id, async () => {
    const run = this.get(id); if (run.endedAt) fail(409, 'RUN_ENDED', '本轮已经结束');
    if (!data || typeof data.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/.test(data.code) || typeof data.message !== 'string' || data.message.length > 1000) fail(400, 'INVALID_FAILURE', '失败记录需要 code 和 message');
    run.environmentFailures.push({ code: data.code, message: data.message }); this.event(run, 'environment_failure', data); await this.persist(run); return { recorded: true };
  }); }
  async agentFailure(id, data) { return this.serial(id, async () => {
    const run = this.get(id); if (run.endedAt) fail(409, 'RUN_ENDED', '本轮已经结束');
    if (!data || typeof data.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/.test(data.code) || typeof data.message !== 'string' || data.message.length > 1000) fail(400, 'INVALID_FAILURE', '失败记录需要 code 和 message');
    run.agentFailures ||= []; run.agentFailures.push({ code: data.code, message: data.message }); this.event(run, 'agent_failure', data); await this.persist(run); return { recorded: true };
  }); }
  async evidence(run) { return { state: clone(run.state), files: await this.filesEvidence(run), events: clone(run.events), preview: clone(run.preview), receipt: clone(run.receipt), parserPending: run.parser.jobs.some(job => job.status === 'pending'), metrics: clone(run.metrics), environmentFailures: clone(run.environmentFailures), agentFailures: clone(run.agentFailures || []), elapsedMs: Math.max(0, Date.now() - Date.parse(run.createdAt)) }; }
  sign(payload) { const body = JSON.stringify(payload); return { format: 'career-portal-result-v2', keyId: hash(this.publicKey), payload, signature: crypto.sign(null, Buffer.from(body), this.privateKey).toString('base64') }; }
  async end(id, options = {}) { return this.serial(id, async () => {
    const run = this.get(id);
    if (run.endedAt) return JSON.parse(await fs.readFile(path.join(this.root, 'results', `${id}.json`), 'utf8'));
    const evidence = await this.evidence(run);
    run.endedAt = new Date().toISOString(); this.cancelParser(run);
    this.event(run, 'run_ended', { parserWasPending: evidence.parserPending }); evidence.events = clone(run.events);
    const result = this.sign({ manifest: this.manifest(run), scenario: run.scenario, evidence, report: score(run.scenario, evidence, true) });
    await fs.writeFile(path.join(this.root, 'results', `${id}.json`), JSON.stringify(result, null, 2)); await this.persist(run);
    return result;
  }); }
  async cleanup(id) {
    await this.serial(id, async () => {
      const run = this.get(id); if (!run.endedAt) fail(409, 'END_REQUIRED', '请先结束并保存结果，再清理轮次');
      this.cancelParser(run);
      const target = path.resolve(this.runPath(id)), boundary = path.resolve(this.root, 'runs') + path.sep;
      // 递归删除只允许由已校验 UUID 定位的轮次目录，签名结果与其他轮次始终保留。
      if (!target.startsWith(boundary) || path.dirname(target) !== path.resolve(this.root, 'runs')) throw new Error('清理路径超出轮次目录');
      await fs.rm(target, { recursive: true, force: true }); this.runs.delete(id);
    });
    return { cleaned: true, resultRetained: true };
  }
  close() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}
function equalValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function verifyEnvelope(envelope, publicKey) {
  if (envelope?.format !== 'career-portal-result-v2' || typeof envelope.signature !== 'string' || !envelope.payload || envelope.keyId !== hash(publicKey)) return false;
  try { return crypto.verify(null, Buffer.from(JSON.stringify(envelope.payload)), publicKey, Buffer.from(envelope.signature, 'base64')); } catch { return false; }
}
module.exports = { RunStore, ApiError, validateShape, verifyFile, verifyEnvelope, RUN_ID, definitions };
