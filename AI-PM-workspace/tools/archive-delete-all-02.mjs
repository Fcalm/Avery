const task=await taskSpace(3);const page=task.page('p1');const checks=[];
function check(name,pass){checks.push({name,pass});if(!pass)throw new Error(name);}
check('交付页不含多选或全选',await page.evaluate(()=>!document.querySelector('input[type="checkbox"],#batchDelete,#selectAll')&&document.querySelectorAll('#deleteAll').length===1));
await page.selectOption('loc=css:#project','AI 产品经理');await page.click('loc=css:#deleteAll');
check('筛选下确认明确全部归档及总数',await page.evaluate(()=>document.querySelector('#dialogText').textContent.includes('全部 8 个已归档对话')&&document.querySelector('#dialogText').textContent.includes('筛选未显示')&&document.activeElement.id==='cancel'));
await page.click('loc=css:#cancel');check('取消不删除任何记录',await page.evaluate(()=>conversations.length===8));
await page.click('loc=css:tr[data-id="a2"] button[data-action="restore"]');
check('单条操作确认仍显示标题项目',await page.evaluate(()=>!document.querySelector('.subject').hidden&&document.querySelector('#dialogSubject').textContent==='筛选上海 AI 产品经理岗位'));
await page.click('loc=css:#cancel');await page.click('loc=css:#deleteAll');await page.keyboard.press('Escape');
check('Esc 取消清空',await page.evaluate(()=>!document.querySelector('#confirm').open&&conversations.length===8));
await page.click('loc=css:#deleteAll');await page.click('loc=css:#commit');
check('确认清空包括筛选外全部归档',await page.evaluate(()=>conversations.length===0&&document.querySelector('#emptyText').textContent==='暂无归档对话'&&document.querySelector('#deleteAll').disabled&&document.querySelector('#toastText').textContent==='已永久删除全部 8 个已归档对话'));
await page.reload();
for(const [width,height]of [[1280,900],[1024,768],[800,640],[390,844],[320,568]]){
 await page.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 check('布局 '+width+'×'+height,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('#deleteAll').getBoundingClientRect().right<=innerWidth));
 if(width===390)await page.screenshot({path:'D:/Avery/project/AI-PM-workspace/archive-conversations/preview-mobile.png'});
}
await page.cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
await page.screenshot({path:'D:/Avery/project/AI-PM-workspace/archive-conversations/preview-desktop.png'});
await page.click('loc=css:#deleteAll');await page.evaluate(async()=>await Promise.allSettled(document.getAnimations().map(animation=>animation.finished)));
await page.screenshot({path:'D:/Avery/project/AI-PM-workspace/archive-conversations/preview-delete-all.png'});
await page.click('loc=css:#cancel');
const{writeFile}=await import('node:fs/promises');await writeFile('D:/Avery/project/AI-PM-workspace/archive-conversations/delete-all-qa.json',JSON.stringify(checks,null,2));
console.log(checks);await task.finish({keep:[]});
