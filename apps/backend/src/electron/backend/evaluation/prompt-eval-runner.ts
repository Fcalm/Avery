import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalDatasetCase, EvalPromptCandidate, EvalUserSimulatorStrategy } from '@avery/contracts';
import type { CompiledInstructions, ScenarioSnapshot } from '@avery/agent-sdk';
import { BuildDefaultPromptFragments, CompilePrompt, DefaultScenario } from '@avery/agent-modules-defaults';
import { AgentHost } from '../agent-host';
import { EvalTestBusiness } from './eval-test-business';
import { CountEvalModelTurns } from './eval-runner-metrics';

export interface PromptEvalCaseInput {
  runId: string;
  caseRunId: string;
  candidate: EvalPromptCandidate & { compiledPrompt?: CompiledInstructions };
  testCase: EvalDatasetCase;
  model: string;
  toolNames: string[];
  maxModelTurns: number;
  userSimulator: EvalUserSimulatorStrategy;
  caseRoot: string;
  signal: AbortSignal;
}

export interface PromptEvalCaseResult {
  finalResponse: string;
  events: Array<{ type: string; createdAt: number; payload: Record<string, unknown> }>;
  finalState: { profiles: unknown[]; resumes: unknown[] };
  metrics: Record<string, number | boolean | null>;
}

/** 使用正式 AgentHost/Kernel 执行 Prompt 案例，同时把业务端口和状态目录替换为 CaseRun 独占实现。 */
export class PromptEvalRunner {
  private credentialPort: any;

  constructor({ credentialPort }: { credentialPort: any }) {
    this.credentialPort = credentialPort;
  }

  async Execute(input: PromptEvalCaseInput): Promise<PromptEvalCaseResult> {
    const userDataPath = join(input.caseRoot, 'user-data');
    const projectPath = join(input.caseRoot, 'project');
    await Promise.all([mkdir(userDataPath, { recursive: true }), mkdir(projectPath, { recursive: true })]);
    for (const file of input.testCase.fixtures.files ?? []) {
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || `fixture-${randomUUID()}.txt`;
      await writeFile(join(projectPath, safeName), file.content, 'utf8');
    }

    const events: PromptEvalCaseResult['events'] = [];
    const business = new EvalTestBusiness(input.testCase.fixtures);
    const observable = {
      RecordLog: (level: string, event: string, detail: string) => events.push({ type: 'log', createdAt: Date.now(), payload: { level, event, detail } }),
      StartTrace: (requestId: string, sessionId: string, model: string) => events.push({ type: 'trace_started', createdAt: Date.now(), payload: { requestId, sessionId, model } }),
      AppendTraceEvent: (requestId: string, eventType: string, payload: unknown, tokenCount = 0) => events.push({ type: eventType, createdAt: Date.now(), payload: { requestId, payload, tokenCount } }),
      RecordTraceUsage: (requestId: string, usage: unknown) => events.push({ type: 'provider_usage', createdAt: Date.now(), payload: { requestId, usage } }),
      FinishTrace: (requestId: string, state: string, summary: string) => events.push({ type: 'trace_finished', createdAt: Date.now(), payload: { requestId, state, summary } }),
    };
    const fragments = BuildDefaultPromptFragments().map((fragment) => {
      const override = input.candidate.promptOverrides[fragment.id];
      return override === undefined ? fragment : { ...fragment, version: `${fragment.version}-eval`, content: override, contentHash: '' };
    });
    const allowedTools = [...new Set(input.toolNames)].filter((name) => DefaultScenario.toolNames.includes(name));
    const scenario: ScenarioSnapshot = {
      ...DefaultScenario,
      toolNames: allowedTools,
      budgets: { ...DefaultScenario.budgets, maxModelTurns: input.maxModelTurns },
    };
    let finalResponse = '';
    let pendingResumeConfirmation: string | null = null;
    let pendingQuestions: unknown = null;
    const host = new AgentHost({
      userDataPath,
      workspacePath: projectPath,
      Emit: (raw: unknown) => {
        const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { value: raw };
        events.push({ type: String(event.type ?? 'agent_event'), createdAt: Date.now(), payload: event });
        if (event.type === 'completed' && typeof event.content === 'string') finalResponse = event.content;
        if (event.type === 'resume_confirmation' && typeof event.confirmationId === 'string') pendingResumeConfirmation = event.confirmationId;
        if (event.type === 'question_requested') pendingQuestions = event.questions ?? true;
      },
      business,
      observability: observable,
      credentialPort: this.credentialPort,
      resolveProjectEnvironment: (projectId: string) => projectId === 'eval-project' ? { rootPath: projectPath, projectId, name: 'eval-project' } : null,
      compileInstructions: (_scenarioId, toolPolicyHash) => {
        const compiled = CompilePrompt(fragments, scenario.id, toolPolicyHash, 'eval-1');
        if (input.candidate.compiledPrompt && input.candidate.compiledPrompt.manifest.compiledHash !== compiled.manifest.compiledHash) {
          throw Object.assign(new Error('Prompt evaluation instructions differ from the frozen run snapshot.'), { code: 'EVAL_PROMPT_SNAPSHOT_MISMATCH' });
        }
        return input.candidate.compiledPrompt ?? compiled;
      },
      scenarioOverride: scenario,
    });

    let currentRequestId: string | null = null;
    const Abort = () => { if (currentRequestId) host.Cancel(currentRequestId); };
    input.signal.addEventListener('abort', Abort, { once: true });
    try {
      let content = input.testCase.input.userMessage;
      for (let segment = 0; segment < Math.min(30, input.maxModelTurns); segment += 1) {
        if (input.signal.aborted) throw Object.assign(new Error('Evaluation case was cancelled.'), { code: 'CANCELLED' });
        const requestId = `eval-request-${input.caseRunId}-${segment}`;
        currentRequestId = requestId;
        await host.Send({
          requestId,
          sessionId: `eval-session-${input.caseRunId}`,
          content,
          model: input.model,
          confirmationMode: 'fully_trusted',
          projectId: 'eval-project',
          resumeId: (input.testCase.fixtures.resume as any)?.id ?? (input.testCase.fixtures.resume ? 'eval-resume' : undefined),
          scenarioId: 'default',
        });
        currentRequestId = null;
        if (input.signal.aborted) throw Object.assign(new Error('Evaluation case was cancelled.'), { code: 'CANCELLED' });
        if (finalResponse) break;
        if (pendingResumeConfirmation) {
          await host.ConfirmResumeEdit(pendingResumeConfirmation, input.userSimulator !== 'scripted' || segment > 0);
          if (input.signal.aborted) throw Object.assign(new Error('Evaluation case was cancelled.'), { code: 'CANCELLED' });
          pendingResumeConfirmation = null;
          content = '我确认这次测评中的简历草稿，请继续完成任务。';
          continue;
        }
        if (pendingQuestions) {
          pendingQuestions = null;
          content = '请基于已有测试资料继续；无法确认的内容请明确标记【待确认】。';
          continue;
        }
        break;
      }
      const usageEvents = events.filter((event) => event.type === 'provider_usage');
      const usage = usageEvents.reduce((total, event) => {
        const fact = (event.payload.usage ?? (event.payload.payload as any)?.usage) as any;
        return {
          promptTokens: total.promptTokens + (Number.isFinite(fact?.promptTokens) ? fact.promptTokens : 0),
          completionTokens: total.completionTokens + (Number.isFinite(fact?.completionTokens) ? fact.completionTokens : 0),
          totalTokens: total.totalTokens + (Number.isFinite(fact?.totalTokens) ? fact.totalTokens : 0),
        };
      }, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return {
        finalResponse,
        events,
        finalState: business.Snapshot(),
        metrics: {
          modelTurns: CountEvalModelTurns(events),
          toolCalls: events.filter((event) => event.type === 'tool_call').length,
          toolErrors: events.filter((event) => event.type === 'tool_result' && JSON.stringify(event.payload).includes('"ok":false')).length,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          completed: Boolean(finalResponse),
        },
      };
    } catch (error) {
      if (error && typeof error === 'object') Object.assign(error, { evalEvidence: { events: [...events], finalState: business.Snapshot() } });
      throw error;
    } finally {
      input.signal.removeEventListener('abort', Abort);
      await host.Close();
    }
  }
}
