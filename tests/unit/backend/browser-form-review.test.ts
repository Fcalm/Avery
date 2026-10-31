import { describe, expect, it } from 'vitest';
import { BuildFormFacts, FormFields, type FormField } from '../../../apps/backend/src/electron/backend/browser-form-service';
import { BrowserFormReviewService, OperationValueMatches } from '../../../apps/backend/src/electron/backend/browser-form-review';
import { BrowserFormDriver, DynamicOptionMatch, FormRetainedValuesExpression } from '../../../apps/backend/src/electron/backend/browser-form-driver';

const url = 'https://example.com/apply';
const fields = () => FormFields({
  e1: { role: 'textbox', name: '姓名', currentValue: '', valueLength: 0, nodeIdentity: 'doc:1' },
  e2: { role: 'textbox', name: '紧急联系电话', currentValue: '', valueLength: 0, nodeIdentity: 'doc:2' },
  e3: { role: 'textbox', name: '实践名称', section: '在校实践', currentValue: '', valueLength: 0, recordIndex: 0, nodeIdentity: 'doc:3' },
  e4: { role: 'textbox', name: '实践描述', section: '在校实践', currentValue: '', valueLength: 0, recordIndex: 0, nodeIdentity: 'doc:4' },
}, 1);
const sources = { resume: { id: 'r1', name: '求职简历', content: '**范炜乾** | 13724908557 | test@example.com\n\n## 项目经历\n\n### Avery\n\n项目简介：为求职提供辅助的应用。\n\n### Agentic RAG\n\n项目简介：企业知识问答助手。' } };
type Preview = { continuationId: string; fields: Array<{fieldId: string; label: string; suggestedFactId?: string}>; facts: Array<{factId: string; concept: string; value: string}>; sources: Array<{sourceId: string}> };
function Preview(service: BrowserFormReviewService, f = fields(), s: Record<string, unknown> = sources): Preview {
  return service.Plan(f, s, 0, url) as Preview;
}

describe('表单事实提取与填写前审阅', () => {
  it('同一学历和结束年月可以同时填写个人教育汇总与同一条教育经历', () => {
    const service = new BrowserFormReviewService();
    const f = FormFields({
      e1: {role:'combobox',name:'最高学历',recordIdentity:'summary',nodeIdentity:'doc:1'},
      e2: {role:'combobox',name:'毕业时间',recordIdentity:'summary',nodeIdentity:'doc:2'},
      e3: {role:'combobox',name:'学历',section:'教育经历',recordIndex:0,recordIdentity:'education:0',nodeIdentity:'doc:3'},
      e4: {role:'combobox',name:'结束时间',section:'教育经历',recordIndex:0,recordIdentity:'education:0',nodeIdentity:'doc:4'},
    },1);
    const p = Preview(service,f,{profiles:[{id:'edu',category:'education',title:'教育经历',content:'[教育经历]\n学历：本科\n结束时间：2027-06'}]});
    const degree = p.facts.find(f=>f.concept==='education.degreeLevel')!.factId;
    const end = p.facts.find(f=>f.concept==='education.endDate')!.factId;
    expect(service.Compile(p.continuationId,[{fieldId:'f1',factId:degree},{fieldId:'f2',factId:end},{fieldId:'f3',factId:degree},{fieldId:'f4',factId:end}],f,1,url,2).operations).toHaveLength(4);
  });

  it('同一记录的重复展示可以复用事实，不能复制到另一条教育经历；拒绝信息包含目标字段', () => {
    const service=new BrowserFormReviewService();
    const f=FormFields({
      e1:{role:'textbox',name:'学校名称',section:'教育经历',recordIndex:0,recordIdentity:'education:0'},
      e2:{role:'textbox',name:'学校名称',section:'教育经历',recordIndex:0,recordIdentity:'education:0'},
      e3:{role:'textbox',name:'学校名称',section:'教育经历',recordIndex:1,recordIdentity:'education:1'},
    },1);
    const p=Preview(service,f,{profiles:[{id:'edu',category:'education',title:'教育经历',content:'[教育经历]\n学校名称：南昌大学'}]});
    const factId=p.facts[0].factId;
    expect(()=>service.Compile(p.continuationId,[{fieldId:'f1',factId},{fieldId:'f3',factId}],f,1,url,2)).toThrow(/f3.*学校名称.*multiple records/);
    expect(service.Compile(p.continuationId,[{fieldId:'f1',factId},{fieldId:'f2',factId}],f,1,url,2).operations).toHaveLength(2);
  });

  it.each([
    {label:'毕业时间',source:'2027-06',actual:'2027-06-01',matched:true},
    {label:'毕业时间',source:'2027-06',actual:'2027年6月30日',matched:true},
    {label:'毕业时间',source:'2027-06',actual:'2027-07-01',matched:false},
    {label:'出生日期',source:'2000-06-15',actual:'2000-06-01',matched:false},
    {label:'毕业时间',source:'2027-06',actual:'2027-06-01 另一个日期',matched:false},
    {label:'学习形式',source:'统招全日制',actual:'全国普通高等院校全日制',matched:true},
    {label:'学习形式',source:'统招全日制',actual:'全国普通高等院校非全日制',matched:false},
    {label:'到岗时间',source:'1周内',actual:'一周内',matched:true},
    {label:'到岗时间',source:'1周内',actual:'一个月内',matched:false},
  ])('按来源日期精度和有限同义值核验，不接受错月或不同含义：%j', row => {
    const f=FormFields({e1:{role:'combobox',name:row.label,currentValue:'',nodeIdentity:'doc:value'}},1);
    const category=row.label==='到岗时间'?'job_intention':row.label==='出生日期'?'application':'education';
    const heading=category==='job_intention'?'求职意向':category==='application'?'个人信息':'教育经历';
    const service=new BrowserFormReviewService(),p=Preview(service,f,{profiles:[{id:'p1',category,title:'资料',content:`[${heading}]\n${row.label}：${row.source}`}]});
    const plan=service.Compile(p.continuationId,[{fieldId:'f1',factId:p.facts[0].factId}],f,1,url,2);
    service.RecordExecution(plan,url,plan.operations);
    f[0].currentValue=row.actual;
    expect(service.Validate(f,url).businessValid).toBe(row.matched);
  });

  it.each([['1周内','custom_select'],['2027-06-01','custom_date']])('到岗时间 %s 根据实际来源值选择控件流程', (value,kind) => {
    const service=new BrowserFormReviewService(),f=FormFields({e1:{role:'combobox',name:'到岗时间'}},1);
    const p=Preview(service,f,{profiles:[{id:'p',category:'job_intention',content:`[求职意向]\n到岗时间：${value}`}]});
    expect(service.Compile(p.continuationId,[{fieldId:'f1',factId:p.facts[0].factId}],f,1,url,2).operations[0].kind).toBe(kind);
  });

  it('原生与自定义下拉使用相同的同义匹配，不把非全日制当成全日制', () => {
    const service=new BrowserFormReviewService(),f=FormFields({e1:{role:'combobox',tag:'select',name:'学习形式',options:[{label:'全国普通高等院校全日制',value:'full'},{label:'全国普通高等院校非全日制',value:'part'}]}},1);
    const p=Preview(service,f,{profiles:[{id:'edu',category:'education',content:'[教育经历]\n学习形式：统招全日制'}]});
    expect(service.Compile(p.continuationId,[{fieldId:'f1',factId:p.facts[0].factId}],f,1,url,2).operations[0]).toMatchObject({kind:'select',value:'full',expectedValue:'全国普通高等院校全日制'});
    const refs={e1:{role:'option',name:'全国普通高等院校非全日制'},e2:{role:'option',name:'全国普通高等院校全日制'}};
    expect(DynamicOptionMatch({refs},'educationType','统招全日制',new Set())?.ref).toBe('@e2');
    expect(DynamicOptionMatch({refs:{e1:refs.e1}},'educationType','统招全日制',new Set())).toBeUndefined();
    expect(DynamicOptionMatch({refs:{e3:{role:'option',name:'一周内'}}},'availability','1周内',new Set())?.ref).toBe('@e3');
  });

  it('多个实际选项同义但枚举值不同时仍要求澄清，不取第一个', () => {
    const service=new BrowserFormReviewService();
    const f=FormFields({e1:{role:'combobox',tag:'select',name:'学习形式',options:[{label:'统招全日制',value:'a'},{label:'全国普通高等院校全日制',value:'b'}]}},1);
    const p=Preview(service,f,{profiles:[{id:'edu',category:'education',content:'[教育经历]\n学习形式：统招全日制'}]});
    expect(()=>service.Compile(p.continuationId,[{fieldId:'f1',factId:p.facts[0].factId}],f,1,url,2)).toThrow(/f1.*学习形式.*Multiple observed options/);
  });

  it('项目描述等普通正文不套用日期或枚举宽松比较', () => {
    const service=new BrowserFormReviewService(),p=Preview(service);
    const plan=service.Compile(p.continuationId,[{fieldId:'f4',sourceId:p.sources[0].sourceId,quote:'项目简介：为求职提供辅助的应用。',value:'为求职提供辅助的应用。',field:'projectDescription'}],fields(),1,url,2);
    expect(OperationValueMatches({...fields()[3],currentValue:'2027-06-01'}, {...plan.operations[0],value:'2027-06',expectedValue:'2027-06'})).toBe(false);
  });

  it('明确标题不被邻居替换，最高学位与最高学历保持不同语义', () => {
    const result=FormFields({e1:{role:'combobox',name:'成绩排名',section:'教育经历',nearbyTexts:['学校名称','专业名称']},e2:{role:'combobox',name:'最高学位',nearbyTexts:['最高学历']}},1);
    expect(result[0].semantic.concept).toBe('unknown');
    expect(result[1].semantic.concept).toBe('education.degree');
  });

  it('长描述独立回读，500字符快照截断不能导致误报成功或损坏字段身份', async () => {
    const value='项目事实。'.repeat(400);
    const name='__avery_field__'+Buffer.from(JSON.stringify({l:'实践描述',s:'project',j:'doc:long'})).toString('base64url');
    const driver=new BrowserFormDriver({pageRevision:()=>1,delay:async()=>{},runCommand:async args=>{
      if(args[0]==='snapshot')return {success:true,data:{refs:{e1:{role:'textbox',name,value:value.slice(0,500),valueLength:value.length,valueTruncated:true}}}};
      const expression=args[0]==='eval'?Buffer.from(args[2],'base64').toString():'';
      return {success:true,data:{result:expression===FormRetainedValuesExpression?[{nodeIdentity:'doc:long',value,truncated:false}]:{}}};
    }});
    const result=await driver.InspectForm({});
    expect(FormFields(result.data?.refs as Record<string,unknown>,1)[0]).toMatchObject({nodeIdentity:'doc:long',currentValue:value});
    expect(name.length).toBeLessThan(4096);
    expect(()=>new Function(FormRetainedValuesExpression)).not.toThrow();
  });
  it('真实简历开头粗体姓名不会被后续章节标题替代', () => {
    expect(BuildFormFacts(sources).facts.find(f => f.key === 'name')?.value).toBe('范炜乾');
    expect(BuildFormFacts({ resume: { content: '## 项目经历\n### Avery\n项目简介：测试' } }).facts.some(f => f.key === 'name')).toBe(false);
    expect(BuildFormFacts({ resume: { content: '# 个人简历\n姓名：张三' } }).facts.filter(f => f.key === 'name').map(f => f.value)).toEqual(['张三']);
  });

  it('不会从紧急联系人号码补造本人电话，字段也不会匹配到本人phone', () => {
    const facts = BuildFormFacts({ resume: { content: '# 张三\n紧急联系电话：13800138000' } }).facts;
    expect(facts.some(f => f.key === 'phone')).toBe(false);
    const service = new BrowserFormReviewService(), preview = Preview(service);
    const phone = preview.facts.find(f => f.concept === 'personal.phone')!;
    expect(fields()[1].semantic.concept).toBe('personal.emergencyContactPhone');
    expect(() => service.Compile(preview.continuationId, [{fieldId:'f2',factId:phone.factId}], fields(),1,url,2)).toThrow(/concepts differ/);
  });

  it('不执行任何隐式匹配；只编译Agent显式选择的字段，且计划不可重放', () => {
    const service = new BrowserFormReviewService(), p = Preview(service);
    const name = p.facts.find(f => f.concept === 'personal.name')!;
    const plan = service.Compile(p.continuationId,[{fieldId:'f1',factId:name.factId}],fields(),1,url,2);
    expect(plan.operations).toMatchObject([{ref:'@e1',value:'范炜乾',strategy:'agent',sourceTitle:'求职简历'}]);
    expect(() => service.Compile(p.continuationId,[],fields(),2,url,2)).toThrow(/already executed/);
  });

  it('续填规划保留来源ID，不重复发送正文；重新选择来源可恢复正文', () => {
    const service=new BrowserFormReviewService(),p=Preview(service);
    const next=service.Plan(fields(),undefined,1,url,p.continuationId) as {sources:Array<{sourceId:string;content?:string;contentUnchanged?:boolean}>};
    expect(next.sources[0]).toMatchObject({sourceId:p.sources[0].sourceId,contentUnchanged:true});
    expect(next.sources[0].content).toBeUndefined();
    const fresh=service.Plan(fields(),sources,2,url) as {sources:Array<{content?:string}>};
    expect(fresh.sources[0].content).toContain('范炜乾');
  });

  it('自由格式项目从精确原文提取，保留资料来源而非冒充用户补充', () => {
    const service = new BrowserFormReviewService(), p = Preview(service);
    const plan = service.Compile(p.continuationId,[{fieldId:'f4',sourceId:p.sources[0].sourceId,quote:'项目简介：为求职提供辅助的应用。',value:'为求职提供辅助的应用。',field:'projectDescription'}],fields(),1,url,2);
    expect(plan.operations[0]).toMatchObject({value:'为求职提供辅助的应用。',sourceTitle:'求职简历',concept:'project.description'});
    expect(plan.operations[0].sourcePath).toMatch(/^agent\.d1\./);
  });

  it('同一条实践的名称和描述不能来自两个不同项目，失败前不消费计划', () => {
    const service=new BrowserFormReviewService(),p=Preview(service),sourceId=p.sources[0].sourceId;
    expect(()=>service.Compile(p.continuationId,[{fieldId:'f3',sourceId,quote:'### Avery',value:'Avery',field:'projectName'},{fieldId:'f4',sourceId,quote:'项目简介：企业知识问答助手。',value:'企业知识问答助手。',field:'projectDescription'}],fields(),1,url,2)).toThrow(/same source record/);
    expect(service.Compile(p.continuationId,[{fieldId:'f3',sourceId,quote:'### Avery',value:'Avery',field:'projectName'},{fieldId:'f4',sourceId,quote:'项目简介：为求职提供辅助的应用。',value:'为求职提供辅助的应用。',field:'projectDescription'}],fields(),2,url,2).operations).toHaveLength(2);
  });

  it('跨批次保留已执行记录的来源绑定，未执行的审阅不会提前绑定', () => {
    const service=new BrowserFormReviewService(),p=Preview(service),sourceId=p.sources[0].sourceId;
    const first=service.Compile(p.continuationId,[{fieldId:'f3',sourceId,quote:'### Avery',value:'Avery',field:'projectName'}],fields(),1,url,2);
    service.RecordExecution(first,url,first.operations);
    const next=service.Plan(fields(),undefined,2,url,p.continuationId) as Preview;
    expect(()=>service.Compile(next.continuationId,[{fieldId:'f4',sourceId,quote:'项目简介：企业知识问答助手。',value:'企业知识问答助手。',field:'projectDescription'}],fields(),3,url,3)).toThrow(/same source record/);
    const other=new BrowserFormReviewService(),draft=Preview(other);
    other.Compile(draft.continuationId,[{fieldId:'f3',sourceId,quote:'### Avery',value:'Avery',field:'projectName'}],fields(),1,url,2);
    const clean=other.Plan(fields(),undefined,2,url,draft.continuationId) as Preview;
    expect(other.Compile(clean.continuationId,[{fieldId:'f4',sourceId,quote:'项目简介：企业知识问答助手。',value:'企业知识问答助手。',field:'projectDescription'}],fields(),3,url,3).operations).toHaveLength(1);
  });

  it.each([
    { quote:'项目简介：为求职提供辅助的应用。',value:'成绩排名前10%',field:'projectDescription' },
    { quote:'不存在的资料',value:'不存在',field:'projectDescription' },
    { quote:'项目简介：为求职提供辅助的应用。',value:'为求职提供辅助的应用。',field:'workDescription' },
  ])('伪造来源、值或跨区块匹配在写入前拒绝：%j', extraction => {
    const service = new BrowserFormReviewService(), p = Preview(service);
    expect(() => service.Compile(p.continuationId,[{fieldId:'f4',sourceId:p.sources[0].sourceId,...extraction}],fields(),1,url,2)).toThrow();
  });

  it('同URL重载、节点替换或记录重排后拒绝旧计划', () => {
    const service = new BrowserFormReviewService(), p = Preview(service), changed=fields();
    changed[0].nodeIdentity='new-doc:1';
    expect(() => service.Compile(p.continuationId,[],changed,1,url,2)).toThrow(/identity changed/);
    expect(() => service.Compile(p.continuationId,[],fields(),31*60000,url,2)).toThrow(/expired/);
  });

  it('已有内容不覆盖，非法批次整体拒绝而非先执行有效部分', () => {
    const service=new BrowserFormReviewService(), f=fields();f[0].filled=true;f[0].currentValue='已有姓名';
    const p=Preview(service,f), name=p.facts.find(x=>x.concept==='personal.name')!;
    expect(service.Compile(p.continuationId,[{fieldId:'f1',factId:name.factId}],f,1,url,2).operations).toEqual([]);
    const p2=Preview(service);
    expect(() => service.Compile(p2.continuationId,[{fieldId:'f1',factId:name.factId},{fieldId:'f999',factId:name.factId}],fields(),1,url,2)).toThrow();
    expect(service.Compile(p2.continuationId,[],fields(),2,url,2).operations).toEqual([]);
  });

  it('非空错值、字段缺失、串到别的记录不会核验通过', () => {
    const service=new BrowserFormReviewService(),p=Preview(service),name=p.facts.find(f=>f.concept==='personal.name')!;
    const plan=service.Compile(p.continuationId,[{fieldId:'f1',factId:name.factId}],fields(),1,url,2);
    service.RecordExecution(plan,url,plan.operations);
    const wrong=fields();wrong[0].currentValue='项目经历';wrong[0].filled=true;
    expect(service.Validate(wrong,url)).toMatchObject({businessValid:false,fieldChecks:[{expected:'范炜乾',actual:'项目经历',status:'mismatch'}]});
    expect(service.Validate(fields().slice(1),url)).toMatchObject({businessValid:null,fieldChecks:[{status:'unverified'}]});
    wrong[0].currentValue='范炜乾';
    expect(service.Validate(wrong,url).businessValid).toBe(true);
    expect(OperationValueMatches({...wrong[0],currentValue:undefined} as FormField,plan.operations[0])).toBe(false);
  });
});
