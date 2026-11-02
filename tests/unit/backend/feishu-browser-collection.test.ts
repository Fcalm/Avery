import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCollectionInputSchema, type RecruitmentSource } from '@avery/contracts';
import { CreateFeishuPageReader, FeishuBrowserCollector, type FeishuBrowserPage } from '../../../apps/backend/src/electron/backend/feishu-browser-collection';
import type { NormalizedJob, PublicTransport } from '../../../apps/backend/src/electron/backend/ats/types';
import type { BrowserAutomationPort } from '@avery/agent-sdk';

const roots: string[] = []; afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
const source: RecruitmentSource = { sourceId:'test', companyId:'test', company:'公告简称', url:'https://test.jobs.feishu.cn/campus/', platform:'feishu', category:'campus', enabled:true, origin:'custom' };
const request = JobCollectionInputSchema.parse({channel:'campus_aggregator',keyword:'产品',browserFallback:true});
const Raw = (id: string) => ({id,title:`产品${id}`,description:'真实JD',requirement:'本科',recruit_type:{name:'校招'},city_list:[{name:'上海'}],channel_online_status:1});
const Page = (url: string, ids=['1'], total=ids.length):FeishuBrowserPage => ({url,ready:true,page:Number(new URL(url).searchParams.get('current')),total,ids,titles:{},path:'campus',company:'官网企业'});
async function Fixture() {
 const root=await mkdtemp(join(tmpdir(),'avery-feishu-browser-'));roots.push(root);
 const transport={Request:vi.fn<PublicTransport['Request']>(async(url)=>{const id=new URL(url).pathname.split('/').pop()!;return{url,status:200,body:JSON.stringify({code:0,data:{job_post_detail:Raw(id)}})}})};
 return {collector:new FeishuBrowserCollector(join(root,'cache.json'),transport),transport};
}
const Input = (readPage:(url:string)=>Promise<FeishuBrowserPage>, accept:(job:NormalizedJob)=>Promise<boolean> = async()=>true) => ({source,request,signal:new AbortController().signal,deadline:Date.now()+10000,readPage,accept});

describe('飞书浏览器列表与公开详情混合采集',()=>{
 it('名称匹配在详情请求前排除全文搜索中的非目标岗位',async()=>{
  const {collector,transport}=await Fixture();const accepted:NormalizedJob[]=[];
  const report=await collector.Run({...Input(async url=>({...Page(url,['1','2','3'],3),titles:{'1':'产品经理','2':'算法工程师','3':'市场营销'}}),async j=>{accepted.push(j);return true}),request:{...request,keywordScope:'title'}});
  expect(report).toMatchObject({received:1,complete:true});expect(transport.Request).toHaveBeenCalledTimes(1);expect(accepted[0].atsJobId).toBe('1');
 });
 it('官网原生关键词搜索、分页和批量详情；缓存跨查询复用详情，不把搜索结果作为全站快照',async()=>{
  const {collector,transport}=await Fixture();const accepted:NormalizedJob[]=[];
  const readPage=vi.fn(async(url:string)=>Page(url,new URL(url).searchParams.get('current')==='1'?['1','2']:['3'],3));
  expect(await collector.Run(Input(readPage,async job=>{accepted.push(job);return true}))).toMatchObject({received:3,complete:true,errors:[]});
  expect(readPage).toHaveBeenCalledTimes(2);expect(transport.Request).toHaveBeenCalledTimes(3);
  expect(accepted[0]).toMatchObject({company:'官网企业',jobType:'campus_recruitment',locations:['上海'],description:'真实JD'});
  expect(new URL(readPage.mock.calls[0][0]).searchParams.get('keywords')).toBe('产品');
  expect(new URL(readPage.mock.calls[0][0]).pathname).toBe('/campus/position/list');
  expect(await collector.HasCachedQuery(source,request)).toBe(true);
  expect(await collector.HasCachedQuery({...source,url:'https://test.jobs.feishu.cn/campus/position/1/detail'},request)).toBe(false);
  await collector.Run(Input(readPage));expect(readPage).toHaveBeenCalledTimes(2);expect(transport.Request).toHaveBeenCalledTimes(3);
  await collector.Run({...Input(readPage),request:{...request,keyword:'工程'}});expect(readPage).toHaveBeenCalledTimes(4);expect(transport.Request).toHaveBeenCalledTimes(3);
 });
 it('最多3个详情并发，接受结果串行；目标满足即停止，不遍历后续页',async()=>{
  const {collector,transport}=await Fixture();let active=0,max=0;
  transport.Request.mockImplementation(async url=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;const id=new URL(url).pathname.split('/').pop()!;return{url,status:200,body:JSON.stringify({code:0,data:{job_post_detail:Raw(id)}})}});
  const readPage=vi.fn(async(url:string)=>Page(url,Array.from({length:10},(_,i)=>String(i+1)),30));const accept=vi.fn(async()=>false);
  expect(await collector.Run(Input(readPage,accept))).toMatchObject({received:1,complete:false});
  expect(readPage).toHaveBeenCalledTimes(1);expect(accept).toHaveBeenCalledTimes(1);expect(max).toBe(3);
 });
 it('重复页面、企业身份或关键词不一致不能当完整结果',async()=>{
  const {collector}=await Fixture();const readPage=async(url:string)=>Page(url,['1'],2);
  await expect(collector.Run(Input(readPage))).rejects.toMatchObject({code:'SOURCE_SCHEMA_CHANGED'});
  await expect(collector.Run({...Input(async url=>({...Page(url),url:'https://evil.example/campus/?keywords=产品'})),request:{...request,refresh:true}})).rejects.toMatchObject({code:'SOURCE_SCHEMA_CHANGED'});
 });
 it('详情失败保留已确认结果，不缓存错误身份；刷新后可以恢复',async()=>{
  const {collector,transport}=await Fixture();const readPage=async(url:string)=>Page(url,['1','2'],2),accepted:NormalizedJob[]=[];
  transport.Request.mockImplementation(async url=>({url,status:200,body:JSON.stringify({code:0,data:{job_post_detail:Raw(new URL(url).pathname.endsWith('/2')?'wrong':'1')}})}));
  expect(await collector.Run(Input(readPage,async j=>{accepted.push(j);return true}))).toMatchObject({received:2,complete:false,errors:[expect.stringContaining('identity')]});expect(accepted).toHaveLength(1);
  transport.Request.mockImplementation(async url=>({url,status:200,body:JSON.stringify({code:0,data:{job_post_detail:Raw(new URL(url).pathname.split('/').pop()!)}})}));
  expect(await collector.Run(Input(readPage))).toMatchObject({complete:true,errors:[]});expect(transport.Request).toHaveBeenCalledTimes(3);
 });
 it('中断后不继续接受岗位，未就绪列表不冒充空结果',async()=>{
  const {collector}=await Fixture(),controller=new AbortController(),accept=vi.fn(async()=>true);controller.abort();
  await expect(collector.Run({...Input(async url=>Page(url),accept),signal:controller.signal})).rejects.toThrow();expect(accept).not.toHaveBeenCalled();
  await expect(collector.Run(Input(async url=>({...Page(url),ready:false})))).rejects.toMatchObject({code:'SOURCE_SCHEMA_CHANGED'});
 });
 it('浏览器读取必须沿用导航授权、冻结域名，跳转或登录不反复重试',async()=>{
  const url='https://test.jobs.feishu.cn/campus/?keywords=产品&current=1&limit=10';
  const browser={Prepare:vi.fn(async()=>({forceConfirmation:false})),Execute:vi.fn(async()=>({status:'succeeded'})),EvaluateTrustedPage:vi.fn(async()=>({...Page(url),risk:'login_or_verification'}))};
  const read=CreateFeishuPageReader(browser as unknown as BrowserAutomationPort);
  await expect(read(url,new AbortController().signal,Date.now()+10000)).rejects.toMatchObject({code:'SOURCE_LOGIN_REQUIRED'});expect(browser.EvaluateTrustedPage).toHaveBeenCalledTimes(1);
  expect(browser.EvaluateTrustedPage).toHaveBeenCalledWith(expect.objectContaining({site:'feishu',expectedOrigin:'https://test.jobs.feishu.cn'}));
  await expect(read('https://test.jobs.feishu.cn.evil.example/campus/',new AbortController().signal,Date.now()+1000)).rejects.toMatchObject({code:'SOURCE_ACCESS_DENIED'});
 });
});
