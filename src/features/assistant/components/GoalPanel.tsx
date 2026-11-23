import { useEffect, useRef, useState } from 'react';
import type { AgentGoalState } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { Icon } from '../../../shared/components/Icon';
import { DialogButton, Modal } from '../../../shared/components/UI';
import { ChangeAgentGoal } from '../api/agentQueries';

function GoalTimer({ activeMs, activeSince }: Pick<AgentGoalState, 'activeMs' | 'activeSince'>) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (activeSince === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeSince]);

  const elapsed = Math.floor(((activeMs ?? 0) + (activeSince === undefined ? 0 : Math.max(0, now - activeSince))) / 1000);
  const minutes = Math.floor(elapsed / 60);
  return <span className="goal-panel-time" aria-label={`累计用时 ${minutes} 分 ${elapsed % 60} 秒`}>
    <Icon name="clock" size={14} />
    {`${minutes}:${String(elapsed % 60).padStart(2, '0')}`}
  </span>;
}

export function GoalPanel({ sessionId, goal, running, busy, waitingForInput, onContinue }: {
  sessionId: string;
  goal: AgentGoalState;
  running: boolean;
  busy: boolean;
  waitingForInput: boolean;
  onContinue: () => void;
}) {
  const { ShowNotice } = useUiStore();
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  const [draft, setDraft] = useState(goal.objective);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  async function ChangeGoal(action: 'edit' | 'pause' | 'delete') {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const identity = { sessionId, requestId: goal.requestId };
      await ChangeAgentGoal(action === 'edit' ? { ...identity, action, objective: draft.trim() } : { ...identity, action });
      setDialog(null);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '目标操作失败，请重试。', 'error');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function CloseDialog() {
    if (!inFlight.current) setDialog(null);
  }

  const canPause = running && !waitingForInput && (goal.status === 'running' || goal.status === 'reviewing');
  const canContinue = !running && !waitingForInput && goal.canContinue;
  const playbackLabel = canContinue ? '继续目标' : '暂停目标';
  const editDisabled = busy || waitingForInput || saving;
  const deleteDisabled = busy || saving;

  return <div className="task-dock goal-dock">
    <div className="task-summary goal-panel" role="group" aria-label="目标" tabIndex={0}>
      <Icon name="target" size={16} />
      <span className="task-summary-copy" title={goal.objective}>{goal.objective}</span>
      <GoalTimer activeMs={goal.activeMs} activeSince={goal.activeSince} />
      <div className="goal-panel-actions">
        <button type="button" className="icon-btn sm" aria-label="编辑目标" title="编辑目标" disabled={editDisabled} onClick={() => {
          setDraft(goal.objective);
          setDialog('edit');
        }}><Icon name="edit" size={15} /></button>
        <button type="button" className="icon-btn sm" aria-label={playbackLabel} title={playbackLabel} disabled={busy || saving || (!canPause && !canContinue)} onClick={() => {
          if (canContinue) onContinue();
          else void ChangeGoal('pause');
        }}><Icon name={canContinue ? 'play' : 'pause'} size={15} /></button>
        <button type="button" className="icon-btn sm goal-panel-delete" aria-label="删除目标" title="删除目标" disabled={deleteDisabled} onClick={() => setDialog('delete')}><Icon name="delete" size={15} /></button>
      </div>
    </div>
    <Modal open={dialog === 'edit'} title="编辑目标" variant="dialog" onClose={CloseDialog} footer={<>
      <DialogButton disabled={saving} onClick={CloseDialog}>取消</DialogButton>
      <DialogButton tone="accent" disabled={editDisabled || !draft.trim() || draft.trim() === goal.objective} onClick={() => void ChangeGoal('edit')}>{running ? '保存并暂停' : '保存'}</DialogButton>
    </>}>
      <textarea className="goal-edit-input" aria-label="目标内容" rows={5} maxLength={4000} value={draft} disabled={saving} onChange={event => setDraft(event.target.value)} />
    </Modal>
    <Modal open={dialog === 'delete'} title="删除目标" onClose={CloseDialog} footer={<>
      <DialogButton disabled={saving} onClick={CloseDialog}>取消</DialogButton>
      <DialogButton tone="danger" disabled={deleteDisabled} onClick={() => void ChangeGoal('delete')}>删除</DialogButton>
    </>}>
      {running ? '删除后将停止当前目标。对话记录和已生成的产物会保留。' : '删除当前目标？对话记录和已生成的产物会保留。'}
    </Modal>
  </div>;
}
