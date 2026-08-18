async (page) => {
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const records = [];

  async function SaveText(fileName, content) {
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(({ name, text }) => {
      const link = document.createElement('a');
      link.download = name;
      link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      document.body.appendChild(link); link.click(); link.remove();
    }, { name: fileName, text: content });
    const download = await downloadPromise;
    await download.saveAs(fileName);
  }

  async function Capture(name, width, height) {
    await page.waitForTimeout(80);
    const metrics = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const critical = [...document.querySelectorAll('.page-header-actions button, .onboarding-actions button, .composer-dock button, [role="dialog"] button')].filter(visible);
      const offscreenCritical = critical.filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight; }).map((element) => element.textContent?.trim() || element.getAttribute('aria-label'));
      return {
        viewport: { width: innerWidth, height: innerHeight },
        document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
        body: { clientWidth: document.body.clientWidth, scrollWidth: document.body.scrollWidth, clientHeight: document.body.clientHeight, scrollHeight: document.body.scrollHeight },
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth,
        offscreenCritical,
        visibleFocusable: [...document.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(visible).length,
        heading: document.querySelector('h1,h2')?.textContent?.trim() || '',
      };
    });
    await page.screenshot({ path: `${name}-${width}x${height}.png`, fullPage: false, scale: 'css' });
    await SaveText(`${name}-${width}x${height}.yml`, await page.locator('body').ariaSnapshot());
    records.push({ name, ...metrics });
  }

  async function Navigate(name) {
    const button = page.getByRole('button', { name: new RegExp(`${name}$`) }).first();
    const started = Date.now(); await button.click(); await page.locator('h1').first().waitFor();
    const durationMs = Date.now() - started;
    records.push({ name: `navigation:${name}`, durationMs, within500ms: durationMs <= 500 });
  }

  async function OpenSettings() {
    const trigger = page.locator('.sidebar-user-trigger');
    await trigger.focus();
    await page.getByRole('button', { name: /设置.*账户、工作空间与 API/ }).click();
    await page.getByRole('heading', { name: '账户' }).waitFor();
  }

  await page.evaluate(() => localStorage.setItem('offerget.visual.scenario', 'populated'));
  await page.reload(); await page.locator('.app-shell').waitFor();
  for (const [width, height] of [[1280, 800], [1024, 680]]) {
    await page.setViewportSize({ width, height });
    await Navigate('求职助手'); await Capture('assistant', width, height);
    await Navigate('岗位库'); await Capture('jobs', width, height);
    await Navigate('投递管理'); await Capture('applications', width, height);
    await Navigate('简历库'); await Capture('resumes', width, height);
    await Navigate('档案库'); await Capture('profiles', width, height);
    await Navigate('开发者工具'); await Capture('developer', width, height);
    await OpenSettings(); await Capture('settings', width, height);
  }

  // 键盘导航：Enter/Space 激活，抽屉获得焦点、Tab 留在弹层内，Escape 关闭并恢复触发按钮焦点。
  await page.setViewportSize({ width: 1280, height: 800 });
  await Navigate('求职助手');
  const jobsButton = page.getByRole('button', { name: /岗位库$/ }); await jobsButton.focus(); await jobsButton.press('Enter');
  const enterWorks = await page.getByRole('heading', { name: '岗位库' }).isVisible();
  const applicationsButton = page.getByRole('button', { name: /投递管理$/ }); await applicationsButton.focus(); await applicationsButton.press('Space');
  const spaceWorks = await page.getByRole('heading', { name: '投递管理' }).isVisible();
  const addButton = page.getByRole('button', { name: '＋ 新增投递' }); await addButton.focus(); await addButton.press('Enter');
  const dialog = page.getByRole('dialog', { name: '新增投递记录' }); await dialog.waitFor();
  const initialFocusInside = await dialog.evaluate((element) => element.contains(document.activeElement));
  for (let index = 0; index < 10; index += 1) await page.keyboard.press('Tab');
  const tabTrapped = await dialog.evaluate((element) => element.contains(document.activeElement));
  await page.keyboard.press('Escape');
  const escapeClosed = !(await dialog.isVisible().catch(() => false));
  const focusRestored = await addButton.evaluate((element) => document.activeElement === element);
  records.push({ name: 'keyboard', enterWorks, spaceWorks, initialFocusInside, tabTrapped, escapeClosed, focusRestored });

  // 首次设置与表单错误关联。
  await page.evaluate(() => localStorage.setItem('offerget.visual.scenario', 'onboarding')); await page.reload();
  await page.getByRole('heading', { name: '欢迎来到 OfferGet' }).waitFor(); await Capture('state-onboarding', 1280, 800);
  await page.getByRole('button', { name: '下一步' }).click(); await page.getByRole('button', { name: '下一步' }).click();
  const apiKey = page.getByRole('textbox', { name: 'API Key' }); await page.getByRole('button', { name: '下一步' }).click();
  const errorAssociated = await apiKey.getAttribute('aria-describedby') === 'onboarding-form-error' && await apiKey.getAttribute('aria-invalid') === 'true' && await page.getByRole('alert').isVisible();
  await Capture('state-form-error', 1280, 800);
  records.push({ name: 'form-error', associated: errorAssociated });

  await page.evaluate(() => localStorage.setItem('offerget.visual.scenario', 'loading')); await page.reload(); await page.waitForTimeout(150);
  await page.getByRole('heading', { name: '正在加载本地工作空间…' }).waitFor(); await Capture('state-loading', 1280, 800);
  for (const [scenario, expectedHeading] of [['error', '本地数据加载失败'], ['backend-recovery', '本地服务正在恢复']]) {
    await page.evaluate((value) => localStorage.setItem('offerget.visual.scenario', value), scenario); await page.reload();
    await page.getByRole('heading', { name: expectedHeading }).waitFor({ timeout: 15000 });
    await Capture(`state-${scenario}`, 1280, 800);
    records.push({ name: `state-heading:${scenario}`, expectedHeading, matched: true });
  }

  // 空态、数据库恢复、模块信任和恢复默认弹窗。
  await page.evaluate(() => localStorage.setItem('offerget.visual.scenario', 'empty')); await page.reload(); await page.locator('.app-shell').waitFor();
  await Navigate('岗位库'); await Capture('state-empty', 1280, 800);
  await page.evaluate(() => localStorage.setItem('offerget.visual.scenario', 'recovery')); await page.reload(); await page.locator('.app-shell').waitFor(); await OpenSettings();
  await page.getByRole('button', { name: '工作空间', exact: true }).click(); await page.getByText('数据库只读恢复模式').waitFor(); await Capture('state-recovery', 1280, 800);
  await page.getByRole('button', { name: '恢复所选备份' }).click(); await Capture('dialog-database-restore', 1280, 800); await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.setItem('offerget.visual.scenario', 'modules-active')); await page.reload(); await page.locator('.app-shell').waitFor(); await OpenSettings();
  await page.getByRole('button', { name: '开发者模式', exact: true }).click(); await page.getByText('已启用 visual-modules').waitFor();
  await page.getByRole('button', { name: '选择本地模块目录' }).click(); await Capture('dialog-module-trust', 1280, 800); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '恢复官方默认' }).click(); await Capture('dialog-module-reset', 1280, 800); await page.keyboard.press('Escape');

  // 档案外部修改冲突。
  await page.evaluate(() => localStorage.setItem('offerget.visual.scenario', 'conflict')); await page.reload(); await page.locator('.app-shell').waitFor();
  await Navigate('档案库'); await page.locator('.profile-card').click(); await page.getByRole('button', { name: '保存资料' }).click();
  await page.getByRole('dialog', { name: '档案文件已被外部修改' }).waitFor(); await Capture('dialog-profile-conflict', 1280, 800);

  const report = {
    generatedAt: new Date().toISOString(),
    records,
    consoleErrors,
    passed: records.every((item) => item.horizontalOverflow !== true && (!item.offscreenCritical || item.offscreenCritical.length === 0) && item.within500ms !== false)
      && records.filter((item) => item.name === 'keyboard').every((item) => item.enterWorks && item.spaceWorks && item.initialFocusInside && item.tabTrapped && item.escapeClosed && item.focusRestored)
      && records.filter((item) => item.name === 'form-error').every((item) => item.associated)
      && consoleErrors.length === 0,
  };
  await SaveText('2.3-visual-report.json', JSON.stringify(report, null, 2));
  return report;
}
