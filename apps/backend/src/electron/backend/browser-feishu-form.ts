import type { FormFillOperation } from './browser-form-service';

/** 飞书 Select 的搜索 input 不是业务值；单选显示与学校标签均从同一控件的已选节点读取。 */
export const FeishuSelectValueScript = `
  const feishuSelectRoot = (element) => element.closest('.atsx-select');
  const feishuSelectedValue = (element) => {
    const root = feishuSelectRoot(element);
    if (!root) return undefined;
    return [...root.querySelectorAll('.atsx-select-selection-selected-value,.atsx-select-selection__choice__content')]
      .map(selected => String(selected.textContent || '').trim()).filter(Boolean).join(' ');
  };
`;

/** 一个 Select 只标记一个触发器；内部搜索框和嵌套包装层不能形成重复的档案目标。 */
export const FeishuSelectEnrichmentScript = `
  for (const root of document.querySelectorAll('.atsx-select')) {
    if (!(root instanceof HTMLElement) || !visibleForContext(root)) continue;
    const trigger = root.querySelector('.atsx-select-selection[role="combobox"]');
    if (!(trigger instanceof HTMLElement) || trigger.hasAttribute('data-avery-form-semantic')) continue;
    const label = rawExplicitLabel(root) || nearbyLabel(root);
    if (!label) continue;
    const value = feishuSelectedValue(trigger);
    const record = /^(education|project|career|internship)\\[(\\d+)\\]/.exec(root.id);
    const context = contextOf(root);
    const section = record ? ({education:'education',project:'project',career:'work',internship:'work'})[record[1]] : context.s;
    preserve(trigger,'aria-label');
    preserve(trigger,'role');
    trigger.setAttribute('aria-label',encodedName(trigger,label,true,{
      t:'feishu',v:Boolean(value),s:section,o:record ? Number(record[2]) : context.o,
      d:root.classList.contains('atsx-select-disabled') || trigger.getAttribute('aria-disabled') === 'true',
      u:Boolean(root.closest('.atsx-form-item')?.querySelector('.atsx-form-item-required')),
    }));
    trigger.setAttribute('data-avery-form-semantic','custom-select');
    trigger.setAttribute('data-avery-form-key',canonicalKey(label));
    trigger.setAttribute('data-avery-form-section',section || '');
    trigger.setAttribute('data-avery-form-label',label);
    if (record) trigger.setAttribute('data-avery-form-record',record[2]);
    for (const input of root.querySelectorAll('input')) {
      if (input.hasAttribute('data-avery-form-semantic')) continue;
      preserve(input,'aria-label');
      input.setAttribute('aria-label','__avery_internal_form_control__');
      input.setAttribute('data-avery-form-semantic','auxiliary');
    }
  }
`;

/** 仅观察本字段 aria-controls 指向的真实菜单；缩放动画会使旧坐标落到相邻学历项。 */
export function FeishuSelectOptionsExpression(operation: FormFillOperation): string {
  return `(async () => {
    const identity = ${JSON.stringify(operation.targetNodeIdentity)};
    if (typeof identity !== 'string' || !identity) return {ready:false,reason:'target_identity_unavailable'};
    const trigger = [...document.querySelectorAll('[data-avery-form-semantic="custom-select"]')]
      .find(element => window.__averyFormIdentities?.nodes.get(element) === identity && element.closest('.atsx-select'));
    const menu = trigger && document.getElementById(trigger.getAttribute('aria-controls') || '');
    const popup = menu?.closest('.atsx-select-dropdown');
    const visible = element => {
      if (!(element instanceof HTMLElement) || !element.isConnected) return false;
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden';
    };
    if (!visible(popup) || !visible(menu)) return {ready:false,reason:'menu_unavailable'};
    let previous, stable=0;
    const stopAt=Date.now()+1500;
    while (Date.now()<stopAt) {
      if (!visible(popup) || !trigger.isConnected) return {ready:false,reason:'menu_changed'};
      const rect=popup.getBoundingClientRect();
      const geometry=[rect.x,rect.y,rect.width,rect.height];
      const animating=popup.getAnimations({subtree:true}).some(animation=>animation.playState==='running' || animation.pending);
      stable=!animating && previous && geometry.every((value,index)=>Math.abs(value-previous[index])<0.5) ? stable+1 : 0;
      if (stable>=2) break;
      previous=geometry;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if (stable<2) return {ready:false,reason:'menu_geometry_unstable'};
    const labels=[];
    for (const element of menu.querySelectorAll('li[role="option"]')) {
      if (!visible(element) || element.getAttribute('aria-disabled')==='true' || element.classList.contains('atsx-select-dropdown-menu-item-disabled')) continue;
      const label=String(element.textContent || '').replace(/\\s+/g,' ').trim();
      if (!label) continue;
      element.setAttribute('data-avery-dynamic-option','1');
      for (const attribute of ['role','aria-label','tabindex']) {
        const suffix=attribute==='aria-label'?'label':attribute;
        element.setAttribute('data-avery-option-had-'+suffix,element.hasAttribute(attribute)?'1':'0');
        element.setAttribute('data-avery-option-'+suffix,element.getAttribute(attribute)||'');
      }
      element.setAttribute('aria-label',label.slice(0,120));
      labels.push(label.slice(0,120));
    }
    return {ready:true,observedOptions:[...new Set(labels)].slice(0,40),optionsTruncated:labels.length>40};
  })()`;
}
