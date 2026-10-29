import { createHash, randomUUID } from 'node:crypto';
import { ProfileCategoryValues } from '@avery/contracts';
import { BrowserDateAdapters, type BrowserDateAdapterId } from './browser-date-adapters';

const FormSemanticAcceptScore = 0.78;
const FormHighConfidenceScore = 0.95;
const FormHighConfidenceLeadMargin = 0.05;
const FormSemanticLeadMargin = 0.08;

export type FormValueType = 'text' | 'phone' | 'email' | 'date' | 'yearMonth' | 'region' | 'enum' | 'file' | 'unknown';
export type MatchStrategy = 'exact' | 'semantic' | 'agent';
export type FormSection = 'personal' | 'education' | 'work' | 'project' | 'preference';

export type FormField = {
  fieldId: string;
  ref: string;
  pageRevision: number;
  label: string;
  section?: string;
  fieldName?: string;
  control: 'text' | 'select' | 'checkbox' | 'radio' | 'file';
  inputType?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  autocomplete?: string;
  filled?: boolean;
  valid?: boolean;
  validationMessage?: string;
  options?: Array<{ label: string; value: string; selected?: boolean }>;
  raw: {
    label?: string;
    name?: string;
    id?: string;
    placeholder?: string;
    ariaLabel?: string;
    ariaLabelledBy?: string;
    autocomplete?: string;
    nearbyTexts: string[];
    optionTexts?: string[];
  };
  context: {
    section?: FormSection;
    recordIndex?: number;
    groupHeading?: string;
    precedingLabels: string[];
    followingLabels: string[];
  };
  semantic: {
    concept: string | 'unknown';
    aliases: string[];
    valueType: FormValueType;
    confidence: number;
  };
  interaction: {
    adapter?: BrowserDateAdapterId;
    kind: 'input' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'cascader' | 'datePicker' | 'upload' | 'unknown';
    editable: boolean;
    levels?: number;
    requiresCommit?: boolean;
  };
};

export type FormFillOperation = {
  adapter?: BrowserDateAdapterId;
  kind: 'fill' | 'select' | 'check' | 'custom_select' | 'custom_date';
  ref: string;
  key: string;
  occurrence: number;
  /** 日期定位使用完整表单中同语义、同标签的序号，不能随已填字段过滤而变化。 */
  targetOccurrence?: number;
  /** ATS 重复经历的页面记录序号，与来源记录匹配序号分开保存。 */
  targetRecordIndex?: number;
  value: string;
  label: string;
  sourceTitle: string;
  sourcePath: string;
  sourcePaths: string[];
  concept: string;
  strategy: MatchStrategy;
};
export type MissingFormField = { key: string; concept: string; fieldId: string; label: string; control: FormField['control']; required: boolean };
export type FormMatchCandidate = { sourcePath: string; concept: string; score: number; evidence: string[]; label?: string; equivalentSourcePaths?: string[] };
export type FormFillPlan = {
  pageRevision: number;
  createdAt: number;
  continuationId?: string;
  publicAmbiguous?: Array<Record<string, unknown>>;
  operations: FormFillOperation[];
  skipped: Array<{ fieldId?: string; label: string; reason: string }>;
  missingFields: MissingFormField[];
  ambiguous: Array<{ fieldId: string; label: string; candidates: FormMatchCandidate[] }>;
  unmatched: Array<{ fieldId: string; label: string; required: boolean; context: string[] }>;
  sourceTitles: string[];
};
export type FormFact = {
  key: string;
  concept: string;
  section?: string;
  recordIndex?: number;
  value: string;
  valueType: FormValueType;
  sourceTitle: string;
  sourcePath: string;
  reusable: boolean;
};

export class AgentBrowserError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusUnknown = false) {
    super(message);
    this.name = 'AgentBrowserError';
  }
}


function StringList(value: unknown, maximum = 8): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)).filter(Boolean))].slice(0, maximum);
}

export function FormTextSimilarity(leftValue: unknown, rightValue: unknown): number {
  const left = NormalizeFormLabel(leftValue).replace(/^(请输入|请选择|请填写)/, '');
  const right = NormalizeFormLabel(rightValue).replace(/^(请输入|请选择|请填写)/, '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (Math.min(left.length, right.length) >= 2 && (left.includes(right) || right.includes(left))) return 0.9;
  const grams = (value: string) => value.length < 2 ? [value] : Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  const remaining = [...rightGrams];
  let matches = 0;
  for (const gram of leftGrams) {
    const index = remaining.indexOf(gram);
    if (index >= 0) { matches += 1; remaining.splice(index, 1); }
  }
  return (2 * matches) / (leftGrams.length + rightGrams.length);
}

function ResolveFieldKey(input: {
  explicitTexts: string[];
  contextualTexts: string[];
  section?: string;
}): { key?: string; confidence: number; exact: boolean } {
  for (const text of input.explicitTexts) {
    const key = CanonicalFormField(text);
    if (key) return { key, confidence: 1, exact: true };
  }
  let best: { key?: string; confidence: number } = { confidence: 0 };
  for (const [key, aliases] of FormFieldAliases) {
    const definition = DefinitionForKey(key, input.section);
    const section = CanonicalFormSection(input.section);
    const sectionCompatible = !section || !definition || section === definition.section;
    if (!sectionCompatible) continue;
    for (const text of [...input.explicitTexts, ...input.contextualTexts]) {
      for (const alias of aliases) {
        const score = FormTextSimilarity(text, alias);
        if (score > best.confidence) best = { key, confidence: score };
      }
    }
  }
  return { ...best, exact: false };
}

function FieldInteraction(
  control: FormField['control'],
  inputType: string,
  definition: FormFieldDefinition | undefined,
  options: FormField['options'],
  metadata: Record<string, unknown>,
): FormField['interaction'] {
  if (metadata.adapter === 'moka' && control === 'select') return {
    adapter: 'moka', kind: ['date', 'yearMonth'].includes(definition?.valueType ?? '') ? 'datePicker' : 'select', editable: false, requiresCommit: true,
  };
  if (control === 'file') return { kind: 'upload', editable: false };
  if (control === 'radio') return { kind: 'radio', editable: true };
  if (control === 'checkbox') return { kind: 'checkbox', editable: true };
  if (control === 'text') return { kind: String(metadata.tag ?? '').toLowerCase() === 'textarea' ? 'textarea' : 'input', editable: true };
  if (definition?.valueType === 'date' || definition?.valueType === 'yearMonth' || /date|month/.test(inputType)) {
    return { kind: 'datePicker', editable: options === undefined, requiresCommit: metadata.requiresCommit === true };
  }
  if (definition?.valueType === 'region' && !options?.length) {
    return { kind: 'cascader', editable: true, levels: Number.isSafeInteger(metadata.levels) ? Math.min(3, Math.max(1, Number(metadata.levels))) : 3, requiresCommit: metadata.requiresCommit !== false };
  }
  return { kind: 'select', editable: true, requiresCommit: metadata.requiresCommit === true };
}

export const EncodedFormFieldPrefix = '__avery_field__';

function DecodeFormFieldContext(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.startsWith(EncodedFormFieldPrefix)) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(EncodedFormFieldPrefix.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return {
      ...(typeof parsed.l === 'string' ? { rawLabel: parsed.l } : {}),
      ...(typeof parsed.n === 'string' ? { fieldName: parsed.n } : {}),
      ...(typeof parsed.i === 'string' ? { id: parsed.i } : {}),
      ...(typeof parsed.p === 'string' ? { placeholder: parsed.p } : {}),
      ...(typeof parsed.a === 'string' ? { ariaLabel: parsed.a } : {}),
      ...(typeof parsed.b === 'string' ? { ariaLabelledBy: parsed.b } : {}),
      ...(typeof parsed.s === 'string' ? { section: parsed.s } : {}),
      ...(typeof parsed.g === 'string' ? { groupHeading: parsed.g } : {}),
      ...(Array.isArray(parsed.x) ? { nearbyTexts: parsed.x } : {}),
      ...(Array.isArray(parsed.r) ? { precedingLabels: parsed.r } : {}),
      ...(Array.isArray(parsed.f) ? { followingLabels: parsed.f } : {}),
      ...(Number.isSafeInteger(parsed.o) ? { recordIndex: parsed.o } : {}),
      ...(typeof parsed.v === 'boolean' ? { filledState: parsed.v } : {}),
      ...(parsed.d === true ? { disabled: true } : {}),
      ...(typeof parsed.t === 'string' && Object.hasOwn(BrowserDateAdapters, parsed.t) ? { adapter: parsed.t } : {}),
    };
  } catch { return {}; }
}

function InferTemporalSection(texts: string[]): FormSection | undefined {
  const text = texts.map(NormalizeFormLabel).join(' ');
  if (/入学|毕业时间|毕业日期|教育.*(?:开始|结束)|(?:开始|结束).*教育|educationstart|educationend/.test(text)) return 'education';
  if (/入职|离职|工作.*(?:开始|结束)|(?:开始|结束).*工作|workstart|workend|employmentstart|employmentend/.test(text)) return 'work';
  if (/项目.*(?:开始|结束)|(?:开始|结束).*项目|projectstart|projectend/.test(text)) return 'project';
  return undefined;
}

/** 将浏览器快照裁剪为表单语义；不返回字段正文，避免把已填个人信息再次写入轨迹。 */
export function FormFields(refs: Record<string, unknown>, pageRevision = 0): FormField[] {
  const fields: FormField[] = [];
  for (const [rawRef, rawMetadata] of Object.entries(refs)) {
    if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) continue;
    const originalMetadata = rawMetadata as Record<string, unknown>;
    if (originalMetadata.formExcluded === true) continue;
    // 辅助搜索框即使从父节点继承了已选文字，也不能再次成为独立申请字段。
    if (originalMetadata.name === '__avery_internal_form_control__' || originalMetadata.ariaLabel === '__avery_internal_form_control__') continue;
    const decodedContext = DecodeFormFieldContext(originalMetadata.name);
    const metadata = { ...originalMetadata, ...decodedContext };
    const role = String(metadata.role ?? '').toLowerCase();
    const tag = String(metadata.tag ?? '').toLowerCase();
    const inputType = String(metadata.type ?? '').toLowerCase();
    const label = String(metadata.rawLabel ?? metadata.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (inputType === 'hidden' || inputType === 'password') continue;
    if (label === '__avery_internal_form_control__') continue;
    if (!label) continue;
    let control: FormField['control'] | undefined;
    if (role === 'combobox' || tag === 'select') control = 'select';
    else if (role === 'checkbox' || inputType === 'checkbox') control = 'checkbox';
    else if (role === 'radio' || inputType === 'radio') control = 'radio';
    else if (inputType === 'file') control = 'file';
    else if (['textbox', 'searchbox', 'spinbutton'].includes(role) || ['input', 'textarea'].includes(tag)) control = 'text';
    if (!control) continue;
    const options = Array.isArray(metadata.options)
      ? metadata.options.slice(0, 50).flatMap((option) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
        const item = option as Record<string, unknown>;
        return [{ label: String(item.label ?? '').slice(0, 120), value: String(item.value ?? '').slice(0, 120), ...(item.selected === true ? { selected: true } : {}) }];
      })
      : undefined;
    const valueLength = Number.isSafeInteger(metadata.valueLength) ? Number(metadata.valueLength) : undefined;
    const filled = typeof metadata.filledState === 'boolean' ? metadata.filledState
      : control === 'checkbox' || control === 'radio'
      ? metadata.checked === true
      : control === 'select'
        ? options?.some((option) => option.selected && option.value !== '')
        : valueLength === undefined ? undefined : valueLength > 0;
    const ref = `@${rawRef.replace(/^@/, '')}`;
    const raw = {
      label: typeof metadata.rawLabel === 'string' ? metadata.rawLabel.slice(0, 180) : label,
      ...(typeof metadata.fieldName === 'string' && metadata.fieldName ? { name: metadata.fieldName.slice(0, 180) } : {}),
      ...(typeof metadata.id === 'string' && metadata.id ? { id: metadata.id.slice(0, 180) } : {}),
      ...(typeof metadata.placeholder === 'string' && metadata.placeholder ? { placeholder: metadata.placeholder.slice(0, 180) } : {}),
      ...(typeof metadata.ariaLabel === 'string' && metadata.ariaLabel ? { ariaLabel: metadata.ariaLabel.slice(0, 180) } : {}),
      ...(typeof metadata.ariaLabelledBy === 'string' && metadata.ariaLabelledBy ? { ariaLabelledBy: metadata.ariaLabelledBy.slice(0, 180) } : {}),
      ...(typeof metadata.autocomplete === 'string' && metadata.autocomplete ? { autocomplete: metadata.autocomplete.slice(0, 80) } : {}),
      nearbyTexts: StringList(metadata.nearbyTexts),
      ...(options?.length ? { optionTexts: options.map((option) => option.label).filter(Boolean).slice(0, 50) } : {}),
    };
    const explicitTexts = [raw.label, raw.name, raw.id, raw.placeholder, raw.ariaLabel, raw.ariaLabelledBy, raw.autocomplete].filter((value): value is string => Boolean(value));
    const observedSection = CanonicalFormSection(metadata.section) ?? InferTemporalSection(explicitTexts);
    // Moka 已提供精确业务标题，未知字段不能再从附近正文猜成另一种资料。
    const mokaKey = metadata.adapter === 'moka' ? CanonicalFormField(label) : undefined;
    const resolved = metadata.adapter === 'moka' ? { key: mokaKey, exact: Boolean(mokaKey), confidence: mokaKey ? 1 : 0 }
      : ResolveFieldKey({ explicitTexts, contextualTexts: raw.nearbyTexts, section: observedSection });
    // 精确字段名比页面容器边界更可靠；通用开始/结束时间仍必须依赖所在模块消歧。
    const fixedDefinition = resolved.exact && resolved.key && resolved.key !== 'startDate' && resolved.key !== 'endDate'
      ? DefinitionForKey(resolved.key)
      : undefined;
    const section = fixedDefinition?.section ?? observedSection;
    const context = {
      ...(section ? { section } : {}),
      ...(Number.isSafeInteger(metadata.recordIndex) && Number(metadata.recordIndex) >= 0 ? { recordIndex: Number(metadata.recordIndex) } : {}),
      ...(typeof metadata.groupHeading === 'string' && metadata.groupHeading ? { groupHeading: metadata.groupHeading.slice(0, 180) } : {}),
      precedingLabels: StringList(metadata.precedingLabels, 4),
      followingLabels: StringList(metadata.followingLabels, 4),
    };
    const contextualTexts = [...raw.nearbyTexts, context.groupHeading ?? '', ...context.precedingLabels, ...context.followingLabels].filter(Boolean);
    const contextualResolution = resolved.exact || metadata.adapter === 'moka' ? resolved : ResolveFieldKey({ explicitTexts, contextualTexts, section });
    // 复合手机号控件中的选择器仅用于国际区号，当前自动填写只处理实际号码输入框。
    if (control === 'select' && contextualResolution.key === 'phone') continue;
    const definition = fixedDefinition ?? (contextualResolution.key ? DefinitionForKey(contextualResolution.key, section) : undefined);
    const unscopedDate = !section && (contextualResolution.key === 'startDate' || contextualResolution.key === 'endDate');
    fields.push({
      fieldId: `field-${ref.slice(1)}`,
      ref,
      pageRevision,
      label,
      ...(section ? { section } : typeof metadata.section === 'string' && metadata.section.trim()
        ? { section: metadata.section.replace(/\s+/g, ' ').trim().slice(0, 180) }
        : {}),
      ...(typeof metadata.fieldName === 'string' && metadata.fieldName.trim() ? { fieldName: metadata.fieldName.trim().slice(0, 180) } : {}),
      control,
      ...(inputType ? { inputType } : {}),
      ...(typeof metadata.required === 'boolean' ? { required: metadata.required } : {}),
      ...(typeof metadata.disabled === 'boolean' ? { disabled: metadata.disabled } : {}),
      ...(typeof metadata.readOnly === 'boolean' ? { readOnly: metadata.readOnly } : {}),
      ...(typeof metadata.autocomplete === 'string' && metadata.autocomplete ? { autocomplete: metadata.autocomplete.slice(0, 80) } : {}),
      ...(filled === undefined ? {} : { filled }),
      ...(typeof metadata.valid === 'boolean' ? { valid: metadata.valid } : {}),
      ...(typeof metadata.validationMessage === 'string' && metadata.validationMessage ? { validationMessage: metadata.validationMessage.slice(0, 300) } : {}),
      ...(options?.length ? { options } : {}),
      raw,
      context,
      semantic: {
        concept: unscopedDate ? 'unknown' : definition?.concept ?? 'unknown',
        aliases: contextualResolution.key ? AliasesForKey(contextualResolution.key).slice(0, 20) : [],
        valueType: definition?.valueType ?? (control === 'file' ? 'file' : 'unknown'),
        confidence: Number(contextualResolution.confidence.toFixed(3)),
      },
      interaction: FieldInteraction(control, inputType, definition, options, metadata),
    });
  }
  return fields.slice(0, 300);
}

export function NormalizeFormLabel(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[\s_\-—–·:：()（）[\]【】]/g, '');
}

export const FormFieldAliases: Array<[string, string[]]> = [
  ['idNumber', ['证件号码', '证件号', '身份证号', '身份证号码', 'idnumber', 'identitynumber']],
  ['idType', ['证件类型', '证件种类', 'idtype']],
  ['phone', ['手机号', '手机号码', '联系电话', '电话', 'phone', 'mobile', 'tel']],
  ['email', ['邮箱', '电子邮箱', '电子邮件', 'email']],
  ['name', ['姓名', '真实姓名', 'name', 'fullname']],
  ['gender', ['性别', 'gender', 'sex']],
  ['birthDate', ['出生日期', '出生日期 (年龄)', '出生年月', '生日', 'birthdate', 'birthday']],
  ['nationality', ['国籍', '国籍/地区', '国家/地区', 'nationality']],
  ['nativePlace', ['籍贯', '祖籍', 'nativeplace']],
  ['ethnicity', ['民族', 'ethnicity']],
  ['residence', ['现居地', '居住地', '现居住地', '所在地', 'residence', 'currentlocation']],
  ['hukou', ['户籍所在地', '户口所在地', '户籍', 'hukou']],
  ['workYears', ['工作年限', '工作经验', '从业年限', 'workyears', 'workexperience']],
  ['politicalStatus', ['政治面貌', 'politicalstatus']],
  ['maritalStatus', ['婚姻状况', '婚姻状态', 'maritalstatus']],
  ['school', ['学校', '学校名称', '毕业院校', '院校', 'school', 'university']],
  ['major', ['专业', '专业名称', '最近毕业专业', 'major']],
  ['educationType', ['学历类型', '学习形式', '教育类型', 'educationtype', 'studytype']],
  ['degreeLevel', ['学历', '最高学历', 'educationlevel', 'degreelevel']],
  ['degree', ['学位', 'degree']],
  ['company', ['公司', '公司名称', '单位名称', '工作单位', 'company', 'employer']],
  ['position', ['职位', '职位名称', '岗位名称', '职务', 'position', 'jobtitle']],
  ['department', ['部门', '部门名称', 'department']],
  ['companyNature', ['企业性质', '公司性质', 'companynature']],
  ['companySize', ['企业规模', '公司规模', 'companysize']],
  ['annualSalary', ['职位年薪', '年薪', 'annualsalary']],
  ['workDescription', ['工作内容', '工作描述', '工作职责', '职责描述', 'workdescription']],
  ['projectName', ['项目名称', '项目名', 'projectname']],
  ['projectRole', ['项目角色', '担任角色', 'projectrole']],
  ['projectDescription', ['项目描述', '项目内容', 'projectdescription']],
  ['projectResponsibility', ['项目职责', '项目中职责', '项目负责内容', '项目责任', 'projectresponsibility', 'projectresponsibilities']],
  ['startDate', ['开始时间', '起始时间', '入学时间', '入职时间', 'startdate']],
  ['endDate', ['结束时间', '毕业时间', '离职时间', 'enddate']],
  ['targetRole', ['目标岗位', '期望职位', '期望岗位', '求职岗位', 'targetrole']],
  ['targetProvince', ['期望省份', '工作省份', 'targetprovince']],
  ['targetCity', ['期望城市', '工作城市', '意向城市', '意向工作城市', 'targetcity']],
  ['targetCategory', ['期望职类', '职位类别', '目标职类', 'targetcategory']],
  ['targetFunction', ['期望职能', '职位职能', '目标职能', 'targetfunction']],
  ['salary', ['期望薪资', '薪资要求', 'expectedsalary', 'salary']],
  ['availability', ['到岗时间', '可到岗时间', 'availability']],
  ['informationSource', ['信息来源', '获知渠道', '招聘渠道', 'informationsource']],
  ['workMode', ['工作方式', '办公方式', 'workmode']],
  ['jobSeekingType', ['工作类型', '求职类型', '用工类型', 'jobseekingtype', 'employmenttype']],
  ['acceptTransfer', ['是否服从调配', '服从调配', '接受调配', 'accepttransfer', 'acceptrelocation']],
  ['acceptGlobalAssignment', ['是否接受全球派遣', '全球派遣', '海外派遣', 'acceptglobalassignment', 'globalmobility']],
];

type FormFieldDefinition = {
  concept: string;
  section: FormSection;
  valueType: FormValueType;
  reusable?: boolean;
};

const FormFieldDefinitions: Record<string, FormFieldDefinition> = {
  idNumber: { concept: 'personal.idNumber', section: 'personal', valueType: 'text' },
  idType: { concept: 'personal.idType', section: 'personal', valueType: 'enum' },
  phone: { concept: 'personal.phone', section: 'personal', valueType: 'phone', reusable: true },
  email: { concept: 'personal.email', section: 'personal', valueType: 'email', reusable: true },
  name: { concept: 'personal.name', section: 'personal', valueType: 'text', reusable: true },
  gender: { concept: 'personal.gender', section: 'personal', valueType: 'enum' },
  birthDate: { concept: 'personal.birthDate', section: 'personal', valueType: 'date' },
  nationality: { concept: 'personal.nationality', section: 'personal', valueType: 'enum' },
  nativePlace: { concept: 'personal.nativePlace', section: 'personal', valueType: 'region' },
  ethnicity: { concept: 'personal.ethnicity', section: 'personal', valueType: 'enum' },
  residence: { concept: 'personal.currentRegion', section: 'personal', valueType: 'region' },
  hukou: { concept: 'personal.hukouRegion', section: 'personal', valueType: 'region' },
  workYears: { concept: 'personal.workYears', section: 'personal', valueType: 'enum' },
  politicalStatus: { concept: 'personal.politicalStatus', section: 'personal', valueType: 'enum' },
  maritalStatus: { concept: 'personal.maritalStatus', section: 'personal', valueType: 'enum' },
  school: { concept: 'education.school', section: 'education', valueType: 'text' },
  major: { concept: 'education.major', section: 'education', valueType: 'text' },
  educationType: { concept: 'education.educationMode', section: 'education', valueType: 'enum' },
  degreeLevel: { concept: 'education.degreeLevel', section: 'education', valueType: 'enum' },
  degree: { concept: 'education.degree', section: 'education', valueType: 'enum' },
  company: { concept: 'work.company', section: 'work', valueType: 'text' },
  position: { concept: 'work.title', section: 'work', valueType: 'text' },
  department: { concept: 'work.department', section: 'work', valueType: 'text' },
  companyNature: { concept: 'work.companyNature', section: 'work', valueType: 'enum' },
  companySize: { concept: 'work.companySize', section: 'work', valueType: 'enum' },
  annualSalary: { concept: 'work.annualSalary', section: 'work', valueType: 'text' },
  workDescription: { concept: 'work.description', section: 'work', valueType: 'text' },
  projectName: { concept: 'project.name', section: 'project', valueType: 'text' },
  projectRole: { concept: 'project.role', section: 'project', valueType: 'text' },
  projectDescription: { concept: 'project.description', section: 'project', valueType: 'text' },
  projectResponsibility: { concept: 'project.responsibility', section: 'project', valueType: 'text' },
  targetRole: { concept: 'preference.targetRole', section: 'preference', valueType: 'text' },
  targetProvince: { concept: 'preference.targetRegion', section: 'preference', valueType: 'region' },
  targetCity: { concept: 'preference.targetRegion', section: 'preference', valueType: 'region' },
  targetCategory: { concept: 'preference.targetCategory', section: 'preference', valueType: 'enum' },
  targetFunction: { concept: 'preference.targetFunction', section: 'preference', valueType: 'enum' },
  salary: { concept: 'preference.expectedSalary', section: 'preference', valueType: 'text' },
  availability: { concept: 'preference.availableDate', section: 'preference', valueType: 'date' },
  informationSource: { concept: 'preference.informationSource', section: 'preference', valueType: 'enum' },
  workMode: { concept: 'preference.workMode', section: 'preference', valueType: 'enum' },
  jobSeekingType: { concept: 'preference.jobType', section: 'preference', valueType: 'enum' },
  acceptTransfer: { concept: 'preference.acceptTransfer', section: 'preference', valueType: 'enum' },
  acceptGlobalAssignment: { concept: 'preference.acceptGlobalAssignment', section: 'preference', valueType: 'enum' },
};

function DefinitionForKey(key: string, section?: string): FormFieldDefinition | undefined {
  if ((key === 'startDate' || key === 'endDate') && section) {
    const normalizedSection = CanonicalFormSection(section);
    // 个人信息中的“毕业时间”属于教育事实，可为教育字段复用，不能误归入工作结束时间。
    if (key === 'endDate' && normalizedSection === 'personal') {
      return { concept: 'education.endDate', section: 'education', valueType: 'yearMonth' };
    }
    if (normalizedSection && normalizedSection !== 'personal' && normalizedSection !== 'preference') {
      return { concept: `${normalizedSection}.${key}`, section: normalizedSection, valueType: 'yearMonth' };
    }
  }
  if (key === 'startDate') return { concept: 'work.startDate', section: 'work', valueType: 'yearMonth' };
  if (key === 'endDate') return { concept: 'work.endDate', section: 'work', valueType: 'yearMonth' };
  return FormFieldDefinitions[key];
}

function AliasesForKey(key: string): string[] {
  return FormFieldAliases.find(([candidate]) => candidate === key)?.[1] ?? [];
}

/**
 * 隔离浏览器的可访问性快照只返回控件自身名称。部分 ATS 将标签渲染为相邻 div，
 * 因而这里用固定、不可由模型修改的页面脚本补齐 aria-label，再由任务页快照生成原生 ref。
 * 脚本只写入辅助语义和非空布尔状态，不回传字段值，也不触发输入、点击或提交事件。
 */

export function CanonicalFormField(value: unknown): string | undefined {
  const label = NormalizeFormLabel(value);
  if (!label) return undefined;
  for (const [key, aliases] of FormFieldAliases) {
    if (aliases.some((alias) => {
      const normalizedAlias = NormalizeFormLabel(alias);
      return label === normalizedAlias || label === `请输入${normalizedAlias}` || label === `请选择${normalizedAlias}`;
    })) return key;
  }
  return undefined;
}

function CanonicalFormSection(value: unknown): FormSection | undefined {
  const section = NormalizeFormLabel(value);
  if (/个人|基本信息|personal|basicinfo/.test(section)) return 'personal';
  if (/教育|education|school/.test(section)) return 'education';
  if (/工作|任职|work|employment/.test(section)) return 'work';
  if (/项目|project/.test(section)) return 'project';
  if (/求职|意向|jobintention|preference/.test(section)) return 'preference';
  return undefined;
}

function ExtractLabelledFacts(
  content: string,
  sourceTitle: string,
  sourcePrefix: string,
  defaultSection?: FormSection,
  fixedRecordIndex?: number,
  allowedSection?: FormSection,
): FormFact[] {
  const facts: FormFact[] = [];
  // 档案必须显式声明自己的模板分区，不能再把无分区旧正文归入分类默认分区。
  let section = allowedSection ? undefined : defaultSection;
  const occurrences = new Map<string, number>();
  for (const rawLine of content.split(/\r?\n/).slice(0, 2_000)) {
    const line = rawLine.trim();
    const heading = line.match(/^(?:#{1,6}\s*)?\[?([^\]：:]{1,40})\]?$/)?.[1];
    const headingSection = heading ? CanonicalFormSection(heading) : undefined;
    if (headingSection) {
      // 单类型档案不能借由旧聚合正文跨区段提供事实；仅接受自身分类对应的区段。
      section = !allowedSection || headingSection === allowedSection ? headingSection : undefined;
      continue;
    }
    const pair = line.match(/^(?:[-*]\s*)?([^：:]{1,40})[：:]\s*(.+)$/);
    if (!pair) continue;
    if (allowedSection && section !== allowedSection) continue;
    const key = CanonicalFormField(pair[1]);
    const value = pair[2].trim();
    if (!key || !value || /^(?:无|暂无|待填写|n\/a|null|-)$/.test(value.toLowerCase())) continue;
    const definition = DefinitionForKey(key, section);
    if (!definition) continue;
    const occurrenceKey = `${section ?? definition.section}:${key}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    facts.push({
      key,
      concept: definition.concept,
      ...(section ? { section } : { section: definition.section }),
      recordIndex: fixedRecordIndex ?? occurrence,
      value: value.slice(0, 20_000),
      valueType: definition.valueType,
      sourceTitle,
      sourcePath: `${sourcePrefix}.${section ?? definition.section}.${key}.${fixedRecordIndex ?? occurrence}`,
      reusable: definition.reusable === true,
    });
  }
  return facts;
}

function BuildFormFacts(sources: Record<string, unknown>): { facts: FormFact[]; sourceTitles: string[] } {
  const profiles = Array.isArray(sources.profiles) ? sources.profiles.filter((profile) => profile && typeof profile === 'object') as Array<Record<string, unknown>> : [];
  const resume = sources.resume && typeof sources.resume === 'object' ? sources.resume as Record<string, unknown> : undefined;
  const decisions = Array.isArray(sources.decisions)
    ? sources.decisions.filter((decision) => decision && typeof decision === 'object' && !Array.isArray(decision)) as Array<Record<string, unknown>>
    : [];
  const facts: FormFact[] = [];
  const sourceTitles: string[] = [];
  const sectionByCategory: Partial<Record<string, FormSection>> = { application: 'personal', education: 'education', work: 'work', project: 'project', job_intention: 'preference' };
  const currentProfileCategories = new Set<string>(ProfileCategoryValues);
  const categoryOccurrences = new Map<string, number>();
  for (const profile of profiles) {
    const title = String(profile.title ?? profile.id ?? '档案').slice(0, 200);
    const category = String(profile.category ?? '');
    if (!currentProfileCategories.has(category)) continue;
    const profileId = String(profile.id ?? 'profile').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) || 'profile';
    const recordIndex = categoryOccurrences.get(category) ?? 0;
    categoryOccurrences.set(category, recordIndex + 1);
    sourceTitles.push(title);
    const sourcePrefix = `profiles.${profileId}`;
    const expectedSection = sectionByCategory[category];
    const extracted = ExtractLabelledFacts(String(profile.content ?? ''), title, sourcePrefix, expectedSection, recordIndex, expectedSection);
    const fallbackKey = category === 'education' ? 'school' : category === 'work' ? 'company' : category === 'project' ? 'projectName' : '';
    const fallbackDefinition = fallbackKey ? DefinitionForKey(fallbackKey, sectionByCategory[category]) : undefined;
    if (!extracted.length && fallbackKey && fallbackDefinition) facts.push({
      key: fallbackKey,
      concept: fallbackDefinition.concept,
      section: fallbackDefinition.section,
      recordIndex,
      value: title,
      valueType: fallbackDefinition.valueType,
      sourceTitle: title,
      sourcePath: `${sourcePrefix}.${fallbackDefinition.section}.${fallbackKey}.${recordIndex}`,
      reusable: fallbackDefinition.reusable === true,
    });
    facts.push(...extracted);
  }
  if (resume) {
    const title = String(resume.name ?? '已绑定简历').slice(0, 200);
    const content = String(resume.content ?? '');
    const resumeId = String(resume.id ?? 'bound').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) || 'bound';
    const sourcePrefix = `resume.${resumeId}`;
    sourceTitles.push(title);
    facts.push(...ExtractLabelledFacts(content, title, sourcePrefix));
    const email = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const phone = content.match(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/)?.[0];
    const name = content.match(/^#{1,2}\s+([^\r\n|｜]{1,30})/m)?.[1]?.trim();
    for (const [key, value] of [['email', email], ['phone', phone], ['name', name]] as const) {
      const definition = DefinitionForKey(key, 'personal');
      if (!value || !definition || facts.some((fact) => fact.key === key && fact.value === value)) continue;
      facts.push({ key, concept: definition.concept, section: 'personal', recordIndex: 0, value, valueType: definition.valueType, sourceTitle: title, sourcePath: `${sourcePrefix}.personal.${key}.0`, reusable: true });
    }
  }
  const allowedKeys = new Set(FormFieldAliases.map(([key]) => key));
  for (const [index, decision] of decisions.slice(0, 30).entries()) {
    const key = String(decision.field ?? '');
    const value = String(decision.value ?? '').trim();
    const requestedSection = CanonicalFormSection(decision.section);
    const definition = DefinitionForKey(key, requestedSection);
    const recordIndex = Number.isSafeInteger(decision.recordIndex) && Number(decision.recordIndex) >= 0
      ? Math.min(99, Number(decision.recordIndex)) : 0;
    if (allowedKeys.has(key) && value && definition) facts.push({
      key,
      concept: definition.concept,
      section: definition.section,
      recordIndex,
      value: value.slice(0, 2_000),
      valueType: definition.valueType,
      sourceTitle: '本轮用户补充',
      sourcePath: `decisions.${definition.section}.${key}.${index}`,
      reusable: definition.reusable === true,
    });
  }
  if (decisions.length) sourceTitles.push('本轮用户补充');
  return { facts, sourceTitles: [...new Set(sourceTitles)] };
}

function FormValueCompatible(field: FormField, fact: FormFact): boolean {
  const targetType = field.semantic.valueType;
  if (targetType !== 'unknown' && fact.valueType !== targetType) {
    if (!(['date', 'yearMonth'].includes(targetType) && ['date', 'yearMonth'].includes(fact.valueType))) return false;
  }
  if (['date', 'yearMonth'].includes(fact.valueType) && !/\d{4}[^\d]?\d{1,2}/.test(fact.value)
    && !(fact.key === 'availability' && field.control === 'text' && !/^(date|month)$/.test(field.inputType ?? ''))) return false;
  return true;
}

type InternalFormMatchCandidate = FormMatchCandidate & { fact: FormFact; exact: boolean };

function ComparableFormValue(fact: FormFact): string {
  const normalized = fact.value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (fact.valueType === 'phone') return normalized.replace(/[^\d+]/g, '');
  if (fact.valueType === 'date' || fact.valueType === 'yearMonth') {
    const parts = normalized.match(/\d+/g);
    if (parts && parts.length >= 2) return `${parts[0]}-${Number(parts[1])}${parts[2] === undefined ? '' : `-${Number(parts[2])}`}`;
  }
  return normalized;
}

function ComparableCandidateValue(field: FormField, candidate: InternalFormMatchCandidate): string {
  const option = field.options?.find((item) => FormTextSimilarity(item.label, candidate.fact.value) === 1
    || FormTextSimilarity(item.value, candidate.fact.value) === 1);
  return option ? `option\u0000${option.value.normalize('NFKC')}` : `${candidate.fact.valueType}\u0000${ComparableFormValue(candidate.fact)}`;
}

function EquivalentCandidateGroups(field: FormField, candidates: InternalFormMatchCandidate[]): Array<{
  representative: InternalFormMatchCandidate;
  candidates: InternalFormMatchCandidate[];
}> {
  const groups = new Map<string, InternalFormMatchCandidate[]>();
  for (const candidate of candidates) {
    const key = ComparableCandidateValue(field, candidate);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const [representative] = group;
    return {
      representative: {
        ...representative,
        ...(group.length > 1 ? {
          equivalentSourcePaths: [...new Set(group.map((candidate) => candidate.sourcePath))],
          evidence: [...new Set([...representative.evidence, 'equivalent_value'])],
        } : {}),
      },
      candidates: group,
    };
  }).sort((left, right) => right.representative.score - left.representative.score);
}

function AcceptCandidateGroup(groups: ReturnType<typeof EquivalentCandidateGroups>): InternalFormMatchCandidate | undefined {
  const first = groups[0]?.representative;
  if (!first) return undefined;
  const second = groups[1]?.representative;
  const requiredLead = first.score >= FormHighConfidenceScore
    ? FormHighConfidenceLeadMargin
    : FormSemanticLeadMargin;
  const leadsNextValue = !second || first.score - second.score >= requiredLead;
  if (first.exact) return leadsNextValue ? first : undefined;
  return first.score >= FormSemanticAcceptScore && leadsNextValue ? first : undefined;
}

function MatchCandidates(field: FormField, facts: FormFact[], effectiveRecordIndex: number, targetKey: string): InternalFormMatchCandidate[] {
  const texts = [
    field.raw.label, field.raw.name, field.raw.id, field.raw.placeholder, field.raw.ariaLabel,
    field.raw.ariaLabelledBy, field.raw.autocomplete, ...field.raw.nearbyTexts,
    field.context.groupHeading, ...field.context.precedingLabels, ...field.context.followingLabels,
  ].filter((value): value is string => Boolean(value));
  return facts.flatMap((fact) => {
    if (!FormValueCompatible(field, fact)) return [];
    const conceptResolved = field.semantic.concept !== 'unknown' && field.semantic.confidence >= FormHighConfidenceScore;
    if (conceptResolved && fact.concept !== field.semantic.concept) return [];
    if (field.semantic.concept === 'unknown' && (targetKey === 'startDate' || targetKey === 'endDate') && fact.key !== targetKey) return [];
    if (field.control === 'radio' && NormalizeFormLabel(field.label) !== NormalizeFormLabel(fact.value)) return [];
    const aliases = AliasesForKey(fact.key);
    const semanticTextScore = Math.max(0, ...texts.flatMap((text) => aliases.map((alias) => FormTextSimilarity(text, alias))));
    const fieldSection = field.context.section;
    const factSection = fact.section;
    if (fieldSection && factSection && fieldSection !== factSection) return [];
    const sectionScore = fieldSection && factSection && fieldSection === factSection ? 1 : 0;
    const typeScore = 1;
    const recordIndex = field.context.recordIndex ?? effectiveRecordIndex;
    const recordScopeKnown = conceptResolved || (fieldSection !== undefined && fieldSection === factSection);
    const recordScore = recordScopeKnown && fact.recordIndex !== undefined && fact.recordIndex === recordIndex ? 1 : 0;
    let optionScore = 0;
    if (field.options?.length) {
      optionScore = field.options.some((option) => FormTextSimilarity(option.label, fact.value) === 1 || FormTextSimilarity(option.value, fact.value) === 1) ? 1 : 0;
      if (optionScore === 0) return [];
    }
    const explicitFieldKey = [
      field.raw.label, field.raw.name, field.raw.id, field.raw.placeholder,
      field.raw.ariaLabel, field.raw.ariaLabelledBy, field.raw.autocomplete,
    ].map(CanonicalFormField).find(Boolean);
    const exact = conceptResolved
      && field.semantic.concept === fact.concept
      && explicitFieldKey === fact.key
      && (fieldSection === undefined || sectionScore === 1)
      && (fact.recordIndex === undefined || recordScore === 1)
      && (!field.options?.length || optionScore === 1);
    const score = exact
      ? 1
      : 0.35 * semanticTextScore + 0.25 * sectionScore + 0.2 * typeScore + 0.1 * recordScore + 0.1 * optionScore;
    if (score <= 0) return [];
    const evidence = [
      semanticTextScore >= 0.9 ? 'semantic_alias' : '',
      sectionScore === 1 ? 'section' : '',
      'value_type',
      recordScore === 1 ? 'record_index' : '',
      optionScore === 1 ? 'control_value' : '',
    ].filter(Boolean);
    return [{
      sourcePath: fact.sourcePath,
      concept: fact.concept,
      score: Number(score.toFixed(3)),
      evidence,
      label: fact.recordIndex === undefined ? fact.sourceTitle : `${fact.sourceTitle} #${fact.recordIndex + 1}`,
      fact,
      exact,
    }];
  }).sort((left, right) => right.score - left.score);
}

export function CreateFormFillPlan(fields: FormField[], sources: Record<string, unknown>, targetRefs?: unknown, rawMappings?: unknown): FormFillPlan {
  const allowedRefs = Array.isArray(targetRefs) ? new Set(targetRefs.map(String)) : null;
  const selected = fields.filter((field) => !field.disabled && !field.readOnly && field.filled !== true && (!allowedRefs || allowedRefs.has(field.ref)));
  const { facts, sourceTitles } = BuildFormFacts(sources);
  const mappings = Array.isArray(rawMappings) ? rawMappings.map((mapping) => mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? mapping as Record<string, unknown> : null).filter(Boolean) as Array<Record<string, unknown>> : [];
  const mappingByField = new Map<string, string>();
  const mappedSourcePaths = new Set<string>();
  for (const mapping of mappings) {
    const targetFieldId = String(mapping.targetFieldId ?? '');
    const sourcePath = String(mapping.sourcePath ?? '');
    const targetField = selected.find((field) => field.fieldId === targetFieldId);
    const sourceFact = facts.find((fact) => fact.sourcePath === sourcePath);
    if (!targetField) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `Unknown form field mapping target: ${targetFieldId}.`);
    if (!sourceFact) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `Unknown or unauthorized form source path: ${sourcePath}.`);
    if (!FormValueCompatible(targetField, sourceFact)) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `Form source path is incompatible with target: ${targetFieldId}.`);
    if (mappingByField.has(targetFieldId)) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `Duplicate form field mapping target: ${targetFieldId}.`);
    if (!sourceFact.reusable && mappedSourcePaths.has(sourcePath)) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `Form source path cannot be reused: ${sourcePath}.`);
    mappingByField.set(targetFieldId, sourcePath);
    mappedSourcePaths.add(sourcePath);
  }
  const textBackedConcepts = new Set(selected.filter((field) => field.control === 'text').map((field) => field.semantic.concept).filter((concept) => concept !== 'unknown'));
  const occurrences = new Map<string, number>();
  const operations: FormFillOperation[] = [];
  const skipped: FormFillPlan['skipped'] = [];
  const missingFields: MissingFormField[] = [];
  const ambiguous: FormFillPlan['ambiguous'] = [];
  const unmatched: FormFillPlan['unmatched'] = [];
  const consumedSources = new Set<string>();
  const matchable: Array<{
    field: FormField;
    key: string;
    occurrence: number;
    forcedSourcePath?: string;
    candidates: InternalFormMatchCandidate[];
  }> = [];
  for (const field of selected) {
    if (!['text', 'select', 'radio'].includes(field.control)) continue;
    const forcedSourcePath = mappingByField.get(field.fieldId);
    const mappedFact = forcedSourcePath ? facts.find((fact) => fact.sourcePath === forcedSourcePath) : undefined;
    const semanticSection = field.context.section ?? field.section;
    const radioKey = field.control === 'radio' ? CanonicalFormField(field.fieldName ?? semanticSection) : undefined;
    const key = mappedFact?.key ?? radioKey ?? CanonicalFormField(field.label)
      ?? FormFieldAliases.find(([candidate]) => DefinitionForKey(candidate, semanticSection)?.concept === field.semantic.concept)?.[0];
    const unresolvedScopedDate = field.semantic.concept === 'unknown' && (key === 'startDate' || key === 'endDate');
    if (!key || (field.semantic.concept === 'unknown' && !mappedFact && !unresolvedScopedDate)) {
      unmatched.push({ fieldId: field.fieldId, label: field.label, required: field.required === true, context: [field.context.section, field.context.groupHeading, ...field.raw.nearbyTexts].filter((value): value is string => Boolean(value)).slice(0, 8) });
      if (field.required) skipped.push({ fieldId: field.fieldId, label: field.label, reason: 'unrecognized_field' });
      continue;
    }
    // 国家区号等复合控件会与真正的手机输入框共享标签；已有文本控件时不把辅助下拉当作同一事实重复填写。
    if (field.control === 'select' && textBackedConcepts.has(field.semantic.concept)) continue;
    const occurrenceKey = field.semantic.concept === 'unknown' ? key : field.semantic.concept;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    let candidates = MatchCandidates(field, facts, occurrence, key);
    if (forcedSourcePath) candidates = candidates.filter((candidate) => candidate.sourcePath === forcedSourcePath).map((candidate) => ({ ...candidate, score: 1, exact: true, evidence: ['agent_mapping', ...candidate.evidence] }));
    const conceptFacts = facts.filter((fact) => fact.key === key);
    if (!conceptFacts.length) {
      if (!missingFields.some((missing) => missing.key === key && missing.label === field.label)) {
        const definition = DefinitionForKey(key, semanticSection);
        missingFields.push({ key, concept: definition?.concept ?? field.semantic.concept, fieldId: field.fieldId, label: field.label, control: field.control, required: field.required === true });
      }
      if (field.required) skipped.push({ fieldId: field.fieldId, label: field.label, reason: 'missing_source_value' });
      continue;
    }
    matchable.push({ field, key, occurrence, ...(forcedSourcePath ? { forcedSourcePath } : {}), candidates });
  }

  const assignments = new Map<string, FormMatchCandidate & { fact: FormFact; exact: boolean }>();
  for (const row of matchable.filter((candidate) => candidate.forcedSourcePath)) {
    const match = row.candidates[0];
    if (!match) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `Form source path is incompatible with target: ${row.field.fieldId}.`);
    assignments.set(row.field.fieldId, match);
    if (!match.fact.reusable) consumedSources.add(match.sourcePath);
  }

  const pending = matchable.filter((candidate) => !candidate.forcedSourcePath);
  const globallyAmbiguous = new Set<string>();
  while (pending.length) {
    const proposals = pending.flatMap((row) => {
      const available = row.candidates.filter((candidate) => candidate.fact.reusable || !consumedSources.has(candidate.sourcePath));
      const groups = EquivalentCandidateGroups(row.field, available);
      const first = AcceptCandidateGroup(groups);
      return first ? [{ row, first, equivalentCandidates: groups[0].candidates }] : [];
    });
    if (!proposals.length) break;
    proposals.sort((left, right) => right.first.score - left.first.score
      || left.equivalentCandidates.length - right.equivalentCandidates.length);
    const proposal = proposals[0];
    if (!proposal.first.fact.reusable) {
      const tied = proposals.filter((candidate) => candidate.first.sourcePath === proposal.first.sourcePath
        && Math.abs(candidate.first.score - proposal.first.score) < 0.001);
      if (tied.length > 1) {
        const equivalentSources = new Set(tied.flatMap((candidate) => candidate.equivalentCandidates
          .filter((equivalent) => !equivalent.fact.reusable && !consumedSources.has(equivalent.sourcePath))
          .map((equivalent) => equivalent.sourcePath)));
        if (equivalentSources.size < tied.length) {
          for (const candidate of tied) {
            globallyAmbiguous.add(candidate.row.field.fieldId);
            pending.splice(pending.indexOf(candidate.row), 1);
          }
          continue;
        }
      }
    }
    assignments.set(proposal.row.field.fieldId, proposal.first);
    if (!proposal.first.fact.reusable) consumedSources.add(proposal.first.sourcePath);
    pending.splice(pending.indexOf(proposal.row), 1);
  }

  for (const row of pending) {
    const candidates = row.candidates.filter((candidate) => candidate.fact.reusable || !consumedSources.has(candidate.sourcePath));
    const candidateGroups = EquivalentCandidateGroups(row.field, candidates);
    if (candidateGroups.length) ambiguous.push({ fieldId: row.field.fieldId, label: row.field.label, candidates: candidateGroups.slice(0, 3).map(({ representative }) => {
      const { fact: _fact, exact: _exact, ...candidate } = representative;
      return candidate;
    }) });
    else unmatched.push({ fieldId: row.field.fieldId, label: row.field.label, required: row.field.required === true, context: [row.field.context.section, row.field.context.groupHeading, ...row.field.raw.nearbyTexts].filter((value): value is string => Boolean(value)).slice(0, 8) });
    if (row.field.required) skipped.push({ fieldId: row.field.fieldId, label: row.field.label, reason: candidates.length ? 'ambiguous_match' : 'incompatible_source' });
  }
  for (const fieldId of globallyAmbiguous) {
    const row = matchable.find((candidate) => candidate.field.fieldId === fieldId)!;
    ambiguous.push({ fieldId, label: row.field.label, candidates: EquivalentCandidateGroups(row.field, row.candidates).slice(0, 3).map(({ representative }) => {
      const { fact: _fact, exact: _exact, ...candidate } = representative;
      return candidate;
    }) });
    if (row.field.required) skipped.push({ fieldId, label: row.field.label, reason: 'ambiguous_match' });
  }

  for (const row of matchable) {
    const { field, key, occurrence, forcedSourcePath } = row;
    const first = assignments.get(field.fieldId);
    if (!first) continue;
    const fact = first.fact;
    const sourcePaths = first.equivalentSourcePaths ?? [fact.sourcePath];
    const strategy: MatchStrategy = forcedSourcePath ? 'agent' : first.exact ? 'exact' : 'semantic';
    if (field.control === 'select') {
      if (!field.options?.length) {
        const kind = ['birthDate', 'startDate', 'endDate', 'availability'].includes(key) ? 'custom_date' : 'custom_select';
        const targetOccurrence = kind === 'custom_date' || field.interaction.adapter === 'moka' ? fields.filter((candidate) => candidate.control === 'select'
          && !candidate.options?.length && candidate.semantic.concept === field.semantic.concept
          && NormalizeFormLabel(candidate.label) === NormalizeFormLabel(field.label)).indexOf(field) : undefined;
        operations.push({ kind, ...(field.interaction.adapter ? { adapter: field.interaction.adapter } : {}), ...(field.interaction.adapter === 'moka' && field.context.recordIndex !== undefined ? { targetRecordIndex: field.context.recordIndex } : {}), ref: field.ref, key, occurrence, ...(targetOccurrence === undefined ? {} : { targetOccurrence }), value: fact.value, label: field.label, sourceTitle: fact.sourceTitle, sourcePath: fact.sourcePath, sourcePaths, concept: fact.concept, strategy });
        continue;
      }
      const option = field.options.find((candidate) => NormalizeFormLabel(candidate.label) === NormalizeFormLabel(fact.value) || NormalizeFormLabel(candidate.value) === NormalizeFormLabel(fact.value));
      if (!option) { if (field.required) skipped.push({ fieldId: field.fieldId, label: field.label, reason: 'select_option_not_found' }); continue; }
      operations.push({ kind: 'select', ref: field.ref, key, occurrence, value: option.value, label: field.label, sourceTitle: fact.sourceTitle, sourcePath: fact.sourcePath, sourcePaths, concept: fact.concept, strategy });
    } else if (field.control === 'radio') {
      if (/协议|隐私|条款|同意|agreement|privacy|terms/i.test(`${field.section ?? ''}${field.label}`)) continue;
      operations.push({ kind: 'check', ref: field.ref, key, occurrence, value: 'true', label: field.label, sourceTitle: fact.sourceTitle, sourcePath: fact.sourcePath, sourcePaths, concept: fact.concept, strategy });
    } else {
      operations.push({ kind: 'fill', ref: field.ref, key, occurrence, value: fact.value, label: field.label, sourceTitle: fact.sourceTitle, sourcePath: fact.sourcePath, sourcePaths, concept: fact.concept, strategy });
    }
  }
  const stableOperations = operations.filter((operation) => operation.kind === 'fill');
  const domChanging = operations.filter((operation) => operation.kind === 'select' || operation.kind === 'check');
  const dynamicOperations = operations.filter((operation) => operation.kind === 'custom_select' || operation.kind === 'custom_date');
  if (domChanging.length > 1) {
    for (const operation of domChanging.slice(1)) skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason: 'reinspect_after_selection' });
  }
  return {
    pageRevision: 0,
    createdAt: 0,
    operations: [...stableOperations, ...domChanging.slice(0, 1), ...dynamicOperations],
    skipped: skipped.slice(0, 100),
    missingFields: missingFields.slice(0, 50),
    ambiguous: ambiguous.slice(0, 50),
    unmatched: unmatched.slice(0, 50),
    sourceTitles,
  };
}

type FormFieldLocator = {
  label: string;
  concept: string;
  section?: string;
  recordIndex?: number;
  occurrence: number;
};

type FormResolutionTarget = {
  locator: FormFieldLocator;
  candidates: Map<string, { sourcePath: string; label: string; score: number }>;
};

type FormFillContinuation = {
  continuationId: string;
  createdAt: number;
  url?: string;
  sources: Record<string, unknown>;
  forcedSelections: Map<string, { locator: FormFieldLocator; sourcePath: string }>;
  resolutionTargets: Map<string, FormResolutionTarget>;
  completedOperations: Set<string>;
  attemptedOperations: Set<string>;
};

export type BrowserFormPreparation = {
  plan: FormFillPlan;
  planId: string;
  planHash: string;
  continuationId: string;
};

/** 保存表单来源、匹配计划和续填句柄；不访问 DOM，也不持有浏览器进程。 */
export class BrowserFormService {
  private readonly plans = new Map<string, FormFillPlan>();
  private readonly continuations = new Map<string, FormFillContinuation>();

  private FieldLocator(field: FormField, fields: FormField[]): FormFieldLocator {
    const peers = fields.filter((candidate) => candidate.semantic.concept === field.semantic.concept);
    return {
      label: field.label,
      concept: field.semantic.concept,
      ...(field.context.section ? { section: field.context.section } : {}),
      ...(field.context.recordIndex === undefined ? {} : { recordIndex: field.context.recordIndex }),
      occurrence: Math.max(0, peers.indexOf(field)),
    };
  }

  private LocatorKey(locator: FormFieldLocator): string {
    return JSON.stringify([locator.concept, locator.section ?? '', locator.recordIndex ?? -1, locator.occurrence, NormalizeFormLabel(locator.label)]);
  }

  private OperationKey(operation: FormFillOperation): string {
    return JSON.stringify([operation.concept, operation.occurrence, NormalizeFormLabel(operation.label), operation.sourcePath]);
  }

  private FindField(fields: FormField[], locator: FormFieldLocator): FormField | undefined {
    const peers = fields.filter((field) => field.semantic.concept === locator.concept);
    const positional = peers[locator.occurrence];
    if (positional
      && NormalizeFormLabel(positional.label) === NormalizeFormLabel(locator.label)
      && (locator.section === undefined || positional.context.section === locator.section)
      && (locator.recordIndex === undefined || positional.context.recordIndex === locator.recordIndex)) return positional;
    const exact = peers.filter((field) => NormalizeFormLabel(field.label) === NormalizeFormLabel(locator.label)
      && (locator.section === undefined || field.context.section === locator.section)
      && (locator.recordIndex === undefined || field.context.recordIndex === locator.recordIndex));
    return exact.length === 1 ? exact[0] : undefined;
  }

  private ResolveSelections(
    continuation: FormFillContinuation,
    fields: FormField[],
    rawResolutions: unknown,
  ): { mappings: Array<{ targetFieldId: string; sourcePath: string }>; selections: Map<string, { locator: FormFieldLocator; sourcePath: string }> } {
    const errors: string[] = [];
    const resolutions = Array.isArray(rawResolutions) ? rawResolutions : [];
    const seenFields = new Set<string>();
    const stagedSelections = new Map<string, { locator: FormFieldLocator; sourcePath: string }>();
    for (const raw of resolutions) {
      const resolution = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const fieldId = String(resolution.fieldId ?? '');
      const candidateId = String(resolution.candidateId ?? '');
      const target = continuation.resolutionTargets.get(fieldId);
      const candidate = target?.candidates.get(candidateId);
      if (!target) errors.push(`${fieldId || '(missing fieldId)'} is not an active unresolved field`);
      else if (!candidate) errors.push(`${candidateId || '(missing candidateId)'} is not a candidate for ${fieldId}`);
      else if (seenFields.has(fieldId)) errors.push(`${fieldId} is resolved more than once`);
      else {
        seenFields.add(fieldId);
        stagedSelections.set(this.LocatorKey(target.locator), { locator: target.locator, sourcePath: candidate.sourcePath });
      }
    }
    const effectiveSelections = new Map(continuation.forcedSelections);
    for (const [key, value] of stagedSelections) effectiveSelections.set(key, value);
    const mappings: Array<{ targetFieldId: string; sourcePath: string }> = [];
    for (const { locator, sourcePath } of effectiveSelections.values()) {
      const field = this.FindField(fields, locator);
      if (field?.filled === true) continue;
      if (!field) errors.push(`resolved field ${locator.label} is no longer present`);
      else mappings.push({ targetFieldId: field.fieldId, sourcePath });
    }
    if (errors.length) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `Invalid form resolutions: ${errors.slice(0, 10).join('; ')}.`);
    return { mappings, selections: effectiveSelections };
  }

  private PublishAmbiguities(plan: FormFillPlan, fields: FormField[], continuation: FormFillContinuation): Array<Record<string, unknown>> {
    continuation.resolutionTargets.clear();
    return plan.ambiguous.map((item, fieldIndex) => {
      const field = fields.find((candidate) => candidate.fieldId === item.fieldId);
      if (!field) return { fieldId: `f${fieldIndex + 1}`, label: item.label, candidates: [] };
      const fieldId = `f${fieldIndex + 1}`;
      const candidates = new Map<string, { sourcePath: string; label: string; score: number }>();
      const publicCandidates = item.candidates.map((candidate, candidateIndex) => {
        const candidateId = `c${candidateIndex + 1}`;
        candidates.set(candidateId, { sourcePath: candidate.sourcePath, label: candidate.label ?? candidate.concept, score: candidate.score });
        return { candidateId, label: candidate.label ?? candidate.concept, concept: candidate.concept, score: candidate.score };
      });
      continuation.resolutionTargets.set(fieldId, { locator: this.FieldLocator(field, fields), candidates });
      return {
        fieldId,
        label: item.label,
        ...(field.context.section ? { section: field.context.section } : {}),
        ...(field.context.recordIndex === undefined ? {} : { recordIndex: field.context.recordIndex }),
        candidates: publicCandidates,
      };
    });
  }

  Prepare(input: {
    fields: FormField[];
    pageRevision: number;
    now: number;
    url?: string;
    sources?: Record<string, unknown>;
    continuationId?: string;
    resolutions?: unknown;
    decisions?: unknown;
    legacyMappings?: unknown;
  }): BrowserFormPreparation {
    let continuation = input.continuationId ? this.continuations.get(input.continuationId) : undefined;
    if (input.continuationId && (!continuation || input.now - continuation.createdAt > 30 * 60_000)) {
      if (continuation) this.continuations.delete(input.continuationId);
      throw new AgentBrowserError('BROWSER_FORM_CONTINUATION_EXPIRED', 'The form continuation expired. Start BrowserFillForm again with the selected source IDs.');
    }
    if (!continuation && !input.sources) throw new AgentBrowserError('BROWSER_FORM_SOURCE_REQUIRED', 'BrowserFillForm requires Host-authorized profile or bound-resume sources.');
    if (!continuation) {
      const continuationId = `form-${randomUUID()}`;
      continuation = {
        continuationId,
        createdAt: input.now,
        ...(input.url ? { url: input.url } : {}),
        sources: input.sources!,
        forcedSelections: new Map(),
        resolutionTargets: new Map(),
        completedOperations: new Set(),
        attemptedOperations: new Set(),
      };
      while (this.continuations.size >= 20) this.continuations.delete(this.continuations.keys().next().value as string);
      this.continuations.set(continuationId, continuation);
    }
    if (continuation.url && input.url && continuation.url !== input.url) {
      this.continuations.delete(continuation.continuationId);
      throw new AgentBrowserError('BROWSER_FORM_CONTINUATION_EXPIRED', 'The browser navigated away from the form. Start BrowserFillForm again.');
    }
    if (!continuation.url && input.url) continuation.url = input.url;
    const decisions = Array.isArray(input.decisions) ? input.decisions : [];
    const priorDecisions = Array.isArray(continuation.sources.decisions) ? continuation.sources.decisions : [];
    const effectiveSources = decisions.length
      ? { ...continuation.sources, decisions: [...priorDecisions, ...decisions] }
      : continuation.sources;
    const resolved = this.ResolveSelections(continuation, input.fields, input.resolutions);
    const legacyMappings = Array.isArray(input.legacyMappings) ? input.legacyMappings : [];
    const plan = CreateFormFillPlan(input.fields, effectiveSources, undefined, [...resolved.mappings, ...legacyMappings]);
    plan.operations = plan.operations.filter((operation) => !continuation!.attemptedOperations.has(this.OperationKey(operation)));
    plan.pageRevision = input.pageRevision;
    plan.createdAt = input.now;
    plan.continuationId = continuation.continuationId;
    plan.publicAmbiguous = this.PublishAmbiguities(plan, input.fields, continuation);
    if (!plan.operations.length && !plan.missingFields.length && !plan.ambiguous.length && !plan.unmatched.length) {
      throw new AgentBrowserError('BROWSER_FORM_NO_MATCH', 'No visible form field could be matched confidently to the selected profile or resume.');
    }
    if (plan.operations.reduce((total, operation) => total + operation.value.length, 0) > 100_000) {
      throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'BrowserFillForm matched content exceeds 100000 characters.');
    }
    continuation.sources = effectiveSources;
    continuation.forcedSelections = resolved.selections;
    const planId = randomUUID();
    const planHash = createHash('sha256').update(JSON.stringify(plan.operations.map(({ kind, ref, value }) => ({ kind, ref, value })))).digest('hex');
    while (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value as string);
    this.plans.set(planId, plan);
    return { plan, planId, planHash, continuationId: continuation.continuationId };
  }

  GetPlan(planId: string, pageRevision: number, now: number): FormFillPlan {
    const plan = this.plans.get(planId);
    if (!plan || plan.pageRevision !== pageRevision || now - plan.createdAt > 30 * 60_000) {
      if (plan) this.plans.delete(planId);
      throw new AgentBrowserError('BROWSER_FORM_PLAN_EXPIRED', 'The private form fill plan expired. Run BrowserFillForm again.');
    }
    return plan;
  }

  RecordCompleted(plan: FormFillPlan, completed: FormFillOperation[]): void {
    const continuation = plan.continuationId ? this.continuations.get(plan.continuationId) : undefined;
    if (continuation) for (const operation of completed) continuation.completedOperations.add(this.OperationKey(operation));
  }

  RecordAttempted(plan: FormFillPlan, attempted: FormFillOperation[] = plan.operations): void {
    const continuation = plan.continuationId ? this.continuations.get(plan.continuationId) : undefined;
    if (continuation) for (const operation of attempted) continuation.attemptedOperations.add(this.OperationKey(operation));
  }

  Finish(plan: FormFillPlan, needsContinuation: boolean): void {
    if (!needsContinuation && plan.continuationId) this.continuations.delete(plan.continuationId);
  }

  DeletePlan(planId: string): void { this.plans.delete(planId); }

  ClearPlans(): void { this.plans.clear(); }

  Clear(): void {
    this.plans.clear();
    this.continuations.clear();
  }
}
