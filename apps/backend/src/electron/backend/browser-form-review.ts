import { randomUUID } from 'node:crypto';
import {
  AgentBrowserError, BuildFormFacts, CanonicalFormField, CreateFormFillPlan, FormFieldAliases, FormValuesMatch, NormalizeFormLabel, ParseFormDateValue,
  type FormFact, type FormField, type FormFillOperation, type FormFillPlan,
} from './browser-form-service';
import { ResumeImportBaseline } from './browser-resume-import';

type SourceDocument = { sourceId: string; title: string; content: string; section?: string; recordKey?: string; recordPrefix?: string };
type Review = {
  createdAt: number; url: string; signature: string;
  sources: Record<string, unknown>; facts: Map<string, FormFact>; documents: Map<string, SourceDocument>;
  consumed: boolean;
  restoreTargets: Map<string, string>;
};
export type FormSelection = { fieldId: string; factId?: string; sourceId?: string; quote?: string; value?: string; field?: string };

function Fail(message: string): never { throw new AgentBrowserError('BROWSER_FORM_REVIEW_INVALID', message); }
const Signature = (fields: FormField[]) => JSON.stringify(fields.map(f => [f.nodeIdentity, f.label, f.control, f.semantic.concept, f.context.section, f.context.recordIndex, f.context.recordIdentity, f.context.groupHeading, f.options, f.currentValue, f.filled, f.disabled, f.readOnly]));
const Plain = (value: string) => value.normalize('NFKC').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();

/** 两阶段协议：先暴露业务字段和来源，再接受有来源依据的批量匹配；本类不执行浏览器动作。 */
export class BrowserFormReviewService {
  readonly resumeImport = new ResumeImportBaseline();
  private readonly reviews = new Map<string, Review>();
  private readonly expected = new Map<string, { url: string; operations: FormFillOperation[] }>();
  private readonly recordSources = new Map<string, string>();

  /** 新上传使旧审阅、预期和记录绑定失效；原始上传基线由 resumeImport 保留。 */
  ResetForResumeUpload(): void { this.reviews.clear(); this.expected.clear(); this.recordSources.clear(); }

  private Get(id: string, now: number, url: string): Review {
    const review = this.reviews.get(id);
    if (!review || now - review.createdAt > 30 * 60_000 || review.url !== url) {
      this.reviews.delete(id);
      throw new AgentBrowserError('BROWSER_FORM_CONTINUATION_EXPIRED', 'The form review expired or the page navigated. Request a new plan with authorized source IDs.');
    }
    return review;
  }

  /** 冻结字段结构与 Host 授权来源；仅返回审阅数据，不建立执行意图或记录来源绑定。 */
  Plan(fields: FormField[], sources: Record<string, unknown> | undefined, now: number, url: string, continuationId?: string): Record<string, unknown> {
    this.resumeImport.Check(fields, url, now);
    const prior = continuationId ? this.Get(continuationId, now, url) : undefined;
    const effectiveSources = prior?.sources ?? sources;
    if (!effectiveSources) throw new AgentBrowserError('BROWSER_FORM_SOURCE_REQUIRED', 'Select authorized profile IDs or the bound resume.');
    const documents = new Map<string, SourceDocument>();
    const categories: Record<string, string> = { application: 'personal', education: 'education', work: 'work', project: 'project', job_intention: 'preference' };
    const profiles = Array.isArray(effectiveSources.profiles) ? effectiveSources.profiles : [];
    const categoryIndexes = new Map<string, number>();
    for (const raw of profiles) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const sourceId = `d${documents.size + 1}`;
      const category = String(p.category), recordIndex = categoryIndexes.get(category) ?? 0;
      categoryIndexes.set(category, recordIndex + 1);
      const profileId = String(p.id ?? 'profile').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) || 'profile';
      documents.set(sourceId, { sourceId, title: String(p.title ?? p.id), content: String(p.content ?? ''), section: categories[category], recordKey: `profiles.${profileId}.${categories[category]}:${recordIndex}` });
    }
    const resume = effectiveSources.resume as Record<string, unknown> | undefined;
    if (resume) {
      const sourceId = `d${documents.size + 1}`;
      documents.set(sourceId, { sourceId, title: String(resume.name ?? '已绑定简历'), content: String(resume.content ?? ''), recordPrefix: `resume.${String(resume.id ?? 'bound')}` });
    }
    const { facts } = BuildFormFacts(effectiveSources);
    const catalog = new Map(facts.map((fact, i) => [`s${i + 1}`, fact]));
    const restoreTargets = new Map<string, string>();
    const restoreFacts = new Map<string, string>();
    for (const [i, field] of fields.entries()) {
      if (['file','checkbox'].includes(field.control)) continue;
      const protection = this.resumeImport.Resolve(field, fields, url), value = protection.previous?.currentValue;
      if (protection.correctionPolicy !== 'restore_only' || value === undefined || value === field.currentValue) continue;
      const factId = `s${catalog.size + 1}`, fieldId = `f${i + 1}`;
      catalog.set(factId, { key: CanonicalFormField(field.raw.label || field.label) ?? '', concept: field.semantic.concept, section: field.context.section,
        recordIndex: field.context.recordIndex, value, valueType: field.semantic.valueType === 'unknown' ? 'text' : field.semantic.valueType,
        sourceTitle: '上传前页面内容（仅恢复原字段）', sourcePath: `preupload.${fieldId}`, reusable: true });
      restoreTargets.set(factId, fieldId); restoreFacts.set(fieldId, factId);
    }
    const id = `form-${randomUUID()}`;
    while (this.reviews.size >= 20) this.reviews.delete(this.reviews.keys().next().value!);
    this.reviews.set(id, { createdAt: now, url, signature: Signature(fields), sources: effectiveSources, facts: catalog, documents, consumed: false, restoreTargets });
    const suggested = CreateFormFillPlan(fields, effectiveSources);
    return {
      phase: 'plan', continuationId: id, executed: false,
      missingFields: suggested.missingFields,
      instruction: 'Review the values and their source evidence. Execute only explicitly selected fields with mode:execute and selections. Omitted fields remain untouched. Use factId for known facts, or sourceId + exact quote + contained value + canonical field for free-form extraction. Never guess missing facts. Request a new plan after DOM changes or execution; do not use global DOM indexes.',
      fields: fields.map((f, i) => ({ fieldId: `f${i + 1}`, label: f.raw.label || f.label, section: f.context.section, group: f.context.groupHeading, recordIndex: f.context.recordIndex,
        concept: f.semantic.concept, control: f.control, required: f.required, editable: !f.disabled && !f.readOnly && !['checkbox', 'file'].includes(f.control),
        filled: f.filled, currentValue: f.currentValue, options: f.options,
        ...(() => { if (!this.resumeImport.Current(url)) return {}; const p = this.resumeImport.Resolve(f, fields, url); return { origin:p.origin, correctionPolicy:p.correctionPolicy,
          ...(p.previous?.filled && p.previous.currentValue !== undefined ? {beforeUploadValue:p.previous.currentValue} : {}),
          ...(restoreFacts.has(`f${i+1}`) ? {restoreFactId:restoreFacts.get(`f${i+1}`)} : {}) }; })(),
        suggestedFactId: [...catalog].find(([, fact]) => suggested.operations.some(op => op.ref === f.ref && op.sourcePath === fact.sourcePath))?.[0],
      })),
      facts: [...catalog].map(([factId, f]) => ({ factId, field: f.key, concept: f.concept, section: f.section, recordIndex: f.recordIndex, value: f.value, source: f.sourceTitle })),
      ...(this.resumeImport.Current(url) ? { resumeImport:this.resumeImport.Current(url), unresolvedProtectedFields:this.resumeImport.Unresolved(fields,url) } : {}),
      // 续填时来源 ID 与正文保持不变，避免每次规划重复发送整份简历；丢失正文后可用原来源 ID 重新开始。
      sourceContentUnchanged: Boolean(prior),
      sources: [...documents.values()].map(({recordKey: _recordKey, recordPrefix: _recordPrefix, ...d}) => prior
        ? { sourceId:d.sourceId, title:d.title, section:d.section, contentUnchanged:true }
        : { ...d, content: d.content.slice(0, 20000), truncated: d.content.length > 20000 }),
    };
  }

  /** 整批校验通过才消费句柄；Agent 只能选择已授权事实或有原文依据的提取，不能指定 DOM 操作。 */
  Compile(id: string, selections: FormSelection[], fields: FormField[], now: number, url: string, pageRevision: number): FormFillPlan {
    this.resumeImport.Check(fields, url, now, true);
    const review = this.Get(id, now, url);
    if (review.consumed) Fail('This review was already executed. Request a new plan; do not replay selections.');
    if (review.signature !== Signature(fields)) Fail('The form structure, options, or document identity changed. Request a new plan before writing.');
    if (!Array.isArray(selections) || selections.length > 100) Fail('Provide at most 100 reviewed selections.');
    const operations: FormFillOperation[] = [], verifiedOperations: FormFillOperation[] = [], seen = new Set<string>(), consumed = new Map<string, string>();
    const recordBindings = new Map<string, string>();
    for (const selection of selections) {
      const index = /^f([1-9]\d*)$/.exec(selection.fieldId)?.[1];
      const target = index ? fields[Number(index) - 1] : undefined;
      if (!target || seen.has(selection.fieldId)) Fail(`Unknown or repeated fieldId: ${selection.fieldId}.`);
      const fail: (message: string) => never = message => Fail(`Field ${selection.fieldId} (${target.raw.label || target.label}): ${message}`);
      seen.add(selection.fieldId);
      if (target.disabled || target.readOnly || ['checkbox', 'file'].includes(target.control)
        || /协议|隐私|条款|签名|同意|agreement|privacy|terms|signature/i.test(target.label)) fail('The selected field cannot be filled by this tool.');
      let fact = selection.factId ? review.facts.get(selection.factId) : undefined;
      const restoreTarget = selection.factId ? review.restoreTargets.get(selection.factId) : undefined;
      if (restoreTarget && restoreTarget !== selection.fieldId) fail('A pre-upload value can only restore its original field.');
      let sourceRecord = fact ? `${fact.sourcePath.split('.').slice(0, -2).join('.')}:${fact.recordIndex ?? 0}` : '';
      if (selection.factId && (!fact || selection.sourceId || selection.quote || selection.value || selection.field)) fail('Choose either one authorized factId or an evidence-backed extraction.');
      if (!selection.factId) {
        const doc = review.documents.get(selection.sourceId ?? '');
        const quote = selection.quote?.trim(), value = selection.value?.trim(), key = selection.field;
        if (!doc || !quote || !value || value.length > 20000 || !key || CanonicalFormField(key) !== key
          || !doc.content.includes(quote) || !Plain(quote).includes(Plain(value))) fail('Extraction must cite an exact quote from an authorized source and a value contained in that quote.');
        // 通过现有规范字段定义产生事实，Agent 提取与用户补充始终保留不同来源。
        fact = BuildFormFacts({ decisions: [{ field: key, value, section: target.context.section, recordIndex: target.context.recordIndex }] }).facts[0];
        if (!fact) fail('Unknown canonical field.');
        if (doc.content.indexOf(quote) !== doc.content.lastIndexOf(quote)) fail('The quote is ambiguous; include enough surrounding source text to identify the record.');
        if (key === 'name' && /经历|简历|背景|resume|curriculum/i.test(value)) fail('A section heading is not a person name.');
        if (fact.valueType === 'phone' && !/^(?:\+?\d[\d ()-]{5,24})$/.test(value)) fail('Invalid source phone number.');
        if (fact.valueType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('Invalid source email.');
        const prefix = doc.content.slice(0, doc.content.indexOf(quote));
        const headings = [...prefix.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1]);
        const sourceSection = doc.section ?? headings.reverse().map(h => /项目|project/i.test(h) ? 'project' : /教育|education/i.test(h) ? 'education' : /工作|work|employment/i.test(h) ? 'work' : undefined).find(Boolean);
        if (sourceSection && sourceSection !== fact.section) fail('The source excerpt belongs to a different section.');
        const quoteStart = doc.content.indexOf(quote);
        const recordHeadings = [...doc.content.matchAll(/^#{3,6}\s+.+$/gm)];
        const inside = recordHeadings.filter(h => h.index >= quoteStart && h.index < quoteStart + quote.length);
        if (inside.length > 1) fail('Use an excerpt from one source record, not several projects or jobs.');
        const heading = inside[0] ?? recordHeadings.filter(h => h.index <= quoteStart).at(-1);
        sourceRecord = doc.recordKey ?? `${doc.recordPrefix ?? doc.sourceId}:${heading?.index ?? fact.recordIndex ?? 0}`;
        fact = { ...fact, sourceTitle: doc.title, sourcePath: `agent.${doc.sourceId}.${key}.${doc.content.indexOf(quote)}`, reusable: fact.reusable };
      }
      if (!fact) fail('Select an authorized source.');
      const protection = this.resumeImport.Resolve(target, fields, url);
      if (protection.correctionPolicy === 'protected') fail('The pre-upload field is protected or ambiguous. Review its original value and record before correcting it.');
      if (protection.correctionPolicy === 'restore_only' && !FormValuesMatch(fact.key, protection.previous?.currentValue ?? '', fact.value)) fail('This field contained a different value before upload. Restore that original value; do not overwrite it with parser output or conflicting sources.');
      if (target.context.section && fact.section !== target.context.section) fail('Source and target sections differ.');
      const explicitConcept = FormFieldAliases.some(([, aliases]) => aliases.some(alias => NormalizeFormLabel(alias) === NormalizeFormLabel(target.raw.label ?? target.label)));
      if (explicitConcept && target.semantic.concept !== 'unknown' && target.semantic.concept !== fact.concept) fail('Source and target concepts differ.');
      if (target.semantic.valueType !== 'unknown' && target.semantic.valueType !== 'text' && target.semantic.valueType !== fact.valueType) fail('Source and target value types differ.');
      // 汇总字段可以引用经历事实，但不构成另一条经历；同一条记录的重复展示也允许复用。
      const summary = target.context.section === 'education' && /^(最高学历|最高学位|(?:预计)?毕业(?:时间|日期))$/.test(NormalizeFormLabel(target.raw.label || target.label));
      const recordKey = summary ? undefined : target.context.recordIdentity ?? (target.context.recordIndex !== undefined ? `${target.context.section}:${target.context.recordIndex}` : undefined);
      if (!restoreTarget && recordKey && ['education', 'work', 'project'].includes(target.context.section ?? '')) {
        const bound = recordBindings.get(recordKey) ?? this.recordSources.get(recordKey);
        if (bound && bound !== sourceRecord) fail('Fields in one target record must come from the same source record.');
        recordBindings.set(recordKey, sourceRecord);
      }
      if (!fact.reusable && !summary) {
        const targetRecord = recordKey ?? target.fieldId;
        if (consumed.has(fact.sourcePath) && consumed.get(fact.sourcePath) !== targetRecord) fail('This source fact cannot be assigned to multiple records.');
        consumed.set(fact.sourcePath, targetRecord);
      }
      // 已有内容必须保留。更正冲突走独立、可观察的修正动作，不允许批量覆盖。
      if (target.filled && protection.correctionPolicy === 'empty_only' && !FormValuesMatch(fact.key, fact.value, target.currentValue ?? '')) continue;
      const kind = target.control === 'radio' ? 'check' : target.control === 'select'
        ? target.options?.length ? 'select' : ['date', 'yearMonth'].includes(fact.valueType) && ParseFormDateValue(fact.value) ? 'custom_date' : 'custom_select' : 'fill';
      const matches = target.options?.filter(o => FormValuesMatch(fact.key, fact.value, o.label) || NormalizeFormLabel(o.value) === NormalizeFormLabel(fact.value)) ?? [];
      if (new Set(matches.map(o => o.value)).size > 1) fail('Multiple observed options match the source value. Inspect the specific choices before selecting.');
      const option = matches[0];
      if (kind === 'select' && !option) fail(`The value is not an observed option. Observed options: ${JSON.stringify((target.options ?? []).slice(0,40).map(o=>o.label))}.`);
      if (kind === 'check' && NormalizeFormLabel(target.label) !== NormalizeFormLabel(fact.value)) fail('The radio option does not match the source value.');
      const peers = fields.filter(f => f.semantic.concept === target.semantic.concept);
      const operation: FormFillOperation = { kind, ref: target.ref, key: fact.key, occurrence: peers.indexOf(target), value: kind === 'check' ? 'true' : option?.value ?? fact.value,
        expectedValue: option?.label ?? fact.value, label: target.label, targetLabel: target.label, targetSection: target.context.section,
        targetNodeIdentity: target.nodeIdentity, targetConcept: target.semantic.concept, targetRecordIndex: target.context.recordIndex,
        targetRecordIdentity: recordKey, ...(!restoreTarget ? {sourceRecordKey: sourceRecord} : {}),
        targetOccurrence: fields.filter(f => f.control === 'select' && !f.options?.length && f.semantic.concept === target.semantic.concept && NormalizeFormLabel(f.label) === NormalizeFormLabel(target.label)).indexOf(target),
        ...(target.interaction.adapter ? { adapter: target.interaction.adapter } : {}), sourceTitle: fact.sourceTitle, sourcePath: fact.sourcePath, sourcePaths: [fact.sourcePath], concept: fact.concept, strategy: 'agent' };
      if (target.currentValue !== undefined && OperationValueMatches(target, operation)) verifiedOperations.push(operation);
      else operations.push(operation);
    }
    if (operations.reduce((n, op) => n + op.value.length, 0) > 100000) Fail('Selected values exceed the form content limit.');
    // 原生选择与单选可能重建后续节点；每批仅执行一个，余项必须重新规划。
    const changing = operations.filter(op => ['select', 'check'].includes(op.kind));
    const scheduled = [...operations.filter(op => op.kind === 'fill'), ...changing.slice(0,1), ...operations.filter(op => op.kind === 'custom_date' || op.kind === 'custom_select')];
    const skipped = changing.slice(1).map(op => ({ fieldId: `field-${op.ref.slice(1)}`, label: op.label, reason: 'reinspect_after_selection' }));
    review.consumed = true;
    return { operations: scheduled, verifiedOperations, pageRevision, createdAt: now, continuationId: id, skipped, missingFields: [], ambiguous: [], unmatched: [], sourceTitles: [...new Set(operations.map(op => op.sourceTitle))] };
  }

  /** 确认等待期间若解析或用户改变字段，必须重新规划，不能执行旧值上的覆盖决定。 */
  AssertCurrent(id: string, fields: FormField[], now: number, url: string): void {
    this.resumeImport.Check(fields,url,now,true);
    if (this.Get(id,now,url).signature !== Signature(fields)) Fail('The form values or structure changed after review. Request a new plan before writing.');
  }

  /** 只有真正执行后的已核实字段才绑定记录来源；取消或未执行的提案不能污染下一批匹配。 */
  RecordExecution(plan: FormFillPlan, url: string, completed: FormFillOperation[]): void {
    this.expected.set(plan.continuationId!, {url, operations:[...plan.operations, ...plan.verifiedOperations ?? []]});
    while(this.expected.size>20)this.expected.delete(this.expected.keys().next().value!);
    for(const op of [...completed,...plan.verifiedOperations ?? []]) if(op.targetRecordIdentity && op.sourceRecordKey) this.recordSources.set(op.targetRecordIdentity,op.sourceRecordKey);
    while(this.recordSources.size>300)this.recordSources.delete(this.recordSources.keys().next().value!);
  }

  /** 回读结果只证明与已审阅来源一致，不能宣称所有语义或网页必填项均正确。 */
  Validate(fields: FormField[], url: string, now?: number): { businessValid: boolean | null; fieldChecks: Array<Record<string, unknown>> } {
    this.resumeImport.Check(fields,url,now);
    // 同一真实节点的最新计划取代旧预期，避免修正后仍被旧值永久判错。
    const latest = new Map<string, FormFillOperation>();
    for (const r of this.expected.values()) if (r.url === url) for (const op of r.operations) latest.set(op.targetNodeIdentity ?? JSON.stringify([op.targetSection, op.targetRecordIndex, op.label]), op);
    const checkedFields: Array<FormField | undefined> = [];
    const checks: Array<Record<string,unknown>> = [...latest.values()].map(op => {
      const field = FindOperationField(fields, op);
      checkedFields.push(field);
      return { label: op.label, section: op.targetSection, recordIndex: op.targetRecordIndex, expected: op.expectedValue ?? op.value,
        actual: field?.currentValue ?? null, source: op.sourceTitle, status: !field || field.currentValue === undefined ? 'unverified' : OperationValueMatches(field, op) ? 'matched' : 'mismatch' };
    });
    // Agent 漏选恢复项时也必须发现原有内容被解析覆盖，不能只核验它选择修正的字段。
    for (const field of fields) {
      const previous = this.resumeImport.Resolve(field,fields,url).previous;
      if (!previous?.filled || previous.currentValue === undefined) continue;
      const matched = field.currentValue !== undefined && FormValuesMatch(CanonicalFormField(field.raw.label || field.label) ?? '',previous.currentValue,field.currentValue);
      const index = checkedFields.indexOf(field);
      const check = {label:field.raw.label || field.label,section:field.context.section,recordIndex:field.context.recordIndex,
        expected:previous.currentValue,actual:field.currentValue??null,source:'上传前页面内容',status:field.currentValue===undefined?'unverified':matched?'matched':'mismatch'};
      if (index < 0) checks.push(check);
      else if (!matched) checks[index]=check;
    }
    for (const old of this.resumeImport.Unresolved(fields,url)) checks.push({label:old.label,expected:old.value,actual:null,recordIndex:old.recordIndex,source:'上传前页面内容',status:'unverified',reason:'pre_upload_record_unresolved'});
    if (this.resumeImport.Current(url)?.status && this.resumeImport.Current(url)?.status !== 'stable') return {businessValid:null,fieldChecks:checks};
    return { businessValid: checks.length && checks.every(c => c.status === 'matched') ? true : checks.some(c => c.status === 'mismatch') ? false : null, fieldChecks: checks };
  }

  Clear(): void { this.reviews.clear(); this.expected.clear(); this.recordSources.clear(); this.resumeImport.Clear(); }
}

/** 优先绑定同一文档内的真实节点；无身份元数据时只接受区块、记录、标题和语义唯一的字段。 */
export function FindOperationField(fields: FormField[], operation: FormFillOperation): FormField | undefined {
  if (operation.targetNodeIdentity) return fields.find(f => f.nodeIdentity === operation.targetNodeIdentity);
  const peers = fields.filter(f => f.semantic.concept === (operation.targetConcept ?? operation.concept) && (operation.targetSection === undefined || f.context.section === operation.targetSection)
    && (operation.targetRecordIndex === undefined || f.context.recordIndex === operation.targetRecordIndex) && NormalizeFormLabel(f.label) === NormalizeFormLabel(operation.targetLabel ?? operation.label));
  return peers.length === 1 ? peers[0] : undefined;
}

/** 仅在完整回读可用时按来源精度、有限枚举同义值核验；非空或截断快照不能替代核验。 */
export function OperationValueMatches(field: FormField, operation: FormFillOperation): boolean {
  if (field.currentValue === undefined) return false;
  const expected = operation.kind === 'check' ? 'true' : operation.expectedValue ?? operation.value;
  return FormValuesMatch(operation.key, expected, field.currentValue)
    || (operation.kind === 'select' && Plain(field.currentValue) === Plain(operation.value));
}
