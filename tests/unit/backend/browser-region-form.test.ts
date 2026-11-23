import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeisenRegionOptionsExpression } from '../../../apps/backend/src/electron/backend/browser-region-form';
import { DynamicOptionMatch } from '../../../apps/backend/src/electron/backend/browser-form-driver';
import { FormFields, EncodedFormFieldPrefix } from '../../../apps/backend/src/electron/backend/browser-form-service';

class Element {
  isConnected=true;
  disabled=false;
  textContent='';
  readonly attributes=new Map<string,string>();
  readonly classList={contains:(_name:string)=>false};
  constructor(text=''){this.textContent=text;}
  getBoundingClientRect(){return {x:0,y:0,width:100,height:24};}
  getAttribute(key:string){return this.attributes.get(key)??null;}
  hasAttribute(key:string){return this.attributes.has(key);}
  setAttribute(key:string,value:string){this.attributes.set(key,value);}
  getAnimations(){return [];}
  querySelector(_selector:string):Element|null{return null;}
  querySelectorAll(_selector:string):Element[]{return [];}
}
function Fixture(){
  let rows:Element[]=[];
  const options:Element[]=[],radios:Element[]=[];
  const search=new Element(),confirmation=new Element('确定');
  const root=new Element();
  root.querySelectorAll=selector=>selector.includes('.area-item-container')?rows:selector.includes('.area-search-input')?[search]:selector.includes('.area-footer-button')?[confirmation]:[];
  const setRows=(labels:string[])=>{
    rows=labels.map(label=>{
      const row=new Element(label),text=new Element(label),radio=new Element();
      options.push(text);radios.push(radio);
      row.querySelector=selector=>selector==='.area-text-label'?text:selector.includes('.icon-container')?radio:null;
      return row;
    });
  };
  const run=(timeout=2000,roots=[root])=>runInNewContext(BeisenRegionOptionsExpression(timeout),{
    HTMLElement:Element,document:{querySelectorAll:()=>roots},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),Date,setTimeout,
  }) as Promise<{ready:boolean;reason?:string;scoped:boolean;observedOptions:string[]}>;
  return {run,setRows,options,radios,root,confirmation,search};
}
afterEach(()=>vi.useRealTimers());

describe('北森地区候选就绪与动作语义',()=>{
  it('Phoenix 字段的适配器身份进入正式字段模型，地区不是可自由录入的文本',()=>{
    const name=EncodedFormFieldPrefix+Buffer.from(JSON.stringify({l:'籍贯',t:'beisen',j:'doc:region'})).toString('base64url');
    expect(FormFields({e1:{role:'combobox',name}},1)[0].interaction).toMatchObject({adapter:'beisen',kind:'cascader',editable:false,requiresCommit:true});
  });
  it('弹层按钮先出现、地区列表晚到时等待真实选项，确认与搜索分别标记',async()=>{
    vi.useFakeTimers();
    const f=Fixture();let completed=false;
    const flight=f.run().then(result=>{completed=true;return result;});
    await vi.advanceTimersByTimeAsync(700);
    expect(completed).toBe(false);
    f.setRows(['广东省','湖南省']);
    await vi.advanceTimersByTimeAsync(160);
    expect(await flight).toMatchObject({ready:true,scoped:true,observedOptions:['广东省','湖南省']});
    expect(f.options[0].getAttribute('role')).toBe('button');
    expect(f.radios[0].getAttribute('role')).toBe('radio');
    expect(f.search.getAttribute('aria-label')).toBe('__avery_dynamic_search__');
    expect(f.confirmation.getAttribute('aria-label')).toBe('__avery_dynamic_confirmation__');
  });
  it('列表未加载不能把取消和确定当候选，超时有明确原因',async()=>{
    vi.useFakeTimers();const f=Fixture(),flight=f.run(120);
    await vi.advanceTimersByTimeAsync(160);
    expect(await flight).toMatchObject({ready:false,reason:'region_options_not_ready',observedOptions:[]});
    expect(f.confirmation.attributes.size).toBe(0);
  });
  it('多个地区弹层并存时拒绝跨菜单匹配',async()=>{
    const f=Fixture();f.setRows(['广东省']);
    expect(await f.run(0,[f.root,new Element()])).toMatchObject({ready:false,reason:'ambiguous_region_menus'});
    expect(f.options[0].attributes.size).toBe(0);
  });
  it('省份文字展开，目标城市用圆点选中，不能误选省份或继续展开区县',()=>{
    const refs={province:{role:'button',name:'广东省'},provinceRadio:{role:'radio',name:'广东省'}};
    expect(DynamicOptionMatch({refs},'nativePlace','广东佛山',new Set())).toMatchObject({ref:'@province',complete:false});
    const cities={city:{role:'button',name:'佛山市'},cityRadio:{role:'radio',name:'佛山市'}};
    expect(DynamicOptionMatch({refs:cities},'nativePlace','广东佛山',new Set())).toMatchObject({ref:'@cityRadio',complete:true});
  });
});
