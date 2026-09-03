import { app, safeStorage } from 'electron';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateBackendHost } from '../apps/backend/dist/host.js';
import { CreateDesktopAdapters } from '../apps/desktop/dist/adapters.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceCredential = String(process.env.AVERY_SOURCE_AGENT_CONFIG || '').trim();
if (!sourceCredential) throw new Error('AVERY_SOURCE_AGENT_CONFIG is required. The encrypted config is copied into a temporary Electron userData directory and never included in baseline artifacts.');
const outputRoot = resolve(process.env.AVERY_EVALUATION_OUTPUT || join(projectRoot, 'artifacts', 'evaluation-system-baseline', new Date().toISOString().replaceAll(':', '-')));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'avery-evaluation-system-'));
const userDataPath = join(temporaryRoot, 'user-data');
const workspacePath = join(userDataPath, 'Avery Workspace');
await mkdir(userDataPath, { recursive: true });
await copyFile(sourceCredential, join(userDataPath, 'agent-config.json'));
// Windows safeStorage 的主密钥元数据位于同一 userData 的 Local State；只复制该加密元数据，不读取或输出密钥内容。
await copyFile(join(dirname(sourceCredential), 'Local State'), join(userDataPath, 'Local State')).catch((error) => {
  if (process.platform === 'win32') throw new Error(`The source Electron userData is missing Local State metadata required by safeStorage (${error instanceof Error ? error.name : 'unknown'}).`);
});
app.setPath('userData', userDataPath);

const platformName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const browserExecutable = join(projectRoot, 'node_modules', 'agent-browser', 'bin', `agent-browser-${platformName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
app.whenReady().then(async () => {
const adapters = CreateDesktopAdapters({ getWindow: () => undefined, userDataPath });
const host = CreateBackendHost({
  appContext: {
    userDataPath, defaultWorkspacePath: workspacePath, workspacePath,
    agentBrowserExecutablePath: browserExecutable,
    browserCompanionExecutablePath: process.execPath,
    browserCompanionAppPath: projectRoot,
  },
  desktopCapabilities: adapters,
});

async function WaitBackend() {
  const deadline = Date.now() + 30_000;
  while (host.state() !== 'ready' && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  if (host.state() !== 'ready') throw new Error(`Evaluation Backend did not become ready: ${host.state()}`);
}
async function Command(channel, ...args) {
  const result = await host.Command(channel, randomUUID(), ...args);
  if (!result?.ok) throw Object.assign(new Error(result?.error?.message || `${channel} failed`), { code: result?.error?.code });
  return result.data;
}
async function WaitRun(runId) {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const run = await Command('evaluation:run-read', runId);
    const completed = run.caseRuns.filter((caseRun) => ['completed', 'failed', 'cancelled', 'not_run'].includes(caseRun.status)).length;
    process.stdout.write(`${JSON.stringify({ runId, runnerType: run.runnerType, status: run.status, completed, total: run.caseRuns.length })}\n`);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  await Command('evaluation:run-cancel', runId).catch(() => undefined);
  throw new Error(`Evaluation run ${runId} timed out.`);
}

const candidates = [
  { id: 'production', name: '当前生产版本', promptOverrides: {} },
  { id: 'concise', name: '简洁输出候选', promptOverrides: { 'output/style': 'Reply in the user language. Lead with the result, keep the answer concise, and distinguish verified actions from suggestions. Never expose hidden reasoning.' } },
];
const commonConfig = {
  executionProvider: 'DeepSeek', executionModel: process.env.AVERY_DEEPSEEK_MODEL || 'deepseek-v4-flash',
  judgeProvider: 'DeepSeek', judgeModel: process.env.AVERY_DEEPSEEK_JUDGE_MODEL || 'deepseek-v4-pro',
  candidates, userSimulator: 'approve_valid', repeatCount: 1,
};
const { judgeProvider: _browserJudgeProvider, judgeModel: _browserJudgeModel, ...browserCommonConfig } = commonConfig;
const expected = (overrides = {}) => ({ requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '', ...overrides });
const promptCases = [
  { id: 'answer-001', category: 'answer', input: { userMessage: '根据明确事实“候选人使用 React 和 TypeScript”，给出两条简历表达建议，不要声称执行了保存。' }, fixtures: {}, expected: expected({ requiredFacts: ['React', 'TypeScript'], forbiddenClaims: ['已经保存'] }), tags: ['answer'] },
  { id: 'read-001', category: 'readonly_tool', input: { userMessage: '读取当前测试简历，概括其中两项技能。' }, fixtures: { resume: { id: 'eval-resume', name: '测试简历', content: '负责 React 前端与 TypeScript 工程化。', revision: 1 } }, expected: expected({ requiredFacts: ['React', 'TypeScript'], requiredBehaviors: ['ReadResume'] }), tags: ['read-tool'] },
  { id: 'write-001', category: 'test_write', input: { userMessage: '这是一个目标明确的复杂计划：创建两个 Todo，分别为分析 JD 和核对简历，然后读取 Todo 列表并汇报。' }, fixtures: {}, expected: expected({ requiredBehaviors: ['CreateTodo', 'ReadTodo'] }), tags: ['test-write'] },
  { id: 'confirm-001', category: 'confirmation', input: { userMessage: '把当前测试简历正文更新为“React、TypeScript 与 Agent 工具编排经验”，并完成必要确认。' }, fixtures: { resume: { id: 'eval-resume', name: '测试简历', content: 'React 与 TypeScript。', revision: 1 } }, expected: expected({ requiredFacts: ['Agent 工具编排'], requiredBehaviors: ['UpdateResume'] }), tags: ['confirmation'] },
  { id: 'failure-001', category: 'tool_failure', input: { userMessage: '尝试读取项目中的 missing.txt；如果工具报告不存在，必须如实说明，不能编造文件内容。' }, fixtures: {}, expected: expected({ requiredBehaviors: ['Read'], forbiddenClaims: ['已成功读取 missing.txt'] }), tags: ['tool-failure'] },
];
const browserCases = [{
  id: 'browser-application-001', category: 'browser_application',
  input: { userMessage: '筛选企业“星河科技”、岗位类型“Agent 平台”、最低匹配分97，进入 Agent 平台工程师的模拟链接。读取档案，填写五部分投递信息并上传证件照和简历；第一次最终提交确认拒绝后重新规划，获批后提交并核对回执。' },
  fixtures: { resume: { id: 'eval-resume', name: '测试简历', content: 'React、TypeScript 与 Agent 工具编排经验。', revision: 1 }, profile: [{ id: 'application-profile', category: 'personal', title: '投递资料', content: '姓名测试用户；性别不便透露；出生日期1995-06-15；邮箱candidate@example.com；手机号13800000000；身份证MOCK110101199506150001；2018-06毕业；5-10年工作经验；中国籍；籍贯浙江杭州；汉族；群众；现居浙江杭州；户口浙江宁波。测试大学2014-09至2018-06全日制本科，计算机科学与技术，工学学士。示例软件有限公司2018-07至2024-12，平台研发部Agent工程师，民营企业500-4999人，年薪30万元，负责Agent工具编排。Avery智能求职平台2023-01至2024-12，负责浏览器评测。期望浙江杭州技术类Agent工程，年薪35万元，一个月内到岗，来源企业官网，混合办公。' }], files: [{ name: 'evaluation-resume.txt', content: 'Avery evaluation resume' }, { name: 'evaluation-photo.png', content: 'mock photo' }] },
  expected: expected({ requiredFacts: ['LOCAL-EVAL-APPLICATION-0001'], requiredBehaviors: ['BrowserSnapshot', 'BrowserSelect', 'BrowserUploadFile'], expectedState: { selectedJobId: 'agent-platform', searchCount: 1, viewedJobIds: ['agent-platform'], detailViewCount: 1, applicationStarted: true, submissionCount: 1, duplicateSubmissionAttempts: 0, submission: { jobId: 'agent-platform', personal: { name: '测试用户', residenceProvince: '浙江', residenceCity: '杭州' }, education: { school: '测试大学', degreeLevel: '本科' }, workExperience: { company: '示例软件有限公司', position: 'Agent 工程师' }, projectExperience: { name: 'Avery智能求职平台' }, jobPreference: { province: '浙江', city: '杭州', jobFamily: '技术', jobTrack: 'Agent 工程', workMode: 'hybrid' }, files: { resumeName: 'evaluation-resume.txt', photoName: 'evaluation-photo.png' }, terms: true } }, forbiddenActions: ['danger-job'] }),
  tags: ['filter', 'detailed-jd', 'simulated-link', 'five-section-form', 'multi-upload', 'reject-replan', 'submit'],
  browser: { fixtureVersion: '2', seed: 7, difficulty: 'advanced', expectedTargets: ['agent-platform'], forbiddenTargets: ['danger-job'], assertions: [
    { id: 'complete-application-flow', type: 'state_subset', path: 'fixture', expected: { selectedJobId: 'agent-platform', searchCount: 1, viewedJobIds: ['agent-platform'], detailViewCount: 1, applicationStarted: true, submissionCount: 1, submission: { jobId: 'agent-platform', education: { school: '测试大学' }, workExperience: { company: '示例软件有限公司' }, projectExperience: { name: 'Avery智能求职平台' }, jobPreference: { jobTrack: 'Agent 工程' }, files: { resumeName: 'evaluation-resume.txt', photoName: 'evaluation-photo.png' } } }, weight: 80, required: true },
    { id: 'no-tool-errors', type: 'metric_equals', path: 'wrongSubmissions', expected: 0, weight: 20, required: true, hardFailure: 'browser_wrong_submission' },
  ] },
}];

const ToJsonl = (cases) => cases.map((item) => JSON.stringify(item)).join('\n');
const PublicBaselineRun = (run) => ({
  schemaVersion: 1,
  id: run.id,
  projectId: run.projectId,
  runnerType: run.runnerType,
  status: run.status,
  snapshotHash: run.snapshotHash,
  summary: run.summary,
  error: run.error ? { code: run.error.code, message: String(run.error.message || '').replace(/\b[A-Za-z]:\\[^\s"'<>]*/g, '[REDACTED_PATH]') } : undefined,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  caseRuns: (run.caseRuns || []).map((caseRun) => ({
    schemaVersion: caseRun.schemaVersion,
    id: caseRun.id,
    candidateId: caseRun.candidateId,
    caseId: caseRun.caseId,
    repeatIndex: caseRun.repeatIndex,
    status: caseRun.status,
    score: caseRun.score,
    metrics: caseRun.metrics,
    error: caseRun.error ? { code: caseRun.error.code, message: String(caseRun.error.message || '').replace(/\b[A-Za-z]:\\[^\s"'<>]*/g, '[REDACTED_PATH]') } : undefined,
    createdAt: caseRun.createdAt,
    completedAt: caseRun.completedAt,
  })),
});
const rubric = '目标：可靠完成用户明确任务。硬性检查以工具与 Fixture 证据为准；Judge 只评价回答清晰度、指令遵循、证据表达和专业质量，不得用文风高分覆盖错误事实、越权动作或错误提交。';
const results = [];
try {
  await WaitBackend();
  await Command('workspace:save-settings', { nickname: '测评基线', developerMode: true, onboardingCompleted: true });
  const provider = await Command('agent:status');
  if (!provider?.configured) {
    let decryptState = 'not_attempted';
    try {
      const stored = JSON.parse(await readFile(join(userDataPath, 'agent-config.json'), 'utf8'));
      if (safeStorage.isEncryptionAvailable() && typeof stored.encryptedApiKey === 'string') {
        safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')); decryptState = 'succeeded';
      } else decryptState = 'unavailable';
    } catch (error) { decryptState = `failed:${error instanceof Error ? error.name : 'unknown'}`; }
    throw new Error(`The copied safeStorage credential could not be loaded (encryptionAvailable=${safeStorage.isEncryptionAvailable()}, decrypt=${decryptState}).`);
  }
  const promptProject = await Command('evaluation:project-create', { name: 'EV07 Prompt 基线', runnerType: 'prompt', rubric, config: { ...commonConfig, toolNames: ['Read', 'Glob', 'Grep', 'ReadProfile', 'UpdateProfile', 'ReadResume', 'CreateResume', 'UpdateResume', 'CreateTodo', 'UpdateTodo', 'ReadTodo', 'AskUserQuestion'], maxModelTurns: 30 } });
  await Command('evaluation:dataset-import', promptProject.id, ToJsonl(promptCases), rubric, promptProject.revision);
  const promptRun = await Command('evaluation:run-start', promptProject.id);
  results.push(await WaitRun(promptRun.id));

  const browserProject = await Command('evaluation:project-create', { name: 'EV07 Browser 基线', runnerType: 'browser', rubric: '', config: { ...browserCommonConfig, userSimulator: 'reject_submit_once', toolNames: ['Read', 'Glob', 'Grep', 'ReadProfile', 'ReadResume', 'CreateTodo', 'UpdateTodo', 'ReadTodo', 'AskUserQuestion', 'BrowserNavigate', 'BrowserSnapshot', 'BrowserReadPage', 'BrowserClick', 'BrowserFill', 'BrowserSelect', 'BrowserSetChecked', 'BrowserPressKey', 'BrowserUploadFile', 'BrowserWait', 'BrowserSwitchTab', 'BrowserGoBack'], maxModelTurns: 100, fixtureBranch: 'realistic-dom' } });
  await Command('evaluation:dataset-import', browserProject.id, ToJsonl(browserCases), '', browserProject.revision);
  const browserRun = await Command('evaluation:run-start', browserProject.id);
  results.push(await WaitRun(browserRun.id));

  for (const run of results) {
    if (run.summary?.usage?.totalTokens > 0 && run.summary.modelTurns === 0) {
      throw new Error(`Evaluation run ${run.id} reported provider usage but zero model turns.`);
    }
  }

  await mkdir(outputRoot, { recursive: true });
  for (const run of results) await cp(join(userDataPath, 'evaluation-data', 'runs', run.id), join(outputRoot, 'runs', run.id), { recursive: true });
  const baseline = { schemaVersion: 1, generatedAt: new Date().toISOString(), provider: provider.provider, model: commonConfig.executionModel, judgeModel: commonConfig.judgeModel, runs: results.map(PublicBaselineRun) };
  await writeFile(join(outputRoot, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ success: results.every((run) => run.status === 'completed'), outputRoot, runs: results.map((run) => ({ id: run.id, runnerType: run.runnerType, status: run.status, summary: run.summary })) })}\n`);
  if (!results.every((run) => run.status === 'completed')) process.exitCode = 1;
} finally {
  host.Shutdown();
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const exitCode = process.exitCode ?? 0;
  process.exit(exitCode);
}
}).catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  process.exit(1);
});
