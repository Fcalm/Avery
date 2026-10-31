import { BrowserDateAdapters } from './browser-date-adapters';
import type { FormFillOperation } from './browser-form-service';

/** Moka 的 input 常只是搜索词；已选项位于 display span，年月范围则由两组独立下拉组成。 */
export const MokaFormValueScript = `
  const moka = ${JSON.stringify(BrowserDateAdapters.moka)};
  const mokaSelectedValue = (element) => {
    if (element.parentElement?.matches(moka.range) && element.tagName === 'SPAN') {
      const values = [...element.querySelectorAll(moka.select)].map((select) => String(select.querySelector(moka.display)?.textContent || '').trim());
      return values.length === 2 && /^\\d{4}$/.test(values[0]) && /^\\d{1,2}$/.test(values[1])
        ? values[0] + '-' + values[1].padStart(2, '0') : '';
    }
    if (element.matches(moka.select)) return String(element.querySelector(moka.display)?.textContent || '').trim();
    const value = String(element.querySelector('input')?.value || '');
    return element.matches(moka.dayField) ? value.replace(/\\s*[（(]\\d+岁[）)]$/, '') : value;
  };
`;

/** 复用表单检查器的编码与恢复边界，仅补充 Moka 控件的确定语义，不改写网站业务值。 */
export const MokaFormEnrichmentScript = `
  ${MokaFormValueScript}
  const mokaContext = (element) => {
    const block = element.closest(moka.block);
    const heading = text(block?.querySelector(':scope > ' + moka.blockTitle));
    const group = element.closest(moka.record);
    const groups = block ? [...block.querySelectorAll(':scope > ' + moka.record)] : [];
    return { s: sectionLabel(heading), g: heading, o: Math.max(0, groups.indexOf(group)), x: [], r: [], f: [] };
  };
  const mokaMark = (element, label, custom) => {
    if (element.hasAttribute('data-avery-form-semantic')) return;
    preserve(element, 'aria-label');
    if (custom) { preserve(element, 'role'); element.setAttribute('role', 'combobox'); }
    element.setAttribute('aria-label', encodedName(element, label, true, {
      ...mokaContext(element), v: custom ? Boolean(mokaSelectedValue(element)) : String(element.value || '').trim().length > 0,
      t: 'moka',
      d: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.querySelector('input:disabled,select:disabled')),
    }));
    element.setAttribute('data-avery-form-semantic', custom ? 'custom-select' : 'label');
    element.setAttribute('data-avery-form-key', canonicalKey(label));
    element.setAttribute('data-avery-form-label', label);
    element.setAttribute('data-avery-form-record', String(mokaContext(element).o));
    element.setAttribute('data-avery-form-section', /毕业|最高学历|最近毕业专业/.test(label) ? 'education' : mokaContext(element).s);
  };
  const mokaAuxiliary = (element) => {
    if (element.hasAttribute('data-avery-form-semantic')) return;
    preserve(element, 'aria-label');
    element.setAttribute('aria-label', '__avery_internal_form_control__');
    element.setAttribute('data-avery-form-semantic', 'auxiliary');
  };
  for (const field of document.querySelectorAll(moka.field)) {
    if (dateAdapterFor(field) !== 'moka') continue;
    const rawTitle = text(field.querySelector(':scope > ' + moka.title)).replace(/[*＊]|[（(]必填[）)]/g, '').trim();
    if (!rawTitle) continue;
    const range = field.querySelector(moka.range);
    if (range) {
      const edges = [...range.children].filter((child) => child.tagName === 'SPAN' && child.querySelectorAll(moka.select).length === 2);
      if (edges.length === 2) edges.forEach((edge, index) => mokaMark(edge, index === 0 ? '开始时间' : '结束时间', true));
      for (const input of range.querySelectorAll('input')) mokaAuxiliary(input);
      continue;
    }
    const selects = [...field.querySelectorAll(moka.select)];
    for (const select of selects) {
      // 国家区号和证件类型不能被误当作手机号或证件号码；同一复合字段保留实际文本输入。
      const auxiliary = /手机号码|证件号码/.test(rawTitle) && field.querySelectorAll('input').length > 1;
      if (!auxiliary) mokaMark(select, rawTitle, true);
      else mokaAuxiliary(select);
      for (const input of select.querySelectorAll('input')) mokaAuxiliary(input);
    }
    const day = field.querySelector(moka.dayField);
    if (day) { mokaMark(day, rawTitle, true); for (const input of day.querySelectorAll('input')) mokaAuxiliary(input); }
    for (const input of field.querySelectorAll('input,textarea,select')) {
      if (input.hasAttribute('data-avery-form-semantic') || ['file', 'checkbox', 'radio', 'password', 'hidden'].includes(input.type)) continue;
      mokaMark(input, rawTitle, false);
    }
  }
`;

/** 为当前搜索菜单补齐候选引用；不将搜索词或“添加自定义值”按钮当成已选项。 */
export const MokaOptionEnrichmentScript = `
  for (const root of document.querySelectorAll(${JSON.stringify(BrowserDateAdapters.moka.menu)})) {
    if (!(root instanceof HTMLElement) || !visible(root)) continue;
    roots.add(root);
    for (const element of root.querySelectorAll(${JSON.stringify(BrowserDateAdapters.moka.option)})) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      if (element.querySelector(${JSON.stringify(BrowserDateAdapters.moka.option)})) continue;
      const label = String(element.querySelector('[data-key="sugar.select.label"],[class*="sd-Menu-content-item-"] > div:first-child')?.textContent || element.innerText || '').trim();
      if (label && label.length <= 80 && element.getAttribute('aria-disabled') !== 'true' && !/disabled/i.test(element.className)) candidateText.set(element, label);
    }
  }
  const search = document.activeElement;
  if (search instanceof HTMLInputElement && !search.readOnly && !search.disabled && search.closest(${JSON.stringify(BrowserDateAdapters.moka.select)}) && !search.hasAttribute('data-avery-dynamic-search')) {
    search.setAttribute('data-avery-dynamic-search', '1');
    for (const attribute of ['role', 'aria-label', 'tabindex']) {
      const suffix = attribute === 'aria-label' ? 'label' : attribute;
      search.setAttribute('data-avery-option-had-' + suffix, search.hasAttribute(attribute) ? '1' : '0');
      search.setAttribute('data-avery-option-' + suffix, search.getAttribute(attribute) || '');
    }
    search.setAttribute('role', 'textbox'); search.setAttribute('aria-label', '__avery_dynamic_search__');
  }
`;

/** 搜索候选异步返回；只等待目标真实候选，不重发搜索，也不把当前搜索词视作成功。 */
export function MokaSearchOptionsWaitExpression(value: string, timeoutMs: number): string {
  return `new Promise((resolve) => {
    const moka = ${JSON.stringify(BrowserDateAdapters.moka)};
    const ready = () => [...document.querySelectorAll(moka.menu)].some((menu) => menu.getBoundingClientRect().height > 0
      && [...menu.querySelectorAll(moka.option)].some((element) => !element.querySelector(moka.option)
        && !/disabled/i.test(element.className) && element.getAttribute('aria-disabled') !== 'true'
        && String(element.querySelector('[data-key="sugar.select.label"],[class*="sd-Menu-content-item-"] > div:first-child')?.textContent || element.textContent || '').trim() === ${JSON.stringify(value)}));
    if (ready()) { resolve({ ready: true }); return; }
    const observer = new MutationObserver(() => { if (ready()) finish(true); });
    const finish = (ready) => { observer.disconnect(); clearTimeout(timer); resolve({ ready }); };
    const timer = setTimeout(() => finish(false), ${Math.max(0, Math.floor(timeoutMs))});
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'aria-disabled'] });
  })`;
}

/** 锁定当前日期端点，后续快照只暴露该端点的年、月入口，避免同页四个下拉串位。 */
export function MokaDatePreparationExpression(operation: FormFillOperation): string {
  return `(() => {
    ${MokaFormValueScript}
    for (const element of document.querySelectorAll('[data-avery-moka-active-date]')) element.removeAttribute('data-avery-moka-active-date');
    const candidates = [...document.querySelectorAll('[data-avery-form-semantic="custom-select"]')].filter((element) =>
      element.getAttribute('data-avery-form-key') === ${JSON.stringify(operation.key)}
      && element.getAttribute('data-avery-form-label') === ${JSON.stringify(operation.label)}
      && (${operation.targetRecordIndex === undefined} || element.getAttribute('data-avery-form-record') === ${JSON.stringify(String(operation.targetRecordIndex))})
      && element.getAttribute('data-avery-form-section') === ${JSON.stringify(operation.concept.split('.')[0])});
    const target = candidates[${operation.targetRecordIndex === undefined ? operation.targetOccurrence ?? 0 : 0}];
    if (!(target instanceof HTMLElement)) return { found: false };
    target.setAttribute('data-avery-moka-active-date', '1');
    return { found: true, range: Boolean(target.parentElement?.matches(moka.range)) };
  })()`;
}

/** 表单目标可能正好被固定页头遮挡；先滚动已确定的字段，再由快照建立可点击引用。 */
export function MokaFormTargetRevealExpression(operation: FormFillOperation): string {
  return `(() => {
    const candidates = [...document.querySelectorAll('[data-avery-form-semantic="custom-select"]')].filter((element) =>
      element.getAttribute('data-avery-form-key') === ${JSON.stringify(operation.key)}
      && element.getAttribute('data-avery-form-label') === ${JSON.stringify(operation.label)}
      && element.getAttribute('data-avery-form-section') === ${JSON.stringify(operation.concept.split('.')[0])}
      && (${operation.targetRecordIndex === undefined} || element.getAttribute('data-avery-form-record') === ${JSON.stringify(String(operation.targetRecordIndex))}));
    const target = candidates[${operation.targetRecordIndex === undefined ? operation.targetOccurrence ?? 0 : 0}];
    if (!(target instanceof HTMLElement)) return { found: false };
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return { found: true };
  })()`;
}

export const MokaDateControlsScript = `
  const mokaDateTarget = document.querySelector('[data-avery-moka-active-date]');
  if (mokaDateTarget?.parentElement?.matches(dateAdapters.moka.range)) {
    const controls = [...mokaDateTarget.querySelectorAll(dateAdapters.moka.select)];
    if (controls.length === 2) controls.forEach((control, index) => {
      if (annotate(control, 'button', index === 0 ? '__avery_moka_year_control__' : '__avery_moka_month_control__')) annotated += 1;
    });
  }
  for (const menu of document.querySelectorAll(dateAdapters.moka.menu)) {
    if (!(menu instanceof HTMLElement) || !visible(menu) || !mokaDateTarget) continue;
    for (const option of menu.querySelectorAll(dateAdapters.moka.option)) {
      if (option.querySelector(dateAdapters.moka.option) || /disabled/i.test(option.className) || option.getAttribute('aria-disabled') === 'true') continue;
      const label = text(option).replace(/[年月]/g, '');
      const prefix = /^\\d{4}$/.test(label) ? '__avery_date_year_option__:' : /^\\d{1,2}$/.test(label) && Number(label) >= 1 && Number(label) <= 12 ? '__avery_date_month_option__:' : '';
      if (prefix && annotate(option, 'option', prefix + Number(label))) annotated += 1;
    }
  }
  for (const panel of document.querySelectorAll(dateAdapters.moka.calendar)) {
    if (!(panel instanceof HTMLElement) || !visible(panel) || !mokaDateTarget) continue;
    // 出生日期实际只精确到年月，选月就会写回，并在输入框附加年龄。
    if (annotate(panel, 'group', '__avery_date_month_only__')) annotated += 1;
    const header = panel.querySelector('[class*="sd-basic-selector-year-"]');
    const label = text(header);
    if (/^\\d{4}年$/.test(label)) {
      if (annotate(header, 'button', '__avery_date_year_header__:' + Number(label.slice(0, 4)))) annotated += 1;
    } else {
      const decade = label.match(/^(\\d{4})-(\\d{4})$/);
      if (decade && annotate(header, 'group', '__avery_moka_decade__:' + decade[1] + ':' + decade[2])) annotated += 1;
    }
    for (const [selector, name] of [['[class*="sd-Icon-icondoubleLeft-"]', '__avery_moka_previous_years__'], ['[class*="sd-Icon-icondoubleRight-"]', '__avery_moka_next_years__']]) {
      const icon = panel.querySelector(selector);
      if (icon && annotate(icon, 'button', name)) annotated += 1;
    }
    for (const item of panel.querySelectorAll('[class*="sd-basic-year-item-"]')) {
      if (item.closest('[class*="sd-basic-disabled-"]') || item.getAttribute('aria-disabled') === 'true') continue;
      const value = text(item), month = monthNumber(value);
      const prefix = /^\\d{4}$/.test(value) ? '__avery_date_year_option__:' : month ? '__avery_date_month_option__:' : '';
      if (prefix && annotate(item, 'option', prefix + (month || Number(value)))) annotated += 1;
    }
  }
`;

/** 仅滚动已观察到的日期菜单，不改变选中值，也不绕过后续点击的遮挡检查。 */
export function MokaDateOptionRevealExpression(value: number): string {
  return `(() => {
    const moka = ${JSON.stringify(BrowserDateAdapters.moka)};
    for (const menu of document.querySelectorAll(moka.menu)) {
      if (!(menu instanceof HTMLElement) || menu.getBoundingClientRect().height <= 0) continue;
      const option = [...menu.querySelectorAll(moka.option)].find((element) => !element.querySelector(moka.option)
        && Number(element.textContent.trim().replace(/[年月]/g, '')) === ${value});
      const list = option?.closest(moka.scrollable);
      if (option && list) { const rect = option.getBoundingClientRect(), bounds = list.getBoundingClientRect(); list.scrollTop += rect.top - bounds.top - (list.clientHeight - rect.height) / 2; }
    }
    return { revealed: true };
  })()`;
}
