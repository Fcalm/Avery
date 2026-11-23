import { GetConversationArtifacts, GetConversationResult } from '@avery/agent-sdk';
import type { ChatMessageDto, ConversationPart, ConversationResource } from '@avery/contracts';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { WorkingIndicator } from './WorkingIndicator';

const ToolNames: Record<string, string> = {
  CompactContext: '压缩上下文',
  ReadResume: '读取简历', ReadProfile: '读取档案', ReadJobs: '查询岗位', SearchJobs: '搜索岗位',
  CreateResume: '创建简历', UpdateResume: '更新简历', UpdateProfile: '更新档案', SaveJob: '保存岗位',
  UpdateApplicationStatus: '更新投递记录', ExportResumeFile: '导出简历', AskUserQuestion: '询问用户',
  WriteTodo: '写入待办', CreateTodo: '创建待办', UpdateTodo: '更新待办', DeleteTodo: '删除待办', ReadTodo: '读取待办',
  CreateCronTask: '创建定时任务', ReadCronTask: '读取定时任务', UpdateCronTask: '更新定时任务',
  BrowserNavigate: '打开网页', BrowserSnapshot: '读取页面', BrowserFillForm: '填写表单',
  BrowserClick: '点击页面', BrowserUploadFile: '上传资料', BrowserValidateForm: '核对表单',
  CollectJobs: '采集岗位', ContactBossJobs: '联系招聘方', Read: '读取文件', Grep: '搜索文件', Glob: '查找文件', LoadSkill: '加载技能',
};
const ResourceMeta: Record<ConversationResource['kind'], { label: string; icon: IconName }> = {
  resume: { label: '简历', icon: 'resumes' }, profile: { label: '档案', icon: 'profiles' },
  job: { label: '岗位', icon: 'jobs' }, application: { label: '投递记录', icon: 'applications' }, file: { label: '文件', icon: 'resume' },
};
const GoalReviewLabels: Record<Extract<ConversationPart, { type: 'goal_review' }>['status'], string> = {
  reviewing: '审核中', achieved: '已通过', continue: '继续处理', waiting: '等待补充',
  paused: '已暂停', blocked: '无法达成', interrupted: '已中断',
};

/** 助手消息只保留工作状态、中间正文和最终报告；思考与工具轨迹仍由 presentation 携带，不再展开展示。 */
export function ConversationMessage({ message, onOpenResource, authorizedResources = [], working = false }: { message: ChatMessageDto; onOpenResource: (resource: ConversationResource) => void; authorizedResources?: ConversationResource[]; working?: boolean }) {
  const presentation = message.presentation;
  if (!presentation) return <>
    {working && <WorkingIndicator label="正在整理结果" />}
    {message.thinkingContent && <details className="thinking-block"><summary>思考内容</summary><div className="thinking-content conversation-event-scroll" tabIndex={0} role="region" aria-label="思考详情"><MarkdownText content={message.thinkingContent} /></div></details>}
    <MarkdownText content={message.content} />
  </>;
  const { parts, status } = presentation;
  const completed = status === 'completed';
  const running = status === 'running';
  const resources = parts.flatMap((part) => part.type === 'resource' ? [part.resource] : []);
  const linkResources = [...resources, ...authorizedResources];
  const artifacts = GetConversationArtifacts(presentation);
  let lastTool = -1;
  parts.forEach((part, index) => { if (part.type === 'tool') lastTool = index; });
  // 最终报告之前的正文继续按原顺序展示；已完成时只排除最后一段报告。
  const intermediate = parts.flatMap((part, index) => part.type === 'goal_review' || (part.type === 'text' && (part.intermediate || !completed || index <= lastTool)) ? [part] : []);
  const lastPart = [...parts].reverse().find((part) => part.type !== 'resource');
  const workingLabel = lastPart?.type === 'goal_review' && lastPart.status === 'reviewing' ? '正在审核目标'
    : lastPart?.type === 'tool' ? ToolNames[lastPart.name] ?? '正在执行工具' : lastPart?.type === 'reasoning' ? '正在梳理与分析' : '正在整理结果';
  // 结束后使用落盘时间定格，避免计时器停留在最后一次 100ms 刷新的近似值。
  const startedAt = presentation.startedAt ?? message.createdAt;
  const endedAt = running ? undefined : presentation.completedAt ?? presentation.pausedAt ?? message.updatedAt;
  return <div className="conversation-response">
    {/* 运行、等待和结束共用同一条状态行，动画收起后计时器留在原处并过渡到左顶格。 */}
    <WorkingIndicator label={presentation.statusMessage ?? workingLabel} running={running} startedAt={startedAt} endedAt={endedAt} />
    {(status === 'waiting' || status === 'paused') && <p className="conversation-run-note" role="status">{presentation.statusMessage ?? (status === 'waiting' ? '等待你的确认或回答，处理过程已保留。' : '任务已暂停，处理过程已保留。')}</p>}
    {intermediate.map((part) => part.type === 'goal_review'
      ? <details key={part.id} className="thinking-block">
        <summary>{part.phase === 'resume' ? '续跑审核' : '交付审核'} · {GoalReviewLabels[part.status]}</summary>
        <div className="thinking-content">{part.summary}</div>
      </details>
      : <div key={part.id} className="conversation-process-text"><MarkdownText content={part.text} resources={linkResources} onOpenResource={onOpenResource} /></div>)}
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
