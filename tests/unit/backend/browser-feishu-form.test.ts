import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuSelectOptionsExpression, FeishuSelectValueScript } from '../../../apps/backend/src/electron/backend/browser-feishu-form';
import { FormRetainedValuesExpression } from '../../../apps/backend/src/electron/backend/browser-form-driver';
import { BrowserFormReviewService } from '../../../apps/backend/src/electron/backend/browser-form-review';
import { EncodedFormFieldPrefix, FormFields, type FormFillOperation } from '../../../apps/backend/src/electron/backend/browser-form-service';

class Element {
  isConnected = true;
  readonly attributes = new Map<string, string>();
  root: Element = this;
  children: Element[] = [];
  textContent = '';
  value = '';
  disabled = false;
  readonly classList = { contains: (name: string) => this.attributes.get('class')?.split(' ').includes(name) ?? false };
  closest(selector: string): Element | null { return selector.includes('atsx-select') ? this.root : null; }
  querySelectorAll(_selector: string): Element[] { return this.children; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 200, height: 40 }; }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  hasAttribute(key: string) { return this.attributes.has(key); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
}
class Input extends Element { type = 'text'; checked = false; }
const selected = (label: string) => Object.assign(new Element(), { textContent: label });
const operation: FormFillOperation = {
  kind: 'custom_select', key: 'degreeLevel', concept: 'education.degreeLevel', label: '学历', value: '本科',
  ref: '@e1', occurrence: 0, sourceTitle: '教育经历', sourcePath: 'education.degreeLevel', sourcePaths: ['education.degreeLevel'],
  strategy: 'agent', adapter: 'feishu', targetNodeIdentity: 'doc:degree',
};

function MenuFixture() {
  const trigger = new Element(), menu = new Element(), popup = new Element();
  trigger.setAttribute('aria-controls', 'degree-menu');
  menu.root = popup;
  let animating = true;
  Object.assign(popup, { getAnimations: () => animating ? [{ playState: 'running' }] : [] });
  menu.children = ['本科', '硕士', '博士'].map(label => {
    const option = selected(label);
    option.setAttribute('role', 'option');
    if (label === '博士') option.setAttribute('aria-disabled', 'true');
    return option;
  });
  const triggers = [trigger], identities = new Map([[trigger, 'doc:degree']]);
  const evaluate = new Function('document', 'window', 'HTMLElement', 'getComputedStyle', `return ${FeishuSelectOptionsExpression(operation)}`);
  const run = () => evaluate({ querySelectorAll: () => triggers, getElementById: (id: string) => id === 'degree-menu' ? menu : null },
    { __averyFormIdentities: { nodes: identities } }, Element, () => ({ display: 'block', visibility: 'visible' })) as Promise<Record<string, unknown>>;
  return { trigger, triggers, identities, menu, run, settle: () => { animating = false; } };
}

afterEach(() => vi.useRealTimers());

describe('飞书 Select 业务值和候选稳定性', () => {
  it.each(['', '硕士'])('已选本科时不把内部搜索词 %s 当作学历值', search => {
    const root = new Element(), input = new Input();
    root.children = [selected('本科')]; input.root = root; input.value = search;
    const read = new Function('element', `${FeishuSelectValueScript}; return feishuSelectedValue(element);`);
    expect(read(input)).toBe('本科');
  });

  it('未选项时返回空，学校多选标签读取完整已选文本', () => {
    const root = new Element();
    const read = new Function('element', `${FeishuSelectValueScript}; return feishuSelectedValue(element);`);
    expect(read(root)).toBe('');
    root.children = [selected('南昌大学'), selected('其他学校')];
    expect(read(root)).toBe('南昌大学 其他学校');
  });

  it('独立完整回读与上传基线使用已选项，不因搜索框空值把本科读为空', () => {
    const trigger = new Element(); trigger.children = [selected('本科')];
    trigger.setAttribute('aria-label', EncodedFormFieldPrefix + 'fixture');
    const evaluate = new Function('document', 'window', 'HTMLInputElement', `return ${FormRetainedValuesExpression}`);
    expect(evaluate({ querySelectorAll: () => [trigger] }, { __averyFormIdentities: { nodes: new Map([[trigger, 'doc:degree']]) } }, Input))
      .toEqual([{ nodeIdentity: 'doc:degree', value: '本科', truncated: false }]);
  });

  it('已正确的学历只核验，不产生重复选择操作', () => {
    const name = EncodedFormFieldPrefix + Buffer.from(JSON.stringify({ l: '学历', s: 'education', o: 0, j: 'doc:degree', t: 'feishu', v: true })).toString('base64url');
    const fields = FormFields({ e1: { role: 'combobox', name, currentValue: '本科', valueLength: 2 } }, 1);
    expect(fields[0]?.interaction.adapter).toBe('feishu');
    const service = new BrowserFormReviewService(), sources = { profiles: [{ id: 'edu', category: 'education', title: '教育经历', content: '[教育经历]\n学历：本科' }] };
    const preview = service.Plan(fields, sources, 1, 'https://example.jobs.feishu.cn/apply') as { continuationId: string; facts: Array<{ factId: string; field: string }> };
    const fact = preview.facts.find(f => f.field === 'degreeLevel')!;
    const plan = service.Compile(preview.continuationId, [{ fieldId: 'f1', factId: fact.factId }], fields, 2, 'https://example.jobs.feishu.cn/apply', 1);
    expect(plan.operations).toEqual([]);
    expect(plan.verifiedOperations).toHaveLength(1);
    service.RecordExecution(plan, 'https://example.jobs.feishu.cn/apply', []);
    expect(service.Validate(fields, 'https://example.jobs.feishu.cn/apply').businessValid).toBe(true);
  });

  it('候选动画未结束不暴露点击目标；稳定后仅返回当前字段的真实可用行', async () => {
    vi.useFakeTimers();
    const fixture = MenuFixture(); let completed = false;
    const result = fixture.run().then(value => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(200);
    expect(completed).toBe(false);
    expect(fixture.menu.children[0]!.hasAttribute('data-avery-dynamic-option')).toBe(false);
    fixture.settle(); await vi.advanceTimersByTimeAsync(60);
    expect(await result).toMatchObject({ ready: true, observedOptions: ['本科', '硕士'], optionsTruncated: false });
    expect(fixture.menu.children[0]!.getAttribute('aria-label')).toBe('本科');
    expect(fixture.menu.children[0]!.getAttribute('role')).toBe('option');
    expect(fixture.menu.children[0]!.hasAttribute('tabindex')).toBe(false);
  });

  it('菜单持续移动时有界失败，不返回可误点的候选', async () => {
    vi.useFakeTimers(); const fixture = MenuFixture(), result = fixture.run();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual({ ready: false, reason: 'menu_geometry_unstable' });
  });

  it('aria-controls 丢失时不扫描其他字段或整页候选', async () => {
    const fixture = MenuFixture(); fixture.trigger.setAttribute('aria-controls', 'other-menu');
    expect(await fixture.run()).toEqual({ ready: false, reason: 'menu_unavailable' });
  });

  it('多个同名学历字段按节点身份定位，不能拿第一条经历的菜单代替目标', async () => {
    vi.useFakeTimers(); const fixture = MenuFixture(), other = new Element();
    other.setAttribute('aria-controls', 'other-record-menu');
    fixture.triggers.unshift(other); fixture.identities.set(other, 'doc:other-degree'); fixture.settle();
    const result = fixture.run(); await vi.advanceTimersByTimeAsync(60);
    expect(await result).toMatchObject({ ready: true, observedOptions: ['本科', '硕士'] });
  });

  it('目标身份缺失时停止，不从同名字段中猜测目标', async () => {
    const run = new Function(`return ${FeishuSelectOptionsExpression({ ...operation, targetNodeIdentity: undefined })}`);
    expect(await run()).toEqual({ ready: false, reason: 'target_identity_unavailable' });
  });
});
