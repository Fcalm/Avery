import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const page = await readFile(new URL('./pb03-browser-application.html', import.meta.url), 'utf8');
const child = await readFile(new URL('./pb03-browser-child.html', import.meta.url), 'utf8');
const smoke = await readFile(new URL('../smoke-browser-extension.mjs', import.meta.url), 'utf8');

test('PB-03 local fixture contains native inputs, select, custom cascade, date, terms, and file control', () => {
  assert.match(page, /aria-label="姓名"[^>]*required/);
  assert.match(page, /<select[^>]*aria-label="方向"[^>]*required/);
  assert.match(page, /aria-label="省份"[^>]*role="combobox"/);
  assert.match(page, /aria-label="城市"[^>]*role="combobox"/);
  assert.match(page, /aria-haspopup="listbox"[^>]*aria-controls="province-options"[^>]*data-selected=""/);
  assert.match(page, /aria-haspopup="listbox"[^>]*aria-controls="city-options"[^>]*data-selected=""/);
  assert.match(page, /data-value="广东省"/);
  assert.match(page, /佛山市/);
  assert.match(page, /type="date"[^>]*required/);
  assert.match(page, /aria-label="同意本地测试条款"[^>]*type="checkbox"[^>]*required/);
  assert.match(page, /type="file"[^>]*required/);
});

test('PB-03 custom cascade requires an option click and enables the city control from the page handler', () => {
  assert.match(page, /window\.__pb03RegionEvents = \[\]/);
  assert.match(page, /event\.target\.closest\('\[role="option"\]'\)/);
  assert.match(page, /<button[^>]*role="option"[^>]*data-value="广东省"><span>广东省<\/span><\/button>/);
  assert.match(page, /optionText: option \? String\(option\.textContent/);
  assert.match(page, /field: listId === 'province-options' \? 'province' : listId === 'city-options' \? 'city'/);
  assert.match(page, /city\.disabled = false/);
  assert.match(page, /cityOptions\.replaceChildren/);
  assert.match(page, /city\.textContent = option\.dataset\.value/);
  assert.match(page, /province\.dataset\.selected = option\.dataset\.value/);
  assert.match(page, /city\.dataset\.selected = option\.dataset\.value/);
  assert.match(page, /aria-valuetext/);
  assert.match(page, /aria-selected/);
});

test('PB-03 container clicks and wrong option text do not masquerade as a valid option action', () => {
  assert.match(page, /const option = event\.target\.closest\('\[role="option"\]'\);/);
  assert.match(page, /if \(!option\) return;/);
  assert.match(page, /data-value="江西省"><span>江西省<\/span>/);
  assert.match(page, /data-value="广东省"><span>广东省<\/span>/);
});

test('PB-03 local fixture opens a child tab and records submit/network attempts without submitting', () => {
  assert.match(page, /id="task-child-link" href="\/child" target="_blank" rel="opener"/);
  assert.doesNotMatch(page, /id="task-child-link"[^>]*rel="noopener"/);
  assert.match(page, /id="noopener-child-control" href="\/child\?noopener=1" target="_blank" rel="noopener" hidden/);
  assert.match(page, /<button type="button" data-pb03-submit>提交申请<\/button>/);
  assert.match(page, /document\.addEventListener\('submit'/);
  assert.match(page, /document\.addEventListener\('click'/);
  assert.match(page, /__pb03NetworkSubmitAttempts/);
  assert.match(child, /<h1>招聘详情子页<\/h1>/);
});

test('PB-03 smoke records task-scoped ownership, activation, close, and explicit noopener limits', () => {
  assert.match(smoke, /child_created_observed_in_current_task/);
  assert.match(smoke, /child_attached_and_active_verified/);
  assert.match(smoke, /targetsAfterClose/);
  assert.match(smoke, /ObserveTaskCloseReceipts/);
  assert.match(smoke, /PB03_FIXTURE_ORACLE_FAILED/);
  assert.match(smoke, /AssertCustomControlSelection/);
  assert.match(smoke, /city-opened/);
  assert.match(smoke, /AssertCustomOptionSelection/);
  assert.match(smoke, /CustomControlSelectedValue/);
  assert.match(smoke, /targetInspectionAfterClose: 'not_performed_retired_task_protected'/);
  assert.doesNotMatch(smoke, /read_only_Target\.getTargets_after_host_close_task/);
  assert.doesNotMatch(smoke, /read_only_other_task_Target\.getTargets_after_own_close/);
  assert.doesNotMatch(smoke, /bridge\.CloseTask\(engine, sentinelObservations/);
  assert.match(smoke, /otherTaskSurvivedMainClose/);
  assert.match(smoke, /unsupported_partial_not_exercised/);
  assert.match(smoke, /not_independently_identified/);
  assert.match(smoke, /VerifyPb03ConfirmationProposal/);
  assert.match(smoke, /VerifyPb03UploadOracle/);
  assert.match(smoke, /VerifyPb03ValidationGate/);
  assert.match(smoke, /VerifyPb03PreFinalGate/);
  assert.match(smoke, /VerifyPb03ExactlyOneCleanupObservation/);
  assert.match(smoke, /kernelTurnLimit\.code/);
  assert.match(smoke, /primary: true/);
});

test('PB-03 isolation compares the sentinel target identity pair, never targetId with sentinelTabId', () => {
  assert.match(smoke, /sentinelTargetIdHash/);
  assert.match(smoke, /sentinelTaskIdHash/);
  const identityStart = smoke.indexOf('function TargetIdentity(target)');
  const identityEnd = smoke.indexOf('async function WaitForTaskTarget', identityStart);
  assert.ok(identityStart >= 0 && identityEnd > identityStart, 'TargetIdentity helper should be present');
  const identitySource = smoke.slice(identityStart, identityEnd);
  assert.match(identitySource, /typeof target\.targetId\s*===\s*['"]string['"]/);
  assert.doesNotMatch(identitySource, /String\(target\.targetId\)/);
  assert.doesNotMatch(smoke, /String\(target\.targetId\)\s*===\s*sentinelObservations\.sentinelTabId/);
  assert.doesNotMatch(smoke, /sentinelTabId[\s\S]{0,80}target\.targetId|target\.targetId[\s\S]{0,80}sentinelTabId/);
});

test('PB-03 parent restore is raw-tab-only and noopener remains explicitly unsupported', () => {
  const restoreMatch = smoke.match(/return dispatch\('BrowserSwitchTab',\s*\{([^}]*)\},\s*'return-to-form-tab'\)/s);
  assert.ok(restoreMatch, 'parent restore dispatch should be present');
  assert.match(restoreMatch[1], /tabId:\s*String\(observations\.parentTabId\)/);
  assert.doesNotMatch(restoreMatch[1], /(?:targetId|url|title)\s*:/);
  assert.match(smoke, /unsupported_partial_not_exercised/);
  assert.match(smoke, /no verifiable opener ownership/i);
});

test('PB-03 turn-limit becomes terminal primary before the unique cleanup receipt gate', () => {
  const limitIndex = smoke.indexOf('observations.turnLimitExceeded =');
  const primaryIndex = smoke.indexOf('RecordPrimaryObservationFailure(observations, {', limitIndex);
  const closeExpectedIndex = smoke.indexOf('main_task_terminal_returned_host_close_expected');
  const cleanupGateIndex = smoke.indexOf('VerifyPb03ExactlyOneCleanupObservation', limitIndex);
  assert.ok(limitIndex >= 0, 'turn-limit observation should be recorded');
  assert.ok(primaryIndex > limitIndex, 'turn-limit must be recorded as primary');
  assert.ok(closeExpectedIndex > primaryIndex, 'cleanup must wait until terminal primary is recorded');
  assert.ok(cleanupGateIndex > closeExpectedIndex, 'cleanup receipt gate must follow terminal transition');
  assert.doesNotMatch(smoke.slice(closeExpectedIndex), /runtime\.RunCommand\(/);
  assert.match(smoke, /VerifyPb03KernelTurnLimit\(\{/);
  assert.match(smoke, /outcome=circuit_open/);
  assert.match(smoke, /iteration_limit/);
  assert.match(smoke, /tool_call_limit/);
  assert.doesNotMatch(smoke, /lastMainTerminalEvent\?\.type === 'waiting_confirmation'/);
  assert.match(smoke, /output\.status = observations\.turnLimitExceeded \? 'failed_turn_limit'/);
  assert.match(smoke, /output\.fixtureCoreStatus = observations\.turnLimitExceeded \? 'failed_turn_limit'/);
  assert.match(smoke, /mainReleaseEvents\.length === 1 && mainReleaseEvent\?\.type === 'run_released'/);
});

test('PB-03 primary observation recording is sequence-aware and retains later failures as secondary evidence', () => {
  const recordStart = smoke.indexOf('function RecordPrimaryObservationFailure(observations, failure)');
  const recordEnd = smoke.indexOf('async function WorktreeEvidence', recordStart);
  assert.ok(recordStart >= 0 && recordEnd > recordStart, 'RecordPrimaryObservationFailure should be present');
  const recordSource = smoke.slice(recordStart, recordEnd);
  assert.match(recordSource, /sequence/);
  assert.match(recordSource, /secondaryCheckerErrors/);
  assert.match(recordSource, /providerFailure/);
});

test('PB-03 pre-final gate names every required oracle and finally has no second task cleanup', () => {
  const preFinalCall = smoke.match(/VerifyPb03PreFinalGate\(\{([\s\S]*?)\}\)/);
  assert.ok(preFinalCall, 'pre-final gate should be called');
  for (const field of ['validation', 'upload', 'child', 'restore', 'isolation', 'noSubmit']) {
    assert.match(preFinalCall[1], new RegExp(`\\b${field}\\s*:`), `pre-final gate missing ${field}`);
  }
  const finallyIndex = smoke.indexOf('} finally {');
  assert.ok(finallyIndex >= 0);
  const finallyBlock = smoke.slice(finallyIndex);
  assert.doesNotMatch(finallyBlock, /bridge\.CloseTask\(/);
  assert.doesNotMatch(finallyBlock, /runtime\.RunCommand\(/);
  assert.equal((finallyBlock.match(/host\.Close\(/g) ?? []).length, 1, 'finally should contain only one guarded main-host close');
});
