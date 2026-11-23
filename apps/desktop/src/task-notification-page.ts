import type { NoticeInteraction } from './task-completion';

function EscapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** 通知页只获得当前提案的展示数据，交互归属和调用权限留在主进程。 */
export function TaskNotificationHtml(input: { title: string; nonce: string; interaction?: NoticeInteraction; soundData?: string; brandData?: string; fontData?: string }): string {
  const nonce = EscapeHtml(input.nonce);
  const interaction = input.interaction;
  const model = JSON.stringify(interaction ?? null).replace(/</g, '\\u003c');
  const label = interaction?.kind === 'approval' ? '需要确认' : interaction?.kind === 'question' ? '需要回答' : '任务完成';
  const glyph = interaction?.kind === 'approval' ? '&#xe40c;' : interaction?.kind === 'question' ? '&#xe17e;' : '&#xe184;';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'">
<style nonce="${nonce}">
${input.fontData ? `@font-face{font-family:Phosphor;src:url(data:font/woff2;base64,${input.fontData}) format('woff2')}` : ''}
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#18181b;font:13px/1.55 "Microsoft YaHei UI","PingFang SC",sans-serif;color-scheme:light}
body{overflow:hidden}button,input{font:inherit;color:inherit}button{border:0;background:none;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:none;background:#f4f4f5}input:focus{outline:none;box-shadow:none}
*{scrollbar-width:thin;scrollbar-color:#d8d8dc transparent}:focus-within{scrollbar-color:#18181b transparent}
.notice{display:flex;flex-direction:column;max-height:480px;padding:10px 12px;border:1px solid #e8e8ea;border-radius:14px}header,.status,.task-title,footer,.error{flex-shrink:0}#details{min-height:0;max-height:240px;overflow-y:auto}.ph{font:18px/1 Phosphor;display:inline-grid;place-items:center;font-style:normal;flex:none}
header{display:flex;align-items:center;justify-content:space-between;height:22px;margin-bottom:6px}.brand{display:inline-flex;align-items:center;gap:6px;padding:0;font-size:13px;font-weight:400}.brand img{width:16px;height:16px;object-fit:contain}.brand-fallback{color:#215544}
.close{display:grid;place-items:center;width:24px;height:24px;padding:0;border-radius:10px;color:#8b8b94}.close:hover{background:#f4f4f5;color:#18181b}
.status{display:flex;align-items:center;gap:7px}.status .ph{color:#215544}h1{margin:0;font-size:14px;font-weight:500}.task-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;max-width:100%;padding:0;margin:4px 0 0;text-align:left;color:#55555e;font-size:12px;line-height:19px}
.summary{margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow-y:auto;font-size:12px;color:#55555e}.risk{margin:5px 0 0;color:#b4413c;font-size:12px}.url{font-size:11px;color:#8b8b94;overflow-wrap:anywhere;margin-top:3px;max-height:36px;overflow-y:auto}
.questions{margin-top:10px}.question-text{margin:0 0 6px;font-size:13px;font-weight:400;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.choices{display:grid;gap:4px}.choice-row{display:flex;gap:6px;align-items:center;min-width:0}.choice{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:6px 8px;border-radius:10px;text-align:left;font-size:12px;line-height:18px}.choice:hover,.choice[aria-checked=true]{background:#f4f4f5}.dot{display:block;flex:none;width:14px;height:14px;border:1px solid #d8d8dc;border-radius:50%}.choice[aria-checked=true] .dot{border-color:#215544;background:#215544}.choice-label{min-width:0;overflow-wrap:anywhere}.choice-row.other-selected .choice{flex:0 0 auto}.other{flex:1;min-width:0;width:0;height:30px;border:1px solid #e8e8ea;border-radius:10px;background:#fafafa;padding:4px 8px;font-size:12px}
footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}.stepper{display:flex;align-items:center;gap:5px;color:#8b8b94;font-size:11px}.stepper button{display:grid;place-items:center;width:24px;height:26px;padding:0;border-radius:10px}.actions{display:flex;gap:6px;margin-left:auto}.action{min-height:30px;padding:4px 13px;border-radius:10px;background:#f4f4f5;font-size:12px}.action:hover{background:#e7e7ea}.action.primary{color:#fff;background:#215544}.action.primary:is(:hover,:focus-visible):not(:disabled){background:#153c2f}.error{margin:8px 0 0;color:#b4413c;font-size:12px;overflow-wrap:anywhere;max-height:60px;overflow-y:auto}[hidden]{display:none!important}
</style></head><body><main class="notice" id="notice"><header><button class="brand" id="open" aria-label="在 Avery 中查看对话">${input.brandData ? `<img src="data:image/png;base64,${input.brandData}" alt="">` : '<span class="brand-fallback" aria-hidden="true">A</span>'}<span>Avery</span></button><button class="close" id="close" aria-label="关闭通知"><i class="ph" aria-hidden="true">&#xe4f6;</i></button></header>
<div class="status"><i class="ph" aria-hidden="true">${glyph}</i><h1>${label}</h1></div><button class="task-title" id="task" title="${EscapeHtml(input.title)}">${EscapeHtml(input.title)}</button>
<div id="details"></div><p class="error" id="error" role="alert" hidden></p>
${interaction ? '<footer><div class="stepper" id="stepper"></div><div class="actions"><button class="action" id="cancel" data-answer>取消</button><button class="action primary" id="confirm" data-answer>确认</button></div></footer>' : ''}
</main>${input.soundData ? `<audio autoplay src="data:audio/wav;base64,${input.soundData}"></audio>` : ''}
<script nonce="${nonce}">
const model=${model};
const bridge=window.averyNotice;
const act=(name)=>bridge?.action(name);
document.getElementById('open').addEventListener('click',()=>act('open'));
document.getElementById('task').addEventListener('click',()=>act('open'));
document.getElementById('close').addEventListener('click',()=>act('dismiss'));
document.body.addEventListener('pointerenter',()=>act('pause'));
document.body.addEventListener('pointerleave',()=>act('resume'));
document.addEventListener('keydown',(event)=>{if(event.key==='Escape')act('dismiss')});
const details=document.getElementById('details');
const error=document.getElementById('error');
let busy=false,stale=false,index=0;
const answers=Object.create(null),others=Object.create(null);
const add=(tag,className,text,parent)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;parent.append(node);return node};
const valueOf=(q)=>answers[q.id]==='其他'?(others[q.id]||'').trim():answers[q.id];
const setBusy=(value)=>{busy=value;document.querySelectorAll('[data-answer],.other').forEach(node=>node.disabled=busy||stale);if(model?.kind==='question')updateContinue()};
const showError=(message)=>{error.textContent=message;error.hidden=false};
async function submit(payload){
 if(busy||stale)return;error.hidden=true;setBusy(true);
 try{const result=await bridge?.submit(payload);if(!result?.ok){stale=Boolean(result?.stale);showError(result?.message||'提交失败，请在 Avery 中查看对话。')}}
 catch{showError('提交失败，请重试或返回对话处理。')}
 finally{setBusy(false)}
}
function updateContinue(){const button=document.getElementById('confirm');if(button)button.disabled=busy||stale||!valueOf(model.questions[index]);const prev=document.getElementById('previous'),next=document.getElementById('next');if(prev)prev.disabled=busy||stale||index===0;if(next)next.disabled=busy||stale||index===model.questions.length-1||!valueOf(model.questions[index])}
function renderQuestion(focusOther=false){
 details.replaceChildren();const panel=add('section','questions',undefined,details);const question=model.questions[index];
 add('h2','question-text',question.question,panel);
 const list=add('div','choices',undefined,panel);list.setAttribute('role','radiogroup');list.setAttribute('aria-label',question.question);
 const options=question.options.length?question.options:['其他'];
 options.forEach(option=>{
  const other=option==='其他'&&answers[question.id]===option;
  const row=add('div','choice-row'+(other?' other-selected':''),undefined,list);
  const button=add('button','choice',undefined,row);button.type='button';button.dataset.answer='';button.setAttribute('role','radio');button.setAttribute('aria-checked',String(answers[question.id]===option));
  add('span','dot',undefined,button).setAttribute('aria-hidden','true');add('span','choice-label',option,button);
  button.addEventListener('click',()=>{answers[question.id]=option;error.hidden=true;renderQuestion(option==='其他')});
  button.addEventListener('keydown',(event)=>{if(!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();const next=(options.indexOf(option)+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;answers[question.id]=options[next];renderQuestion();document.querySelectorAll('.choices button')[next]?.focus()});
  if(other){const input=add('input','other',undefined,row);input.maxLength=20000;input.placeholder='请输入';input.setAttribute('aria-label','其他答案');input.value=others[question.id]||'';input.addEventListener('input',()=>{others[question.id]=input.value;updateContinue()});if(focusOther)input.focus({preventScroll:true})}
 });
 const stepper=document.getElementById('stepper');stepper.replaceChildren();
 const previous=add('button','', '‹',stepper);previous.id='previous';previous.dataset.answer='';previous.setAttribute('aria-label','上一题');previous.disabled=index===0;previous.addEventListener('click',()=>{index--;renderQuestion()});
 add('span','',String(index+1)+'/'+model.questions.length,stepper);
 const next=add('button','','›',stepper);next.id='next';next.dataset.answer='';next.setAttribute('aria-label','下一题');next.disabled=index===model.questions.length-1||!valueOf(question);next.addEventListener('click',()=>{index++;renderQuestion()});
 document.getElementById('confirm').textContent=index===model.questions.length-1?'确认':'继续';updateContinue();
}
if(model?.kind==='approval'){
 add('p','summary',model.summary,details);
 if(model.risk==='high')add('p','risk','高风险操作',details);
 if(model.url)add('div','url',model.url,details);
 document.getElementById('cancel').addEventListener('click',()=>submit({action:'cancel'}));
 document.getElementById('confirm').addEventListener('click',()=>submit({action:'confirm'}));
}else if(model?.kind==='question'){
 model.questions.forEach(q=>answers[q.id]=q.options[0]||'其他');renderQuestion();
 document.getElementById('cancel').addEventListener('click',()=>submit({action:'cancel'}));
 document.getElementById('confirm').addEventListener('click',()=>{
  if(!valueOf(model.questions[index]))return;
  if(index<model.questions.length-1){index++;renderQuestion();return}
  const missing=model.questions.findIndex(q=>!valueOf(q));if(missing>=0){index=missing;renderQuestion();showError('请回答全部问题');return}
  submit({action:'answer',answers:Object.fromEntries(model.questions.map(q=>[q.id,valueOf(q)]))});
 });
}
const resize=()=>bridge?.resize(Math.ceil(document.getElementById('notice').getBoundingClientRect().height));
new ResizeObserver(resize).observe(document.getElementById('notice'));document.fonts.ready.then(resize);resize();
</script></body></html>`;
}
