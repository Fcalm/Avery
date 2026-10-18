import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const require = createRequire(import.meta.url);
const { AtsPublicTransport } = require('../apps/backend/dist/electron/backend/ats/public-transport.js');
const output = resolve(process.argv[2] ?? `artifacts/ats-investigation/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const fixture = JSON.parse(await readFile('tests/fixtures/ats-sources-50.json', 'utf8'));
const tenants = ['ankki', 'chinadaily', 'kstar', 'kelunbotai', 'kedacom', 'eswin', 'zhito', 'gtgroup'];
const transport = new AtsPublicTransport();
const reports = [];
for (const tenant of tenants) {
  const source = fixture.sources.find((item) => new URL(item.url).hostname === `${tenant}.zhiye.com`);
  if (!source) throw new Error(`Missing frozen source: ${tenant}`);
  const pages = [];
  // 只读取公开入口与已知旧版公开列表，不访问登录、申请或内部推荐端点。
  for (const [name, path] of [['home', '/'], ['registration', '/portal/registerSystemInfo'], ['list', '/alljob/']]) {
    const url = new URL(path, source.url).toString();
    try {
      const response = await transport.Request(url, { signal: AbortSignal.timeout(10_000) });
      const bodyPath = resolve(output, `${tenant}-${name}.html`);
      await writeFile(bodyPath, response.body, 'utf8');
      const links = [...response.body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1].replace(/&amp;/g, '&'));
      pages.push({ name, url, status: response.status, bodyPath,
        title: response.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim(),
        portalIdPresent: /["']?PortalId["']?\s*[:=]/i.test(response.body),
        detailLinks: [...new Set(links.filter((link) => /jobid=|jobadid=|\/(?:zpdetail|detail)\/\d+/i.test(link)))],
        paginationLinks: [...new Set(links.filter((link) => /PageIndex=/i.test(link)))],
      });
      if ([401, 403, 429].includes(response.status)) break;
    } catch (error) { pages.push({ name, url, error: error.message }); break; }
  }
  const registration = pages.find((page) => page.name === 'registration');
  const list = pages.find((page) => page.name === 'list');
  const detailLink = list?.detailLinks?.[0] ?? pages.find((page) => page.name === 'home')?.detailLinks?.[0];
  if (detailLink) {
    const url = new URL(detailLink, source.url);
    if (url.origin === new URL(source.url).origin) {
      try {
        const detail = await transport.Request(url.toString(), { signal: AbortSignal.timeout(10_000) });
        const bodyPath = resolve(output, `${tenant}-detail.html`);
        await writeFile(bodyPath, detail.body, 'utf8');
        pages.push({ name: 'detail', url: url.toString(), status: detail.status, bodyPath });
      } catch (error) { pages.push({ name: 'detail', url: url.toString(), error: error.message }); }
    }
  }
  reports.push({ company: source.company, url: source.url, pages,
    conclusion: registration?.title === 'Not Found' && list?.detailLinks?.length
      ? '旧 CMS 无新 PortalId 接口，公开 HTML 列表含岗位链接，需旧列表与详情适配。'
      : list?.title === 'Not Found' || !list?.detailLinks?.length
        ? '旧列表未提供已识别的职位链接，需要调查页面声明的其他公开列表，不能认定企业没有岗位。'
        : '公开 HTML 含岗位入口，需核对列表分页和详情字段。',
  });
  console.log(JSON.stringify({ company: source.company, pages: pages.map(({ bodyPath, detailLinks, paginationLinks, ...page }) => ({ ...page, details: detailLinks?.length, pagination: paginationLinks?.length })) }));
}
await writeFile(resolve(output, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sources: reports }, null, 2), 'utf8');
console.log(JSON.stringify({ output, investigated: reports.length }));
