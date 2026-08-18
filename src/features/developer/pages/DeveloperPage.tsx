import { useEffect, useState } from 'react';
import type { AgentObservability } from '@offerget/contracts';
import { DeleteAgentTraces, GetAgentObservability, GetAgentTraceEvents } from '../../../features/assistant/api/agentQueries';
import { useConversations } from '../../../features/conversation';
import { Icon } from '../../../shared/components/Icon';
import { Button } from '../../../shared/components/UI';
import { TraceViewer } from '../components/TraceViewer';

const EmptyObservability: AgentObservability = { configured: false, model: '—', historySessions: 0, taskCount: 0, contextUsage: { inputTokens: 0, contextLimit: 64000, compressionCount: 0, compressionThreshold: 80 }, logs: [], traces: [] };

/** 本地运行记录：只保留可排障的日志与请求 Trace，避免概览信息分散注意力。 */
function DeveloperPage() {
  const [tab, setTab] = useState<'logs' | 'trace'>('trace');
  const [observability, setObservability] = useState<AgentObservability>(EmptyObservability);
  const conversations = useConversations();

  async function RefreshObservability() {
    setObservability((await GetAgentObservability()) ?? EmptyObservability);
  }

  async function DeleteTraces(sessionIds: string[]) {
    await DeleteAgentTraces(sessionIds);
    await RefreshObservability();
  }

  useEffect(() => { void RefreshObservability(); }, []);

  return <div className="standard-page developer-page">
    <section className="developer-console" aria-label="本地运行记录">
      <header className="developer-console-header">
        <div className="tabs" role="tablist" aria-label="开发者记录视图">
          <button type="button" role="tab" aria-selected={tab === 'trace'} className={tab === 'trace' ? 'selected' : ''} onClick={() => setTab('trace')}><Icon name="trace" size={15} />运行轨迹</button>
          <button type="button" role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'selected' : ''} onClick={() => setTab('logs')}><Icon name="logs" size={15} />运行日志</button>
        </div>
        <div className="developer-console-actions">
          <Button variant="quiet" onClick={() => void RefreshObservability()}><Icon name="refresh" size={15} />刷新</Button>
        </div>
      </header>
      {tab === 'logs'
        ? <div className="log-table">{observability.logs.length
          ? observability.logs.map((item, index) => <div key={`${item.time}-${item.event}-${index}`}><time>{item.time}</time><b className={item.level.toLowerCase()}>{item.level}</b><code>{item.event}</code><span>{item.detail}</span></div>)
          : <p className="empty-copy">暂无本地运行日志。</p>}</div>
        : <TraceViewer traces={observability.traces} conversations={conversations} onSelectTrace={GetAgentTraceEvents} onDeleteTraces={DeleteTraces} />}
    </section>
  </div>;
}

export { DeveloperPage };
