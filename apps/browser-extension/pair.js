(() => {
  if (location.pathname !== '/pair') return;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  const port = Number(params.get('port'));
  if (!/^[a-f0-9]{64}$/.test(token || '') || !Number.isSafeInteger(port) || port < 1 || port > 65535) return;
  const render = (status) => {
    const update = () => {
      const main = document.createElement('main');
      main.style.cssText = 'font:16px system-ui;margin:48px;max-width:680px';
      const heading = document.createElement('h1');
      heading.style.fontSize = '24px';
      heading.textContent = status;
      main.append(heading);
      document.body.replaceChildren(main);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', update, { once: true });
    else update();
  };
  chrome.runtime.sendMessage({ type: 'avery_pair', token, port }).then((result) => {
    render(result?.ok ? 'Avery 浏览器扩展已连接，此页面将自动关闭。若未关闭，可手动关闭并返回 Avery。' : `连接失败：${result?.message || 'unknown error'}`);
  }).catch((error) => render(`连接失败：${error?.message || '无法联系 Avery 浏览器扩展'}`));
})();
