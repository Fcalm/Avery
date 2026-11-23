const task=await taskSpace('Avery archive delete all 20261104');const page=task.page('p1');
await page.goto('file:///D:/Avery/project/AI-PM-workspace/archive-conversations/index.html');
console.log({spaceId:task.spaceId});console.log(await page.snapshot());
