import { DynamicOptionPrefix } from './browser-form-service';

/** 北森地区菜单延迟加载且文字与圆点动作不同；仅在唯一、稳定的地区面板内暴露真实候选。 */
export function BeisenRegionOptionsExpression(timeoutMs: number): string {
  return `(async () => {
    const visible = element => {
      if (!(element instanceof HTMLElement) || !element.isConnected) return false;
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity||1)>0;
    };
    const until=Date.now()+${Math.max(0, Math.min(8_000, Math.trunc(timeoutMs)))};
    let root, previous='', stable=0;
    do {
      const roots=[...document.querySelectorAll('.area-selector-container')].filter(visible);
      if (roots.length>1) return {ready:false,scoped:true,reason:'ambiguous_region_menus',observedOptions:[]};
      root=roots[0];
      const rows=root ? [...root.querySelectorAll('.area-data-container .area-item-container')].filter(visible) : [];
      const signature=JSON.stringify(rows.map(row=>{
        const rect=row.getBoundingClientRect();
        return [row.querySelector('.area-text-label')?.textContent?.trim(),rect.x,rect.y,rect.width,rect.height];
      }));
      const busy=root?.getAttribute('aria-busy')==='true' || Boolean(root?.querySelector('[role="progressbar"],[aria-busy="true"]'));
      const animating=root?.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending);
      stable=rows.length && !busy && !animating && previous===signature ? stable+1 : 0;
      previous=signature;
      if(stable>=2) break;
      if(Date.now()>=until) return {ready:false,scoped:true,reason:'region_options_not_ready',observedOptions:[]};
      await new Promise(resolve=>setTimeout(resolve,40));
    }while(true);
    const mark=(element,label,role)=>{
      if(!visible(element) || element.getAttribute('aria-disabled')==='true' || element.hasAttribute('disabled')) return;
      element.setAttribute('data-avery-dynamic-option','1');
      for(const attribute of ['role','aria-label','tabindex']) {
        const suffix=attribute==='aria-label'?'label':attribute;
        element.setAttribute('data-avery-option-had-'+suffix,element.hasAttribute(attribute)?'1':'0');
        element.setAttribute('data-avery-option-'+suffix,element.getAttribute(attribute)||'');
      }
      element.setAttribute('role',role);element.setAttribute('tabindex','0');
      element.setAttribute('aria-label',label==='__avery_dynamic_confirmation__'?label:${JSON.stringify(DynamicOptionPrefix)}+label);
    };
    const labels=[];
    for(const row of [...root.querySelectorAll('.area-data-container .area-item-container')].filter(visible).slice(0,300)) {
      if(row.getAttribute('aria-disabled')==='true'||row.classList.contains('disabled')) continue;
      const text=row.querySelector('.area-text-label'),label=String(text?.textContent||'').trim();
      if(!label||label.length>120) continue;
      // 文字用于进入下一层，圆点用于选中当前层；同一候选保留两个独立动作。
      mark(text,label,'button');
      const radio=row.querySelector('.icon-container.visible,[role="radio"],input[type="radio"]');
      if(radio) mark(radio,label,'radio');
      labels.push(label);
    }
    for(const element of root.querySelectorAll('.area-footer-button button,.area-footer-button [role="button"],.area-footer-button .phoenix-button')) {
      if(/^(确定|确认|完成)$/.test(String(element.textContent||'').trim()) && !element.disabled && !element.classList.contains('disabled') && !element.querySelector('[class*="disabled"]')) mark(element,'__avery_dynamic_confirmation__','button');
    }
    const searches=[...root.querySelectorAll('.area-search-input input')].filter(visible);
    if(searches.length===1) {
      const search=searches[0];
      search.setAttribute('data-avery-dynamic-search','1');
      for(const attribute of ['role','aria-label','tabindex']) {
        const suffix=attribute==='aria-label'?'label':attribute;
        search.setAttribute('data-avery-option-had-'+suffix,search.hasAttribute(attribute)?'1':'0');
        search.setAttribute('data-avery-option-'+suffix,search.getAttribute(attribute)||'');
      }
      search.setAttribute('role','textbox');search.setAttribute('aria-label','__avery_dynamic_search__');
    }
    return {ready:true,scoped:true,observedOptions:[...new Set(labels)].slice(0,40),optionsTruncated:labels.length>40};
  })()`;
}
