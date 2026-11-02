import { cloneElement, useId, useState, type ReactElement } from 'react';
import { JobCollectionInputSchema, JobCollectionLimits, type JobCollectionInput, type JobCollectionState, type JobCollectionTask, type JobSeekingType, type JobQuery } from '@avery/contracts';
import { DialogButton, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { JobConditionGroups, type JobConditions } from '../api/jobConditions';
import type { useJobCollection } from '../api/jobCollection';

const StateLabels: Record<JobCollectionState, string> = {
  running: '采集中', completed: '采集完成', completed_with_shortage: '采集结束 · 数量不足',
  cancelled: '已取消', interrupted: '采集已中断', timed_out: '采集超时', failed: '采集失败',
};
const ChannelTitles = { company_website: '企业官网', campus_aggregator: '校招信息汇总', boss_zhipin: 'BOSS直聘' } as const;
const CollectionFilterGroups = JobConditionGroups.filter((group) => group.key === 'jobSeekingType' || group.key === 'education');

interface CollectionControlProps {
  id?: string;
  'aria-describedby'?: string;
  ariaDescribedBy?: string;
  'aria-required'?: boolean;
  ariaRequired?: boolean;
}

/** 显式关联标题与控件，说明和网格留白不放入 label，避免点击远处仍聚焦或展开控件。 */
function CollectionField({ label, hint, required = false, children }: {
  label: string; hint?: string; required?: boolean; children: ReactElement<CollectionControlProps>;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  const hintId = `${id}-hint`;
  const isSelect = children.type === Select;
  const describedBy = [isSelect ? children.props.ariaDescribedBy : children.props['aria-describedby'], hint ? hintId : undefined].filter(Boolean).join(' ') || undefined;
  const control = cloneElement(children, { id, ...(isSelect
    ? { ariaDescribedBy: describedBy, ariaRequired: required || children.props.ariaRequired }
    : { 'aria-describedby': describedBy, 'aria-required': required || children.props['aria-required'] }) });
  return <div className="form-field job-collection-field">
    <label htmlFor={id}>{label}{required && <i className="profile-field-required" aria-hidden="true">*</i>}</label>
    {control}{hint && <small id={hintId}>{hint}</small>}
  </div>;
}

/** 进度只表达已确认的数量，不因任务结束或来源遍历完成而伪造 100%。 */
function CollectionProgress({ task }: { task: JobCollectionTask }) {
  const running = task.status === 'running';
  const failed = task.status === 'failed';
  const percent = Math.min(100, Math.floor(task.collected / task.request.targetCount * 100));
  const processed = task.sources.filter((source) => ['completed', 'partial', 'failed'].includes(source.status)).length;
  const failedSources = task.sources.filter((source) => source.status === 'failed').length;
  const tone = running ? 'running' : failed ? 'danger' : task.status === 'completed' ? 'success' : 'muted';
  return <section className={`job-collection-progress is-${tone}`} aria-label="采集进度">
    <div className="jc-progress-heading">
      <div className="jc-progress-title" role="status" aria-live="polite"><Icon name={running ? 'loading' : failed ? 'warning-circle' : task.status === 'completed' ? 'check-circle' : 'info'} size={17} className={running ? 'jc-spinning' : ''} /><h3>{StateLabels[task.status]}</h3></div>
      <span className="jc-progress-percent">{percent}<small>%</small></span>
    </div>
    <div className="jc-progress-caption"><span>{ChannelTitles[task.request.channel]}</span><span>已找到 <b>{task.collected}</b> / {task.request.targetCount} 个</span></div>
    <progress max={task.request.targetCount} value={task.collected} aria-label="已找到岗位数量" aria-valuetext={`已找到 ${task.collected} 个，目标 ${task.request.targetCount} 个`} />
    <dl className="jc-progress-stats">
      <div className="is-accent"><dt>新增岗位</dt><dd>{task.inserted}</dd></div>
      <div><dt>已在库中</dt><dd>{task.existing}</dd></div>
      <div><dt>已检查</dt><dd>{task.scanned}</dd></div>
      <div className={task.failedWrites ? 'is-danger' : ''}><dt>入库失败</dt><dd>{task.failedWrites}</dd></div>
    </dl>
    {(task.skippedDeleted > 0 || failedSources > 0) && <p className="jc-progress-note">{[task.skippedDeleted ? `跳过已删除 ${task.skippedDeleted} 个` : '', failedSources ? `${failedSources} 个来源采集失败` : ''].filter(Boolean).join(' · ')}</p>}
    {task.discovery && <div className="jc-discovery"><Icon name="search" size={14} /><span>发现公告 {task.discovery.total} 条 · 匹配 {task.discovery.matched} 条 · 招聘入口 {task.discovery.sources} 个 · 跳过 {task.discovery.skipped} 条</span></div>}
    {task.sources.length > 0 ? <details className="jc-progress-details">
      <summary><span>采集详情 <small>{processed} / {task.sources.length} 个来源已处理</small></span><Icon name="chevron-down" size={12} /></summary>
      <ul className="jc-source-results">{task.sources.map((source) => {
        const label = source.status === 'pending' ? running ? '待采集' : '未执行' : source.status === 'running' ? '采集中' : source.status === 'completed' ? '读取完成' : source.status === 'failed' ? '失败' : '部分采集';
        const icon = source.status === 'running' ? 'loading' : source.status === 'failed' ? 'warning-circle' : source.status === 'completed' ? 'check-circle' : source.status === 'partial' ? 'info' : 'clock';
        return <li key={source.sourceId} className={`jc-source-result is-${source.status}`}>
          <div className="jc-source-result-head"><Icon name={icon} size={14} className={source.status === 'running' ? 'jc-spinning' : ''} /><b title={source.company}>{source.company}</b><span className="jc-source-status">{label}</span></div>
          <div className="jc-source-result-meta">读取 {source.received} 条记录 · {source.segments} 段{source.browserAssisted ? ' · 浏览器读取' : ''}</div>
          {source.error && <p className="jc-source-result-error">{source.error}</p>}
        </li>;
      })}</ul>
    </details> : running && <p className="jc-progress-note">正在查找招聘信息…</p>}
    {task.warnings.length > 0 && <details className="jc-progress-warnings" open={failed}>
      <summary><span><Icon name="warning-circle" size={14} />{task.warnings.length} 条采集提示</span><Icon name="chevron-down" size={12} /></summary>
      <ul>{task.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}
  </section>;
}

/** 采集与列表筛选独立；只有显式点击复制才带入当前列表中支持的条件。 */
export function JobCollectionPanel({ open, onClose, conditions, collection }: {
  open: boolean; onClose(): void; conditions: JobConditions; collection: ReturnType<typeof useJobCollection>;
}) {
  const [keyword, setKeyword] = useState('');
  const [keywordScope, setKeywordScope] = useState<'all' | 'title'>('all');
  const [channel, setChannel] = useState<JobCollectionInput['channel']>('company_website');
  const [count, setCount] = useState<number>(JobCollectionLimits.defaultCount);
  const [city, setCity] = useState('全国');
  const [company, setCompany] = useState('');
  const [graduationYear, setGraduationYear] = useState('');
  const [batch, setBatch] = useState('');
  const [jobSeekingType, setJobSeekingType] = useState<'any' | JobSeekingType>('any');
  const [education, setEducation] = useState<'any' | JobQuery['educations'][number]>('any');
  const sectionId = useId();
  const { sources, task, start, cancel } = collection;
  const currentTask = task.data;
  const busy = start.isPending || currentTask?.status === 'running';
  const needsSources = channel === 'company_website';
  const error = start.error ?? cancel.error ?? (needsSources ? sources.error : null) ?? task.error;
  function CopyFilters() {
    setKeyword(conditions.keyword);
    if (conditions.channel === 'boss_zhipin' || conditions.channel === 'company_website') setChannel(conditions.channel);
    if (conditions.city !== 'any' && conditions.city !== '远程') setCity(conditions.city);
    setJobSeekingType(conditions.jobSeekingType as typeof jobSeekingType);
    setEducation(conditions.education as typeof education);
  }
  const request: JobCollectionInput = {
    keyword, keywordScope, channel, targetCount: count,
    jobSeekingTypes: jobSeekingType === 'any' ? [] : [jobSeekingType],
    educations: education === 'any' ? [] : [education],
    ...(city.trim() ? { city: city.trim() } : {}),
    ...(channel === 'campus_aggregator' ? { ...(company.trim() ? { company: company.trim() } : {}), ...(graduationYear ? { graduationYear: Number(graduationYear) } : {}), ...(batch.trim() ? { batch: batch.trim() } : {}) } : {}),
  };
  const validYear = !graduationYear || /^\d{4}$/.test(graduationYear);
  const canStart = JobCollectionInputSchema.safeParse(request).success && (channel !== 'campus_aggregator' || validYear) && (!needsSources || Boolean(sources.data?.length));
  return <Modal open={open} title="采集岗位" onClose={onClose} variant="dialog" footer={<>
    <DialogButton onClick={onClose}>关闭</DialogButton>
    {currentTask?.status === 'running' ? <DialogButton disabled={cancel.isPending} onClick={() => cancel.mutate(currentTask.taskId)}>{cancel.isPending ? '正在停止…' : '取消采集'}</DialogButton>
      : <DialogButton tone="accent" disabled={busy || !canStart} onClick={() => start.mutate(request)}>{start.isPending ? '正在启动…' : '开始采集'}</DialogButton>}
  </>}>
    <div className="job-collection-form">
      {error && <p role="alert" className="job-source-error">{error.message}</p>}
      {currentTask && <CollectionProgress task={currentTask} />}
      <fieldset className="job-collection-section" disabled={busy} aria-labelledby={`${sectionId}-setup`}>
        <div className="job-collection-section-head"><h3 id={`${sectionId}-setup`}>采集设置</h3></div>
        <div className="form-two-col">
          <CollectionField label="渠道"><Select value={channel} disabled={busy} ariaLabel="采集渠道" options={Object.entries(ChannelTitles).map(([value, label]) => ({ value, label }))} onChange={(value) => setChannel(value as typeof channel)} /></CollectionField>
          <CollectionField label="采集数量" hint="包含新增及已在库的岗位。"><input type="number" min={1} max={JobCollectionLimits.maxCount} value={count || ''} onChange={(event) => setCount(Number(event.target.value))} /></CollectionField>
        </div>
      </fieldset>
      <fieldset className="job-collection-section" disabled={busy} aria-labelledby={`${sectionId}-filters`}>
        <div className="job-collection-section-head"><h3 id={`${sectionId}-filters`}>筛选条件</h3><button className="ghost-btn jc-copy-filters" disabled={busy} type="button" onClick={CopyFilters}><Icon name="copy" size={13} />复制列表条件</button></div>
        <CollectionField label="关键词" required={channel === 'boss_zhipin'}><input value={keyword} maxLength={500} onChange={(event) => setKeyword(event.target.value)} placeholder="例如：产品经理" /></CollectionField>
        <div className="form-two-col">
          <CollectionField label="匹配范围"><Select value={keywordScope} disabled={busy} ariaLabel="关键词范围" options={[{ value: 'all', label: '岗位、企业与 JD' }, { value: 'title', label: '仅岗位名称' }]} onChange={(value) => setKeywordScope(value as typeof keywordScope)} /></CollectionField>
          <CollectionField label="城市" required={channel === 'boss_zhipin'}><input value={city} maxLength={100} onChange={(event) => setCity(event.target.value)} placeholder="全国、北京、上海、深圳…" /></CollectionField>
        </div>
        <div className="form-two-col">
          {CollectionFilterGroups.map((group) => <CollectionField key={group.key} label={group.label}>
            <Select value={group.key === 'jobSeekingType' ? jobSeekingType : education} disabled={busy} ariaLabel={`采集${group.label}`} options={channel === 'campus_aggregator' && group.key === 'jobSeekingType' ? group.options.map((option) => option.value === 'any' ? { ...option, label: '校招与实习' } : option) : group.options}
              onChange={(value) => group.key === 'jobSeekingType' ? setJobSeekingType(value as typeof jobSeekingType) : setEducation(value as typeof education)} />
          </CollectionField>)}
        </div>
        {channel === 'campus_aggregator' && <>
          <CollectionField label="公司"><input value={company} maxLength={200} onChange={(event) => setCompany(event.target.value)} placeholder="不限" /></CollectionField>
          <div className="form-two-col">
            <CollectionField label="毕业届别"><input value={graduationYear} maxLength={4} inputMode="numeric" onChange={(event) => setGraduationYear(event.target.value)} placeholder="例如：2027" /></CollectionField>
            <CollectionField label="批次"><input value={batch} maxLength={100} onChange={(event) => setBatch(event.target.value)} placeholder="例如：秋招、提前批" /></CollectionField>
          </div>
        </>}
        <p className="job-collection-hint">同时满足所选条件才入库；选择学历或求职类型后，未说明对应信息的岗位会被跳过。</p>
        {channel === 'campus_aggregator' && <p className="job-collection-hint">届别和批次仅筛选公告，任职资格以官网为准。<a href="https://campus.sma-wiki.cn/campus/campus_recruit.html?channel=bz" target="_blank" rel="noreferrer">查看公告来源</a></p>}
        {channel === 'boss_zhipin' && <p className="job-collection-hint">请先连接已登录 BOSS 的浏览器；遇到登录失效或验证时会停止采集。</p>}
        {needsSources && sources.isPending && <p className="job-collection-hint" role="status">正在读取采集渠道…</p>}
        {needsSources && sources.isSuccess && !sources.data.length && <p className="job-source-error" role="alert">暂无可用的企业招聘来源。</p>}
      </fieldset>
    </div>
  </Modal>;
}
