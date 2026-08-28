import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineRoot = resolve(process.argv[2] || process.env.OFFERGET_EVALUATION_BASELINE || join(projectRoot, 'artifacts', 'evaluation-system-baseline'));

async function ResolveBaselineRoot() {
  if ((await stat(baselineRoot)).isFile()) return dirname(baselineRoot);
  try { await stat(join(baselineRoot, 'baseline.json')); return baselineRoot; } catch { /* 选择最新一次运行。 */ }
  const directories = [];
  for (const name of await readdir(baselineRoot)) {
    const target = join(baselineRoot, name);
    if ((await stat(target)).isDirectory()) directories.push(name);
  }
  if (!directories.length) throw new Error('No evaluation baseline directory was found.');
  return join(baselineRoot, directories.sort().at(-1));
}

function Assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

const selectedRoot = await ResolveBaselineRoot();
const baselineText = await readFile(join(selectedRoot, 'baseline.json'), 'utf8');
const baseline = JSON.parse(baselineText);
const failures = [];
let auditedCases = 0;
let auditedEvents = 0;

for (const run of baseline.runs ?? []) {
  const runRoot = join(selectedRoot, 'runs', run.id);
  const snapshotText = await readFile(join(runRoot, 'snapshot.json'), 'utf8');
  const snapshot = JSON.parse(snapshotText);
  const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  Assert(snapshotHash === run.snapshotHash, `${run.id}: snapshot hash mismatch`, failures);
  Assert(run.status === 'completed', `${run.id}: run is not completed`, failures);
  Assert(run.caseRuns.length === run.summary?.totalCaseRuns, `${run.id}: CaseRun count differs from summary`, failures);

  const totals = { modelTurns: 0, toolErrors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const caseRun of run.caseRuns) {
    auditedCases += 1;
    const caseRoot = join(runRoot, 'cases', caseRun.id);
    const [messagesText, resultText, scoreText] = await Promise.all([
      readFile(join(caseRoot, 'messages.jsonl'), 'utf8'),
      readFile(join(caseRoot, 'result.json'), 'utf8'),
      readFile(join(caseRoot, 'score.json'), 'utf8'),
    ]);
    const events = messagesText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    auditedEvents += events.length;
    const modelTurns = events.filter((event) => event.type === 'loop_turn').length;
    const toolErrors = events.filter((event) => event.type === 'tool_result' && JSON.stringify(event.payload).includes('"ok":false') && !JSON.stringify(event.payload).includes('CONFIRMATION_REQUIRED')).length;
    const result = JSON.parse(resultText);
    const score = JSON.parse(scoreText);
    Assert(caseRun.status === 'completed', `${caseRun.id}: CaseRun is not completed`, failures);
    Assert(caseRun.metrics.modelTurns === modelTurns, `${caseRun.id}: modelTurns does not match loop_turn evidence`, failures);
    Assert(caseRun.metrics.toolErrors === toolErrors, `${caseRun.id}: toolErrors does not match tool_result evidence`, failures);
    Assert(caseRun.metrics.taskCompleted === true, `${caseRun.id}: task was not completed`, failures);
    Assert(result.id === caseRun.id, `${caseRun.id}: result artifact id mismatch`, failures);
    Assert(score.score?.id === caseRun.score?.id, `${caseRun.id}: score artifact id mismatch`, failures);
    Assert(Array.isArray(caseRun.score?.hardFailures) && caseRun.score.hardFailures.length === 0, `${caseRun.id}: hard failure present`, failures);
    for (const key of Object.keys(totals)) totals[key] += Number(caseRun.metrics[key] ?? 0);
  }
  Assert(totals.modelTurns === run.summary.modelTurns, `${run.id}: modelTurns summary mismatch`, failures);
  Assert(totals.toolErrors === run.summary.toolErrorCount, `${run.id}: toolError summary mismatch`, failures);
  Assert(totals.promptTokens === run.summary.usage.promptTokens, `${run.id}: prompt token summary mismatch`, failures);
  Assert(totals.completionTokens === run.summary.usage.completionTokens, `${run.id}: completion token summary mismatch`, failures);
  Assert(totals.totalTokens === run.summary.usage.totalTokens, `${run.id}: total token summary mismatch`, failures);
  Assert(run.summary.taskCompletionRate === 1, `${run.id}: task completion rate is not 1`, failures);
}

const artifactFiles = [];
async function CollectFiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) await CollectFiles(target); else artifactFiles.push(target);
  }
}
await CollectFiles(selectedRoot);
for (const file of artifactFiles) {
  const text = await readFile(file, 'utf8');
  Assert(!/\bsk-[A-Za-z0-9_-]{8,}\b/.test(text), `${file}: API key pattern found`, failures);
  Assert(!/Bearer\s+(?!\[REDACTED\])\S+/i.test(text), `${file}: unredacted bearer token found`, failures);
  Assert(!/\b[A-Za-z]:\\Users\\/i.test(text), `${file}: local user path found`, failures);
  Assert(!/encryptedApiKey/i.test(text), `${file}: encrypted credential field found`, failures);
}

const result = { schemaVersion: 1, passed: failures.length === 0, baselineRoot: selectedRoot, runs: baseline.runs?.length ?? 0, auditedCases, auditedEvents, auditedFiles: artifactFiles.length, failures };
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;
