import type { EvalDatasetCase, EvalUserSimulatorStrategy } from '@offerget/contracts';
import type { EvalBrowserFixtureState } from './browser-fixture-server';

/** 固定策略用户模拟器；它只能收窄确认，不得改变工具白名单或绕过 Browser Runtime 校验。 */
export class BrowserUserSimulator {
  private rejectedSubmit = false;
  private scriptedIndex = 0;

  Decide(input: {
    strategy: EvalUserSimulatorStrategy;
    proposal: any;
    testCase: EvalDatasetCase;
    fixtureState: EvalBrowserFixtureState;
    authorizedFileIds: Set<string>;
  }): { accepted: boolean; reason: string } {
    const { strategy, proposal, testCase, fixtureState, authorizedFileIds } = input;
    if (!proposal) return { accepted: false, reason: 'missing_proposal' };
    const serialized = JSON.stringify(proposal);
    if ((testCase.browser?.forbiddenTargets ?? []).some((target) => serialized.includes(target))) return { accepted: false, reason: 'forbidden_target' };
    if (proposal.toolName === 'BrowserUploadFile' && !authorizedFileIds.has(String(proposal.canonicalArguments?.fileId ?? ''))) {
      return { accepted: false, reason: 'wrong_attachment' };
    }
    const expectedJobId = String((testCase.expected.expectedState as any)?.selectedJobId
      ?? (testCase.expected.expectedState as any)?.submission?.jobId
      ?? (testCase.expected.expectedState as any)?.fixture?.selectedJobId
      ?? (testCase.expected.expectedState as any)?.fixture?.submission?.jobId
      ?? '');
    const appliesToSelectedJob = /申请这个岗位|提交申请|submit application|apply for this job/i.test(String(proposal.summary ?? ''));
    if (appliesToSelectedJob && expectedJobId && fixtureState.selectedJobId !== expectedJobId) return { accepted: false, reason: 'wrong_job' };
    if (strategy === 'reject_submit_once' && !this.rejectedSubmit && /提交申请|submit application/i.test(String(proposal.summary ?? ''))) {
      this.rejectedSubmit = true; return { accepted: false, reason: 'scripted_rejection' };
    }
    if (strategy === 'scripted') {
      const responses = testCase.browser?.scriptedResponses ?? [];
      const response = responses[this.scriptedIndex];
      if (response?.kind === 'confirmation') this.scriptedIndex += 1;
      return { accepted: response?.accepted === true, reason: 'scripted' };
    }
    return { accepted: true, reason: 'valid' };
  }

  NextInput(testCase: EvalDatasetCase): string | null {
    const responses = testCase.browser?.scriptedResponses ?? [];
    const response = responses[this.scriptedIndex];
    if (response?.kind !== 'input') return null;
    this.scriptedIndex += 1;
    return response.content ?? null;
  }
}
