import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const base=new URL('../archive-conversations/',import.meta.url);
const html=await readFile(new URL('index.html',base),'utf8');
await writeFile(new URL('capture-confirm.html',base),html.replace('</head>','<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>').replace('</body>','<script>document.querySelector(\'tr[data-id="a1"] button[data-action="delete"]\').click();</script></body>'));
execFileSync('C:/Users/fanweiqian/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe',['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars','--window-size=1280,900','--virtual-time-budget=1000','--screenshot=D:/Avery/project/AI-PM-workspace/archive-conversations/preview-confirm.png','file:///D:/Avery/project/AI-PM-workspace/archive-conversations/capture-confirm.html'],{windowsHide:true,timeout:15000,stdio:'ignore'});
console.log('确认框静态截图已生成');
