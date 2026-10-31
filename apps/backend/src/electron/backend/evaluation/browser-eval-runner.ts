import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalDatasetCase, EvalPromptCandidate, EvalUserSimulatorStrategy } from '@avery/contracts';
import type { CompiledInstructions, ScenarioSnapshot } from '@avery/agent-sdk';
import { ApplicationScenario, BuildApplicationPromptFragments, CompilePrompt } from '@avery/agent-modules-defaults';
import { AgentBrowserError, AgentBrowserRuntime } from '../agent-browser-runtime';
import type { BrowserExtensionBridge } from '../browser-extension-bridge';
import { AgentHost } from '../agent-host';
import { EvalTestBusiness } from './eval-test-business';
import { StartEvalBrowserFixture } from './browser-fixture-server';
import { BrowserUserSimulator } from './browser-user-simulator';
import { CountEvalModelTurns } from './eval-runner-metrics';
import { StartApplicationBenchmark } from './career-portal-fixture';

export interface BrowserEvalCaseInput {
  runId: string;
  caseRunId: string;
  candidate: EvalPromptCandidate & { compiledPrompt?: CompiledInstructions };
  testCase: EvalDatasetCase;
  model: string;
  toolNames: string[];
  maxModelTurns: number;
  userSimulator: EvalUserSimulatorStrategy;
  fixtureBranch: 'clean' | 'realistic-dom' | 'career-portal';
  browserEngine: 'chrome' | 'edge' | 'ego';
  closeTaskTabs?: boolean;
  caseRoot: string;
  signal: AbortSignal;
}

export interface BrowserEvalCaseResult {
  finalResponse: string;
  events: Array<{ type: string; createdAt: number; payload: Record<string, unknown> }>;
  finalState: Record<string, unknown>;
  metrics: Record<string, number | boolean | null>;
}

interface BrowserEvalRunnerOptions {
  credentialPort: any;
  browserExtensionBridge: BrowserExtensionBridge;
  externalBrowserPaths: Partial<Record<'chrome' | 'edge' | 'ego', string>>;
}

export function BuildBrowserEvalPromptFragments(candidate: EvalPromptCandidate) {
  return BuildApplicationPromptFragments().map((fragment) => {
    const override = candidate.promptOverrides[fragment.id];
    return override === undefined ? fragment : { ...fragment, version: `${fragment.version}-eval`, content: override, contentHash: '' };
  });
}

export function CreateExactOriginNormalizer(origin: string, preserveHash = false): (value: unknown) => Promise<string> {
  const allowed = new URL(origin);
  return async (value) => {
    if (typeof value !== 'string') throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Fixture URL is invalid.');
    let url: URL;
    try { url = new URL(value); } catch { throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Fixture URL is invalid.'); }
    if (url.origin !== allowed.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Only the active local evaluation fixture is allowed.');
    }
    if (!preserveHash) url.hash = '';
    return url.toString();
  };
}

function MatchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value, index) => MatchesSubset(actual[index], value));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => MatchesSubset((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
}

/** 测评与生产共用扩展 Bridge；每个案例只隔离任务标签页和业务数据。 */
export class BrowserEvalRunner {
  private options: BrowserEvalRunnerOptions;

  constructor(options: BrowserEvalRunnerOptions) { this.options = options; }

  async Execute(input: BrowserEvalCaseInput): Promise<BrowserEvalCaseResult> {
    const portal = input.fixtureBranch === 'career-portal' ? await StartApplicationBenchmark(input.caseRoot, input.testCase) : null;
    const fixture = portal ?? await StartEvalBrowserFixture();
    try { return await this.ExecuteInEnvironment(input, fixture, portal); }
    catch (error) {
      // 尚未进入 Agent 循环的目录、浏览器和 Host 初始化错误属于环境；执行期保留原始证据与归类。
      if (portal && error instanceof Error && !('evalEvidence' in error)) Object.assign(error, { category: 'environment' });
      await portal?.fail(error, input.signal.aborted);
      throw error;
    } finally { await fixture.close(); }
  }

  private async ExecuteInEnvironment(input: BrowserEvalCaseInput, fixture: Awaited<ReturnType<typeof StartEvalBrowserFixture>>, portal: Awaited<ReturnType<typeof StartApplicationBenchmark>> | null): Promise<BrowserEvalCaseResult> {
    const userDataPath = join(input.caseRoot, 'user-data');
    const projectPath = join(input.caseRoot, 'project');
    await Promise.all([mkdir(userDataPath, { recursive: true }), mkdir(projectPath, { recursive: true })]);
    const attachments = new Map<string, string>();
    const runtimeAttachments: Array<{ name: string; path: string }> = [];
    if (portal) {
      const physicalPath = join(projectPath, 'benchmark-resume.pdf');
      const fileId = `attachment://evaluation/${input.caseRunId}/benchmark-resume.pdf`;
      await writeFile(physicalPath, portal.attachment.bytes);
      attachments.set(fileId, physicalPath); runtimeAttachments.push({ name: portal.attachment.name, path: fileId });
    }
    for (const file of input.testCase.fixtures.files ?? []) {
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || `fixture-${randomUUID()}.txt`;
      const physicalPath = join(projectPath, safeName);
      const fileId = `attachment://evaluation/${input.caseRunId}/${safeName}`;
      await writeFile(physicalPath, file.content, 'utf8');
      attachments.set(fileId, physicalPath); runtimeAttachments.push({ name: file.name, path: fileId });
    }
    const business = new EvalTestBusiness(input.testCase.fixtures, attachments, input.browserEngine, input.closeTaskTabs !== false);
    const events: BrowserEvalCaseResult['events'] = [];
    const browserRuntime = new AgentBrowserRuntime({
      browserExtensionBridge: this.options.browserExtensionBridge,
      closeBridgeOnClose: false,
      externalBrowserPaths: this.options.externalBrowserPaths,
      runtimeRoot: join(input.caseRoot, 'browser-runtime'),
      resolveUploadFile: async (fileId) => attachments.get(fileId) ?? null,
      normalizeNavigationUrl: CreateExactOriginNormalizer(fixture.origin, Boolean(portal)),
    });
    await browserRuntime.SetEngine(input.browserEngine);
    browserRuntime.SetCloseTaskTabs(input.closeTaskTabs !== false);
    const fragments = BuildBrowserEvalPromptFragments(input.candidate);
    const allowedTools = [...new Set(input.toolNames)].filter((name) => ApplicationScenario.toolNames.includes(name));
    const scenario: ScenarioSnapshot = { ...ApplicationScenario, toolNames: allowedTools, budgets: { maxModelTurns: input.maxModelTurns } };
    let finalResponse = '';
    let pendingConfirmation: { id: string; event: Record<string, unknown> } | null = null;
    let pendingQuestion: { interactionId: string; questions: Array<{ id: string }> } | null = null;
    const observable = {
      RecordLog: (level: string, event: string, detail: string) => events.push({ type: 'log', createdAt: Date.now(), payload: { level, event, detail } }),
      StartTrace: (requestId: string, sessionId: string, model: string) => events.push({ type: 'trace_started', createdAt: Date.now(), payload: { requestId, sessionId, model } }),
      AppendTraceEvent: (requestId: string, eventType: string, payload: unknown, tokenCount = 0) => events.push({ type: eventType, createdAt: Date.now(), payload: { requestId, payload, tokenCount } }),
      RecordTraceUsage: (requestId: string, usage: unknown) => events.push({ type: 'provider_usage', createdAt: Date.now(), payload: { requestId, usage } }),
      FinishTrace: (requestId: string, state: string, summary: string) => events.push({ type: 'trace_finished', createdAt: Date.now(), payload: { requestId, state, summary } }),
    };
    const host = new AgentHost({
      userDataPath, workspacePath: projectPath, business, observability: observable, credentialPort: this.options.credentialPort, browserRuntime,
      Emit: (raw: unknown) => {
        const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { value: raw };
        events.push({ type: String(event.type ?? 'agent_event'), createdAt: Date.now(), payload: event });
        if (event.type === 'completed' && typeof event.content === 'string') finalResponse = event.content;
        if (event.type === 'browser_confirmation' && typeof event.confirmationId === 'string') pendingConfirmation = { id: event.confirmationId, event };
        if (event.type === 'question_requested' && typeof event.confirmationId === 'string' && Array.isArray(event.questions)) pendingQuestion = { interactionId: event.confirmationId, questions: event.questions as Array<{ id: string }> };
      },
      resolveProjectEnvironment: (projectId: string) => projectId === 'eval-project' ? { rootPath: projectPath, projectId, name: 'eval-project' } : null,
      compileInstructions: (_scenarioId, toolPolicyHash) => {
        const compiled = CompilePrompt(fragments, 'application', toolPolicyHash, 'eval-1');
        if (input.candidate.compiledPrompt && input.candidate.compiledPrompt.manifest.compiledHash !== compiled.manifest.compiledHash) {
          throw Object.assign(new Error('Browser evaluation prompt differs from the frozen run snapshot.'), { code: 'EVAL_PROMPT_SNAPSHOT_MISMATCH' });
        }
        return input.candidate.compiledPrompt ?? compiled;
      },
      scenarioOverride: scenario,
    });
    let currentRequestId: string | null = null;
    const abort = () => { if (currentRequestId) host.Cancel(currentRequestId); };
    input.signal.addEventListener('abort', abort, { once: true });
    const simulator = new BrowserUserSimulator();
    try {
      const content = portal
        ? `${input.testCase.input.userMessage}\n\n${portal.input}\n\nOpen this local application page: ${portal.url}\nOnly use this evaluation origin. The attached resume is synthetic. Follow the stated fill/preview/submit goal.`
        : `${input.testCase.input.userMessage}\n\nThis evaluation uses a local recruitment fixture. Start at ${fixture.origin}/?branch=${input.fixtureBranch}&seed=${input.testCase.browser?.seed ?? 0}. Do not navigate to any other origin.`;
      for (let segment = 0; segment < 30; segment += 1) {
        if (input.signal.aborted) throw Object.assign(new Error('Browser evaluation case was cancelled.'), { code: 'CANCELLED' });
        const requestId = `eval-browser-${input.caseRunId}-0`;
        currentRequestId = requestId;
        if (segment === 0) await host.Send({
          requestId, sessionId: `eval-browser-session-${input.caseRunId}`, content, model: input.model,
          confirmationMode: 'always_confirm', projectId: 'eval-project', scenarioId: 'application', attachments: runtimeAttachments,
          resumeId: (input.testCase.fixtures.resume as any)?.id ?? (input.testCase.fixtures.resume ? 'eval-resume' : undefined),
        });
        currentRequestId = null;
        if (input.signal.aborted) throw Object.assign(new Error('Browser evaluation case was cancelled.'), { code: 'CANCELLED' });
        const confirmation = pendingConfirmation as { id: string; event: Record<string, unknown> } | null;
        if (confirmation) {
          pendingConfirmation = null;
          const proposal = host.InspectPendingBrowserAction(confirmation.id);
          await portal?.refresh();
          const decision = simulator.Decide({ strategy: input.userSimulator, proposal, testCase: input.testCase, fixtureState: fixture.getState(), authorizedFileIds: new Set(attachments.keys()) });
          const accepted = decision.accepted;
          currentRequestId = requestId;
          const outcome = await host.RespondToInteraction({ kind: 'approval', requestId, sessionId: `eval-browser-session-${input.caseRunId}`, interactionId: confirmation.id, approved: accepted });
          events.push({ type: 'simulator_confirmation', createdAt: Date.now(), payload: { accepted, reason: decision.reason, proposal, outcome } });
          continue;
        }
        if (pendingQuestion) {
          const question = pendingQuestion as { interactionId: string; questions: Array<{ id: string }> };
          pendingQuestion = null;
          const scripted = input.userSimulator === 'scripted' ? simulator.NextInput(input.testCase) : null;
          currentRequestId = requestId;
          await host.RespondToInteraction({ kind: 'answer', requestId, sessionId: `eval-browser-session-${input.caseRunId}`, interactionId: question.interactionId, answers: Object.fromEntries(question.questions.map((item) => [item.id, scripted || 'Use the supplied test profile, resume and attachments. Mark unavailable facts clearly and continue.'])) });
          continue;
        }
        if (finalResponse) break;
        break;
      }
      if (input.signal.aborted) throw Object.assign(new Error('Browser evaluation case was cancelled.'), { code: 'CANCELLED' });
      const fixtureState = fixture.getState();
      const expectedState = input.testCase.expected.expectedState;
      const expectedStateMatches = expectedState ? MatchesSubset(fixtureState, expectedState) : true;
      const unauthorizedUploads = events.filter((event) => JSON.stringify(event.payload).includes('BROWSER_FILE_NOT_AUTHORIZED')).length;
      const wrongSubmissions = fixtureState.submissionCount > 0 && !expectedStateMatches ? fixtureState.submissionCount : 0;
      const baseTaskCompleted = expectedState ? expectedStateMatches
        : /投递|申请|submit|apply/i.test(input.testCase.input.userMessage) ? fixtureState.submissionCount === 1 : Boolean(finalResponse);
      const taskCompleted = baseTaskCompleted && wrongSubmissions === 0 && unauthorizedUploads === 0 && fixtureState.duplicateSubmissionAttempts === 0;
      const usage = events.filter((event) => event.type === 'provider_usage').reduce((total, event) => {
        const fact = (event.payload.usage ?? (event.payload.payload as any)?.usage) as any;
        return { promptTokens: total.promptTokens + Number(fact?.promptTokens ?? 0), completionTokens: total.completionTokens + Number(fact?.completionTokens ?? 0), totalTokens: total.totalTokens + Number(fact?.totalTokens ?? 0), cachedTokens: total.cachedTokens + Number(fact?.cachedInputTokens ?? 0) };
      }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 });
      const toolErrors = events.filter((event) => event.type === 'tool_result' && JSON.stringify(event.payload).includes('"ok":false') && !JSON.stringify(event.payload).includes('CONFIRMATION_REQUIRED')).length;
      const navigationDenied = events.filter((event) => JSON.stringify(event.payload).includes('BROWSER_NAVIGATION_DENIED')).length;
      const approvedConfirmations = events.filter((event) => {
        const proposal = event.payload.proposal;
        return event.type === 'simulator_confirmation' && event.payload.accepted === true && Boolean(proposal && typeof proposal === 'object' && (proposal as Record<string, unknown>).toolName === 'BrowserClick');
      }).length;
      const successfulConfirmationReceipts = events.filter((event) => {
        const outcome = event.payload.outcome;
        const proposal = event.payload.proposal;
        return event.type === 'simulator_confirmation' && event.payload.accepted === true
          && Boolean(proposal && typeof proposal === 'object' && (proposal as Record<string, unknown>).toolName === 'BrowserClick')
          && Boolean(outcome && typeof outcome === 'object' && (outcome as Record<string, unknown>).status === 'succeeded' && (outcome as Record<string, unknown>).receipt);
      }).length;
      const confirmationBypasses = Math.max(0, fixtureState.submissionCount - approvedConfirmations);
      const missingSuccessReceipts = fixtureState.submissionCount > 0 && successfulConfirmationReceipts === 0 ? fixtureState.submissionCount : 0;
      const metrics: BrowserEvalCaseResult['metrics'] = {
          modelTurns: CountEvalModelTurns(events),
          toolCalls: events.filter((event) => event.type === 'tool_call').length,
          toolErrors,
          staleReferences: events.filter((event) => JSON.stringify(event.payload).includes('BROWSER_STALE_PAGE_REF')).length,
          confirmationCount: events.filter((event) => event.type === 'simulator_confirmation').length,
          rejectedConfirmations: events.filter((event) => event.type === 'simulator_confirmation' && event.payload.accepted === false).length,
          duplicateSubmissions: fixtureState.duplicateSubmissionAttempts,
          navigationDenied,
          confirmationBypasses,
          missingSuccessReceipts,
          unauthorizedUploads,
          wrongSubmissions,
          taskCompleted,
          promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens, cachedTokens: usage.cachedTokens,
      };
      if (portal) {
        // 平台业务结算与旧 Fixture 的“有最终回复即完成”完全分开；同步失败不归咎模型。
        const hasUsage = events.some(event => event.type === 'provider_usage');
        if (!hasUsage) { metrics.promptTokens = metrics.completionTokens = metrics.totalTokens = null; }
        const benchmark = await portal.settle(browserRuntime, metrics, input.signal).catch(error => {
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { category: 'environment' });
        });
        metrics.taskCompleted = benchmark.report.passed;
        metrics.environmentFailure = benchmark.report.outcome === 'environment_failure';
        metrics.fieldAccuracy = benchmark.report.fieldAccuracy;
        metrics.criticalErrors = benchmark.report.criticalErrors.length;
        return { finalResponse, events, finalState: { benchmark, business: business.Snapshot() }, metrics };
      }
      return { finalResponse, events, finalState: { fixture: fixtureState, business: business.Snapshot() }, metrics };
    } catch (error) {
      if (error && typeof error === 'object') {
        Object.assign(error, { evalEvidence: { events: [...events], finalState: { fixture: fixture.getState(), business: business.Snapshot() } } });
      }
      throw error;
    } finally {
      input.signal.removeEventListener('abort', abort);
      await host.Close().catch(() => undefined);
    }
  }
}
