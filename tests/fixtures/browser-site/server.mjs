import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureRoot = dirname(fileURLToPath(import.meta.url));
function SendJson(response,status,value){response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(value))}
/** 启动一次性 loopback fixture；状态仅供测试进程断言，不作为模型可见页面能力。 */
export async function StartBrowserFixture(){
 const state={submissionCount:0,submission:null,receipt:null};const html=await readFile(join(fixtureRoot,'index.html'),'utf8');
 const server=createServer(async(request,response)=>{const url=new URL(request.url||'/','http://127.0.0.1');
  if(request.method==='GET'&&url.pathname==='/'){response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(html);return}
  if(request.method==='GET'&&url.pathname==='/__test/state'){SendJson(response,200,state);return}
  if(request.method==='POST'&&url.pathname==='/__test/submit'){let body='';for await(const chunk of request){body+=chunk;if(body.length>65536){SendJson(response,413,{message:'payload too large'});return}}let submission;try{submission=JSON.parse(body)}catch{SendJson(response,400,{message:'invalid json'});return}if(state.submissionCount>0){SendJson(response,409,{message:'duplicate submission blocked',receipt:state.receipt});return}const required=['jobId','name','email','phone','intro','workMode','province','city','jobFamily','jobTrack','resumeName'];if(required.some(field=>typeof submission[field]!=='string'||!submission[field])||submission.terms!==true){SendJson(response,422,{message:'required application fields are missing'});return}state.submissionCount=1;state.submission=submission;state.receipt='LOCAL-APPLICATION-0001';SendJson(response,200,{receipt:state.receipt});return}
  response.writeHead(404).end('not found')});
 await new Promise((resolveListen,rejectListen)=>{server.once('error',rejectListen);server.listen(0,'127.0.0.1',resolveListen)});const address=server.address();if(!address||typeof address==='string')throw new Error('fixture did not bind a TCP port');const origin=`http://127.0.0.1:${address.port}`;
 return{origin,getState:()=>JSON.parse(JSON.stringify(state)),close:()=>new Promise((resolveClose,rejectClose)=>server.close(error=>error?rejectClose(error):resolveClose()))}
}
