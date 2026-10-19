import { useEffect, useState } from 'react';
import { GetConversationResult } from '@avery/agent-sdk';
import type { ChatMessageDto, ConversationPart, ConversationResource, ConversationToolStatus } from '@avery/contracts';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { WorkingIndicator } from './WorkingIndicator';

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
export const ResourceHref = (resource: ConversationResource) => 'avery://' + resource.kind + '/' + encodeURIComponent(resource.id) + (resource.revision ? '?revision=' + resource.revision : '');

/** 有序块按执行顺序展示；完成后只折叠过程，不折叠产物和最终正文。 */
export function ConversationMessage({ message, onOpenResource, authorizedResources = [] }: { message: ChatMessageDto; onOpenResource: (resource: ConversationResource) => void; authorizedResources?: ConversationResource[] }) {
  const presentation = message.presentation;
  const [processOpen, setProcessOpen] = useState(presentation?.status !== 'completed');
  useEffect(() => { setProcessOpen(presentation?.status !== 'completed'); }, [presentation?.status]);
  if (!presentation) return <>
    {message.thinkingContent && <details className="thinking-block"><summary>思考内容</summary><div className="thinking-content"><MarkdownText content={message.thinkingContent} /></div></details>}
    <MarkdownText content={message.content} />
  </>;
  const { parts, status } = presentation;
  const resources = parts.flatMap((part) => part.type === 'resource' ? [part.resource] : []);
  const linkResources = [...resources, ...authorizedResources];
  const completed = status === 'completed';
  let lastTool = -1;
  parts.forEach((part, index) => { if (part.type === 'tool') lastTool = index; });
  const process = parts.filter((part, index) => part.type !== 'resource' && (!completed || part.type !== 'text' || index <= lastTool));
  const renderPart = (part: ConversationPart) => {
    if (part.type === 'resource') return null;
    if (part.type === 'text') return <MarkdownText key={part.id} content={part.text} resources={linkResources} onOpenResource={onOpenResource} />;
    if (part.type === 'reasoning') return <details key={part.id} className="conversation-reason">
      <summary><Icon name="brain" size={17} /><span>深度思考</span><Icon name="chevron-right" className="conversation-chevron" size={12} /></summary>
      <div className="conversation-reason-body"><MarkdownText content={part.text} /></div>
    </details>;
    const icon: IconName = part.status === 'running' ? 'loading' : part.status === 'succeeded' ? 'check' : part.status === 'waiting' ? 'shield-check' : part.status === 'failed' ? 'warning' : 'clock';
    return <details key={part.id} className={'conversation-tool is-' + part.status}>
      <summary><span>{ToolNames[part.name] ?? part.name}</span><Icon name={icon} className="conversation-tool-status" size={15} /><small>{StatusLabels[part.status]}</small><Icon name="chevron-right" className="conversation-chevron" size={12} /></summary>
      <div className="conversation-tool-body"><span className="conversation-tool-name">{part.name}</span><p>{part.summary || StatusLabels[part.status]}</p>
        {part.completedAt && <small>{((part.completedAt - part.startedAt) / 1000).toFixed(1)} 秒</small>}
        {parts.flatMap((item) => item.type === 'resource' && item.stepId === part.stepId && item.toolCallId === part.toolCallId ? [item.resource] : []).map((resource) => <a key={ResourceHref(resource)} href={ResourceHref(resource)} onClick={(event) => { event.preventDefault(); onOpenResource(resource); }}>{resource.title}<Icon name="arrow-right" size={12} /></a>)}
      </div>
    </details>;
  };
  const lastPart = [...parts].reverse().find((part) => part.type !== 'resource');
  const workingLabel = lastPart?.type === 'tool' ? ToolNames[lastPart.name] ?? '正在执行工具' : lastPart?.type === 'reasoning' ? '正在梳理与分析' : '正在整理结果';
  return <div className="conversation-response">
    {(status === 'running' || status === 'waiting' || status === 'paused') && <WorkingIndicator waiting={status !== 'running'} label={status === 'waiting' ? '等待你的确认或回答' : status === 'paused' ? '任务已暂停' : workingLabel} />}
    {process.length > 0 && <details className="conversation-process" open={processOpen} onToggle={(event) => setProcessOpen(event.currentTarget.open)}>
      <summary><Icon name={completed ? 'check' : 'trace'} size={16} /><span>{completed ? '查看处理过程' : '处理过程'}</span><small>{parts.filter((part) => part.type === 'reasoning').length} 段思考 · {parts.filter((part) => part.type === 'tool').length} 项工具</small><Icon name="chevron-right" className="conversation-chevron" size={12} /></summary>
      <div className="conversation-process-body">{process.map(renderPart)}</div>
    </details>}
    {resources.filter((resource) => resource.produced).map((resource) => <button key={ResourceHref(resource)} className="conversation-resource" type="button" onClick={() => onOpenResource(resource)}>
      <span className="conversation-resource-symbol"><Icon name={ResourceMeta[resource.kind].icon} size={22} /></span>
      <span className="conversation-resource-copy"><strong>{resource.title}{resource.revision && <small>v{resource.revision}</small>}</strong><span>{ResourceMeta[resource.kind].label} · 已保存，点击查看</span></span><Icon name="arrow-right" size={15} />
    </button>)}
    {completed && <MarkdownText content={GetConversationResult(presentation)} resources={linkResources} onOpenResource={onOpenResource} />}
    {presentation.error && <p className="conversation-run-error" role="alert">{presentation.error}</p>}
    {status === 'cancelled' && <p className="conversation-run-note">已停止生成，已保留本轮过程。</p>}
  </div>;
}
