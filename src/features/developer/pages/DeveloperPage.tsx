import { useEffect, useState } from 'react';
import type { AgentObservability } from '@avery/contracts';
import { GetAgentObservability } from '../../../features/assistant/api/agentQueries';
import { useUiStore } from '../../../app/UiStore';
import { Icon } from '../../../shared/components/Icon';
import { Button } from '../../../shared/components/UI';
import { EvaluationConsole } from '../components/EvaluationConsole';

const EmptyObservability: AgentObservability = { configured: false, model: '—', historySessions: 0, taskCount: 0, contextUsage: { inputTokens: 0, contextLimit: 256000, compressionCount: 0, compressionThreshold: 80 }, logs: [], traces: [] };

/** 开发者工具仅保留本地运行日志；会话轨迹统一在求职助手中查看。 */
function DeveloperPage() {
  const [observability, setObservability] = useState<AgentObservability>(EmptyObservability);
  const { developerView, setDeveloperView } = useUiStore();

  async function RefreshObservability() {
    setObservability((await GetAgentObservability()) ?? EmptyObservability);
  }

  useEffect(() => { void RefreshObservability(); }, []);

  return <div className="standard-page developer-page">
    <section className="developer-reference-overview">
      <header className="developer-reference-heading"><div><h1>开发者工具</h1><p>查看 Avery 的本地运行记录，并管理 Agent 测评。</p></div><div className="developer-reference-stats" aria-label="开发者工具数据概览"><span><b>{observability.historySessions}</b><small>历史会话</small></span><span><b>{observability.taskCount}</b><small>任务总数</small></span><span><b>{observability.contextUsage.inputTokens}</b><small>上下文输入</small></span></div></header>
    </section>
    <div className="developer-page-view-switcher" role="tablist" aria-label="开发者工具次级页面">
      <button type="button" role="tab" aria-selected={developerView === 'logs'} className={developerView === 'logs' ? 'selected' : ''} onClick={() => setDeveloperView('logs')}>
        <Icon name="logs" size={16} />运行日志
      </button>
      <button type="button" role="tab" aria-selected={developerView === 'evaluation'} className={developerView === 'evaluation' ? 'selected' : ''} onClick={() => setDeveloperView('evaluation')}>
        <Icon name="trace" size={16} />Agent 测评
      </button>
    </div>
    {developerView === 'logs' ? <section className="developer-console" aria-label="本地运行记录">
      <header className="developer-console-header">
        <div className="developer-console-title"><Icon name="logs" size={16} /><span>运行日志</span></div>
        <div className="developer-console-actions">
          <Button variant="quiet" onClick={() => void RefreshObservability()}><Icon name="refresh" size={15} />刷新</Button>
        </div>
      </header>
      <div className="log-table">{observability.logs.length
        ? observability.logs.map((item, index) => <div key={`${item.time}-${item.event}-${index}`}><time>{item.time}</time><b className={item.level.toLowerCase()}>{item.level}</b><code>{item.event}</code><span>{item.detail}</span></div>)
        : <p className="empty-copy">暂无本地运行日志。</p>}</div>
    </section> : <EvaluationConsole />}
  </div>;
}

export { DeveloperPage };
