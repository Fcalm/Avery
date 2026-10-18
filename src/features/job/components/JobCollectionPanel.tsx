import { useEffect, useState } from 'react';
import { JobCollectionLimits, type JobCollectionState, type JobSeekingType, type JobQuery } from '@avery/contracts';
import { DialogButton, FormField, Modal, Select } from '../../../shared/components/UI';
import { JobConditionGroups, type JobConditions } from '../api/jobConditions';
import type { useJobCollection } from '../api/jobCollection';

const StateLabels: Record<JobCollectionState, string> = {
  running: '采集中', completed: '采集完成', completed_with_shortage: '采集结束（数量不足）',
  cancelled: '已取消', interrupted: '应用退出中断', timed_out: '达到任务期限', failed: '采集失败',
};
const SourceSelectionKey = 'avery.job-collection.source-selection.v1';
const CollectionFilterGroups = JobConditionGroups.filter((group) => group.key === 'jobSeekingType' || group.key === 'education');
type SourceSelection = { scope: 'all' | 'selected'; ids: string[] };
function LoadSourceSelection(): SourceSelection {
  try {
    const value = JSON.parse(localStorage.getItem(SourceSelectionKey) ?? 'null') as SourceSelection | null;
    if (value && ['all', 'selected'].includes(value.scope) && Array.isArray(value.ids)
      && value.ids.length <= 1000 && value.ids.every((id) => typeof id === 'string' && id.length <= 100)) return value;
  } catch (error) { console.warn('岗位采集来源选择读取失败。', error); }
  return { scope: 'all', ids: [] };
}

/** 采集与列表筛选独立；只有显式点击复制才带入当前列表中支持的条件。 */
export function JobCollectionPanel({ open, onClose, conditions, collection }: {
  open: boolean; onClose(): void; conditions: JobConditions; collection: ReturnType<typeof useJobCollection>;
}) {
  const [keyword, setKeyword] = useState('');
  const [channel, setChannel] = useState<'company_website' | 'boss_zhipin'>('company_website');
  const [count, setCount] = useState<number>(JobCollectionLimits.defaultCount);
  const [city, setCity] = useState('全国');
  const [jobSeekingType, setJobSeekingType] = useState<'any' | JobSeekingType>('any');
  const [education, setEducation] = useState<'any' | JobQuery['educations'][number]>('any');
  const [selection, setSelection] = useState<SourceSelection>(LoadSourceSelection);
  useEffect(() => {
    try { localStorage.setItem(SourceSelectionKey, JSON.stringify(selection)); }
    catch (error) { console.warn('岗位采集来源选择保存失败。', error); }
  }, [selection]);
  const { sources, task, start, cancel, setEnabled } = collection;
  const currentTask = task.data;
  const busy = start.isPending || currentTask?.status === 'running';
  const enabled = sources.data?.filter((source) => source.enabled) ?? [];
  const selected = selection.ids.filter((id) => enabled.some((source) => source.sourceId === id));
  const error = start.error ?? cancel.error ?? setEnabled.error ?? sources.error ?? task.error;
  function CopyFilters() {
    setKeyword(conditions.keyword);
    if (conditions.channel === 'boss_zhipin' || conditions.channel === 'company_website') setChannel(conditions.channel);
    if (conditions.city !== 'any' && conditions.city !== '远程') setCity(conditions.city);
    setJobSeekingType(conditions.jobSeekingType as typeof jobSeekingType);
    setEducation(conditions.education as typeof education);
  }
  function Start() {
    start.mutate({ keyword, channel, targetCount: count,
      jobSeekingTypes: jobSeekingType === 'any' ? [] : [jobSeekingType],
      educations: education === 'any' ? [] : [education],
      ...(channel === 'boss_zhipin' ? { city } : selection.scope === 'selected' ? { sourceIds: selected } : {}),
    });
  }
  const validCount = Number.isInteger(count) && count >= 1 && count <= JobCollectionLimits.maxCount;
  const canStart = validCount && (channel === 'boss_zhipin' ? Boolean(keyword.trim() && city.trim()) : enabled.length > 0 && (selection.scope === 'all' || selected.length > 0));
  return <Modal open={open} title="采集岗位" onClose={onClose} variant="dialog" footer={<>
    <DialogButton onClick={onClose}>关闭</DialogButton>
    {currentTask?.status === 'running' ? <DialogButton disabled={cancel.isPending} onClick={() => cancel.mutate(currentTask.taskId)}>{cancel.isPending ? '正在停止…' : '取消采集'}</DialogButton>
      : <DialogButton tone="accent" disabled={busy || setEnabled.isPending || !canStart} onClick={Start}>{start.isPending ? '正在启动…' : '开始采集'}</DialogButton>}
  </>}>
    <div className="job-collection-form">
      <p className="job-collection-hint">采集结果直接保存到岗位库，不调用模型、不要求简历。重复岗位不会重复新增，已删除岗位不会恢复。</p>
      <button className="ghost-btn" disabled={busy} type="button" onClick={CopyFilters}>复制当前列表的可用条件</button>
      <fieldset disabled={busy}>
        <FormField label="关键词" hint={channel === 'company_website' ? '匹配岗位名称、企业名称或 JD；留空采集全部岗位。' : '请输入 BOSS 搜索关键词。'}><input value={keyword} maxLength={500} onChange={(event) => setKeyword(event.target.value)} placeholder="例如：产品经理" /></FormField>
        <div className="form-two-col">
          <FormField label="渠道"><Select value={channel} ariaLabel="采集渠道" options={[{ value: 'company_website', label: '企业官网' }, { value: 'boss_zhipin', label: 'BOSS直聘' }]} onChange={(value) => setChannel(value as typeof channel)} /></FormField>
          <FormField label="采集数量" hint="包括新增及已在库的唯一岗位，不保证全部为新增。"><input type="number" min={1} max={JobCollectionLimits.maxCount} value={count || ''} onChange={(event) => setCount(Number(event.target.value))} /></FormField>
        </div>
        <div className="form-two-col">
          {CollectionFilterGroups.map((group) => <FormField key={group.key} label={group.label}>
            <Select value={group.key === 'jobSeekingType' ? jobSeekingType : education} ariaLabel={`采集${group.label}`} options={group.options}
              onChange={(value) => group.key === 'jobSeekingType' ? setJobSeekingType(value as typeof jobSeekingType) : setEducation(value as typeof education)} />
          </FormField>)}
        </div>
        <p className="job-collection-hint">同时满足所选条件才入库，默认不限。学历按岗位要求分类，例如“本科及以上”归入本科；开启条件后，未说明对应信息的岗位会被跳过。</p>
        {channel === 'boss_zhipin' ? <>
          <FormField label="城市"><input value={city} maxLength={100} onChange={(event) => setCity(event.target.value)} placeholder="全国、北京、上海、深圳…" /></FormField>
          <p className="job-collection-hint">请先连接已登录 BOSS 的个人浏览器。采集仅读取岗位；出现验证、风控或登录失效时停止，不发送消息。</p>
        </> : <>
          <FormField label="企业范围"><Select value={selection.scope} ariaLabel="企业采集范围" options={[{ value: 'all', label: `全部已启用来源（${enabled.length}）` }, { value: 'selected', label: '指定招聘来源' }]} onChange={(value) => setSelection((current) => ({ ...current, scope: value === 'selected' ? 'selected' : 'all' }))} /></FormField>
          <p className="job-collection-hint">按来源顺序采集，达到数量即停止，不保证遍历每家企业。</p>
          {selection.scope === 'selected' && <div className="job-source-list" aria-label="选择招聘来源">{enabled.map((source) => <label key={source.sourceId}>
            <input type="checkbox" checked={selected.includes(source.sourceId)} onChange={(event) => setSelection((current) => ({ ...current, ids: event.target.checked ? [...current.ids, source.sourceId] : current.ids.filter((id) => id !== source.sourceId) }))} />
            <span>{source.company} · {source.category === 'campus' ? '校招' : source.category === 'social' ? '社招' : '综合'}</span><small>{source.platform}</small>
          </label>)}</div>}
          <details className="job-source-settings"><summary>招聘来源与启停设置</summary>
            {sources.isPending ? <p>正在读取来源…</p> : sources.data?.map((source) => <label key={source.sourceId} className="job-source-setting">
              <input type="checkbox" checked={source.enabled} disabled={setEnabled.isPending} onChange={(event) => { setSelection((current) => ({ ...current, ids: current.ids.filter((id) => id !== source.sourceId) })); setEnabled.mutate({ id: source.sourceId, enabled: event.target.checked }); }} />
              <span><b>{source.company} · {source.platform}</b><small>{source.url}</small>{source.lastError && <small className="job-source-error">最近错误：{source.lastError}</small>}</span>
            </label>)}
          </details>
          <button className="ghost-btn" type="button" disabled title="自定义企业配置尚未开放">自定义企业（待支持）</button>
        </>}
      </fieldset>
      {error && <p role="alert" className="job-source-error">{error.message}</p>}
      {currentTask && <section className="job-collection-progress" aria-label="采集进度" aria-live="polite">
        <h3>{StateLabels[currentTask.status]}</h3>
        <progress max={currentTask.request.targetCount} value={currentTask.collected} />
        <p>已找到 {currentTask.collected} / {currentTask.request.targetCount} · 新增 {currentTask.inserted} · 已有 {currentTask.existing} · 写入失败 {currentTask.failedWrites}</p>
        <p>已检查 {currentTask.scanned} 个岗位 · 跳过已删除 {currentTask.skippedDeleted} · 失败来源 {currentTask.sources.filter((source) => source.status === 'failed').length}</p>
        {currentTask.sources.map((source) => <p key={source.sourceId}>{source.company}：{source.status === 'pending' ? currentTask.status === 'running' ? '待采集' : '未执行' : source.status === 'running' ? '采集中' : source.status === 'completed' ? '遍历完成' : source.status === 'failed' ? '失败' : '部分采集'} · {source.received} 个源记录 · {source.segments} 段{source.error ? ` · ${source.error}` : ''}</p>)}
        {currentTask.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      </section>}
    </div>
  </Modal>;
}
