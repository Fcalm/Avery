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
  const { developerView } = useUiStore();

  async function RefreshObservability() {
    setObservability((await GetAgentObservability()) ?? EmptyObservability);
  }

  useEffect(() => { void RefreshObservability(); }, []);

  return <div className="standard-page developer-page">
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
