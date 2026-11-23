const task=await taskSpace(1);const page=task.page('p1');
await page.cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
console.log(await page.screenshot({path:'D:/Avery/project/AI-PM-workspace/archive-conversations/preview-desktop.png'}));
