import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BrowserFormDriver, DynamicOptionMatch, DynamicSelectionVerificationExpression } from '../../../apps/backend/src/electron/backend/browser-form-driver';
import { FormValuesMatch, type FormFillOperation } from '../../../apps/backend/src/electron/backend/browser-form-service';

const operation = (overrides: Partial<FormFillOperation> = {}): FormFillOperation => ({
  kind: 'custom_select', key: 'politicalStatus', concept: 'personal.politicalStatus', ref: '@e1',
  occurrence: 0, label: '政治面貌', value: '党员', sourceTitle: '个人资料', sourcePath: 'p.politicalStatus',
  sourcePaths: ['p.politicalStatus'], strategy: 'agent', ...overrides,
});

describe('浏览器字段值完整性', () => {
  it('候选已限定弹层时，页面上同名按钮不能冒充选项', () => {
    const refs = { e1: { role: 'button', name: '党员' }, e2: { role: 'button', name: '__avery_dynamic_option__:预备党员' } };
    expect(DynamicOptionMatch({ refs, optionObservation: { scoped: true } }, 'politicalStatus', '党员', new Set())).toBeUndefined();
    expect(DynamicOptionMatch({ refs, optionObservation: { scoped: true } }, 'politicalStatus', '预备党员', new Set())?.ref).toBe('@e2');
  });
  it.each([
    ['politicalStatus', '党员', '预备党员'], ['maritalStatus', '已婚', '未婚或已婚'],
    ['degree', '学士', '无学士学位'], ['degree', '本科', '学士'],
    ['school', '交通大学', '西安交通大学'],
  ])('不因子串相似把 %s 的 %s 写为 %s', (key, desired, observed) => {
    expect(DynamicOptionMatch({ refs: { e1: { role: 'button', name: observed } } }, key, desired, new Set())).toBeUndefined();
  });

  it.each([['ethnicity', '汉', '汉族'], ['workYears', '在校学生', '在读学生']])('候选与最终回读使用相同的有限别名：%s', (key, desired, actual) => {
    expect(DynamicOptionMatch({ refs: { e1: { role: 'button', name: actual } } }, key, desired, new Set())?.complete).toBe(true);
    expect(FormValuesMatch(key, desired, actual)).toBe(true);
  });

  it('有目标节点身份时，原节点消失不能改填另一条同名记录', async () => {
    const commands: string[][] = [];
    const driver = new BrowserFormDriver({
      pageRevision: () => 1, delay: async () => undefined,
      runCommand: async command => {
        commands.push(command);
        return { success: true, data: { refs: { e2: { role: 'combobox', name: '政治面貌', nodeIdentity: 'doc:replacement' } } } };
      },
    });
    expect(await driver.ExecuteCustomSelect(operation({ targetNodeIdentity: 'doc:original' }), {})).toMatchObject({ filled: false, reason: 'dynamic_field_not_found' });
    expect(commands.some(command => command[0] === 'click')).toBe(false);
  });

  it.each(['预备党员', '请选择'])('周围容器含目标文字，但当前控件为 %s 时不能通过回读', actual => {
    class Element {
      innerText = actual;
      textContent = actual;
      tagName = 'DIV';
      parentElement?: Element;
      getAttribute(key: string) { return ({ 'data-avery-form-key': 'politicalStatus', 'data-avery-form-label': '政治面貌', 'data-avery-form-section': 'personal' } as Record<string, string>)[key]; }
      querySelector() { return null; }
      querySelectorAll() { return []; }
      matches() { return false; }
      closest() { return null; }
      getBoundingClientRect() { return { width: 100, height: 30 }; }
    }
    const target = new Element(), surrounding = new Element();
    surrounding.innerText = surrounding.textContent = '政治面貌 党员 预备党员 请选择';
    target.parentElement = surrounding;
    const result = runInNewContext(DynamicSelectionVerificationExpression(operation(), ['党员']), {
      document: { querySelectorAll: () => [target] }, HTMLElement: Element,
      HTMLInputElement: class {}, HTMLTextAreaElement: class {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    });
    expect(result.filled).toBe(false);
  });
});
