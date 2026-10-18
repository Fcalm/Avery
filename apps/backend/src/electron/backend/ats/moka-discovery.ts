import { AtsError } from './types';

export function ParseMokaRecruitmentUrl(value: string): { orgId: string; siteId?: string; mode: 'campus' | 'social'; url: string } | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined;
  if (!/(?:^|\.)mokahr\.com$/i.test(url.hostname)) return undefined;
  const match = url.pathname.match(/^\/(campus-recruitment|social-recruitment|apply)\/([^/]+)(?:\/(\d+))?\/?$/);
  if (!match) return undefined;
  let orgId: string;
  try { orgId = decodeURIComponent(match[2]); } catch { return undefined; }
  if (!/^[\w.-]+$/.test(orgId)) return undefined;
  url.hash = '';
  return { orgId, siteId: match[3], mode: match[1] === 'campus-recruitment' ? 'campus' : 'social', url: url.toString() };
}

/** 仅解析公开 HTML 声明的标准入口，不执行 JS，不猜测多个招聘站的选择顺序。 */
export function DiscoverMokaRecruitment(html: string, finalUrl: string): ReturnType<typeof ParseMokaRecruitmentUrl> {
  const direct = ParseMokaRecruitmentUrl(finalUrl);
  if (direct) return direct;
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const entries = new Map<string, NonNullable<ReturnType<typeof ParseMokaRecruitmentUrl>>>();
  for (const match of clean.matchAll(/<(?:a|iframe|link)\b[^>]*(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let url: URL;
    try { url = new URL(match[1].replace(/&amp;/g, '&'), finalUrl); } catch { continue; }
    const entry = ParseMokaRecruitmentUrl(url.toString());
    if (entry) entries.set(JSON.stringify([entry.orgId, entry.siteId, entry.mode]), entry);
  }
  if (entries.size > 1) throw new AtsError('SOURCE_MULTIPLE_PORTALS', 'Public page exposes multiple Moka recruitment portals; provide one explicit recruitment URL instead of assuming a complete list.');
  if (entries.size === 1) return [...entries.values()][0];
  // 自定义域名保留标准路径时还须有 Moka 静态资源或接口特征，路径名称本身不构成平台证据。
  if (/(?:https?:)?\/\/[^\s"'<>]*mokahr\.com\//i.test(clean)) {
    const url = new URL(finalUrl);
    return ParseMokaRecruitmentUrl(`https://app.mokahr.com${url.pathname}`);
  }
  return undefined;
}
