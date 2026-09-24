(() => {
  if (location.pathname !== '/pair') return;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  const port = Number(params.get('port'));
  if (!/^[a-f0-9]{64}$/.test(token || '') || !Number.isSafeInteger(port) || port < 1 || port > 65535) return;
  chrome.runtime.sendMessage({ type: 'avery_pair', token, port }).then((result) => {
    const status = result?.ok ? 'Avery 浏览器扩展已连接。你可以关闭此页面并返回 Avery。' : `连接失败：${result?.message || 'unknown error'}`;
    const render = () => {
      document.body.innerHTML = `<main style="font:16px system-ui;margin:48px;max-width:680px"><h1 style="font-size:24px">${status}</h1></main>`;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
    else render();
  }).catch(() => undefined);
})();
