import { describe, expect, it } from 'vitest';
import {
  BrowserFormService,
  CreateFormFillPlan,
  FormFields,
  type FormField,
  type FormValueType,
} from '../../../apps/backend/src/electron/backend/browser-form-service';
import {
  BrowserFormDriver,
  DateEditorEnrichmentExpression,
  DynamicOptionEnrichmentExpression,
  DynamicOptionMatch,
  DynamicOverlayDismissExpression,
  DynamicSearchMatch,
  DynamicSelectionVerificationExpression,
  FormSemanticEnrichmentExpression,
} from '../../../apps/backend/src/electron/backend/browser-form-driver';

function Field(input: {
  id: string;
  label: string;
  concept: string;
  section: 'personal' | 'education' | 'work' | 'project' | 'preference';
  valueType?: FormValueType;
  recordIndex?: number;
}): FormField {
  return {
    fieldId: input.id,
    ref: `@${input.id}`,
    pageRevision: 1,
    label: input.label,
    section: input.section,
    control: 'text',
    raw: {
      label: input.label,
      nearbyTexts: [],
    },
    context: {
      section: input.section,
      ...(input.recordIndex === undefined ? {} : { recordIndex: input.recordIndex }),
      precedingLabels: [],
      followingLabels: [],
    },
    semantic: {
      concept: input.concept,
      aliases: [],
      valueType: input.valueType ?? 'text',
      confidence: 1,
    },
    interaction: {
      kind: 'input',
      editable: true,
    },
  };
}

describe('BrowserFormService 匹配阈值与等价值候选', () => {
  it('Inspect 脚本包含字段锚点、局部块和冲突降级规则并保持语法有效', () => {
    expect(() => new Function(FormSemanticEnrichmentExpression)).not.toThrow();
    expect(FormSemanticEnrichmentExpression).toContain("[class*=\"title\" i]");
    expect(FormSemanticEnrichmentExpression).toContain("['教育经历', ['教育经历', '教育背景'");
    expect(FormSemanticEnrichmentExpression).toContain('"education":["school","major","educationType","degreeLevel","degree"]');
    expect(FormSemanticEnrichmentExpression).toContain('(ranked[0]?.[1].size || 0) < 2');
    expect(FormSemanticEnrichmentExpression).toContain('beforeSection !== afterSection');
    expect(FormSemanticEnrichmentExpression).toContain('blockSignature(candidate, block.section) === signature');
    expect(FormSemanticEnrichmentExpression).toContain('visibleControlCount(explicit) <= 20');
    expect(FormSemanticEnrichmentExpression).toContain('interactiveAncestor !== element && !strongNativeField');
    expect(FormSemanticEnrichmentExpression).toContain("['tel', 'email', 'number', 'date', 'month'].includes(type)");
    expect(FormSemanticEnrichmentExpression).toContain("element.hasAttribute('aria-autocomplete') || element.hasAttribute('aria-controls')");
  });

  it('高置信语义候选领先 0.10 时自动匹配', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'school', label: '学校名称（必填）', concept: 'education.school', section: 'education', recordIndex: 0 }),
    ], {
      profiles: [
        { id: 'education-1', category: 'education', title: '教育一', content: '[教育经历]\n学校：第一大学' },
        { id: 'education-2', category: 'education', title: '教育二', content: '[教育经历]\n学校：第二大学' },
      ],
    });

    expect(plan.operations).toMatchObject([{
      ref: '@school',
      value: '第一大学',
      strategy: 'semantic',
    }]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('单类型档案不再从旧聚合正文的其他区段读取事实', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'company', label: '公司名称', concept: 'work.company', section: 'work' }),
    ], {
      profiles: [{
        id: 'personal-1', category: 'application', title: '个人信息',
        content: '[个人信息]\n姓名：测试用户\n\n[工作经历]\n公司名称：旧版公司',
      }],
    });

    expect(plan.operations).toEqual([]);
  });

  it('当前个人信息模板仍可向个人字段提供事实', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'name', label: '姓名', concept: 'personal.name', section: 'personal' }),
    ], {
      profiles: [{ id: 'personal-1', category: 'application', title: '个人信息', content: '[个人信息]\n姓名：测试用户' }],
    });

    expect(plan.operations).toMatchObject([{ ref: '@name', value: '测试用户' }]);
  });

  it('不再将无分区旧正文归入当前档案分类', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'name', label: '姓名', concept: 'personal.name', section: 'personal' }),
    ], {
      profiles: [{ id: 'personal-1', category: 'application', title: '个人信息', content: '姓名：旧版用户' }],
    });

    expect(plan.operations).toEqual([]);
  });

  it('相同写入值的满分候选不构成歧义，并保留全部来源路径', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'school', label: '学校', concept: 'education.school', section: 'education', recordIndex: 0 }),
    ], {
      profiles: [{ id: 'education-1', category: 'education', title: '教育档案', content: '[教育经历]\n学校：测试大学' }],
      resume: { id: 'resume-1', name: '测试简历', content: '# 教育经历\n学校：测试大学' },
    });

    expect(plan.operations).toMatchObject([{
      ref: '@school',
      value: '测试大学',
      strategy: 'exact',
      sourcePaths: [
        'profiles.education-1.education.school.0',
        'resume.resume-1.education.school.0',
      ],
    }]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('写入值不同的满分候选仍返回歧义', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'school', label: '学校', concept: 'education.school', section: 'education', recordIndex: 0 }),
    ], {
      profiles: [{ id: 'education-1', category: 'education', title: '教育档案', content: '[教育经历]\n学校：第一大学' }],
      resume: { id: 'resume-1', name: '测试简历', content: '# 教育经历\n学校：第二大学' },
    });

    expect(plan.operations).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].candidates.filter((candidate) => candidate.concept === 'education.school')).toHaveLength(2);
  });

  it('重复记录包含相同日期时按 recordIndex 分别填写', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'start-1', label: '开始时间', concept: 'education.startDate', section: 'education', valueType: 'yearMonth', recordIndex: 0 }),
      Field({ id: 'start-2', label: '开始时间', concept: 'education.startDate', section: 'education', valueType: 'yearMonth', recordIndex: 1 }),
    ], {
      profiles: [
        { id: 'education-1', category: 'education', title: '教育一', content: '[教育经历]\n开始时间：2022-09' },
        { id: 'education-2', category: 'education', title: '教育二', content: '[教育经历]\n开始时间：2022-09' },
      ],
    });

    expect(plan.operations.map((operation) => ({ ref: operation.ref, sourcePath: operation.sourcePath }))).toEqual([
      { ref: '@start-1', sourcePath: 'profiles.education-1.education.startDate.0' },
      { ref: '@start-2', sourcePath: 'profiles.education-2.education.startDate.1' },
    ]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('续填时将多个同名字段按原始位置恢复为不同目标', () => {
    const fields = [
      Field({ id: 'start-1', label: '开始时间', concept: 'work.startDate', section: 'work', valueType: 'yearMonth' }),
      Field({ id: 'start-2', label: '开始时间', concept: 'work.startDate', section: 'work', valueType: 'yearMonth' }),
    ];
    for (const field of fields) {
      delete field.section;
      delete field.context.section;
      field.semantic.confidence = 0.9;
    }
    const sources = {
      profiles: [
        { id: 'work-1', category: 'work', title: '工作经历一', content: '[工作经历]\n开始时间：2023-09' },
        { id: 'work-2', category: 'work', title: '工作经历二', content: '[工作经历]\n开始时间：2026-05' },
      ],
    };
    const service = new BrowserFormService();
    const first = service.Prepare({ fields, pageRevision: 1, now: 1, url: 'https://example.com/form', sources });
    const unresolved = first.plan.publicAmbiguous as Array<{
      fieldId: string;
      candidates: Array<{ candidateId: string; label: string }>;
    }>;
    expect(unresolved).toHaveLength(2);
    const resolutions = unresolved.map((item, index) => ({
      fieldId: item.fieldId,
      candidateId: item.candidates.find((candidate) => candidate.label.startsWith(index === 0 ? '工作经历一' : '工作经历二'))!.candidateId,
    }));

    const second = service.Prepare({
      fields,
      pageRevision: 1,
      now: 2,
      url: 'https://example.com/form',
      continuationId: first.continuationId,
      resolutions,
    });

    expect(second.plan.operations.map((operation) => operation.ref)).toEqual(['@start-1', '@start-2']);
  });

  it('缺少模块的通用日期保持未知，并交给候选消歧', () => {
    const fields = FormFields({
      date: { role: 'textbox', tag: 'input', name: '开始时间', rawLabel: '开始时间' },
    }, 1);

    expect(fields[0].context.section).toBeUndefined();
    expect(fields[0].semantic).toMatchObject({ concept: 'unknown', valueType: 'yearMonth' });
    const plan = CreateFormFillPlan(fields, {
      profiles: [
        { id: 'education-1', category: 'education', title: '教育经历', content: '[教育经历]\n开始时间：2022-09' },
        { id: 'project-1', category: 'project', title: '项目经历', content: '[项目经历]\n开始时间：2025-02' },
      ],
    });
    expect(plan.operations).toEqual([]);
    expect(plan.ambiguous[0].candidates.map((candidate) => candidate.concept)).toEqual([
      'education.startDate',
      'project.startDate',
    ]);
  });

  it('字段标题包含毕业语义时推断为教育结束时间', () => {
    const fields = FormFields({
      graduation: { role: 'combobox', tag: 'input', name: '毕业时间', rawLabel: '毕业时间' },
    }, 1);

    expect(fields[0]).toMatchObject({
      context: { section: 'education' },
      semantic: { concept: 'education.endDate', valueType: 'yearMonth', confidence: 1 },
    });
  });

  it('精确地区字段覆盖错误的页面模块归属', () => {
    const fields = FormFields({
      residence: {
        role: 'combobox', tag: 'div', name: '现居住地', rawLabel: '现居住地',
        section: '教育经历', groupHeading: '教育经历', nearbyTexts: ['学校名称'],
      },
    }, 1);

    expect(fields[0]).toMatchObject({
      section: 'personal',
      context: { section: 'personal' },
      semantic: { concept: 'personal.currentRegion', valueType: 'region', confidence: 1 },
      interaction: { kind: 'cascader' },
    });
  });

  it('北森地区弹层同时暴露文字导航行和圆点选择控件', () => {
    expect(() => new Function(DynamicOptionEnrichmentExpression)).not.toThrow();
    expect(DynamicOptionEnrichmentExpression).toContain("element.matches('[class*=\"area-item-container\" i]')");
    expect(DynamicOptionEnrichmentExpression).toContain("element.matches('[class*=\"area-item-name\" i]')");
    expect(DynamicOptionEnrichmentExpression).toContain("element.parentElement?.matches('[class*=\"area-item-container\" i]')");
    expect(DynamicOptionEnrichmentExpression).toContain('|| regionRow');
    expect(DynamicOptionEnrichmentExpression).toContain('[class*="area-selector-container" i]');
    expect(DynamicOptionEnrichmentExpression).toContain('[class*="area-text-label" i]');
    expect(DynamicOptionEnrichmentExpression).toContain("element.setAttribute('tabindex', '0')");
    expect(DynamicOptionEnrichmentExpression).not.toContain("getComputedStyle(element).cursor !== 'pointer'");
  });

  it('北森民族弹层暴露虚拟列表、单选项和搜索入口', () => {
    expect(() => new Function(DynamicOptionEnrichmentExpression)).not.toThrow();
    expect(DynamicOptionEnrichmentExpression).toContain('[class*="constant-main-selector-container" i]');
    expect(DynamicOptionEnrichmentExpression).toContain('[class*="list-item-container" i]');
    expect(DynamicOptionEnrichmentExpression).toContain('data-avery-dynamic-search');

    expect(DynamicOptionMatch({ refs: {
      e1: { role: 'radio', name: '汉族' },
      e2: { role: 'radio', name: '回族' },
    } }, 'ethnicity', '汉', new Set())).toMatchObject({ ref: '@e1', role: 'radio', complete: true });
    expect(DynamicOptionMatch({ refs: {
      e1: { role: 'radio', name: '汉族' },
      e2: { role: 'button', name: '汉族' },
    } }, 'ethnicity', '汉', new Set())).toMatchObject({ ref: '@e2', role: 'button', complete: true });
    expect(DynamicSearchMatch({ refs: {
      e3: { role: 'textbox', name: '__avery_dynamic_search__' },
    } })).toEqual({ ref: '@e3' });
  });

  it('民族目标不在虚拟列表时先搜索再选择并确认', async () => {
    let snapshotCount = 0;
    let verificationCount = 0;
    const commands: string[][] = [];
    const driver = new BrowserFormDriver({
      pageRevision: () => 1,
      delay: async () => undefined,
      runCommand: async (command) => {
        commands.push(command);
        if (command[0] === 'snapshot') {
          snapshotCount += 1;
          if (snapshotCount === 1) return { data: { refs: {
            e1: { role: 'combobox', tag: 'input', name: '民族', rawLabel: '民族' },
          } } };
          if (snapshotCount <= 11) return { data: { refs: {
            e2: { role: 'textbox', name: '__avery_dynamic_search__' },
          } } };
          if (snapshotCount === 12) return { data: { refs: {
            e3: { role: 'radio', name: '汉族' },
          } } };
          return { data: { refs: {
            e4: { role: 'button', name: '__avery_dynamic_confirmation__' },
          } } };
        }
        if (command[0] === 'eval') {
          const expression = Buffer.from(command[2] ?? '', 'base64').toString('utf8');
          if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')")) {
            verificationCount += 1;
            return { data: { result: { filled: verificationCount > 1 } } };
          }
        }
        return { success: true, data: {} };
      },
    });

    const result = await driver.ExecuteCustomSelect({
      kind: 'custom_select', fieldId: 'f1', ref: '@e1', pageRevision: 1,
      label: '民族', key: 'ethnicity', concept: 'personal.ethnicity', occurrence: 0,
      value: '汉',
    }, {});

    expect(result).toEqual({ filled: true });
    expect(commands).toContainEqual(['fill', '@e2', '汉']);
    expect(commands).toContainEqual(['click', '@e3']);
    expect(commands).toContainEqual(['click', '@e4']);
  });

  it('动态候选支持 Phoenix 在无障碍树中稳定暴露的 button 角色', () => {
    const workYears = DynamicOptionMatch({ refs: {
      e1: { role: 'button', name: '在读学生' },
      e2: { role: 'button', name: '应届毕业生' },
    } }, 'workYears', '在读学生', new Set());
    const province = DynamicOptionMatch({ refs: {
      e3: { role: 'button', name: '广东省' },
      e4: { role: 'radio', name: '广东省' },
    } }, 'residence', '广东省佛山市', new Set());

    expect(workYears).toMatchObject({ ref: '@e1', role: 'button', complete: true });
    expect(province).toMatchObject({ ref: '@e3', role: 'button', complete: false });
  });

  it('地区提交验证允许控件直接恢复到目标末级', () => {
    const expression = DynamicSelectionVerificationExpression({
      kind: 'custom_select', fieldId: 'f1', ref: '@e1', pageRevision: 1,
      label: '现居住地', key: 'residence', concept: 'personal.currentRegion', occurrence: 0,
      value: '广东省佛山市',
    }, ['佛山市']);

    expect(expression).toContain('desiredGeographic.endsWith(selectedLeaf)');
    expect(expression).not.toContain('selected.length > 1');
  });

  it('北森日期弹层将年份入口、年份候选、月份候选和日期候选区分为稳定动作', () => {
    expect(() => new Function(DateEditorEnrichmentExpression)).not.toThrow();
    expect(DateEditorEnrichmentExpression).toContain('[class*="year-panel" i]');
    expect(DateEditorEnrichmentExpression).toContain('[class*="month-panel" i]');
    expect(DateEditorEnrichmentExpression).toContain('__avery_date_year_header__:');
    expect(DateEditorEnrichmentExpression).toContain('__avery_date_year_option__:');
    expect(DateEditorEnrichmentExpression).toContain('__avery_date_month_option__:');
    expect(DateEditorEnrichmentExpression).toContain('__avery_date_day_option__:');
    expect(DateEditorEnrichmentExpression).toContain('[data-avery-date-original-role="gridcell"]');
    expect(DateEditorEnrichmentExpression).toContain("input.matches('.phoenix-select__input--unText')");
    expect(DateEditorEnrichmentExpression).toContain('__avery_date_month_year_header__:');
    expect(DateEditorEnrichmentExpression).toContain('.phoenix-calendar-month-panel-year-select-content');
    expect(DateEditorEnrichmentExpression).toContain('monthPanelYearButton !== element');
  });

  it('北森相对定位的日期和地区弹层也可由字段触发器关闭', () => {
    const expression = DynamicOverlayDismissExpression({
      kind: 'custom_select', fieldId: 'f1', ref: '@e1', pageRevision: 1,
      label: '现居住地', key: 'residence', concept: 'personal.currentRegion', occurrence: 0,
      value: '广东省佛山市',
    });

    expect(() => new Function(expression)).not.toThrow();
    expect(expression).toContain('[class*="area-selector-container" i]');
    expect(expression).toContain('[class*="calendar" i]');
    expect(expression).toContain('[class*="selectList" i]');
  });

  it('续填不重放上一次已有确定结果的字段', () => {
    const residence = Field({ id: 'residence', label: '现居住地', concept: 'personal.currentRegion', section: 'personal', valueType: 'region' });
    residence.control = 'select';
    residence.interaction = { kind: 'cascader', editable: true, levels: 3, requiresCommit: true };
    const ethnicity = Field({ id: 'ethnicity', label: '民族', concept: 'personal.ethnicity', section: 'personal' });
    ethnicity.control = 'select';
    ethnicity.required = true;
    ethnicity.interaction = { kind: 'select', editable: true };
    const service = new BrowserFormService();
    const first = service.Prepare({
      fields: [residence, ethnicity], pageRevision: 1, now: 1, url: 'https://example.com/form',
      sources: { profiles: [{ id: 'profile-1', category: 'application', title: '个人信息', content: '[个人信息]\n现居住地：广东省佛山市' }] },
    });

    expect(first.plan.operations.map((operation) => operation.label)).toEqual(['现居住地']);
    expect(first.plan.missingFields.map((field) => field.label)).toContain('民族');
    service.RecordAttempted(first.plan);

    const second = service.Prepare({
      fields: [residence, ethnicity], pageRevision: 1, now: 2, url: 'https://example.com/form',
      continuationId: first.continuationId,
    });
    expect(second.plan.operations).toEqual([]);
    expect(second.plan.missingFields.map((field) => field.label)).toContain('民族');
  });

  it('续填只跳过已实际执行的字段，保留因预算延期的字段', () => {
    const name = Field({ id: 'name', label: '姓名', concept: 'personal.name', section: 'personal' });
    const email = Field({ id: 'email', label: '邮箱', concept: 'personal.email', section: 'personal', valueType: 'email' });
    const service = new BrowserFormService();
    const first = service.Prepare({
      fields: [name, email], pageRevision: 1, now: 1, url: 'https://example.com/form',
      sources: { profiles: [{ id: 'profile-1', category: 'application', title: '个人信息', content: '[个人信息]\n姓名：张三\n邮箱：zhangsan@example.com' }] },
    });

    service.RecordAttempted(first.plan, [first.plan.operations[0]!]);
    const second = service.Prepare({
      fields: [name, email], pageRevision: 1, now: 2, url: 'https://example.com/form',
      continuationId: first.continuationId,
    });

    expect(second.plan.operations.map((operation) => operation.label)).toEqual(['邮箱']);
  });

  it('忽略手机号复合控件中的区号选择器，仅保留号码输入框', () => {
    const fields = FormFields({
      areaCode: { role: 'combobox', tag: 'div', name: '手机号码', rawLabel: '手机号码' },
      phone: { role: 'textbox', tag: 'input', type: 'tel', name: '手机号码', rawLabel: '手机号码' },
    }, 1);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      ref: '@phone',
      control: 'text',
      semantic: { concept: 'personal.phone' },
    });
  });

  it.each([
    ['教育开始时间', 'education', 'education.startDate'],
    ['工作结束时间', 'work', 'work.endDate'],
    ['项目开始时间', 'project', 'project.startDate'],
  ])('组合标题“%s”生成完整日期语义', (label, section, concept) => {
    const fields = FormFields({
      date: { role: 'textbox', tag: 'input', name: label, rawLabel: label },
    }, 1);

    expect(fields[0]).toMatchObject({
      context: { section },
      semantic: { concept },
    });
  });

  it('已识别模块的同名日期只匹配同模块数据', () => {
    const plan = CreateFormFillPlan([
      Field({ id: 'education-start', label: '开始时间', concept: 'education.startDate', section: 'education', valueType: 'yearMonth', recordIndex: 0 }),
      Field({ id: 'project-start', label: '开始时间', concept: 'project.startDate', section: 'project', valueType: 'yearMonth', recordIndex: 0 }),
    ], {
      profiles: [
        { id: 'education-1', category: 'education', title: '教育经历', content: '[教育经历]\n开始时间：2022-09' },
        { id: 'project-1', category: 'project', title: '项目经历', content: '[项目经历]\n开始时间：2025-02' },
      ],
    });

    expect(plan.operations.map((operation) => ({ ref: operation.ref, concept: operation.concept, value: operation.value }))).toEqual([
      { ref: '@education-start', concept: 'education.startDate', value: '2022-09' },
      { ref: '@project-start', concept: 'project.startDate', value: '2025-02' },
    ]);
    expect(plan.ambiguous).toEqual([]);
  });
});
