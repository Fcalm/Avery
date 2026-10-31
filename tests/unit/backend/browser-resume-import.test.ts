import {describe,expect,it} from 'vitest';
import {BrowserFormReviewService} from '../../../apps/backend/src/electron/backend/browser-form-review';
import {FormFields} from '../../../apps/backend/src/electron/backend/browser-form-service';
import {BrowserFormDriver} from '../../../apps/backend/src/electron/backend/browser-form-driver';

const url='https://example.com/apply';
const sources={resume:{id:'r',name:'授权简历',content:'**张三** | 13800138000 | correct@example.com'}};
const fields=(name='',email='',doc='doc')=>FormFields({
  e1:{role:'textbox',name:'姓名',currentValue:name,valueLength:name.length,nodeIdentity:doc+':1'},
  e2:{role:'textbox',name:'邮箱',currentValue:email,valueLength:email.length,nodeIdentity:doc+':2'},
},1);
type Plan={continuationId:string;fields:Array<{fieldId:string;origin:string;correctionPolicy:string;beforeUploadValue?:string;restoreFactId?:string}>;facts:Array<{factId:string;field:string;value:string}>;unresolvedProtectedFields?:unknown[]};
const preview=(service:BrowserFormReviewService,f=fields())=>service.Plan(f,sources,1,url) as Plan;
function imported(before=fields(),status:'stable'|'pending'|'failed'='stable'){
 const service=new BrowserFormReviewService(),id=service.resumeImport.Begin(before,url,0);
 service.resumeImport.Complete(id,status);return service;
}

describe('简历上传基线与解析后修正',()=>{
 it('搜索没有结果时同时保留搜索前真实候选，不让Agent重新打开控件查找',async()=>{
  let opened=false,searched=false;
  const commands:string[][]=[];
  const driver=new BrowserFormDriver({pageRevision:()=>1,delay:async()=>{},runCommand:async args=>{
   commands.push(args);
   if(args[0]==='click')opened=true;
   if(args[0]==='fill')searched=true;
   if(args[0]==='snapshot')return {success:true,data:{refs:opened?{
    ...(!searched?{e9:{role:'option',name:'珠海市'}}:{}),e10:{role:'textbox',name:'__avery_dynamic_search__'},
   }:{e1:{role:'combobox',name:'期望城市',section:'求职意向',currentValue:'',nodeIdentity:'doc:city'}}}};
   const expr=args[0]==='eval'?Buffer.from(args[2],'base64').toString('utf8'):'';
   if(expr.includes('const onlyMoka = true;'))return {success:true,data:{result:{observedOptions:searched?[]:['珠海市'],optionsTruncated:false}}};
   return {success:true,data:{result:{}}};
  }});
  const result=await driver.ExecuteCustomSelect({kind:'custom_select',key:'targetCity',concept:'preference.targetRegion',label:'期望城市',targetOccurrence:0,
   ref:'@e1',occurrence:0,value:'广州市',adapter:'moka',sourceTitle:'求职意向',sourcePath:'p.city',sourcePaths:['p.city'],strategy:'agent'},{});
  expect(result).toMatchObject({filled:false,reason:'option_not_found',requestedValue:'广州市',observedOptions:[],optionsBeforeSearch:['珠海市'],searchAttempted:true});
  expect(commands.filter(c=>c[0]==='click').map(c=>c[1])).toEqual(['@e1']);
 });
 it('解析覆盖的原有内容只能恢复原值，解析生成的错值可按来源批量修正',()=>{
  const service=imported(fields('李四','')),f=fields('项目经历','wrong@example.com'),p=preview(service,f);
  expect(p.fields[0]).toMatchObject({origin:'protected_before_upload',correctionPolicy:'restore_only',beforeUploadValue:'李四'});
  expect(p.fields[1]).toMatchObject({origin:'resume_parse',correctionPolicy:'source_reviewed'});
  const name=p.facts.find(x=>x.field==='name'&&x.value==='张三')!,email=p.facts.find(x=>x.field==='email')!;
  expect(()=>service.Compile(p.continuationId,[{fieldId:'f1',factId:name.factId}],f,2,url,1)).toThrow(/before upload/);
  expect(()=>service.Compile(p.continuationId,[{fieldId:'f2',factId:p.fields[0].restoreFactId}],f,2,url,1)).toThrow(/original field/);
  const plan=service.Compile(p.continuationId,[{fieldId:'f1',factId:p.fields[0].restoreFactId},{fieldId:'f2',factId:email.factId}],f,2,url,1);
  expect(plan.operations.map(op=>op.value)).toEqual(['李四','correct@example.com']);
  service.RecordExecution(plan,url,plan.operations);
  expect(service.Validate(fields('李四','correct@example.com'),url).businessValid).toBe(true);
 });

 it('解析结果已正确时只记录核验，不重复写入',()=>{
  const service=imported(),f=fields('','correct@example.com'),p=preview(service,f),email=p.facts.find(x=>x.field==='email')!;
  const plan=service.Compile(p.continuationId,[{fieldId:'f2',factId:email.factId}],f,2,url,1);
  expect(plan.operations).toEqual([]);expect(plan.verifiedOperations).toHaveLength(1);
  service.RecordExecution(plan,url,[]);
  expect(service.Validate(f,url).businessValid).toBe(true);
 });

 it('没有选择恢复项也会核验上传前原值，不能把漏恢复报成成功',()=>{
  const service=imported(fields('张三','')),f=fields('错误姓名','correct@example.com'),p=preview(service,f);
  const plan=service.Compile(p.continuationId,[{fieldId:'f2',factId:p.facts.find(x=>x.field==='email')!.factId}],f,2,url,1);
  service.RecordExecution(plan,url,[]);
  expect(service.Validate(f,url)).toMatchObject({businessValid:false,fieldChecks:expect.arrayContaining([expect.objectContaining({label:'姓名',expected:'张三',actual:'错误姓名',source:'上传前页面内容',status:'mismatch'})])});
 });

 it('解析未结束不能写，继续观察完成后可用原基线，不要求再次上传',()=>{
  const service=imported(fields(),'pending'),p=preview(service),email=p.facts.find(x=>x.field==='email')!;
  expect(()=>service.Compile(p.continuationId,[{fieldId:'f2',factId:email.factId}],fields(),2,url,1)).toThrow(/BrowserWait/);
  service.resumeImport.Complete(service.resumeImport.Current()!.id,'stable');
  expect(service.Compile(p.continuationId,[{fieldId:'f2',factId:email.factId}],fields(),2,url,1).operations).toHaveLength(1);
 });

 it('没有上传基线时仍保留原来的非空字段保护',()=>{
  const service=new BrowserFormReviewService(),f=fields('','existing@example.com'),p=preview(service,f);
  expect(service.Compile(p.continuationId,[{fieldId:'f2',factId:p.facts.find(x=>x.field==='email')!.factId}],f,2,url,1).operations).toEqual([]);
 });

 it('同URL重载、计划后迟到的解析和过期基线不能静默覆盖',()=>{
  const service=imported(),p=preview(service),email=p.facts.find(x=>x.field==='email')!;
  service.Compile(p.continuationId,[{fieldId:'f2',factId:email.factId}],fields(),2,url,1);
  expect(()=>service.AssertCurrent(p.continuationId,fields('','late@example.com'),3,url)).toThrow(/changed after review/);
  expect(()=>service.Plan(fields('','','other-doc'),sources,3,url)).toThrow(/document changed/);
  expect(()=>service.Plan(fields(),sources,31*60_000,url)).toThrow(/expired/);
 });

 it('重复经历节点全部被重建时不按序号猜测旧内容归属',()=>{
  const education=(doc:string)=>FormFields({
   e1:{role:'textbox',name:'学校名称',section:'教育经历',recordIndex:0,nodeIdentity:doc+':a',currentValue:'甲大学',valueLength:3},
   e2:{role:'textbox',name:'学校名称',section:'教育经历',recordIndex:1,nodeIdentity:doc+':b',currentValue:'乙大学',valueLength:3},
  },1);
  const before=education('doc'),after=education('doc');after[0].nodeIdentity='doc:new1';after[1].nodeIdentity='doc:new2';
  const service=imported(before),p=preview(service,after);
  expect(p.fields.map(f=>f.correctionPolicy)).toEqual(['protected','protected']);expect(p.unresolvedProtectedFields).toHaveLength(2);
 });

 it('再次上传不会把上一轮解析错值变成用户原有内容',()=>{
  const service=imported(fields('李四',''));
  const id=service.resumeImport.Begin(fields('错误姓名',''),url,3);service.resumeImport.Complete(id,'stable');
  expect(preview(service,fields('再次覆盖','')).fields[0].beforeUploadValue).toBe('李四');
 });

 it('明确解析失败与仍在等待分开返回，上传后旧审阅不可复用',()=>{
  const service=imported(fields(),'failed'),p=preview(service),email=p.facts.find(x=>x.field==='email')!;
  expect(()=>service.Compile(p.continuationId,[{fieldId:'f2',factId:email.factId}],fields(),2,url,1)).toThrow(/reported resume/);
  service.resumeImport.Complete(service.resumeImport.Current()!.id,'stable');
  service.ResetForResumeUpload();
  expect(()=>service.Compile(p.continuationId,[{fieldId:'f2',factId:email.factId}],fields(),2,url,1)).toThrow(/expired/);
 });
});
