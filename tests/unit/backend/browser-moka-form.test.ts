import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BrowserFormDriver, DynamicOptionMatch, DynamicSelectionVerificationExpression } from '../../../apps/backend/src/electron/backend/browser-form-driver';
import { CreateFormFillPlan, FormFields, type FormFillOperation } from '../../../apps/backend/src/electron/backend/browser-form-service';
import { MokaFormValueScript, MokaSearchOptionsWaitExpression } from '../../../apps/backend/src/electron/backend/browser-moka-form';

function Metadata(label: string, overrides: Record<string, unknown> = {}) {
  return { role: 'combobox', name: '__avery_field__' + Buffer.from(JSON.stringify({ l: label, s: 'education', o: 0, t: 'moka', v: false, ...overrides })).toString('base64url') };
}

function Operation(overrides: Partial<FormFillOperation> = {}): FormFillOperation {
  return { kind: 'custom_select', ref: '@school', key: 'school', occurrence: 0, targetOccurrence: 0, targetRecordIndex: 0,
    adapter: 'moka', value: '南昌大学', label: '学校名称', sourceTitle: '教育经历', sourcePath: 'education.school',
    sourcePaths: ['education.school'], concept: 'education.school', strategy: 'exact', ...overrides };
}

describe('Moka 申请表适配', () => {
  it('跳过内部搜索框和禁用的教育摘要，只规划真实可编辑字段', () => {
    const fields = FormFields({
      summary: Metadata('最高学历', { d: true }), school: Metadata('学校名称'),
      degree: Metadata('学历'), internal: { role: 'textbox', name: '__avery_internal_form_control__', rawLabel: '本科' },
    }, 1);
    expect(fields.map(f => f.label)).toEqual(['最高学历', '学校名称', '学历']);
    expect(fields[0]).toMatchObject({ disabled: true, interaction: { adapter: 'moka', requiresCommit: true } });
    const plan = CreateFormFillPlan(fields, { profiles: [{ id: 'edu', category: 'education', title: '教育经历', content: '[教育经历]\n学校：南昌大学\n学历：本科' }] });
    expect(plan.operations.map(o => o.label)).toEqual(['学校名称', '学历']);
    expect(plan.operations.every(o => o.adapter === 'moka' && o.targetRecordIndex === 0)).toBe(true);
  });

  it('过滤前条经历的已填字段后，保留第二条经历的原始记录编号', () => {
    const fields = FormFields({ first: Metadata('学校名称', { v: true }), second: Metadata('学校名称', { o: 1 }) });
    const sources = { profiles: [
      { id: 'edu1', category: 'education', title: '教育经历一', content: '[教育经历]\n学校：南昌大学' },
      { id: 'edu2', category: 'education', title: '教育经历二', content: '[教育经历]\n学校：北京大学' },
    ] };
    const plan = CreateFormFillPlan(fields, sources);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({ value: '北京大学', targetRecordIndex: 1 });
  });

  it('精确识别意向工作城市，未知的推荐码不借用信息来源事实', () => {
    const fields = FormFields({ city: Metadata('意向工作城市', { s: 'preference' }), referral: Metadata('推荐码', { s: '' }) });
    expect(fields[0].semantic.concept).toBe('preference.targetRegion');
    expect(fields[1].semantic.concept).toBe('unknown');
    const plan = CreateFormFillPlan(fields, { profiles: [{ id: 'pref', category: 'job_intention', title: '求职意向', content: '[求职意向]\n目标城市：广州\n信息来源：学校官网' }] });
    expect(plan.operations.some(o => o.label === '推荐码')).toBe(false);
  });

  it('相似学校不能替代目标学校，也不点击添加自定义选项', () => {
    const data = { refs: { college: { role: 'button', name: '南昌大学科学技术学院' }, add: { role: 'button', name: '添加学校全称' } } };
    expect(DynamicOptionMatch(data, 'school', '南昌大学', new Set(), true)).toBeUndefined();
    expect(DynamicOptionMatch({ refs: { ...data.refs, exact: { role: 'button', name: '南昌大学' } } }, 'school', '南昌大学', new Set(), true)?.ref).toBe('@exact');
  });

  it('异步搜索只输入一次，等待真实候选，再点击并验证选中值，不按 Enter 提交', async () => {
    let opened = false, loaded = false, committed = false;
    const commands: string[][] = [];
    const driver = new BrowserFormDriver({ pageRevision: () => 1, delay: async () => undefined,
      runCommand: async args => {
        commands.push(args);
        if (args[0] === 'eval') {
          const expression = Buffer.from(args[2]!, 'base64').toString();
          if (expression.startsWith('new Promise')) { loaded = true; return { data: { result: { ready: true } } }; }
          if (expression.includes('const candidates = triggers.filter')) return { data: { result: { filled: committed } } };
        }
        if (args[0] === 'click') { if (args[1] === '@school') opened = true; if (args[1] === '@candidate') committed = true; }
        if (args[0] === 'snapshot') return { data: { refs: {
          school: Metadata('学校名称'),
          ...(opened ? { search: { role: 'textbox', name: '__avery_dynamic_search__' } } : {}),
          ...(loaded ? { candidate: { role: 'button', name: '南昌大学' } } : {}),
        } } };
        return { data: {} };
      },
    });
    expect(await driver.ExecuteCustomSelect(Operation(), {})).toEqual({ filled: true });
    expect(commands.filter(args => args[0] === 'fill')).toEqual([['fill', '@search', '南昌大学']]);
    expect(commands.filter(args => args[0] === 'click')).toEqual([['click', '@school'], ['click', '@candidate']]);
    expect(commands.some(args => args[0] === 'press' && args[1] === 'Enter')).toBe(false);
  });

  it('重建页面后目标变为只读，不点击禁用字段', async () => {
    const runCommand = vi.fn(async (args: string[]) => ({ data: args[0] === 'snapshot' ? { refs: { school: Metadata('学校名称', { d: true }) } } : {} }));
    const driver = new BrowserFormDriver({ runCommand, pageRevision: () => 1, delay: async () => undefined });
    expect(await driver.ExecuteCustomSelect(Operation(), {})).toEqual({ filled: false, reason: 'field_not_editable' });
    expect(runCommand.mock.calls.some(([args]) => args[0] === 'click')).toBe(false);
  });

  it.each([['', '南昌大学', false], ['南昌大学科学技术学院', '南昌大学', false], ['南昌大学', '', true]])(
    '只比较已选值 %s，忽略搜索词 %s', (selected, search, filled) => {
      class Element {
        getAttribute(name: string) { return ({ 'data-avery-form-key': 'school', 'data-avery-form-label': '学校名称', 'data-avery-form-section': 'education', 'data-avery-form-record': '0' } as Record<string, string>)[name]; }
        matches() { return true; }
        querySelector(selector: string) { return selector === 'input' ? { value: search } : { textContent: selected }; }
      }
      expect(runInNewContext(DynamicSelectionVerificationExpression(Operation(), ['南昌大学']), { document: { querySelectorAll: () => [new Element()] }, HTMLElement: Element }).filled).toBe(filled);
    },
  );

  it('生日读值去掉网站附加的年龄，保留实际年月精度', () => {
    const target = { matches: (selector: string) => selector.includes('day_info'), querySelector: () => ({ value: '1993-05 (33岁)' }) };
    expect(runInNewContext(`(() => { ${MokaFormValueScript} return mokaSelectedValue(target); })()`, { target })).toBe('1993-05');
  });

  it('候选等待到期后清理观察器并返回未就绪，不能把无候选算成功', async () => {
    const disconnect = vi.fn();
    class Observer { observe() {} disconnect = disconnect; }
    const result = await runInNewContext(MokaSearchOptionsWaitExpression('南昌大学', 1), { document: { body: {}, querySelectorAll: () => [] }, MutationObserver: Observer, setTimeout, clearTimeout });
    expect(result.ready).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('教育结束年月分别选择，不借用开始年月或搜索值作为完成依据', async () => {
    let stage = 'controls', committed = false;
    const clicks: string[] = [];
    const driver = new BrowserFormDriver({ pageRevision: () => 1, delay: async () => undefined, runCommand: async args => {
      if (args[0] === 'eval') {
        const expression = Buffer.from(args[2]!, 'base64').toString();
        if (expression.includes("target.setAttribute('data-avery-moka-active-date'")) return { data: { result: { found: true, range: true } } };
        if (expression.includes('const candidates = triggers.filter')) return { data: { result: { filled: committed } } };
      }
      if (args[0] === 'click') {
        clicks.push(args[1]!);
        if (args[1] === '@endYear') stage = 'years';
        if (args[1] === '@year2027') stage = 'controls';
        if (args[1] === '@endMonth') stage = 'months';
        if (args[1] === '@month6') { committed = true; stage = 'controls'; }
      }
      if (args[0] === 'snapshot') return { data: { refs: {
        end: Metadata('结束时间'),
        endYear: { role: 'button', name: '__avery_moka_year_control__' }, endMonth: { role: 'button', name: '__avery_moka_month_control__' },
        ...(stage === 'years' ? { year2027: { role: 'option', name: '__avery_date_year_option__:2027' } } : {}),
        ...(stage === 'months' ? { month6: { role: 'option', name: '__avery_date_month_option__:6' } } : {}),
      } } };
      return { data: {} };
    } });
    expect(await driver.ExecuteCustomDate(Operation({ kind: 'custom_date', key: 'endDate', concept: 'education.endDate', label: '结束时间', value: '2027-06' }), {})).toEqual({ filled: true });
    expect(clicks).toEqual(['@endYear', '@year2027', '@endMonth', '@month6']);
  });

  it('生日跨十年选年后选月即完成，不等待不存在的日网格', async () => {
    let stage = 'months', year = 1990, decade = 1990, committed = false;
    const clicks: string[] = [];
    const driver = new BrowserFormDriver({ pageRevision: () => 1, delay: async () => undefined, runCommand: async args => {
      if (args[0] === 'eval') {
        const expression = Buffer.from(args[2]!, 'base64').toString();
        if (expression.includes("target.setAttribute('data-avery-moka-active-date'")) return { data: { result: { found: true, range: false } } };
        if (expression.includes('const candidates = triggers.filter')) return { data: { result: { filled: committed } } };
      }
      if (args[0] === 'click') {
        clicks.push(args[1]!);
        if (args[1] === '@yearHeader') stage = 'years';
        if (args[1] === '@next') decade += 10;
        if (args[1] === '@year2003') { year = 2003; stage = 'months'; }
        if (args[1] === '@month9') committed = true;
      }
      if (args[0] === 'snapshot') return { data: { refs: {
        birth: Metadata('出生日期 (年龄)', { s: 'personal' }),
        panel: { role: 'group', name: '__avery_date_month_only__' },
        ...(stage === 'months' ? { yearHeader: { role: 'button', name: `__avery_date_year_header__:${year}` }, month9: { role: 'option', name: '__avery_date_month_option__:9' } }
          : { decade: { role: 'group', name: `__avery_moka_decade__:${decade}:${decade + 9}` }, next: { role: 'button', name: '__avery_moka_next_years__' }, ...(decade === 2000 ? { year2003: { role: 'option', name: '__avery_date_year_option__:2003' } } : {}) }),
      } } };
      return { data: {} };
    } });
    expect(await driver.ExecuteCustomDate(Operation({ kind: 'custom_date', key: 'birthDate', concept: 'personal.birthDate', label: '出生日期 (年龄)', value: '2003-09-12' }), {})).toEqual({ filled: true });
    expect(clicks).toEqual(['@birth', '@yearHeader', '@next', '@year2003', '@month9']);
  });
});
