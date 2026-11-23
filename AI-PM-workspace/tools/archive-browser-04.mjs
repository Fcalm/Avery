const task=await taskSpace(1);const page=task.page('p1');await page.reload();
const checks=[];function check(name,pass){checks.push({name,pass});if(!pass)throw new Error(name);}
await page.click('loc=css:tr[data-id="a1"] button[data-action="delete"]');
await page.keyboard.press('Tab');await page.keyboard.press('Tab');
check('键盘焦点保留在确认框',await page.evaluate(()=>document.querySelector('#confirm').contains(document.activeElement)));
await page.mouse.click(16,70);check('点击遮罩取消且不删除',await page.evaluate(()=>!document.querySelector('#confirm').open&&document.querySelectorAll('#rows tr').length===8));
await page.click('loc=css:tr[data-id="a1"] button[data-action="restore"]');
await page.evaluate(()=>{conversations.find(item=>item.id==='a1').expires=Date.now()-1;});
await page.click('loc=css:#commit');
check('确认期间到期不会误报恢复成功',await page.evaluate(()=>document.querySelector('#toastText').textContent==='对话已自动清理'&&!document.querySelector('tr[data-id="a1"]')));
await page.reload();
const sizes=[[1280,900],[1280,768],[1024,768],[800,640],[390,844],[320,568]];const layouts=[];
for(const [width,height]of sizes){
 await page.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 const result=await page.evaluate(()=>({width:innerWidth,height:innerHeight,noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth,actionsFit:[...document.querySelectorAll('.actions')].every(node=>node.getBoundingClientRect().right<=node.parentElement.getBoundingClientRect().right+1&&node.scrollWidth<=node.clientWidth+1),count:document.querySelectorAll('#rows tr').length,allIconsMapped:[...document.querySelectorAll('.ph')].every(node=>getComputedStyle(node,'::before').content!=='none')}));
 layouts.push(result);check('布局 '+width+'×'+height,result.noHorizontalOverflow&&result.actionsFit&&result.count===8&&result.allIconsMapped);
 if(width===390)await page.screenshot({path:'D:/Avery/project/AI-PM-workspace/archive-conversations/preview-mobile.png'});
}
await page.cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
await page.screenshot({path:'D:/Avery/project/AI-PM-workspace/archive-conversations/preview-desktop.png'});
await page.click('loc=css:tr[data-id="a1"] button[data-action="delete"]');
await page.screenshot({path:'D:/Avery/project/AI-PM-workspace/archive-conversations/preview-confirm.png'});
await page.click('loc=css:#cancel');
const {writeFile}=await import('node:fs/promises');await writeFile('D:/Avery/project/AI-PM-workspace/archive-conversations/layout-qa.json',JSON.stringify({checks,layouts},null,2));
console.log({checks,layouts});await task.finish({keep:[]});
