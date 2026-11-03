import { useState } from 'react';
import { CreateEmptyResumeData, GetResumeData, ResumeDataToText, ValidateResumeData, type ResumeData, type ResumeTemplateId } from '@avery/contracts';
import type { Resume } from '../../types/domain';

export interface ResumeDraft { name: string; data: ResumeData; templateId: ResumeTemplateId }
export function CreateResumeDraft(resume: Resume): ResumeDraft { return { name: resume.name, data: GetResumeData(resume), templateId: resume.templateId ?? 'classic' }; }
/** 标题属于文档元数据，与正文分开校验，两个编辑入口使用相同的保存边界。 */
export function ValidateResumeDraft(draft: ResumeDraft) {
  const issues = ValidateResumeData(draft.data);
  if (!draft.name.trim()) issues.unshift({ path: 'name', message: '此项为必填项' });
  else if (draft.name.trim().length > 200) issues.unshift({ path: 'name', message: '简历标题不能超过 200 个字符' });
  return issues;
}
export function ApplyResumeDraft(resume: Resume, draft: ResumeDraft): Resume {
  return { ...resume, name: draft.name.trim(), data: draft.data, templateId: draft.templateId, content: ResumeDataToText(draft.data), updatedAt: Date.now() };
}

/** 简历页和会话侧栏共用的草稿/撤销/校验状态；只在显式进入编辑时装载当前快照。 */
export function useResumeDraft() {
  const [draft, SetDraft] = useState<ResumeDraft>({ name: '', data: CreateEmptyResumeData(), templateId: 'classic' });
  const [history, SetHistory] = useState<ResumeDraft[]>([]);
  const [validationAttempt, SetValidationAttempt] = useState(0);
  const [baseResume, SetBaseResume] = useState<Resume | null>(null);
  function Begin(resume: Resume) { SetBaseResume(structuredClone(resume)); SetDraft(CreateResumeDraft(resume)); SetHistory([]); SetValidationAttempt(0); }
  function Change(value: ResumeDraft) { SetHistory((items) => [...items, draft]); SetDraft(value); }
  function Undo() { const previous = history.at(-1); if (previous) { SetDraft(previous); SetHistory((items) => items.slice(0, -1)); } }
  function Validate() { SetValidationAttempt((value) => value + 1); return !ValidateResumeDraft(draft).length; }
  return { draft, baseResume, Change, Begin, Undo, Validate, validationAttempt, canUndo: !!history.length };
}
