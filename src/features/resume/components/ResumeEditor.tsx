import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ResumeDataToText, ResumeLimits, ResumeTemplates, type ResumeData } from '@avery/contracts';
import { Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { ValidateResumeDraft, type ResumeDraft } from '../resumeDraft';
import { ResumePdfPreview } from './ResumePdfPreview';
import '../../../styles/resume-editor.css';

interface Props { value: ResumeDraft; onChange: (value: ResumeDraft) => void; validationAttempt: number; disabled?: boolean }

/** 两处简历编辑入口复用；数量约束同时由按钮、共享 Schema 与服务端校验保护。 */
export function ResumeEditor({ value, onChange, validationAttempt, disabled = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const data = value.data;
  const [previewOpen, SetPreviewOpen] = useState(false);
  const issues = validationAttempt ? ValidateResumeDraft(value) : [];
  const errors = new Map(issues.map((issue) => [issue.path, issue.message]));
  useEffect(() => {
    if (validationAttempt) root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [validationAttempt]);
  function Update(update: (next: ResumeData) => void) { const next = structuredClone(data); update(next); onChange({ ...value, data: next }); }
  function Field(path: string, label: string, content: string, change: (text: string) => void, optional = false, multiline = false, placeholder?: string) {
    const id = `${prefix}-${path}`;
    const props = { id, value: content, disabled, 'aria-invalid': errors.has(path), 'aria-describedby': errors.has(path) ? `${id}-error` : undefined, 'aria-required': !optional, onChange: (event: { target: { value: string } }) => change(event.target.value), placeholder, maxLength: path === 'name' ? 200 : path === 'legacyContent' ? 200000 : multiline ? 20000 : 2000 };
    return <div className={`rse-field${multiline ? ' rse-wide' : ''}`} key={path}>
      <label htmlFor={id}>{label}{!optional && <span className="rse-required" aria-hidden="true"> *</span>}{optional && <span className="rse-optional">选填</span>}</label>
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} type={path === 'personal.email' ? 'email' : path === 'personal.phone' ? 'tel' : 'text'} />}
      {errors.has(path) && <span className="rse-error" id={`${id}-error`}>{errors.get(path)}</span>}
    </div>;
  }
  function Remove(label: string, action: () => void, limit = false) { return <button className="icon-btn" type="button" disabled={disabled || limit} title={limit ? '至少保留一条内容' : `删除${label}`} aria-label={`删除${label}`} onClick={action}><Icon name="delete" size={14} /></button>; }
  function Lines(path: string, items: string[], update: (items: string[]) => void) {
    return <div className="rse-lines">{items.map((line, index) => <div className="rse-line" key={`${path}.${index}`}>
      {Field(`${path}.${index}`, `描述 ${index + 1}`, line, (text) => update(items.map((entry, i) => i === index ? text : entry)), false, true)}
      {Remove(`描述 ${index + 1}`, () => update(items.filter((_, i) => i !== index)), items.length <= 1)}
    </div>)}<div className="rse-add-row"><button className="ghost-btn" type="button" disabled={disabled || items.length >= ResumeLimits.lines} onClick={() => update([...items, ''])}><Icon name="plus" size={13} />添加内容</button><span>{items.length}/5 条</span></div></div>;
  }
  function Period(path: string, row: { start: string; end: string }, update: (key: 'start' | 'end', text: string) => void) {
    return <>{Field(`${path}.start`, '开始时间', row.start, (text) => update('start', text), false, false, '如 2024-09')}{Field(`${path}.end`, '结束时间', row.end, (text) => update('end', text), false, false, '如 2026-06 或 至今')}</>;
  }
  function Section(title: string, count: number, add: () => void, children: ReactNode) {
    return <section className="rse-section"><div className="rse-section-head"><h3>{title}</h3><span>{count}/3 组</span><button className="ghost-btn" type="button" disabled={disabled || count >= ResumeLimits.groups} title={count >= 3 ? '最多添加 3 组' : undefined} onClick={add}><Icon name="plus" size={13} />添加</button></div>{children}</section>;
  }
  return <div className="resume-editor" ref={root}>
    <fieldset className="rse-fields" disabled={disabled}>
      <div className="rse-title">{Field('name', '简历标题', value.name, (name) => onChange({ ...value, name }))}</div>
      <div className="rse-template"><label htmlFor={`${prefix}-template`}>简历模板</label><Select id={`${prefix}-template`} ariaLabel="简历模板" value={value.templateId} options={ResumeTemplates.map((item) => ({ value: item.id, label: item.label }))} onChange={(id) => onChange({ ...value, templateId: id as ResumeDraft['templateId'] })} disabled={disabled} /></div>
      {!!issues.length && <p className="rse-error-summary" role="alert">{errors.get('content') ?? `有 ${issues.length} 项需要检查，请补全红色标记的字段。`}</p>}
      {data.mode === 'legacy' ? <section className="rse-section"><div className="rse-section-head"><h3>旧版简历</h3><button className="ghost-btn" type="button" onClick={() => Update((next) => { next.mode = 'structured'; })}>转为结构化编辑</button></div><p className="rse-hint">原文已完整保留。转为结构化编辑后，可逐项整理内容，原文仍会保留。</p>{Field('legacyContent', '简历原文', data.legacyContent ?? '', (text) => Update((next) => { next.legacyContent = text; }), false, true)}</section> : <>
        <section className="rse-section"><div className="rse-section-head"><h3>个人信息</h3></div><div className="rse-grid">{(['name', 'email', 'phone', 'github'] as const).map((key) => Field(`personal.${key}`, { name: '姓名', email: '邮箱', phone: '手机', github: 'GitHub 主页' }[key], data.personal[key], (text) => Update((next) => { next.personal[key] = text; }), key === 'github'))}</div></section>
        {Section('教育经历', data.education.length, () => Update((next) => { next.education.push({ school: '', degree: '', major: '', start: '', end: '' }); }), data.education.map((row, i) => <div className="rse-entry" key={i}><div className="rse-entry-head"><h4>教育经历 {i + 1}</h4>{Remove(`教育经历 ${i + 1}`, () => Update((next) => { next.education.splice(i, 1); }))}</div><div className="rse-grid">{(['school', 'degree', 'major'] as const).map((key) => Field(`education.${i}.${key}`, { school: '学校', degree: '学历', major: '专业' }[key], row[key], (text) => Update((next) => { next.education[i][key] = text; })))}{Period(`education.${i}`, row, (key, text) => Update((next) => { next.education[i][key] = text; }))}</div></div>))}
        {Section('工作经历', data.work.length, () => Update((next) => { next.work.push({ company: '', project: '', role: '', start: '', end: '', descriptions: [''] }); }), data.work.map((row, i) => <div className="rse-entry" key={i}><div className="rse-entry-head"><h4>工作经历 {i + 1}</h4>{Remove(`工作经历 ${i + 1}`, () => Update((next) => { next.work.splice(i, 1); }))}</div><div className="rse-grid">{(['company', 'project', 'role'] as const).map((key) => Field(`work.${i}.${key}`, { company: '公司名称', project: '项目名称', role: '职位' }[key], row[key], (text) => Update((next) => { next.work[i][key] = text; }), key === 'project'))}{Period(`work.${i}`, row, (key, text) => Update((next) => { next.work[i][key] = text; }))}</div>{Lines(`work.${i}.descriptions`, row.descriptions, (items) => Update((next) => { next.work[i].descriptions = items; }))}</div>))}
        {Section('项目经历', data.projects.length, () => Update((next) => { next.projects.push({ name: '', role: '', start: '', end: '', descriptions: [''] }); }), data.projects.map((row, i) => <div className="rse-entry" key={i}><div className="rse-entry-head"><h4>项目经历 {i + 1}</h4>{Remove(`项目经历 ${i + 1}`, () => Update((next) => { next.projects.splice(i, 1); }))}</div><div className="rse-grid">{Field(`projects.${i}.name`, '项目名称', row.name, (text) => Update((next) => { next.projects[i].name = text; }))}{Field(`projects.${i}.role`, '职位', row.role, (text) => Update((next) => { next.projects[i].role = text; }))}{Period(`projects.${i}`, row, (key, text) => Update((next) => { next.projects[i][key] = text; }))}</div>{Lines(`projects.${i}.descriptions`, row.descriptions, (items) => Update((next) => { next.projects[i].descriptions = items; }))}</div>))}
        {Section('自由栏目', data.sections.length, () => Update((next) => { next.sections.push({ title: '', items: [''] }); }), data.sections.map((row, i) => <div className="rse-entry" key={i}><div className="rse-entry-head"><h4>自由栏目 {i + 1}</h4>{Remove(`自由栏目 ${i + 1}`, () => Update((next) => { next.sections.splice(i, 1); }))}</div>{Field(`sections.${i}.title`, '栏目标题', row.title, (text) => Update((next) => { next.sections[i].title = text; }), false, false, '如 核心能力')}{Lines(`sections.${i}.items`, row.items, (items) => Update((next) => { next.sections[i].items = items; }))}</div>))}
        {data.legacyContent !== undefined && <section className="rse-section"><div className="rse-section-head"><h3>保留的旧版内容</h3></div><p className="rse-hint">未整理的原文会一并展示。确认已完整转录后，可清空这一栏。</p>{Field('legacyContent', '旧版原文', data.legacyContent, (text) => Update((next) => { next.legacyContent = text; }), true, true)}</section>}
      </>}
    </fieldset>
    <details className="rse-preview" onToggle={(event) => SetPreviewOpen(event.currentTarget.open)}><summary>预览 PDF</summary>{previewOpen && <ResumePdfPreview resume={{ name: value.name, summary: '', content: ResumeDataToText(data), data, templateId: value.templateId }} />}</details>
  </div>;
}
