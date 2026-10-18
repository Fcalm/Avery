import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { AtsPublicTransport } = require('../apps/backend/dist/electron/backend/ats/public-transport.js');
const fixturePath = resolve(process.argv[2] ?? 'tests/fixtures/ats-sources-100.json');
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);
const investigations = [
  ...fixture.sources,
  ...(process.argv[2] ? [] : [
  { company: '理想汽车-官方', url: 'https://www.lixiang.com/employ/social.html' },
  { company: '海尔-官方', url: 'https://maker.haier.net/client.html' },
  { company: '无问芯穹-候选', url: 'https://infinigence.jobs.feishu.cn/' },
  { company: '商汤-候选', url: 'https://hr-jobs.sensetime.com/' },
  { company: '商汤-官网', url: 'https://www.sensetime.com/cn/join-us' },
  ]),
];
const output = resolve(`artifacts/ats-registry-v2-audit/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const transport = new AtsPublicTransport();
const records = [];
// 本脚本只取公开页面及其声明的两个脚本；缺少特征仍为未验证，不证明排除其他平台。
for (const [index, source] of investigations.entries()) {
  const record = { company: source.company, url: source.url, responses: [], signals: [], links: [] };
  const read = async (url, suffix) => {
    try {
      const response = await transport.Request(url, { signal: AbortSignal.timeout(30_000) });
      const bodyFile = `${index}-${suffix}.txt`;
      await writeFile(resolve(output, bodyFile), response.body, { flag: 'wx' });
      record.responses.push({ requestedUrl: url, finalUrl: response.url, status: response.status, bodyFile, sha256: createHash('sha256').update(response.body).digest('hex') });
      if (response.status === 200) {
        const patterns = {
          moka: /https?:\/?\/?[^\s"'<>]*mokahr\.com[^\s"'<>]*/gi,
          beisen: /(?:BSGlobal|beisen|zhiye\.com)[^\s"'<>]{0,80}/gi,
          feishu: /(?:jobs\.feishu\.cn|talent\.feishu\.cn|Feishu Career)[^\s"'<>]{0,80}/gi,
          hotjob: /(?:hotjob\.cn|wecruit)[^\s"'<>]{0,100}/gi,
          dayee: /(?:dayee\.com|大易|eHire)[^\s"'<>]{0,80}/gi,
          zhaopin: /(?:zhaopin\.com|智联招聘)[^\s"'<>]{0,80}/gi,
          chinahr: /(?:chinahr\.com|中华英才)[^\s"'<>]{0,80}/gi,
        };
        for (const [platform, pattern] of Object.entries(patterns)) {
          const matches = [...new Set([...response.body.matchAll(pattern)].map((match) => match[0]))].slice(0, 8);
          if (matches.length) record.signals.push({ platform, bodyFile, matches });
        }
      }
      return response;
    } catch (error) { record.responses.push({ requestedUrl: url, code: error.code, message: error.message }); return undefined; }
  };
  const page = await read(source.url, 'page');
  if (page?.status === 200) {
    const links = [...page.body.matchAll(/<(a|iframe|script)\b[^>]*\b(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)].flatMap((match) => {
      try { return [{ kind: match[1].toLowerCase(), url: new URL((match[2] ?? match[3] ?? match[4]).replace(/&amp;/g, '&'), page.url).toString() }]; } catch { return []; }
    });
    record.links = links.filter((link) => link.kind !== 'script' && /career|employ|recruit|job|zhaopin|join|maker\.haier/i.test(link.url));
    const scripts = links.filter((link) => link.kind === 'script' && /\.js(?:\?|$)/i.test(link.url)
      && !/jquery|analytics|gtag|polyfill|vendor|swiper|bootstrap|qrcode|cookie|runtime|manifest|tracker|collector|monitor|sentry|locale|tracking/i.test(new URL(link.url).pathname)).slice(-2);
    for (const [scriptIndex, script] of scripts.entries()) await read(script.url, `script-${scriptIndex}`);
  }
  records.push(record);
  console.log(JSON.stringify({ company: record.company, status: record.responses[0]?.status, signals: [...new Set(record.signals.map((signal) => signal.platform))], links: record.links.slice(0, 5), error: record.responses[0]?.code }));
}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), fixturePath, fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'), records };
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, records: records.length }));
