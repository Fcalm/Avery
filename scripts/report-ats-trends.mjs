import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BuildTrends } from './ats-trends-report.mjs';

const [input, ...args] = process.argv.slice(2);
if (!input || args.length % 2) throw new Error('Usage: node scripts/report-ats-trends.mjs <facts.json> [--platform name] [--source id] [--since ISO-date] [--output directory]');
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  if (!['--platform', '--source', '--since', '--output'].includes(name)) throw new Error(`Unknown option: ${name}`);
  options[name] = args[index + 1];
}
const state = JSON.parse(await readFile(resolve(input), 'utf8'));
if (state.schemaVersion !== 1 || !Array.isArray(state.sourceRuns) || !state.sources) throw new Error('Invalid ATS fact store.');
const report = BuildTrends(state, { platform: options['--platform'], sourceId: options['--source'], since: options['--since'] });
const output = resolve(options['--output'] ?? `artifacts/ats-trends/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
// 独占创建，趋势报告不能覆盖前次证据。
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
const markdown = ['# ATS 历史趋势', '', `来源文件：${resolve(input)}`, `选中 ${report.selectedRuns}/${report.historyRuns} 次；历史最多保留 ${report.historyLimit} 次；日期按 UTC 分组。`, '',
  '| 日期 | 平台 | 企业 / 来源 | 成功 / 部分 / 失败 | P50 / P95(ms) | 字段完整率 | 未验证质量次数 | 错误 |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...report.groups.map((group) => `| ${group.day} | ${group.platform} | ${group.company} / ${group.sourceId} | ${group.success}/${group.partial}/${group.failed} | ${group.latencyP50Ms}/${group.latencyP95Ms} | ${group.fieldCompleteness ? JSON.stringify(group.fieldCompleteness) : 'unverified'} | ${group.unverifiedQualityRuns} | ${JSON.stringify(group.errors)} |`), '',
  '异常通知条件：连续三次失败或停滞；结构或访问权限失败；完整采集岗位数相比前次完整采集下降超过50%。预算内分段且岗位数持续增长不计连续失败。通知记录保存在报告中，不自动发送外部消息。', '',
  ...report.alerts.map((alert) => `- ${alert.at} ${alert.platform} ${alert.sourceId}: ${alert.reasons.join(', ')}`)];
await writeFile(resolve(output, 'report.md'), `${markdown.join('\n')}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, selectedRuns: report.selectedRuns, groups: report.groups.length, alerts: report.alerts.length }));
