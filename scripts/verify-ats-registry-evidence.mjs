import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { AtsPublicTransport } = require('../apps/backend/dist/electron/backend/ats/public-transport.js');
const { ParseMokaRecruitmentUrl } = require('../apps/backend/dist/electron/backend/ats/moka-discovery.js');
const registry = JSON.parse(await readFile(new URL('../tests/fixtures/ats-sources-100.json', import.meta.url), 'utf8'));
// 只调查既有企业的官方入口，不更换企业、不把失败样本换成成功样本。
const investigations = [
  { company: '智谱', officialUrl: 'https://www.zhipuai.cn/zh/joinus', scriptPath: '/joinus/page-' },
  { company: '阶跃星辰', officialUrl: 'https://www.stepfun.com/', scriptPath: '/assets/index-' },
  { company: '理想汽车', officialUrl: 'https://www.lixiang.com/employ.html', scriptPath: '/js/employ/index.' },
  { company: '海尔', officialUrl: 'https://www.haier.com/contact-us/zplx/' },
];
const output = resolve(`artifacts/ats-registry-evidence/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const transport = new AtsPublicTransport();
const evidence = [];
for (const [index, item] of investigations.entries()) {
  const source = registry.sources.find((source) => source.company === item.company);
  if (!source) throw new Error(`Company is not in the frozen registry: ${item.company}`);
  const record = { company: item.company, originalUrl: source.url, officialUrl: item.officialUrl, responses: [], publicRecruitmentLinks: [], declaredRecruitmentPortals: [] };
  const read = async (url, name) => {
    try {
      const response = await transport.Request(url, { signal: AbortSignal.timeout(30_000) });
      await writeFile(resolve(output, `${index}-${name}.txt`), response.body, { flag: 'wx' });
      record.responses.push({ requestedUrl: url, finalUrl: response.url, status: response.status, bodyFile: `${index}-${name}.txt`, sha256: createHash('sha256').update(response.body).digest('hex') });
      return response;
    } catch (error) { record.responses.push({ requestedUrl: url, code: error.code, message: error.message }); return undefined; }
  };
  await read(source.url, 'original');
  const page = await read(item.officialUrl, 'official');
  if (page?.status === 200) {
    const links = [...page.body.matchAll(/<(a|script)\b[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].flatMap((match) => {
      try { return [{ kind: match[1].toLowerCase(), url: new URL(match[2].replace(/&amp;/g, '&'), page.url).toString() }]; } catch { return []; }
    });
    record.publicRecruitmentLinks = links.filter((link) => link.kind === 'a' && /career|employ|recruit|join|maker\.haier/i.test(link.url));
    const script = item.scriptPath && links.find((link) => link.kind === 'script' && new URL(link.url).pathname.includes(item.scriptPath));
    const bodies = [page.body];
    if (script) { const response = await read(script.url, 'public-script'); if (response?.status === 200) bodies.push(response.body); }
    const portals = new Map();
    for (const body of bodies) for (const match of body.matchAll(/https:\/\/app\.mokahr\.com\/[^\s"'<>\\)]+/g)) {
      const portal = ParseMokaRecruitmentUrl(match[0]);
      if (portal) { const url = new URL(portal.url); url.search = ''; url.hash = ''; portals.set(url.toString(), { platform: 'moka', url: url.toString(), orgId: portal.orgId, siteId: portal.siteId, mode: portal.mode }); }
    }
    record.declaredRecruitmentPortals = [...portals.values()];
  }
  record.eligibility = record.declaredRecruitmentPortals.length ? 'contradicted_moka' : 'unverified';
  evidence.push(record);
}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), registrySha256: createHash('sha256').update(await readFile(new URL('../tests/fixtures/ats-sources-100.json', import.meta.url))).digest('hex'), output, evidence,
  contradictedCompanies: evidence.filter((item) => item.eligibility === 'contradicted_moka').map((item) => item.company) };
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, contradictedCompanies: report.contradictedCompanies, evidence: evidence.map(({ company, eligibility, declaredRecruitmentPortals, publicRecruitmentLinks }) => ({ company, eligibility, declaredRecruitmentPortals, publicRecruitmentLinks })) }));
