import { useEffect, useState } from 'react';
import { GetConversationArtifacts, GetConversationResult } from '@avery/agent-sdk';
import type { ChatMessageDto, ConversationPart, ConversationResource, ConversationToolStatus } from '@avery/contracts';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { WorkingIndicator } from './WorkingIndicator';
import { ConversationProcessSummary } from './ConversationProcessSummary';

const ToolNames: Record<string, string> = {
  ReadResume: '读取简历', ReadProfile: '读取档案', ReadJobs: '查询岗位', SearchJobs: '搜索岗位',
  CreateResume: '创建简历', UpdateResume: '更新简历', UpdateProfile: '更新档案', SaveJob: '保存岗位',
  UpdateApplicationStatus: '更新投递记录', ExportResumeFile: '导出简历', AskUserQuestion: '询问用户',
  CreateTodo: '创建待办', UpdateTodo: '更新待办', DeleteTodo: '删除待办', ReadTodo: '读取待办',
  CreateCronTask: '创建定时任务', ReadCronTask: '读取定时任务', UpdateCronTask: '更新定时任务',
  BrowserNavigate: '打开网页', BrowserSnapshot: '读取页面', BrowserFillForm: '填写表单',
  BrowserClick: '点击页面', BrowserUploadFile: '上传资料', BrowserValidateForm: '核对表单',
  CollectJobs: '采集岗位', ContactBossJobs: '联系招聘方', Read: '读取文件', Grep: '搜索文件', Glob: '查找文件', LoadSkill: '加载技能',
};
const StatusLabels: Record<ConversationToolStatus, string> = {
  running: '正在执行', succeeded: '已完成', waiting: '等待确认或回答', paused: '已暂停',
  failed: '执行失败', cancelled: '已取消', skipped: '未执行',
};
const ResourceMeta: Record<ConversationResource['kind'], { label: string; icon: IconName }> = {
  resume: { label: '简历', icon: 'resumes' }, profile: { label: '档案', icon: 'profiles' },
  job: { label: '岗位', icon: 'jobs' }, application: { label: '投递记录', icon: 'applications' }, file: { label: '文件', icon: 'resume' },
};
const ToolTimeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const ResourceHref = (resource: ConversationResource) => 'avery://' + resource.kind + '/' + encodeURIComponent(resource.id) + (resource.revision ? '?revision=' + resource.revision : '');

/** 非最终报告统一按执行顺序放入过程；正文完整显示，思考和工具各自折叠。 */
export function ConversationMessage({ message, onOpenResource, authorizedResources = [] }: { message: ChatMessageDto; onOpenResource: (resource: ConversationResource) => void; authorizedResources?: ConversationResource[] }) {
  const presentation = message.presentation;
  const completed = presentation?.status === 'completed';
  const processActive = presentation?.status === 'running' || presentation?.status === 'waiting' || presentation?.status === 'paused';
  const [processOpen, setProcessOpen] = useState(false);
  // 新一轮、恢复运行和结束时均默认收起；运行与等待确认之间切换时保留用户手动开合。
  useEffect(() => { setProcessOpen(false); }, [presentation?.requestId, processActive]);
  if (!presentation) return <>
    {message.thinkingContent && <details className="thinking-block"><summary>思考内容</summary><div className="thinking-content conversation-event-scroll" tabIndex={0} role="region" aria-label="思考详情"><MarkdownText content={message.thinkingContent} /></div></details>}
    <MarkdownText content={message.content} />
  </>;
  const { parts, status } = presentation;
  const resources = parts.flatMap((part) => part.type === 'resource' ? [part.resource] : []);
  const linkResources = [...resources, ...authorizedResources];
  const artifacts = GetConversationArtifacts(presentation);
  let lastTool = -1;
  parts.forEach((part, index) => { if (part.type === 'tool') lastTool = index; });
  const process = parts.filter((part, index) => part.type !== 'resource' && (!completed || part.type !== 'text' || index <= lastTool));
  const renderPart = (part: ConversationPart) => {
    if (part.type === 'resource') return null;
    if (part.type === 'text') return <div key={part.id} className="conversation-process-text"><MarkdownText content={part.text} resources={linkResources} onOpenResource={onOpenResource} /></div>;
    if (part.type === 'reasoning') return <details key={part.id} className="conversation-reason">
      <summary><Icon name="brain" size={14} /><span>深度思考</span><Icon name="chevron-right" className="conversation-chevron" size={10} /></summary>
      <div className="conversation-reason-body conversation-event-scroll" tabIndex={0} role="region" aria-label="深度思考详情"><MarkdownText content={part.text} /></div>
    </details>;
    const icon: IconName = part.status === 'running' ? 'loading' : part.status === 'succeeded' ? 'check' : part.status === 'waiting' ? 'shield-check' : part.status === 'failed' ? 'warning' : 'clock';
    const toolResources = parts.flatMap((item) => item.type === 'resource' && item.stepId === part.stepId && item.toolCallId === part.toolCallId ? [item.resource] : []);
    const endLabel = part.status === 'waiting' ? '等待开始' : part.status === 'paused' ? '暂停于' : '结束';
    return <details key={part.id} className={'conversation-tool is-' + part.status}>
      <summary><Icon name="wrench" className="conversation-tool-icon" size={14} /><span>{ToolNames[part.name] ?? part.name}</span><Icon name={icon} className="conversation-tool-status" size={12} /><small>{StatusLabels[part.status]}</small><Icon name="chevron-right" className="conversation-chevron" size={10} /></summary>
      <div className="conversation-tool-body conversation-event-scroll" tabIndex={0} role="region" aria-label={`${ToolNames[part.name] ?? part.name}详情`}>
        <div className="conversation-tool-heading"><code>{part.name}</code><span>{StatusLabels[part.status]}</span></div>
        <pre className="conversation-tool-output">{part.summary || StatusLabels[part.status]}</pre>
        {/* 仅展示投影已授权的资料信息；工具详情不再承担打开侧栏的入口。 */}
        {toolResources.length > 0 && <section className="conversation-tool-resources" aria-label="关联资料">
          <h4>关联资料 · {toolResources.length}</h4>
          <ul>{toolResources.map((resource) => <li key={ResourceHref(resource)}>
            <span>{ResourceMeta[resource.kind].label}</span><div>{resource.title}{resource.revision !== undefined && <small>版本 {resource.revision}</small>}{resource.fileName && resource.fileName !== resource.title && <small>{resource.fileName}</small>}</div>
          </li>)}</ul>
        </section>}
        <dl className="conversation-tool-meta">
          <div><dt>开始</dt><dd><time dateTime={new Date(part.startedAt).toISOString()}>{ToolTimeFormat.format(part.startedAt)}</time></dd></div>
          {part.completedAt !== undefined && <>
            <div><dt>{endLabel}</dt><dd><time dateTime={new Date(part.completedAt).toISOString()}>{ToolTimeFormat.format(part.completedAt)}</time></dd></div>
            <div><dt>阶段用时</dt><dd>{((part.completedAt - part.startedAt) / 1000).toFixed(1)} 秒</dd></div>
          </>}
        </dl>
      </div>
    </details>;
  };
  const lastPart = [...parts].reverse().find((part) => part.type !== 'resource');
  const workingLabel = lastPart?.type === 'tool' ? ToolNames[lastPart.name] ?? '正在执行工具' : lastPart?.type === 'reasoning' ? '正在梳理与分析' : '正在整理结果';
  return <div className="conversation-response">
    {/* 动画独立于折叠过程，按整轮状态持续显示，生成最终报告期间也不提前隐藏。 */}
    {processActive && <WorkingIndicator waiting={status !== 'running'} label={status === 'waiting' ? '等待你的确认或回答' : status === 'paused' ? '任务已暂停' : workingLabel} />}
    {(process.length > 0 || processActive) && <details className="conversation-process" open={processOpen} onToggle={(event) => setProcessOpen(event.currentTarget.open)}>
      <ConversationProcessSummary presentation={presentation} messageCreatedAt={message.createdAt} messageUpdatedAt={message.updatedAt} />
      <div className="conversation-process-body">
        {process.map(renderPart)}
      </div>
    </details>}
    {completed && <MarkdownText content={GetConversationResult(presentation)} resources={linkResources} onOpenResource={onOpenResource} />}
    {completed && artifacts.length > 0 && <div className="conversation-artifacts" aria-label="本轮产物">
      {artifacts.map((resource) => <button key={JSON.stringify([resource.kind, resource.id])} className="conversation-resource" type="button" onClick={() => onOpenResource(resource)} aria-label={`查看${ResourceMeta[resource.kind].label}：${resource.title}${resource.revision ? `，版本 ${resource.revision}` : ''}`}>
        <span className="conversation-resource-symbol"><Icon name={ResourceMeta[resource.kind].icon} size={22} /></span>
        <span className="conversation-resource-copy">
          <strong><span>{resource.title}</span>{resource.revision !== undefined && <small>v{resource.revision}</small>}</strong>
          {resource.lineChanges && <span className="conversation-resource-changes">
            {resource.lineChanges.added > 0 && <span className="is-added" aria-label={`新增 ${resource.lineChanges.added} 行`}>+{resource.lineChanges.added}</span>}
            {resource.lineChanges.removed > 0 && <span className="is-removed" aria-label={`删除 ${resource.lineChanges.removed} 行`}>−{resource.lineChanges.removed}</span>}
          </span>}
        </span>
        <Icon name="arrow-right" size={15} />
      </button>)}
    </div>}
    {presentation.error && <p className="conversation-run-error" role="alert">{presentation.error}</p>}
    {status === 'cancelled' && <p className="conversation-run-note">已停止生成，已保留本轮过程。</p>}
  </div>;
}
