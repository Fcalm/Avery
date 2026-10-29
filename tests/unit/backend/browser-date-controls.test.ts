import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CreateFormFillPlan, FormFields, type FormFillOperation } from '../../../apps/backend/src/electron/backend/browser-form-service';
import { BrowserFormDriver, DynamicSelectionVerificationExpression, MatchingDynamicFormFields } from '../../../apps/backend/src/electron/backend/browser-form-driver';

const profiles = [{ id: 'education', category: 'education', title: '教育经历', content: '[教育经历]\n开始时间：2023-09\n结束时间：2027-06' }];

function DateOperation(overrides: Partial<FormFillOperation> = {}): FormFillOperation {
  return { kind: 'custom_date', ref: '@start', key: 'startDate', occurrence: 0, targetOccurrence: 0,
    value: '2023-09', label: '开始时间', sourceTitle: '教育经历', sourcePath: 'profiles.education.education.startDate.0',
    sourcePaths: ['profiles.education.education.startDate.0'], concept: 'education.startDate', strategy: 'exact', ...overrides };
}

describe('日期字段定位与提交验证', () => {
  it('年月滚动面板先显露目标项，选月提交后不等待日网格', async () => {
    let panel = false, revealed = false, committed = false, reveals = 0;
    const clicks: string[] = [];
    const driver = new BrowserFormDriver({
      pageRevision: () => 1, delay: async () => undefined,
      runCommand: async args => {
        if (args[0] === 'eval') {
          const expression = Buffer.from(args[2]!, 'base64').toString('utf8');
          if (expression.includes('list.scrollTop +=')) { revealed = true; reveals += 1; }
          if (expression.includes('const candidates = triggers.filter')) return { success: true, data: { result: { filled: committed } } };
        }
        if (args[0] === 'click') {
          clicks.push(args[1]!);
          if (args[1] === '@start') panel = true;
          if (args[1] === '@year') revealed = false;
          if (args[1] === '@month') { panel = false; committed = true; }
        }
        if (args[0] === 'snapshot') return { success: true, data: { refs: panel ? {
          start: { role: 'combobox', name: '开始时间', section: 'education' },
          panel: { role: 'group', name: '__avery_date_month_only__' },
          year: { role: 'option', name: '__avery_date_year_option__:2023' },
          ...(revealed ? { month: { role: 'option', name: '__avery_date_month_option__:9' } } : {}),
        } : { start: { role: 'combobox', name: '开始时间', section: 'education' } } } };
        return { success: true, data: {} };
      },
    });
    expect(await driver.ExecuteCustomDate(DateOperation(), {})).toEqual({ filled: true });
    expect(clicks).toEqual(['@start', '@year', '@month']);
    expect(reveals).toBe(2);
  });

  it('教育结束时间不借用同语义的个人毕业时间入口', () => {
    const fields = FormFields({
      graduation: { role: 'combobox', name: '毕业时间', section: 'education' },
      end: { role: 'combobox', name: '结束时间', section: 'education' },
    }, 1);
    const plan = CreateFormFillPlan(fields, { profiles }, ['@end']);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({ kind: 'custom_date', ref: '@end', targetOccurrence: 0 });
    expect(MatchingDynamicFormFields(fields, plan.operations[0]!).map(field => field.ref)).toEqual(['@end']);
  });

  it('过滤已填的前一条经历后，日期目标序号保持原位置', () => {
    const fields = FormFields({
      first: { role: 'combobox', name: '开始时间', section: 'education', filledState: true, recordIndex: 0 },
      second: { role: 'combobox', name: '开始时间', section: 'education', filledState: false, recordIndex: 1 },
    }, 1);
    const plan = CreateFormFillPlan(fields, { profiles }, ['@second']);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({ ref: '@second', targetOccurrence: 1 });
    const matches = MatchingDynamicFormFields(fields, plan.operations[0]!);
    expect(matches[plan.operations[0]!.targetOccurrence!]!.ref).toBe('@second');
  });

  it('过期序号停止执行，不回退点击第一条经历', async () => {
    const commands: string[][] = [];
    const driver = new BrowserFormDriver({
      runCommand: async args => { commands.push(args); return { success: true, data: { refs: { first: { role: 'combobox', name: '开始时间', section: 'education' } } } }; },
      pageRevision: () => 1, delay: async () => undefined,
    });
    expect(await driver.ExecuteCustomDate(DateOperation({ targetOccurrence: 1 }), {})).toEqual({ filled: false, reason: 'dynamic_field_not_found' });
    expect(commands.some(args => args[0] === 'click')).toBe(false);
  });

  it.each([
    ['2023-08', false], ['2023-09', true], ['2023年9月', true], ['2023-MM', false], ['2023-09-extra', false], ['', false],
  ])('只读取当前端点 %s，不采用相邻日期', (actual, expected) => {
    class Element {
      constructor(readonly textContent: string, readonly label = '开始时间', readonly section = 'education') {}
      getAttribute(key: string) { return ({ 'data-avery-form-key': 'startDate', 'data-avery-form-section': this.section, 'data-avery-form-label': this.label } as Record<string, string>)[key]; }
      querySelector() { return null; }
      matches() { return true; }
    }
    const target = new Element(actual);
    const neighbor = new Element('2023-09', '开始时间', 'work');
    const result = runInNewContext(DynamicSelectionVerificationExpression(DateOperation(), ['2023-09']), {
      HTMLElement: Element, document: { querySelectorAll: () => [target, neighbor] },
    });
    expect(result.filled).toBe(expected);
  });

  it('年月相同但具体日期不同，不能当成完整日期填写成功', () => {
    class Element {
      getAttribute(key: string) { return ({ 'data-avery-form-key': 'birthDate', 'data-avery-form-section': 'personal', 'data-avery-form-label': '出生日期' } as Record<string, string>)[key]; }
      querySelector() { return { value: '2005-01-14' }; }
      matches() { return false; }
    }
    const result = runInNewContext(DynamicSelectionVerificationExpression(DateOperation({ key: 'birthDate', concept: 'personal.birthDate', label: '出生日期', value: '2005-01-15' }), ['2005-01-15']), {
      HTMLElement: Element, document: { querySelectorAll: () => [new Element()] },
    });
    expect(result.filled).toBe(false);
  });
});
