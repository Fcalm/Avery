import { randomUUID } from 'node:crypto';

/** 每个 CaseRun 独占的最小业务端口；所有写入仅修改内存副本，绝不连接生产 BusinessStore。 */
export class EvalTestBusiness {
  private profiles: unknown[];
  private resumes: any[];
  private snapshots = new Map<string, { sessionSnapshotJson: string; toolSnapshotJson: string }>();
  private attachments: Map<string, string>;

  constructor(fixtures: { profile?: unknown[]; resume?: Record<string, unknown> }, attachments: Map<string, string> = new Map()) {
    this.profiles = structuredClone(fixtures.profile ?? []);
    const resume = fixtures.resume && typeof fixtures.resume === 'object'
      ? { id: 'eval-resume', name: '测评简历', content: '', summary: '', targetRoles: [], revision: 1, ...structuredClone(fixtures.resume) }
      : null;
    this.resumes = resume ? [resume] : [];
    this.attachments = new Map(attachments);
  }

  GetStoredSettings(): any { return {}; }
  GetProfiles(): any { return { items: structuredClone(this.profiles), hash: null, modified: false }; }
  SaveProfiles(items: unknown[]): any { this.profiles = structuredClone(items); return { count: this.profiles.length, revision: 1 }; }
  LoadViewModel(): any { return { conversations: [], resumes: structuredClone(this.resumes), jobs: [], applications: [] }; }

  UpsertResume(resume: any, expectedRevision?: number): any {
    const index = this.resumes.findIndex((item) => item.id === resume.id);
    const current = index >= 0 ? this.resumes[index] : null;
    if (current && expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw Object.assign(new Error('Evaluation resume revision conflict.'), { code: 'REVISION_CONFLICT' });
    }
    const next = { ...structuredClone(resume), id: resume.id || `eval-resume-${randomUUID()}`, revision: (current?.revision ?? 0) + 1 };
    if (index >= 0) this.resumes[index] = next; else this.resumes.push(next);
    return { id: next.id, revision: next.revision };
  }

  GetConversationSnapshots(sessionId: string): any { return this.snapshots.get(sessionId) ?? null; }
  SetConversationSnapshots(sessionId: string, snapshots: any): any {
    this.snapshots.set(sessionId, structuredClone(snapshots));
    return { updated: true };
  }
  ResolveAttachmentUri(uri: string): string | null { return this.attachments.get(uri) ?? null; }

  Snapshot(): { profiles: unknown[]; resumes: unknown[] } {
    return { profiles: structuredClone(this.profiles), resumes: structuredClone(this.resumes) };
  }
}
