import { randomUUID } from 'node:crypto';
import { AgentBrowserError, type FormField } from './browser-form-service';

export type ResumeParseStatus = 'stable' | 'pending' | 'failed';
export type ImportProtection = {
  origin: 'existing' | 'resume_parse' | 'protected_before_upload' | 'ambiguous_before_upload';
  correctionPolicy: 'empty_only' | 'source_reviewed' | 'restore_only' | 'protected';
  previous?: FormField;
};
const Key = (f: FormField) => JSON.stringify([f.context.section, f.semantic.concept, f.raw.label || f.label, f.control]);
const Document = (fields: FormField[]) => fields.find(f => f.nodeIdentity)?.nodeIdentity?.split(':')[0];

/** 上传基线仅存于当前浏览器任务内；重复经历重建后不能仅按数组序号恢复用户内容。 */
export class ResumeImportBaseline {
  private state?: { id: string; url: string; document?: string; createdAt: number; fields: FormField[]; status: ResumeParseStatus };

  Begin(fields: FormField[], url: string, now: number): string {
    const previous = this.state;
    this.state = { id: `import-${randomUUID()}`, url, document: Document(fields), createdAt: now,
      // 同一文档再次上传仍保护首次上传前的内容，不能把上次错误解析当成用户原有值。
      fields: previous?.url === url && previous.document === Document(fields) ? previous.fields : structuredClone(fields), status: 'pending' };
    return this.state.id;
  }

  Complete(id: string, status: ResumeParseStatus): void {
    if (this.state?.id !== id) throw new AgentBrowserError('BROWSER_RESUME_IMPORT_EXPIRED', 'The resume upload changed. Observe the current form before continuing.');
    this.state.status = status;
  }

  Current(url?: string): { id: string; status: ResumeParseStatus } | undefined {
    return this.state && (url === undefined || this.state.url === url) ? { id: this.state.id, status: this.state.status } : undefined;
  }

  Check(fields: FormField[], url: string, now?: number, writing = false): void {
    const state = this.state;
    if (!state || state.url !== url) return;
    if ((now !== undefined && now - state.createdAt > 30 * 60_000) || state.document !== Document(fields)) {
      throw new AgentBrowserError('BROWSER_RESUME_IMPORT_EXPIRED', 'The upload baseline expired or the document changed; do not restore values using old field positions.');
    }
    if (writing && state.status === 'failed') throw new AgentBrowserError('BROWSER_RESUME_PARSE_FAILED','The website reported resume upload/parsing failure. Review that failure before filling; do not blindly upload again.');
    if (writing && state.status === 'pending') throw new AgentBrowserError('BROWSER_RESUME_PARSE_PENDING', 'Resume parsing is not ready. Use BrowserWait({kind:"resume_parse",value:"settled"}); never upload the file again just to wait.');
  }

  Resolve(field: FormField, fields: FormField[], url: string): ImportProtection {
    const state = this.state;
    if (!state || state.url !== url) return { origin: 'existing', correctionPolicy: 'empty_only' };
    let previous = field.nodeIdentity ? state.fields.find(f => f.nodeIdentity === field.nodeIdentity) : undefined;
    if (!previous) {
      const old = state.fields.filter(f => Key(f) === Key(field));
      const current = fields.filter(f => Key(f) === Key(field));
      if (old.length === 1 && current.length === 1) previous = old[0];
      else if (old.some(f => f.filled)) return { origin: 'ambiguous_before_upload', correctionPolicy: 'protected' };
    }
    if (previous?.filled && previous.currentValue !== '') {
      return { origin: 'protected_before_upload', correctionPolicy: previous.currentValue === undefined ? 'protected' : 'restore_only', previous };
    }
    return { origin: 'resume_parse', correctionPolicy: 'source_reviewed', previous };
  }

  Unresolved(fields: FormField[], url: string): Array<{ label: string; value?: string; recordIndex?: number }> {
    if (this.state?.url !== url) return [];
    return this.state.fields.filter(f => f.filled && !fields.some(current => current.nodeIdentity && current.nodeIdentity === f.nodeIdentity)
      && !(this.state!.fields.filter(old => Key(old) === Key(f)).length === 1 && fields.filter(current => Key(current) === Key(f)).length === 1))
      .map(f => ({ label: f.raw.label || f.label, value: f.currentValue, recordIndex: f.context.recordIndex }));
  }

  Clear(): void { this.state = undefined; }
}
