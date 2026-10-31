(function () {
  'use strict';
  // 页面只有单轮令牌；创建、结束、评分和清理始终由页面之外的控制端负责。
  class Session {
    constructor(id, token) { this.id = id; this.token = token; this.revision = 0; }
    async request(action, method = 'GET', body) {
      const response = await fetch(`/api/runs/${this.id}/${action}`, { method, headers: { Authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      if (!response.ok) { const error = new Error(value.error?.message || '本地测评服务不可用'); error.code = value.error?.code; error.details = value.error?.details; throw error; }
      if (Number.isInteger(value.revision) && !(action === 'state' && method === 'GET')) this.adopt(value);
      return value;
    }
    load() { return this.request('state'); }
    adopt(view) { this.revision = view.revision; this.view = view; }
    save(state, events) { return this.request('state', 'PUT', { state: { ...state, events: [] }, events, revision: this.revision }); }
    async upload(kind, file) {
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      return this.request('files/' + kind, 'POST', { name: file.name, base64 });
    }
    removeFile(kind) { return this.request('files/' + kind, 'DELETE'); }
    preview() { return this.request('preview', 'POST', { revision: this.revision }); }
    submit() { return this.request('submit', 'POST', { revision: this.revision, previewId: this.view.preview?.id }); }
  }
  window.CareerRuntime = {
    async connect() {
      const match = location.pathname.match(/^\/runs\/([0-9a-f-]{36})\//);
      if (!match) return null;
      const key = 'career-run-access-' + match[1];
      const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('access');
      const token = fragmentToken || sessionStorage.getItem(key);
      if (!token) throw new Error('缺少本轮访问令牌，请使用控制端创建的完整 URL 打开');
      if (fragmentToken) { sessionStorage.setItem(key, token); history.replaceState(null, '', location.pathname); }
      const session = new Session(match[1], token); session.adopt(await session.load());
      if (!session.view.manifest.endedAt && session.view.state.status !== 'submitted') await session.request('context', 'POST', { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
      let resizeTimer;
      window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!session.view.manifest.endedAt && session.view.state.status !== 'submitted') session.request('context', 'POST', { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio }).catch(() => undefined); }, 300); });
      return session;
    },
  };
})();
