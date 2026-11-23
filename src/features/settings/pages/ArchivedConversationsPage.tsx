import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../../../app/UiStore';
import { Icon } from '../../../shared/components/Icon';
import { DialogButton, Modal, Select } from '../../../shared/components/UI';
import { useConversations, useDeleteArchivedConversations, useSetConversationArchived } from '../../conversation/api/conversationQueries';
import { WORKSPACE_QUERY_KEY, type WorkspaceData } from '../../workspace/api/workspaceData';
import { ArchiveDayMs, ArchiveProjectKey, ArchiveProjectLabel, ArchiveRetentionDays, BuildArchivedConversations, FilterArchivedConversations, FormatArchiveRemaining, ReadArchiveProjectPreferences, type ArchivedConversationItem, type ArchiveSort } from '../archiveConversations';
import '../../../styles/archive-conversations.css';

type ArchiveAction = { kind: 'restore' | 'delete'; item: ArchivedConversationItem } | { kind: 'delete-all'; items: ArchivedConversationItem[] };

/** 归档页只消费现有会话接口；不补造时间、不在浏览器实现定时清理。 */
export function ArchivedConversationsPage() {
  const conversations = useConversations();
  const queryClient = useQueryClient();
  const { ShowNotice, activeConversationId, setActiveConversationId } = useUiStore();
  const restore = useSetConversationArchived();
  const remove = useDeleteArchivedConversations();
  const [preferences] = useState(ReadArchiveProjectPreferences);
  const items = useMemo(() => BuildArchivedConversations(conversations, preferences), [conversations, preferences]);
  const [query, SetQuery] = useState('');
  const [project, SetProject] = useState('all');
  const [sort, SetSort] = useState<ArchiveSort>('expiry');
  const [pending, SetPending] = useState<ArchiveAction | null>(null);
  const [busy, SetBusy] = useState(false);
  const busyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLTableSectionElement>(null);
  const [now, SetNow] = useState(Date.now);
  const hasDeadline = items.some((item) => item.autoDeleteAt !== null);

  useEffect(() => {
    if (!hasDeadline) return;
    const Update = () => SetNow(Date.now());
    Update();
    const timer = window.setInterval(Update, 30_000);
    document.addEventListener('visibilitychange', Update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', Update); };
  }, [hasDeadline]);
  useEffect(() => { if (pending) document.querySelector<HTMLButtonElement>('[data-archive-cancel]')?.focus(); }, [pending]);

  // 保留当前筛选项，即使最后一条对应记录已被移除，也便于用户清除筛选。
  const projectOptions = useMemo(() => {
    const names = new Map(items.map((item) => [ArchiveProjectKey(item), ArchiveProjectLabel(item)]));
    if (project !== 'all' && !names.has(project)) names.set(project, project === 'ungrouped' ? '未分组' : '当前项目（无归档对话）');
    return [{ value: 'all', label: '全部项目' }, ...[...names].map(([value, label]) => ({ value, label }))];
  }, [items, project]);
  const visible = useMemo(() => FilterArchivedConversations(items, query, project, sort), [items, query, project, sort]);

  function ClearFilters() { SetQuery(''); SetProject('all'); searchRef.current?.focus(); }
  function CloseDialog() { if (!busyRef.current) SetPending(null); }
  function CurrentArchived(id: string) {
    return queryClient.getQueryData<WorkspaceData>(WORKSPACE_QUERY_KEY)?.conversations.find((item) => item.id === id && item.archived);
  }

  async function ConfirmAction() {
    if (!pending || busyRef.current) return;
    busyRef.current = true; SetBusy(true);
    const action = pending;
    const rowIndex = action.kind === 'delete-all' ? 0 : visible.findIndex((item) => item.id === action.item.id);
    try {
      if (action.kind === 'delete-all') {
        // 后端逐项校验确认时的版本，不依赖前端缓存判断删除权限。
        if (action.items.some(item => !Number.isSafeInteger(item.revision) || (item.revision ?? 0) < 1)) throw new Error('归档数据版本缺失，请刷新列表后重试。');
        const result = await remove.mutateAsync(action.items.map(item => ({ id: item.id, expectedRevision: item.revision! })));
        const deleted = result.deletedIds.length, failed = result.failed.length, skipped = result.skipped.length;
        if (activeConversationId && result.deletedIds.includes(activeConversationId)) setActiveConversationId(null);
        await queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
        ShowNotice(failed ? `已删除 ${deleted} 个对话，${failed} 个删除失败，请重试` : skipped ? `已删除 ${deleted} 个对话，${skipped} 个已变更的对话未删除` : `已永久删除全部 ${deleted} 个已归档对话`, failed ? 'error' : skipped ? 'info' : 'success');
        if (!failed && !skipped) { SetQuery(''); SetProject('all'); }
      } else {
        const current = CurrentArchived(action.item.id);
        if (!current) {
          ShowNotice('对话已被恢复或删除，列表已更新', 'info'); SetPending(null);
          requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
          return;
        }
        if (action.kind === 'restore') {
          if (!Number.isSafeInteger(action.item.revision) || (action.item.revision ?? 0) < 1) throw new Error('归档数据版本缺失，请刷新列表后重试。');
          await restore.mutateAsync({ id: current.id, archived: false, expectedRevision: action.item.revision });
          ShowNotice('对话已恢复', 'success');
        } else {
          if (!Number.isSafeInteger(action.item.revision) || (action.item.revision ?? 0) < 1) throw new Error('归档数据版本缺失，请刷新列表后重试。');
          const result = await remove.mutateAsync([{ id: current.id, expectedRevision: action.item.revision! }]);
          await queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
          if (result.failed.length) throw new Error(result.failed[0].message);
          if (result.skipped.length) throw new Error('对话已发生变化，本次未删除，请核对后重试。');
          if (activeConversationId === current.id) setActiveConversationId(null);
          ShowNotice('对话已永久删除', 'success');
        }
      }
      SetPending(null);
      requestAnimationFrame(() => {
        const rows = rowsRef.current?.querySelectorAll('tr');
        const next = rows?.[Math.min(Math.max(0, rowIndex), rows.length - 1)]?.querySelector<HTMLButtonElement>('button');
        (next ?? searchRef.current)?.focus({ preventScroll: true });
      });
    } catch (error) {
      // 失败时保留确认框和原记录，避免以界面移除冒充成功。
      ShowNotice(error instanceof Error ? error.message : '操作失败，请稍后重试', 'error');
    } finally { busyRef.current = false; SetBusy(false); }
  }

  const deleting = pending?.kind !== 'restore';
  const subject = pending && pending.kind !== 'delete-all' ? pending.item : null;
  const restoreDestination = subject?.projectId && !subject.projectRemoved ? `的「${subject.projectName}」项目` : '的未分组列表';
  return <div className="settings-page is-set-page archive-settings"><div className="set-root">
    <div className="set-head archive-heading"><div className="archive-heading-left"><h1>已归档对话</h1><span className="archive-count" aria-label={`归档对话数量：${visible.length}`} aria-live="polite">{visible.length}</span></div><span className="archive-retention" title="按每条对话的清理时间计算"><Icon name="clock" size={14} />归档后保留 {ArchiveRetentionDays} 天</span></div>
    <div className="archive-toolbar" role="group" aria-label="筛选已归档对话">
      <label className="archive-search"><Icon name="search" size={15} /><input ref={searchRef} type="search" aria-label="搜索归档对话" placeholder="搜索对话标题" autoComplete="off" value={query} onChange={(event) => SetQuery(event.target.value)} /></label>
      <Select className="archive-project-filter" value={project} options={projectOptions} onChange={SetProject} ariaLabel="筛选所属项目" />
      <Select className="archive-sort-filter" value={sort} options={[{ value: 'expiry', label: '最早清理优先' }, { value: 'archive', label: '最近归档优先' }]} onChange={(value) => SetSort(value as ArchiveSort)} ariaLabel="排序方式" />
      <button className="archive-delete-all" type="button" disabled={!items.length || busy} onClick={() => SetPending({ kind: 'delete-all', items: [...items] })}><Icon name="delete" size={14} />删除所有对话</button>
    </div>
    <div className="archive-table-wrap">
      {visible.length ? <table className="archive-table" aria-label="已归档对话"><thead><tr><th scope="col">对话标题</th><th scope="col">所属项目</th><th scope="col">自动清理剩余</th><th scope="col">操作</th></tr></thead><tbody ref={rowsRef}>{visible.map((item) => <tr key={item.id}>
        <td><div className="archive-title-cell"><Icon name="assistant" size={17} /><span className="archive-title" title={item.title}>{item.title}</span></div></td>
        <td><div className={`archive-project${!item.projectId || item.projectRemoved ? ' is-missing' : ''}`}><Icon name="folder-simple" size={14} /><span data-native-title="true" title={ArchiveProjectLabel(item)}>{ArchiveProjectLabel(item)}</span></div></td>
        <td><span className={`archive-deadline${item.autoDeleteAt !== null && item.autoDeleteAt - now < ArchiveDayMs ? ' is-urgent' : ''}`} data-native-title="true" title={item.autoDeleteAt === null ? '历史对话未设清理时间' : `${new Date(item.autoDeleteAt).toLocaleString('zh-CN', { hour12: false })} 自动清理`}>{FormatArchiveRemaining(item.autoDeleteAt, now)}</span></td>
        <td><div className="archive-actions"><button className="archive-action is-restore" type="button" title="恢复" aria-label={`恢复：${item.title}`} disabled={busy} onClick={() => SetPending({ kind: 'restore', item })}><Icon name="recovery" size={14} /><span>恢复</span></button><button className="archive-action is-delete" type="button" title="删除" aria-label={`删除：${item.title}`} disabled={busy} onClick={() => SetPending({ kind: 'delete', item })}><Icon name="delete" size={14} /><span>删除</span></button></div></td>
      </tr>)}</tbody></table> : <div className="archive-empty" role="status"><Icon name="archive" size={26} /><p>{items.length ? '没有找到匹配的对话' : '暂无归档对话'}</p>{items.length > 0 && <button type="button" onClick={ClearFilters}>清除筛选</button>}</div>}
    </div>
    <Modal open={pending !== null} title={pending?.kind === 'delete-all' ? '删除所有已归档对话？' : deleting ? '永久删除对话？' : '恢复对话？'} onClose={CloseDialog} footer={<><DialogButton data-archive-cancel disabled={busy} onClick={CloseDialog}>取消</DialogButton><DialogButton tone={deleting ? 'danger' : 'accent'} disabled={busy} onClick={() => void ConfirmAction()}>{busy ? '处理中…' : pending?.kind === 'delete-all' ? '永久删除全部' : deleting ? '永久删除' : '确认恢复'}</DialogButton></>}>
      <span className="archive-confirm-content">{subject && <span className="archive-confirm-subject"><strong>{subject.title}</strong><span className="archive-project"><Icon name="folder-simple" size={14} /><span>{ArchiveProjectLabel(subject)}</span></span></span>}<span className="archive-confirm-text">{pending?.kind === 'delete-all' ? `将永久删除全部 ${pending.items.length} 个已归档对话及其中的消息，包含当前筛选未显示的对话，无法恢复。` : deleting ? '对话及其中的消息将被永久删除，无法恢复。' : subject?.projectRemoved ? '原项目已移除，恢复后对话将回到「最近」的未分组列表，并停止自动清理。' : `对话将回到「最近」${restoreDestination}，并停止自动清理。`}</span></span>
    </Modal>
  </div></div>;
}
