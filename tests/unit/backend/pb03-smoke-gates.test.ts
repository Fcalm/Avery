import { describe, expect, it } from 'vitest';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { CreateKernelHarness, CreateRegisteredTool } from '../agent/test-helpers';
import {
  ParseExpectedToolResult,
  ResolvePb03PrimaryFailure,
  VerifyNavigationEvidence,
  VerifyPb03ChildIdentity,
  VerifyPb03ConfirmationProposal,
  VerifyPb03ExactlyOneCleanupObservation,
  VerifyPb03KernelTurnLimit,
  VerifyPb03PreChildEvidence,
  VerifyPb03PreFinalGate,
  VerifyPb03SwitchResult,
  VerifyPb03UploadOracle,
  VerifyPb03ValidationGate,
} from '../../../scripts/fixtures/pb03-tool-result.mjs';

const expectedConfirmation = {
  proposalId: 'proposal-upload-1', proposalHash: 'proposal-hash-1', toolName: 'BrowserUploadFile', requestId: 'run-1',
  sessionId: 'session-1', runId: 'run-1', browserTaskId: 'task-1', pageRevision: 8,
  ref: '@resume', fileId: 'attachment://pb03/synthetic-resume.pdf', sentinelBrowserTaskId: 'task-sentinel',
};

const confirmationEvent = {
  requestId: 'run-1',
  browserAction: {
    proposalId: 'proposal-upload-1', proposalHash: 'proposal-hash-1', toolName: 'BrowserUploadFile', sessionId: 'session-1',
    runId: 'run-1', browserTaskId: 'task-1',
  },
};

const confirmationInspection = {
  requestId: 'run-1',
  proposal: {
    proposalId: 'proposal-upload-1', proposalHash: 'proposal-hash-1', toolName: 'BrowserUploadFile', pageRevision: 8,
    canonicalArguments: { ref: '@resume', fileId: 'attachment://pb03/synthetic-resume.pdf' },
  },
  binding: {
    bindingVersion: 1, sessionId: 'session-1', browserTaskId: 'task-1', runId: 'run-1',
    proposalId: 'proposal-upload-1', proposalHash: 'proposal-hash-1', pageRevision: 8,
    fileId: 'attachment://pb03/synthetic-resume.pdf',
  },
};

const validUpload = {
  ok: true,
  data: { uploaded: true, fileId: 'attachment://pb03/synthetic-resume.pdf', fileName: 'PB-03-synthetic-resume.pdf', fileSize: 123, fileSha256: 'hash-123' },
};

const validResource = { fileId: 'attachment://pb03/synthetic-resume.pdf', name: 'PB-03-synthetic-resume.pdf', bytes: 123, sha256: 'hash-123' };
const validInputFiles = { fileName: 'PB-03-synthetic-resume.pdf', sizeBytes: 123, sha256: 'hash-123' };

describe('PB-03 smoke confirmation and upload evidence gates', () => {
  it('requires exact proposal/session/run/task/pageRevision/ref/file binding', () => {
    expect(VerifyPb03ConfirmationProposal({ event: confirmationEvent, inspection: confirmationInspection, expected: expectedConfirmation })).toMatchObject({ ok: true });
    for (const [key, value] of Object.entries({
      proposalId: 'proposal-other', sessionId: 'session-other', runId: 'run-other', browserTaskId: 'task-other',
      proposalHash: 'hash-other', pageRevision: 9, ref: '@other', fileId: 'attachment://pb03/other.pdf',
    })) {
      const expected = { ...expectedConfirmation, [key]: value };
      expect(VerifyPb03ConfirmationProposal({ event: confirmationEvent, inspection: confirmationInspection, expected })).toMatchObject({ ok: false });
    }
    expect(VerifyPb03ConfirmationProposal({
      event: { ...confirmationEvent, sessionId: 'session-other' },
      inspection: confirmationInspection,
      expected: expectedConfirmation,
    })).toMatchObject({ ok: false, failed: expect.arrayContaining(['sessionId']) });
  });

  it('requires a complete version-1 inspection.binding and never fills it from event/proposal fields', () => {
    const bindingFields = ['bindingVersion', 'sessionId', 'browserTaskId', 'runId', 'proposalId', 'proposalHash', 'pageRevision', 'fileId'] as const;
    for (const field of bindingFields) {
      const binding = { ...confirmationInspection.binding } as Record<string, unknown>;
      delete binding[field];
      const result = VerifyPb03ConfirmationProposal({
        // Keep the event and nested proposal complete: an implementation that
        // falls back to either source must fail this sparse-binding case.
        event: confirmationEvent,
        inspection: { ...confirmationInspection, binding },
        expected: expectedConfirmation,
      });
      expect(result, `missing binding.${field}`).toMatchObject({ ok: false });
    }
    expect(VerifyPb03ConfirmationProposal({
      event: confirmationEvent,
      inspection: { ...confirmationInspection, binding: { ...confirmationInspection.binding, bindingVersion: 2 } },
      expected: expectedConfirmation,
    })).toMatchObject({ ok: false });
    expect(VerifyPb03ConfirmationProposal({
      event: confirmationEvent,
      inspection: { ...confirmationInspection, binding: undefined },
      expected: expectedConfirmation,
    })).toMatchObject({ ok: false });
    expect(VerifyPb03ConfirmationProposal({
      event: { ...confirmationEvent, browserAction: { ...confirmationEvent.browserAction, ref: '@resume' } },
      inspection: {
        ...confirmationInspection,
        proposal: { ...confirmationInspection.proposal, canonicalArguments: { fileId: expectedConfirmation.fileId } },
      },
      expected: expectedConfirmation,
    })).toMatchObject({ ok: false });
  });

  it('rejects event-only session/task/run/proposal/hash/revision/file/ref evidence', () => {
    const inspection = { binding: { bindingVersion: 1 }, proposal: { canonicalArguments: {} } };
    expect(VerifyPb03ConfirmationProposal({
      event: {
        requestId: 'run-1', sessionId: 'session-1', runId: 'run-1', browserTaskId: 'task-1',
        proposalId: 'proposal-upload-1', proposalHash: 'proposal-hash-1', pageRevision: 8,
        browserAction: {
          toolName: 'BrowserUploadFile', sessionId: 'session-1', runId: 'run-1', browserTaskId: 'task-1',
          proposalId: 'proposal-upload-1', proposalHash: 'proposal-hash-1', pageRevision: 8,
          ref: '@resume', fileId: 'attachment://pb03/synthetic-resume.pdf',
        },
      },
      inspection,
      expected: expectedConfirmation,
    })).toMatchObject({ ok: false });
  });

  it('rejects a sentinel/cross-task proposal even when toolName matches', () => {
    const event = { ...confirmationEvent, browserAction: { ...confirmationEvent.browserAction, browserTaskId: 'task-sentinel' } };
    const inspection = { ...confirmationInspection, browserTaskId: 'task-sentinel' };
    const result = VerifyPb03ConfirmationProposal({ event, inspection, expected: expectedConfirmation });
    expect(result).toMatchObject({ ok: false, code: 'PB03_CONFIRMATION_PROPOSAL_BINDING_MISMATCH' });
    expect(result.failed).toContain('browserTaskId');
  });

  it('rejects missing proposal id rather than confirming by toolName', () => {
    const event = { requestId: 'run-1', browserAction: { toolName: 'BrowserUploadFile', sessionId: 'session-1', runId: 'run-1', browserTaskId: 'task-1' } };
    expect(VerifyPb03ConfirmationProposal({ event, inspection: confirmationInspection, expected: expectedConfirmation })).toMatchObject({ ok: false });
  });

  it('requires uploaded=true and exact resource plus input.files metadata', () => {
    expect(VerifyPb03UploadOracle({ result: validUpload, resource: validResource, inputFiles: validInputFiles })).toMatchObject({ ok: true });
    expect(VerifyPb03UploadOracle({ result: { ...validUpload, data: { ...validUpload.data, uploaded: false } }, resource: validResource, inputFiles: validInputFiles })).toMatchObject({ ok: false, code: 'PB03_UPLOAD_RESULT_NOT_UPLOADED' });
    expect(VerifyPb03UploadOracle({ result: { ...validUpload, data: { ...validUpload.data, fileSha256: 'wrong' } }, resource: validResource, inputFiles: validInputFiles })).toMatchObject({ ok: false, code: 'PB03_UPLOAD_RESOURCE_MISMATCH' });
    expect(VerifyPb03UploadOracle({ result: validUpload, resource: validResource, inputFiles: { ...validInputFiles, sizeBytes: 124 } })).toMatchObject({ ok: false, code: 'PB03_UPLOAD_INPUT_FILES_MISMATCH' });
    expect(VerifyPb03UploadOracle({ result: validUpload, resource: validResource, inputFiles: { ...validInputFiles, sha256: undefined } })).toMatchObject({ ok: false, code: 'PB03_UPLOAD_INPUT_FILES_MISMATCH' });
  });

  it('fails closed when expected resource or input.files metadata is empty', () => {
    expect(VerifyPb03UploadOracle({
      result: { ok: true, data: { uploaded: true } }, resource: {}, inputFiles: {},
    })).toMatchObject({ ok: false });
    expect(VerifyPb03UploadOracle({
      result: validUpload, resource: {}, inputFiles: validInputFiles,
    })).toMatchObject({ ok: false });
    expect(VerifyPb03UploadOracle({
      result: validUpload, resource: validResource, inputFiles: {},
    })).toMatchObject({ ok: false, code: 'PB03_UPLOAD_INPUT_FILES_MISMATCH' });
    expect(VerifyPb03UploadOracle({
      result: { ok: true, data: { uploaded: true, fileId: validResource.fileId, fileName: validResource.name, fileSize: validResource.bytes, fileSha256: validResource.sha256 } },
      resource: validResource,
      inputFiles: { fileName: validResource.name, sizeBytes: validResource.bytes, sha256: validResource.sha256 },
    })).toMatchObject({ ok: true });
  });
});

describe('PB-03 smoke validation and pre-final gates', () => {
  const validValidation = { ok: true, data: { valid: true, issues: [], inspectedFieldCount: 7, validationMetadataAvailable: true } };
  it('requires Validate ok, valid, empty issues, metadata, and expected inspected fields', () => {
    expect(VerifyPb03ValidationGate({ result: validValidation })).toMatchObject({ ok: true });
    expect(VerifyPb03ValidationGate({ result: { ok: false, code: 'VALIDATION_FAILED' } })).toMatchObject({ ok: false, code: 'PB03_VALIDATE_GATE_FAILED' });
    expect(VerifyPb03ValidationGate({ result: { ok: true, data: { valid: false, issues: [{ ref: '@x', label: '姓名', code: 'required' }], inspectedFieldCount: 7, validationMetadataAvailable: true } } })).toMatchObject({ ok: false });
    expect(VerifyPb03ValidationGate({ result: { ok: true, data: { valid: true, issues: [], inspectedFieldCount: 6, validationMetadataAvailable: true } } })).toMatchObject({ ok: false });
    expect(VerifyPb03ValidationGate({ result: { ok: true, data: { valid: true, issues: [], inspectedFieldCount: 7 } } })).toMatchObject({ ok: false });
  });

  it('stops when pre-child DOM/file/no-submit evidence is absent', () => {
    const dom = { available: true, verified: true, requiredFieldsVerified: true, fileSelected: true, fileVerified: true, noSubmitObserved: true };
    expect(VerifyPb03PreChildEvidence({ validation: VerifyPb03ValidationGate({ result: validValidation }), upload: VerifyPb03UploadOracle({ result: validUpload, resource: validResource, inputFiles: validInputFiles }), dom })).toMatchObject({ ok: true });
    expect(VerifyPb03PreChildEvidence({ validation: VerifyPb03ValidationGate({ result: validValidation }), upload: VerifyPb03UploadOracle({ result: validUpload, resource: validResource, inputFiles: validInputFiles }), dom: { ...dom, fileVerified: false } })).toMatchObject({ ok: false, code: 'PB03_PRE_CHILD_ORACLE_FAILED' });
  });

  it('requires every pre-final component before provider final', () => {
    const all = { validation: true, upload: true, child: true, restore: true, isolation: true, noSubmit: true };
    expect(VerifyPb03PreFinalGate(all)).toMatchObject({ ok: true });
    for (const component of Object.keys(all)) {
      const failedKey = component === 'validation' ? 'validate' : component;
      expect(VerifyPb03PreFinalGate({ ...all, [component]: false }), `missing ${component}`)
        .toMatchObject({ ok: false, code: 'PB03_PRE_FINAL_GATE_FAILED', failed: [failedKey] });
    }
    expect(VerifyPb03PreFinalGate({ ...all, validation: undefined })).toMatchObject({ ok: false, failed: ['validate'] });
  });

  it('selects the earliest monotonic primary sequence even when provider failure precedes child/restore gates', () => {
    const provider = { primary: true, sequence: 1, code: 'PB03_PROVIDER_FAILURE', message: 'provider failed first' };
    const child = { primary: true, sequence: 2, code: 'PB03_CHILD_SNAPSHOT_FAILED', message: 'child snapshot timeout' };
    const restore = { primary: true, sequence: 3, code: 'PB03_PARENT_RESTORE_FAILED', message: 'restore failed' };
    const selected = ResolvePb03PrimaryFailure({ providerFailure: provider, childSnapshotFailure: child, restoreFailure: restore, preFinalFailure: { primary: true, sequence: 4, code: 'PB03_PRE_FINAL_GATE_FAILED' }, oracleFailure: { primary: true, sequence: 5, code: 'PB03_UPLOAD_ORACLE_FAILED' } });
    expect(selected).toBe(provider);
  });

  it('does not let a later primary/category overwrite the first observation; later failures are secondary', () => {
    const provider = { primary: true, sequence: 4, code: 'PB03_PROVIDER_FAILURE', message: 'provider first in the recorded sequence' };
    const child = { primary: true, sequence: 7, code: 'PB03_CHILD_SNAPSHOT_FAILED' };
    const restore = { primary: false, sequence: 8, code: 'PB03_PARENT_RESTORE_FAILED', secondaryOf: provider.code };
    expect(ResolvePb03PrimaryFailure({ providerFailure: provider, childSnapshotFailure: child, restoreFailure: restore })).toBe(provider);
    expect(ResolvePb03PrimaryFailure({ providerFailure: provider, childSnapshotFailure: { ...child, primary: false }, restoreFailure: restore })).toBe(provider);
    expect(ResolvePb03PrimaryFailure({ providerFailure: { primary: false, sequence: 1, code: 'secondary-provider' }, childSnapshotFailure: child })).toBe(child);
  });
});

describe('PB-03 smoke raw tab identity and cleanup evidence', () => {
  const parent = { targetId: 'target-parent', tabId: 100, windowId: 7, browserTaskId: 'task-1', attached: true, active: false, url: 'http://127.0.0.1/application', title: 'application' };
  const child = { targetId: 'target-child', tabId: 101, windowId: 7, browserTaskId: 'task-1', openerTabId: 100, attached: true, active: true, url: 'http://127.0.0.1/child', title: 'child' };

  it('accepts only raw numeric tabId and exact opener; targetId-as-tabId/noopener fails', () => {
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child, expectedChildUrl: child.url })).toMatchObject({ ok: true });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, attached: false }, expectedChildUrl: child.url })).toMatchObject({ ok: true });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent: { ...parent, tabId: parent.targetId }, child, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, tabId: child.targetId }, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, openerTabId: undefined }, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, openerTabId: { tabId: 100 } }, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent: { ...parent, browserTaskId: 'task-other' }, child, expectedChildUrl: child.url })).toMatchObject({ ok: false });
  });

  it('requires task ownership and rejects non-raw/object identity values', () => {
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent: { ...parent, browserTaskId: undefined }, child, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, browserTaskId: undefined }, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent: { ...parent, targetId: { id: 'target-parent' } }, child, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent: { ...parent, targetId: 100 }, child, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent: { ...parent, tabId: '100' }, child, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, windowId: '7' }, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, targetId: { id: 'target-child' } }, expectedChildUrl: child.url })).toMatchObject({ ok: false });
  });

  it('requires the complete parent/child pair and never falls back to URL/title/targetId for restore', () => {
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent: { ...parent, tabId: undefined }, child, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03ChildIdentity({ taskId: 'task-1', parent, child: { ...child, openerTabId: undefined }, expectedChildUrl: child.url })).toMatchObject({ ok: false });
    expect(VerifyPb03SwitchResult({
      result: { ok: true, data: { tabs: [{ targetId: child.targetId, url: child.url, title: child.title, active: true }] } },
      expected: child,
    })).toMatchObject({ ok: false });
    expect(VerifyPb03SwitchResult({
      result: { ok: true, data: { tabs: [{ ...child, tabId: child.targetId }] } },
      expected: child,
    })).toMatchObject({ ok: false });
  });

  it('requires BrowserSwitchTab to return exact tab/window/url/active evidence', () => {
    const result = { ok: true, data: { tabs: [child] } };
    expect(VerifyPb03SwitchResult({ result, expected: child })).toMatchObject({ ok: true });
    expect(VerifyPb03SwitchResult({ result: { ...result, data: { tabs: [{ ...child, active: false }] } }, expected: child })).toMatchObject({ ok: false });
    expect(VerifyPb03SwitchResult({ result: { ...result, data: { tabs: [{ ...child, targetId: 'other' }] } }, expected: child })).toMatchObject({ ok: false });
  });

  it('disables URL-only and targetId-as-tabId navigation fallback', () => {
    const result = { ok: true, data: { currentUrl: 'http://127.0.0.1:4567/application' } };
    expect(VerifyNavigationEvidence({ result, taskTargets: [{ type: 'page', targetId: 'target-only', url: result.data.currentUrl }], expectedUrl: result.data.currentUrl, readyState: 'complete' })).toMatchObject({ ok: false, code: 'PB03_NAVIGATION_TASK_TARGET_MISSING' });
    expect(VerifyNavigationEvidence({ result, taskTargets: [{ type: 'page', targetId: '100', tabId: '100', url: result.data.currentUrl }], expectedUrl: result.data.currentUrl, readyState: 'complete' })).toMatchObject({ ok: false, code: 'PB03_NAVIGATION_TASK_TARGET_MISSING' });
    expect(VerifyNavigationEvidence({ result, taskTargets: [{ type: 'page', targetId: 'target-1', tabId: 100, url: result.data.currentUrl }], expectedUrl: result.data.currentUrl, readyState: 'complete' })).toMatchObject({ ok: true, targetId: 'target-1', tabId: 100 });
  });

  it('requires exactly one acknowledged cleanup observation', () => {
    expect(VerifyPb03ExactlyOneCleanupObservation([{ acknowledged: true, closed: true, lockReleased: true }])).toMatchObject({ ok: true });
    expect(VerifyPb03ExactlyOneCleanupObservation([])).toMatchObject({ ok: false, code: 'PB03_CLEANUP_OBSERVATION_COUNT_FAILED' });
    expect(VerifyPb03ExactlyOneCleanupObservation([{ acknowledged: true, closed: true, lockReleased: true }, { acknowledged: true, closed: true, lockReleased: true }])).toMatchObject({ ok: false });
    expect(VerifyPb03ExactlyOneCleanupObservation([{ acknowledged: true, closed: true, lockReleased: false }])).toMatchObject({ ok: false });
  });
});

describe('PB-03 smoke real Kernel terminal budget evidence', () => {
  const kernelTool = CreateRegisteredTool('ReadProfile');
  const toolCall = (id: string) => ({
    id,
    type: 'function' as const,
    function: { name: 'ReadProfile', arguments: '{}' },
  });

  it('uses the real Kernel maxTurns result and records terminal primary before one released cleanup', async () => {
    const harness = CreateKernelHarness({
      tools: [kernelTool],
      completions: [{ content: '', toolCalls: [toolCall('max-turns-call')] }],
    });
    harness.input.scenario.budgets = { maxModelTurns: 1, maxToolCalls: 12 };

    const result = await RunAgentLoop(harness.input);
    const terminalEvent = harness.events.at(-1);
    const turnLimit = VerifyPb03KernelTurnLimit({ terminalEvent, sendResult: result });
    const primary = { primary: true, sequence: 1, code: turnLimit.code, message: 'Kernel maxTurns exhausted.' };

    expect(result).toMatchObject({ outcome: 'circuit_open', disposition: 'paused', reason: 'iteration_limit' });
    expect(terminalEvent).toMatchObject({ type: 'error', requestId: 'request-1' });
    expect(turnLimit).toMatchObject({ ok: true, outcome: 'circuit_open', reason: 'iteration_limit' });
    expect(ResolvePb03PrimaryFailure({ providerFailure: primary })).toBe(primary);
    expect(VerifyPb03ExactlyOneCleanupObservation([{ acknowledged: true, closed: true, lockReleased: true }])).toMatchObject({ ok: true });
    expect(harness.events.some((event) => event.type === 'waiting_confirmation')).toBe(false);
  });

  it('uses the real Kernel maxToolCalls result and rejects message-only or duplicate cleanup evidence', async () => {
    const harness = CreateKernelHarness({
      tools: [kernelTool],
      completions: [{ content: '', toolCalls: [toolCall('max-tools-call')] }],
    });
    harness.input.scenario.budgets = { maxModelTurns: 12, maxToolCalls: 0 };

    const result = await RunAgentLoop(harness.input);
    const terminalEvent = harness.events.at(-1);
    const turnLimit = VerifyPb03KernelTurnLimit({ terminalEvent, sendResult: result });

    expect(result).toMatchObject({ outcome: 'circuit_open', disposition: 'paused', reason: 'tool_call_limit' });
    expect(turnLimit).toMatchObject({ ok: true, outcome: 'circuit_open', reason: 'tool_call_limit' });
    expect(VerifyPb03KernelTurnLimit({
      terminalEvent: { type: 'error', requestId: 'request-1', message: 'tool_call_limit' },
      sendResult: { accepted: true },
    })).toMatchObject({ ok: false, code: 'PB03_KERNEL_TURN_LIMIT_NOT_STRUCTURED' });
    expect(VerifyPb03ExactlyOneCleanupObservation([
      { acknowledged: true, closed: true, lockReleased: true },
      { acknowledged: true, closed: true, lockReleased: true },
    ])).toMatchObject({ ok: false });
    expect(harness.events.some((event) => event.type === 'waiting_confirmation')).toBe(false);
  });

  it('can combine exact Host trace/log fields when the error event has no reason', () => {
    expect(VerifyPb03KernelTurnLimit({
      terminalEvent: { type: 'error', requestId: 'trace-run', message: 'opaque provider text' },
      sendResult: { accepted: true },
      traceEvents: [
        { type: 'trace_finished', requestId: 'trace-run', payload: { state: 'circuit_open', summary: 'opaque' } },
        { type: 'observability_log', requestId: 'trace-run', payload: { event: 'conversation.circuit_open', detail: 'iteration_limit' } },
      ],
    })).toMatchObject({ ok: true, outcome: 'circuit_open', reason: 'iteration_limit', source: 'host_trace_and_log' });
  });
});

describe('PB-03 smoke tool history remains exact-call scoped', () => {
  it('rejects missing evidence instead of accepting another tool result', () => {
    expect(() => ParseExpectedToolResult([{ role: 'tool', tool_call_id: 'other', content: JSON.stringify({ ok: true, data: {} }) }], 'expected'))
      .toThrow(expect.objectContaining({ code: 'PB03_TOOL_RESULT_CALL_MISMATCH' }));
  });
});
