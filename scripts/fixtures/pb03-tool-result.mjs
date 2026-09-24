const IsRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const Own = (value, key) => IsRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
const StringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const NumberValue = (value) => Number.isSafeInteger(value) ? value : null;
const PresentStrings = (...values) => values.map(StringValue).filter((value) => value !== null);
const PresentNumbers = (...values) => values.map(NumberValue).filter((value) => value !== null);
const AllEqualTo = (values, expected) => values.length > 0 && values.every((value) => value === expected);

function GateFailure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

const Pb03KernelTurnLimitReasons = new Set(['iteration_limit', 'tool_call_limit']);

const ExactKernelTurnLimitReason = (value) => Pb03KernelTurnLimitReasons.has(value) ? value : null;

/**
 * Verify a terminal Kernel budget result without treating a waiting event or
 * human-readable error text as a turn limit.  AgentHost currently returns only
 * `{ accepted: true }`; the smoke harness may therefore combine its structured
 * Send result with the Host event and the observability trace/log records.
 * Every accepted fallback below is an exact protocol field/value comparison.
 */
export function VerifyPb03KernelTurnLimit({ terminalEvent, sendResult, traceEvents } = {}) {
  const event = IsRecord(terminalEvent) ? terminalEvent : {};
  const send = IsRecord(sendResult) ? sendResult : {};
  const resultSources = [
    event,
    event.result,
    event.kernelResult,
    send,
    send.result,
    send.kernelResult,
  ].filter(IsRecord);
  const directOutcome = resultSources.find((source) => source.outcome === 'circuit_open')?.outcome ?? null;
  const directReason = resultSources
    .map((source) => ExactKernelTurnLimitReason(source.reason))
    .find((value) => value !== null) ?? null;
  const eventRequestId = StringValue(event.requestId);
  const evidence = eventRequestId === null || !Array.isArray(traceEvents) ? [] : traceEvents.filter(IsRecord)
    .filter((entry) => entry.requestId === eventRequestId);
  const traceFinished = evidence.find((entry) => {
    const payload = IsRecord(entry.payload) ? entry.payload : entry;
    return entry.type === 'trace_finished' && payload.state === 'circuit_open';
  });
  const traceFinishedPayload = IsRecord(traceFinished?.payload) ? traceFinished.payload : traceFinished ?? {};
  const traceOutcome = traceFinishedPayload.state === 'circuit_open' ? traceFinishedPayload.state : null;
  const circuitLog = evidence.find((entry) => {
    const payload = IsRecord(entry.payload) ? entry.payload : entry;
    return entry.type === 'observability_log'
      && payload.event === 'conversation.circuit_open'
      && ExactKernelTurnLimitReason(payload.detail) !== null;
  });
  const circuitLogPayload = IsRecord(circuitLog?.payload) ? circuitLog.payload : circuitLog ?? {};
  const traceReason = ExactKernelTurnLimitReason(circuitLogPayload.detail);
  const outcome = directOutcome ?? traceOutcome;
  const reason = directReason ?? traceReason;
  const checks = {
    errorEvent: event.type === 'error',
    circuitOpenOutcome: outcome === 'circuit_open',
    turnLimitReason: reason !== null,
    reasonEvidence: directReason !== null || traceReason !== null,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) {
    return GateFailure('PB03_KERNEL_TURN_LIMIT_NOT_STRUCTURED',
      `Kernel turn-limit terminal evidence failed closed: ${failed.join(', ')}.`, {
        checks,
        failed,
        observed: {
          eventType: event.type ?? null,
          outcome: outcome ?? null,
          reason: reason ?? null,
        },
      });
  }
  return {
    ok: true,
    code: 'PB03_KERNEL_TURN_LIMIT',
    outcome,
    reason,
    checks,
    source: directOutcome !== null || directReason !== null ? 'kernel_result' : 'host_trace_and_log',
  };
}

/**
 * Verify the immutable browser confirmation envelope before the smoke harness
 * calls AgentHost.  Confirmation ids are intentionally not proposal ids: a
 * confirmation may only be accepted when the event and Host's inspection
 * expose the same frozen proposal and all task/session bindings agree.
 */
export function VerifyPb03ConfirmationProposal({ event, inspection, expected } = {}) {
  const browserAction = IsRecord(event?.browserAction) ? event.browserAction : (IsRecord(event) ? event : {});
  const expectedValues = IsRecord(expected) ? expected : {};
  const proposal = IsRecord(inspection?.proposal) ? inspection.proposal : {};
  // 确认证据必须锚定 Host 检查到的 pending 记录；事件字段只能交叉核对，不能补齐稀疏或过期 binding。
  const binding = IsRecord(inspection?.binding) ? inspection.binding : {};
  const canonicalArguments = IsRecord(proposal.canonicalArguments) ? proposal.canonicalArguments : {};
  const expectedProposalId = StringValue(expectedValues.proposalId);
  const expectedProposalHash = StringValue(expectedValues.proposalHash);
  const expectedToolName = StringValue(expectedValues.toolName);
  const expectedSessionId = StringValue(expectedValues.sessionId);
  const expectedRunId = StringValue(expectedValues.runId);
  const expectedBrowserTaskId = StringValue(expectedValues.browserTaskId);
  const expectedPageRevision = NumberValue(expectedValues.pageRevision);
  const expectedRef = StringValue(expectedValues.ref);
  const expectedFileId = StringValue(expectedValues.fileId);
  const bindingSessionId = StringValue(binding.sessionId);
  const bindingRunId = StringValue(binding.runId);
  const bindingBrowserTaskId = StringValue(binding.browserTaskId);
  const bindingProposalId = StringValue(binding.proposalId);
  const bindingProposalHash = StringValue(binding.proposalHash);
  const bindingPageRevision = NumberValue(binding.pageRevision);
  const proposalIdFromEvent = PresentStrings(browserAction.proposalId, event?.proposalId);
  const proposalHashFromEvent = PresentStrings(browserAction.proposalHash, event?.proposalHash);
  const sessionIdFromEvent = PresentStrings(browserAction.sessionId, event?.sessionId);
  const runIdFromEvent = PresentStrings(browserAction.runId, event?.runId);
  const taskIdFromEvent = PresentStrings(browserAction.browserTaskId, event?.browserTaskId);
  const toolNameFromEvent = PresentStrings(browserAction.toolName, event?.toolName);
  const checks = {
    eventPresent: IsRecord(event),
    inspectionPresent: IsRecord(inspection),
    bindingPresent: IsRecord(inspection?.binding),
    bindingVersion: binding.bindingVersion === 1,
    proposalPresent: IsRecord(inspection?.proposal),
    proposalCanonicalArguments: IsRecord(proposal.canonicalArguments),
    proposalIdPresent: bindingProposalId !== null && expectedProposalId !== null,
    proposalIdMatches: bindingProposalId !== null && expectedProposalId !== null && bindingProposalId === expectedProposalId
      && StringValue(proposal.proposalId) === bindingProposalId
      && proposalIdFromEvent.length > 0
      && proposalIdFromEvent.every((value) => value === bindingProposalId),
    proposalHashPresent: bindingProposalHash !== null && expectedProposalHash !== null,
    proposalHashMatches: bindingProposalHash !== null && expectedProposalHash !== null && bindingProposalHash === expectedProposalHash
      && StringValue(proposal.proposalHash) === bindingProposalHash
      && (proposalHashFromEvent.length === 0 || proposalHashFromEvent.every((value) => value === bindingProposalHash)),
    toolName: expectedToolName !== null && StringValue(proposal.toolName) === expectedToolName
      && (toolNameFromEvent.length === 0 || toolNameFromEvent.every((value) => value === expectedToolName)),
    requestId: AllEqualTo(PresentStrings(event?.requestId, inspection?.requestId), StringValue(expectedValues.requestId)),
    sessionId: bindingSessionId !== null && expectedSessionId !== null && bindingSessionId === expectedSessionId
      && (sessionIdFromEvent.length === 0 || sessionIdFromEvent.every((value) => value === bindingSessionId)),
    runId: bindingRunId !== null && expectedRunId !== null && bindingRunId === expectedRunId
      && (runIdFromEvent.length === 0 || runIdFromEvent.every((value) => value === bindingRunId)),
    browserTaskId: bindingBrowserTaskId !== null && expectedBrowserTaskId !== null && bindingBrowserTaskId === expectedBrowserTaskId
      && (taskIdFromEvent.length === 0 || taskIdFromEvent.every((value) => value === bindingBrowserTaskId)),
    pageRevision: bindingPageRevision !== null && bindingPageRevision >= 0
      && expectedPageRevision !== null && expectedPageRevision >= 0 && bindingPageRevision === expectedPageRevision
      && NumberValue(proposal.pageRevision) === bindingPageRevision,
    ref: expectedValues.requireRef === false
      ? true
      : StringValue(canonicalArguments.ref) !== null && expectedRef !== null && StringValue(canonicalArguments.ref) === expectedRef,
    fileId: expectedToolName === 'BrowserUploadFile'
      ? StringValue(canonicalArguments.fileId) !== null && StringValue(binding.fileId) !== null
        && expectedFileId !== null && StringValue(canonicalArguments.fileId) === expectedFileId
        && StringValue(binding.fileId) === expectedFileId
      : true,
    notSentinel: expectedValues.sentinelBrowserTaskId === undefined
      || bindingBrowserTaskId !== StringValue(expectedValues.sentinelBrowserTaskId),
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) {
    return GateFailure('PB03_CONFIRMATION_PROPOSAL_BINDING_MISMATCH',
      `Browser confirmation proposal binding failed closed: ${failed.join(', ')}.`, {
        checks,
        observed: {
          proposalId: bindingProposalId,
          inspectedProposalId: StringValue(proposal.proposalId),
          toolName: proposal.toolName ?? null,
          requestId: event?.requestId ?? inspection?.requestId ?? null,
          sessionId: bindingSessionId,
          runId: bindingRunId,
          browserTaskId: bindingBrowserTaskId,
          pageRevision: bindingPageRevision,
          ref: canonicalArguments.ref ?? null,
          fileId: canonicalArguments.fileId ?? null,
        },
        expected: expectedValues,
        failed,
      });
  }
  return { ok: true, code: '', checks, proposalId: bindingProposalId, canonicalArguments: { ...canonicalArguments } };
}

/** Verify ValidateForm's success envelope and its complete inspected-field oracle. */
export function VerifyPb03ValidationGate({ result, expectedInspectedFieldCount = 7, expectedFields } = {}) {
  const envelope = IsRecord(result) && typeof result.ok === 'boolean' ? result : null;
  const data = IsRecord(envelope?.data) ? envelope.data : IsRecord(result) ? result : {};
  const fields = Array.isArray(expectedFields) && expectedFields.length > 0
    ? expectedFields
    : ['valid', 'issues', 'inspectedFieldCount', 'validationMetadataAvailable'];
  const issues = Array.isArray(data.issues) ? data.issues : null;
  const issuesSchema = Array.isArray(issues) && issues.every((issue) => IsRecord(issue)
    && typeof issue.ref === 'string' && typeof issue.label === 'string' && typeof issue.code === 'string'
    && (issue.message === undefined || typeof issue.message === 'string'));
  const checks = {
    envelopeOk: envelope ? envelope.ok === true : false,
    expectedFields: fields.every((field) => Own(data, field)),
    valid: data.valid === true,
    issuesArray: Array.isArray(issues),
    issuesSchema,
    noIssues: Array.isArray(issues) && issues.length === 0,
    inspectedFieldCount: Number.isSafeInteger(data.inspectedFieldCount)
      && data.inspectedFieldCount === expectedInspectedFieldCount,
    validationMetadataAvailable: data.validationMetadataAvailable === true,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) return GateFailure('PB03_VALIDATE_GATE_FAILED',
    `BrowserValidateForm did not pass the continuation gate: ${failed.join(', ')}.`, {
      checks, failed, data: {
        valid: data.valid ?? null,
        issues: issues ?? null,
        inspectedFieldCount: NumberValue(data.inspectedFieldCount),
        validationMetadataAvailable: data.validationMetadataAvailable === true,
      },
    });
  return { ok: true, code: '', checks, data };
}

/** Verify Host upload metadata against both the authorized resource and input.files. */
export function VerifyPb03UploadOracle({ result, resource, inputFiles } = {}) {
  const envelope = IsRecord(result) && typeof result.ok === 'boolean' ? result : null;
  const data = IsRecord(envelope?.data) ? envelope.data : IsRecord(result) ? result : {};
  const expected = IsRecord(resource) ? resource : {};
  const file = IsRecord(inputFiles) ? inputFiles : {};
  const expectedFileId = StringValue(expected.fileId);
  const expectedName = StringValue(expected.name ?? expected.fileName);
  const expectedSize = NumberValue(expected.bytes ?? expected.fileSize ?? expected.sizeBytes);
  const expectedHash = StringValue(expected.sha256 ?? expected.fileSha256);
  const actual = {
    uploaded: data.uploaded === true,
    fileId: StringValue(data.fileId),
    fileName: StringValue(data.fileName ?? data.name),
    fileSize: NumberValue(data.fileSize ?? data.sizeBytes ?? data.size),
    fileSha256: StringValue(data.fileSha256 ?? data.sha256 ?? data.hash),
  };
  const inputActual = {
    fileName: StringValue(file.fileName ?? file.name),
    fileSize: NumberValue(file.fileSize ?? file.sizeBytes ?? file.size),
    fileSha256: StringValue(file.fileSha256 ?? file.sha256 ?? file.hash),
  };
  const checks = {
    envelopeOk: envelope ? envelope.ok === true : false,
    uploaded: actual.uploaded,
    expectedResourcePresent: expectedFileId !== null && expectedName !== null && expectedSize !== null && expectedHash !== null,
    expectedInputFilesPresent: inputActual.fileName !== null && inputActual.fileSize !== null && inputActual.fileSha256 !== null,
    actualMetadataPresent: actual.fileId !== null && actual.fileName !== null && actual.fileSize !== null && actual.fileSha256 !== null,
    resourceFileId: actual.fileId === expectedFileId,
    resourceName: actual.fileName === expectedName,
    resourceSize: actual.fileSize === expectedSize,
    resourceHash: actual.fileSha256 === expectedHash,
    inputFilesName: inputActual.fileName === expectedName,
    inputFilesSize: inputActual.fileSize === expectedSize,
    inputFilesHash: inputActual.fileSha256 === expectedHash,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) {
    const code = !checks.envelopeOk || !checks.uploaded || !checks.actualMetadataPresent ? 'PB03_UPLOAD_RESULT_NOT_UPLOADED'
      : !checks.expectedInputFilesPresent || failed.some((key) => key.startsWith('inputFiles')) ? 'PB03_UPLOAD_INPUT_FILES_MISMATCH' : 'PB03_UPLOAD_RESOURCE_MISMATCH';
    return GateFailure(code, `BrowserUploadFile oracle failed: ${failed.join(', ')}.`, {
      checks, failed, actual, expected: { fileId: expectedFileId, name: expectedName, size: expectedSize, sha256: expectedHash }, inputFiles: inputActual,
    });
  }
  return { ok: true, code: '', checks, actual, expected: { fileId: expectedFileId, name: expectedName, size: expectedSize, sha256: expectedHash }, inputFiles: inputActual };
}

/** DOM/file/no-submit evidence is a hard pre-child stop gate. */
export function VerifyPb03PreChildEvidence({ validation, upload, dom } = {}) {
  const checks = {
    validation: validation?.ok === true,
    upload: upload?.ok === true,
    domAvailable: dom?.available === true,
    domVerified: dom?.verified === true,
    requiredFields: dom?.requiredFieldsVerified === true,
    fileSelected: dom?.fileSelected === true,
    fileVerified: dom?.fileVerified === true,
    noSubmitObserved: dom?.noSubmitObserved === true,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) return GateFailure('PB03_PRE_CHILD_ORACLE_FAILED', `Pre-child DOM/file/no-submit evidence failed: ${failed.join(', ')}.`, { checks, failed });
  return { ok: true, code: '', checks };
}

/** Target identity is raw and task-scoped: targetId is never accepted as tabId. Attachment is verified after BrowserSwitchTab. */
export function VerifyPb03ChildIdentity({ taskId, parent, child, expectedChildUrl } = {}) {
  const parentTabId = NumberValue(parent?.tabId);
  const childTabId = NumberValue(child?.tabId);
  const openerTabId = NumberValue(child?.openerTabId);
  const taskScope = StringValue(taskId);
  const parentTaskId = StringValue(parent?.browserTaskId ?? parent?.ownerTaskId ?? parent?.taskId);
  const childTaskId = StringValue(child?.browserTaskId ?? child?.ownerTaskId ?? child?.taskId);
  const checks = {
    taskId: taskScope !== null,
    sameTask: taskScope !== null
      && parentTaskId === taskScope
      && childTaskId === taskScope,
    parentTargetId: StringValue(parent?.targetId) !== null,
    parentRawTabId: parentTabId !== null,
    parentWindowId: NumberValue(parent?.windowId) !== null,
    childTargetId: StringValue(child?.targetId) !== null,
    childRawTabId: childTabId !== null,
    childWindowId: NumberValue(child?.windowId) !== null,
    childIsNewTarget: StringValue(child?.targetId) !== null && child.targetId !== parent?.targetId,
    childIsNewTab: childTabId !== null && childTabId !== parentTabId,
    openerMatchesParentTab: openerTabId !== null && openerTabId === parentTabId,
    childUrlMatches: expectedChildUrl === undefined || String(child?.url ?? '') === String(expectedChildUrl),
    childActive: child?.active === true,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) return GateFailure('PB03_CHILD_IDENTITY_MISMATCH', `Child identity failed closed: ${failed.join(', ')}.`, { checks, failed });
  return { ok: true, code: '', checks, parentTabId, childTabId, openerTabId };
}

/** BrowserSwitchTab must return the selected raw tab identity, window, URL and active bit. */
export function VerifyPb03SwitchResult({ result, expected } = {}) {
  const data = IsRecord(result?.data) ? result.data : {};
  const tabs = Array.isArray(data.tabs) ? data.tabs : [];
  const expectedValues = IsRecord(expected) ? expected : {};
  const selected = tabs.find((tab) => NumberValue(tab?.tabId) === NumberValue(expectedValues.tabId));
  const checks = {
    envelopeOk: result?.ok === true,
    tabsPresent: Array.isArray(data.tabs),
    rawTabId: NumberValue(selected?.tabId) !== null,
    targetId: StringValue(selected?.targetId) !== null && StringValue(selected?.targetId) === StringValue(expectedValues.targetId),
    windowId: NumberValue(selected?.windowId) !== null && selected.windowId === expectedValues.windowId,
    url: StringValue(selected?.url) !== null && String(selected.url) === String(expectedValues.url),
    active: selected?.active === true,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) return GateFailure('PB03_SWITCH_IDENTITY_MISMATCH', `BrowserSwitchTab identity evidence failed: ${failed.join(', ')}.`, { checks, failed, selected: selected ?? null });
  return { ok: true, code: '', checks, selected };
}

/** The final provider completion is permitted only after every pre-final oracle passes. */
export function VerifyPb03PreFinalGate({ validation, upload, child, restore, isolation, noSubmit } = {}) {
  const checks = {
    validate: validation === true || validation?.ok === true,
    upload: upload === true || upload?.ok === true,
    child: child === true || child?.ok === true,
    restore: restore === true || restore?.ok === true,
    isolation: isolation === true || isolation?.ok === true,
    noSubmit: noSubmit === true || noSubmit?.ok === true,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) return GateFailure('PB03_PRE_FINAL_GATE_FAILED', `PB03 pre-final gate failed: ${failed.join(', ')}.`, { checks, failed });
  return { ok: true, code: '', checks };
}

export function ResolvePb03PrimaryFailure({ providerFailure, childSnapshotFailure, restoreFailure, preFinalFailure, oracleFailure } = {}) {
  const candidates = [childSnapshotFailure, restoreFailure, preFinalFailure, oracleFailure, providerFailure]
    .filter((candidate) => IsRecord(candidate) && candidate.primary === true);
  if (candidates.length === 0) return null;
  const sequenced = candidates.filter((candidate) => Number.isSafeInteger(candidate.sequence) && candidate.sequence > 0);
  if (sequenced.length > 0) {
    return sequenced.reduce((earliest, candidate) => candidate.sequence < earliest.sequence ? candidate : earliest);
  }
  // 没有 sequence 的旧调用仅保留传入的第一个值；新的 smoke 观测始终带 sequence。
  return candidates[0];
}

export function VerifyPb03ExactlyOneCleanupObservation(receipts) {
  const entries = Array.isArray(receipts) ? receipts : [];
  const checks = {
    exactlyOne: entries.length === 1,
    acknowledged: entries.length === 1 && entries[0]?.acknowledged === true,
    closed: entries.length === 1 && entries[0]?.closed === true,
    lockReleased: entries.length === 1 && entries[0]?.lockReleased === true,
  };
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) return GateFailure('PB03_CLEANUP_OBSERVATION_COUNT_FAILED', `Expected exactly one cleanup observation: ${failed.join(', ')}.`, { checks, failed });
  return { ok: true, code: '', checks, receipt: entries[0] };
}

export function ParseExpectedToolResult(history, expectedToolCallId) {
  if (typeof expectedToolCallId !== 'string' || !expectedToolCallId) {
    throw Object.assign(new Error('The fixture provider cannot match a tool result without an expected tool call id.'), { code: 'PB03_TOOL_RESULT_CALL_ID_INVALID' });
  }
  const messages = Array.isArray(history) ? history.filter(IsRecord) : [];
  const expectedEntries = messages.filter((item) => item.tool_call_id === expectedToolCallId);
  if (expectedEntries.length > 1) {
    throw Object.assign(new Error(`The fixture history contains ${expectedEntries.length} entries for tool call "${expectedToolCallId}"; exactly one is required.`), { code: 'PB03_TOOL_RESULT_DUPLICATE' });
  }
  if (expectedEntries.length === 0) {
    const toolResults = messages.filter((item) => item.role === 'tool');
    if (toolResults.length === 0) {
      throw Object.assign(new Error(`The fixture provider did not receive a tool result for expected call "${expectedToolCallId}".`), { code: 'PB03_TOOL_RESULT_MISSING' });
    }
    const observedCallIds = toolResults.map((item) => typeof item.tool_call_id === 'string' && item.tool_call_id ? item.tool_call_id : '<missing>').join(', ');
    throw Object.assign(new Error(`The fixture provider expected tool call "${expectedToolCallId}" but history contained result(s) for: ${observedCallIds}.`), { code: 'PB03_TOOL_RESULT_CALL_MISMATCH' });
  }
  const message = expectedEntries[0];
  if (message.role !== 'tool') {
    throw Object.assign(new Error(`The history entry for expected tool call "${expectedToolCallId}" has role "${String(message.role ?? '<missing>')}", not "tool".`), { code: 'PB03_TOOL_RESULT_INVALID_ROLE' });
  }
  let result;
  try { result = JSON.parse(String(message.content || '')); }
  catch { throw Object.assign(new Error('The fixture tool result was not valid JSON.'), { code: 'PB03_TOOL_RESULT_INVALID_JSON' }); }
  if (!IsRecord(result) || typeof result.ok !== 'boolean') {
    throw Object.assign(new Error('The fixture tool result did not match the expected { ok, data, code, message } envelope.'), { code: 'PB03_TOOL_RESULT_INVALID_SHAPE' });
  }
  if (result.ok === true && !IsRecord(result.data)) {
    throw Object.assign(new Error('A successful fixture browser result is missing its data object.'), { code: 'PB03_TOOL_RESULT_INVALID_SHAPE' });
  }
  if (result.ok === false && (typeof result.code !== 'string' || !result.code)) {
    throw Object.assign(new Error('A failed fixture browser result is missing its error code.'), { code: 'PB03_TOOL_RESULT_INVALID_SHAPE' });
  }
  return { ...result, toolCallId: message.tool_call_id };
}

export function NormalizeToolResultEnvelope(result, toolCallId) {
  if (!IsRecord(result) || typeof result.ok !== 'boolean') {
    throw Object.assign(new Error('The fixture received a tool result outside the expected { ok, data, code, message } envelope.'), { code: 'PB03_TOOL_RESULT_INVALID_SHAPE' });
  }
  if (result.ok === true && !IsRecord(result.data)) {
    throw Object.assign(new Error('A successful fixture browser result is missing its data object.'), { code: 'PB03_TOOL_RESULT_INVALID_SHAPE' });
  }
  if (result.ok === false && (typeof result.code !== 'string' || !result.code)) {
    throw Object.assign(new Error('A failed fixture browser result is missing its error code.'), { code: 'PB03_TOOL_RESULT_INVALID_SHAPE' });
  }
  return { ...result, ...(toolCallId ? { toolCallId } : {}) };
}

export function VerifyNavigationEvidence({ result, taskTargets, expectedUrl, readyState }) {
  let envelope;
  try { envelope = NormalizeToolResultEnvelope(result); }
  catch (error) { return { ok: false, code: error?.code || 'PB03_TOOL_RESULT_INVALID_SHAPE', message: error instanceof Error ? error.message : 'Invalid tool result.' }; }
  if (!envelope.ok) {
    return { ok: false, code: envelope.code, message: typeof envelope.message === 'string' ? envelope.message : 'BrowserNavigate failed.' };
  }
  const expected = new URL(expectedUrl);
  const SameUrl = (value) => {
    try {
      const url = new URL(String(value));
      url.hash = '';
      const normalizedExpected = new URL(expected.href);
      normalizedExpected.hash = '';
      return url.href === normalizedExpected.href;
    } catch { return false; }
  };
  const finalUrl = envelope.data.currentUrl ?? envelope.data.url;
  if (!SameUrl(finalUrl)) {
    return { ok: false, code: 'PB03_NAVIGATION_FINAL_URL_MISMATCH', message: 'BrowserNavigate returned success but the final task URL did not match the fixture URL.' };
  }
  if (!['interactive', 'complete'].includes(String(readyState))) {
    return { ok: false, code: 'PB03_NAVIGATION_DOCUMENT_NOT_READY', message: 'BrowserNavigate returned success but the task document did not reach an interactive or complete ready state.' };
  }
  // URL/title are only corroborating evidence.  A task target must expose its
  // exact protocol targetId and the extension's raw numeric tabId; accepting a
  // targetId as tabId (or a URL-only match) would make cross-task attribution
  // unverifiable.
  const target = (Array.isArray(taskTargets) ? taskTargets : []).find((item) => item?.type === 'page'
    && typeof item.targetId === 'string' && item.targetId.length > 0
    && Number.isSafeInteger(item.tabId)
    && SameUrl(item.url));
  if (!target) {
    return { ok: false, code: 'PB03_NAVIGATION_TASK_TARGET_MISSING', message: 'BrowserNavigate returned success but no task-owned target matched the fixture URL.' };
  }
  return { ok: true, code: '', finalUrl: String(finalUrl), readyState: String(readyState), targetId: String(target.targetId), tabId: target.tabId };
}
