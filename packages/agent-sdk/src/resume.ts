/** 简历内容的跨模块数据契约；模板编号独立于内容，运行时校验由 contracts 提供。 */
export interface ResumeData {
  version: 1;
  mode: 'structured' | 'legacy';
  personal: { name: string; email: string; phone: string; github: string };
  education: Array<{ school: string; degree: string; major: string; start: string; end: string }>;
  work: Array<{ company: string; project: string; role: string; start: string; end: string; descriptions: string[] }>;
  projects: Array<{ name: string; role: string; start: string; end: string; descriptions: string[] }>;
  sections: Array<{ title: string; items: string[] }>;
  legacyContent?: string;
}
export type ResumeTemplateId = 'classic' | 'compact';
