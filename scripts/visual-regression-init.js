(() => {
  const now = 1786320000000;
  const scenario = localStorage.getItem('avery.visual.scenario') || 'populated';
  const ok = (data) => Promise.resolve({ ok: true, data });
  const fail = (code, message, details) => Promise.resolve({ ok: false, error: { code, message, details, retryable: false } });
  const populated = scenario !== 'empty' && scenario !== 'onboarding';
  const viewModel = {
    conversations: populated ? [{ id: 'visual-conversation', title: '前端岗位简历优化', revision: 1, updatedAt: now, messages: [
      { id: 'visual-user', role: 'user', content: '请帮我突出项目中的性能优化成果。', createdAt: now - 1000 },
      { id: 'visual-assistant', role: 'assistant', content: '可以。建议把“负责页面开发”改写为包含指标、方法和业务结果的成果描述。', createdAt: now },
    ] }] : [],
    resumes: populated ? [{ id: 'visual-resume', name: '前端工程师简历', targetRoles: ['前端开发工程师'], summary: '三年前端经验，关注性能与工程效率。', content: '项目经历\n将首屏耗时降低 38%，构建时间降低 45%。', updatedAt: now, revision: 2 }] : [],
    jobs: populated ? [{ id: 'visual-job', company: '示例科技', title: '前端开发工程师', city: '上海', salary: '25–35K', experience: '3–5 年', employmentType: 'full_time', channel: 'manual', favorite: true, matchScore: 86, url: 'https://example.invalid/job', jd: '负责 React 应用性能优化与工程化建设。', revision: 1 }] : [],
    applications: populated ? [{ id: 'visual-application', jobId: 'visual-job', resumeId: 'visual-resume', status: 'applied', appliedAt: '2026-08-10', nextStepAt: '2026-08-15', note: '等待一面安排', revision: 1 }] : [],
  };
  const profiles = populated ? [{ id: 'visual-profile', category: 'project', title: '核心项目成果', content: '通过拆包、缓存和按需加载，将首屏耗时降低 38%。', updatedAt: now }] : [];
  const settings = {
    nickname: '验收用户', workspaceName: 'Avery Visual Workspace', provider: 'DeepSeek', baseUrl: '', model: 'deepseek-v4-flash', contextLength: '64K', thinkingEnabled: true,
    developerMode: true, traceRetention: 50, compressionThreshold: 80, onboardingCompleted: scenario !== 'onboarding', customContext: '使用简洁、可验证的成果表达。',
  };
  const recovery = scenario === 'recovery'
    ? { mode: 'recovery', readOnly: true, reason: '数据库校验失败，工作空间已进入只读保护。', backups: [{ id: 'daily-visual-valid', valid: true, schemaVersion: 6, createdAt: now }], canRestore: true }
    : { mode: 'normal', readOnly: false, reason: '', backups: [], canRestore: false };
  const workspaceValues = {
    GetViewModel: viewModel,
    GetProfiles: { items: profiles, hash: 'visual-profile-hash', modified: false },
    GetSettings: settings,
    GetStatus: { name: settings.workspaceName, metadata: { workspace_id: 'visual', schema_version: 6, created_at: now, last_opened_at: now }, integrity: 'ok' },
    GetRecoveryStatus: { recovering: false, blocked: scenario === 'recovery', recovered: 0, failed: scenario === 'recovery' ? 1 : 0, blockedCount: scenario === 'recovery' ? 1 : 0 },
    GetDatabaseRecoveryStatus: recovery,
    GetResumeRevisions: [{ id: 'revision-2', revision: 2, source: 'user', isPinned: false, isProtected: true, createdAt: now }],
    CleanupAttachments: { scanned: 1, logicallyDeleted: 0, filesDeleted: 0, cacheFilesDeleted: 0, failed: 0 },
    RecoverOperations: { writable: true, recovered: 1 },
    RestoreLatestBackup: { restored: true, backupId: 'daily-visual-valid', sceneId: 'scene-visual' },
    RestoreBackup: { restored: true, backupId: 'daily-visual-valid', sceneId: 'scene-visual' },
    ExportRecoveryDiagnostic: { exported: true, fileName: 'recovery-diagnostic-visual.json' },
    CreateBackup: { created: true, timestamp: now, retainedCount: 1 },
    ExportResume: { exported: true, fileName: 'visual-export.pdf' },
    Migrate: { workspaceName: settings.workspaceName, integrity: 'ok' },
    ReloadProfiles: { items: profiles, hash: 'visual-profile-hash' },
  };
  window.averyWorkspace = new Proxy({}, {
    get: (_target, property) => (...args) => {
      const name = String(property);
      if (name === 'GetViewModel' && scenario === 'loading') return new Promise(() => undefined);
      if (name === 'GetViewModel' && (scenario === 'error' || scenario === 'backend-recovery')) {
        return fail('INTERNAL_ERROR', 'Visual regression injected startup failure.', scenario === 'backend-recovery' ? { backendState: 'restarting' } : undefined);
      }
      if (name === 'SaveProfiles' && scenario === 'conflict' && args[1] !== true) return fail('PROFILE_CONFLICT', 'Profile changed outside the application.');
      if (name === 'ImportAttachment') return ok({ id: 'visual-attachment', name: 'visual.txt', uri: 'attachment://visual-attachment/visual.txt' });
      if (Object.prototype.hasOwnProperty.call(workspaceValues, name)) return ok(workspaceValues[name]);
      return ok({ saved: true, id: args[0]?.id || 'visual-result', revision: 2 });
    },
  });
  const observability = {
    configured: true, model: 'deepseek-v4-flash', historySessions: 2, taskCount: 1,
    contextUsage: { inputTokens: 12800, contextLimit: 64000, compressionCount: 1, compressionThreshold: 80 },
    logs: [{ time: '16:00:00', level: 'INFO', event: 'visual.ready', detail: '脱敏的验收日志' }],
    traces: [{ requestId: 'visual-request', startedAt: now, status: 'completed', model: 'deepseek-v4-flash', durationMs: 320 }],
  };
  const agentValues = {
    GetStatus: { configured: true, provider: 'DeepSeek', model: 'deepseek-v4-flash', contextLength: '64K', thinkingEnabled: true },
    GetBalance: { available: true, balances: [{ currency: 'CNY', totalBalance: '28.60' }] },
    GetModels: { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
    GetObservability: observability,
    GetTraceEvents: [],
    GetModuleConfiguration: scenario === 'modules-active' ? { enabled: true, status: 'active', directoryName: 'visual-modules', error: null, slots: [] } : { enabled: false, status: 'default', directoryName: null, error: null, slots: [] },
    Configure: { configured: true }, TestConnection: { connected: true }, SetTraceRetention: { saved: true }, ClearObservability: { cleared: true },
    SelectModuleDirectory: { enabled: true, status: 'active', directoryName: 'visual-modules', error: null, slots: [] },
    ResetModules: { enabled: false, status: 'default', directoryName: null, error: null, slots: [] },
    AcquireResumeEditLock: { acquired: true }, ReleaseResumeEditLock: { released: true }, Cancel: { cancelled: true }, ReloadSession: { reloaded: true },
  };
  window.averyAgent = new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (name === 'OnStream') return () => () => undefined;
      return () => ok(Object.prototype.hasOwnProperty.call(agentValues, name) ? agentValues[name] : { accepted: true });
    },
  });
})();
