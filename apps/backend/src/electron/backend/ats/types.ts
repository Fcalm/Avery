export type AtsType = 'beisen' | 'moka' | 'hotjob' | 'feishu';
export type SourceHealth = 'healthy' | 'partial' | 'timeout' | 'schema_changed' | 'access_controlled' | 'empty' | 'unsupported';
export type SnapshotStatus = 'complete' | 'partial' | 'unknown';
export type Transport = 'public_api' | 'public_portal_json' | 'public_portal_html' | 'browser' | 'unsupported_private_api';

/** 企业事实来源与用户筛选后的岗位库分离；来源 ID 不依赖可变的企业名称。 */
export interface AtsSource {
  id: string;
  companyId: string;
  company: string;
  url: string;
  ats?: AtsType;
  enabled: boolean;
  maxPages?: 5 | 10 | 20;
  health?: SourceHealth;
  snapshotStatus?: SnapshotStatus;
  transport?: Transport;
  lastProbeAt?: string;
  lastSuccessAt?: string;
  lastJobCount?: number;
}

export interface NormalizedJob {
  id: string;
  sourceId: string;
  ats: AtsType;
  tenant: string;
  atsJobId: string;
  title: string;
  company: string;
  sourceUrl: string;
  applicationUrl: string;
  department?: string;
  locations: string[];
  jobType?: 'campus_recruitment' | 'social_recruitment' | 'intern';
  description?: string;
  requirements?: string;
  salary?: string;
  education?: string;
  experience?: string;
  publishedAt?: string;
  updatedAt?: string;
  /** 缺失或无法映射的公开字段来源；不以推测内容提升完整率。 */
  fieldIssues?: Partial<Record<'locations' | 'description' | 'requirements' | 'updatedAt', 'source_missing' | 'source_empty' | 'unmapped_value' | 'source_invalid'>>;
  rawHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: 'open' | 'closed' | 'unknown' | 'stale';
}

export interface QuarantinedJob {
  sourceId: string;
  atsJobId?: string;
  reason: string;
  raw: unknown;
  at: string;
}

export interface ProbeResult {
  ats: AtsType;
  tenant: string;
  portalId?: string;
  orgId?: string;
  siteId?: string;
  mode?: 'campus' | 'social';
  /** 已验证的北森旧 CMS 公开列表协议，不以缺少 PortalId 直接认定不可采集。 */
  protocol?: 'beisen_cms';
  listUrl?: string;
  listHtml?: string;
  recruitmentUrl?: string;
  feishuPath?: string;
  directJobId?: string;
  companyName?: string;
  recruitType?: 1 | 2 | 12 | 13;
  transport: Transport;
}

export interface SourceResult {
  sourceId: string;
  ats?: AtsType;
  health: SourceHealth;
  snapshotStatus: SnapshotStatus;
  transport: Transport;
  jobs: NormalizedJob[];
  quarantine: QuarantinedJob[];
  errors: Array<{ code: string; message: string }>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  requestCount: number;
  receivedCount: number;
  scope?: 'single_job';
  cacheHit?: boolean;
  publicJobCount?: number;
  detectedPlatform?: string;
  /** 未完成全量遍历的检查点；不代表增量同步或完整快照。 */
  continuation?: CollectionContinuation;
}

export interface CollectionContinuation {
  signature: string;
  startedAt: string;
  nextPage: number;
  firstPageHash: string;
  count?: number;
  receivedCount: number;
  jobs: NormalizedJob[];
  /** Hotjob 详情分段游标：尚未读取详情的当前页公开列表，不含认证或用户数据。 */
  pendingRows?: Array<Record<string, unknown>>;
}

export interface PublicResponse { status: number; body: string; url: string; etag?: string; lastModified?: string }
/** 缓存校验和飞书公开站点路由是固定用途字段，不开放任意请求头或认证信息。 */
export interface PublicRequest { method?: 'GET' | 'POST'; body?: unknown; bodyEncoding?: 'json' | 'form'; signal: AbortSignal; onRequest?: () => void; ifNoneMatch?: string; ifModifiedSince?: string; feishuPath?: string }
export interface PublicTransport {
  Request(url: string, input: PublicRequest): Promise<PublicResponse>;
}

export class AtsError extends Error {
  constructor(readonly code: string, message: string, readonly detectedPlatform?: string) { super(message); this.name = 'AtsError'; }
}

export interface AtsAdapter {
  readonly ats: AtsType;
  probe(source: AtsSource, transport: PublicTransport, signal: AbortSignal): Promise<ProbeResult>;
  collect(source: AtsSource, probe: ProbeResult, transport: PublicTransport, signal: AbortSignal, continuation?: CollectionContinuation): Promise<Pick<SourceResult, 'jobs' | 'quarantine' | 'snapshotStatus' | 'errors' | 'receivedCount' | 'continuation' | 'publicJobCount'>>;
}
