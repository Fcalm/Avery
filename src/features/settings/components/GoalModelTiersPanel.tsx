import { useEffect, useState } from 'react';
import type { GoalModelTiersConfiguration } from '@avery/contracts';
import { NormalizeModelEndpoint } from '@avery/agent-sdk';
import { GetGoalModelTiers, SaveGoalModelTiers } from '../../assistant/api/agentQueries';
import { useUiStore } from '../../../app/UiStore';
import { Select } from '../../../shared/components/UI';

type Tier = GoalModelTiersConfiguration['tiers'][number];
const TierKey = (tier: Tier) => JSON.stringify([tier.provider, NormalizeModelEndpoint(tier.baseUrl), tier.model]);
const TierNames = ['次级模型', '高级模型'] as const;

export function GoalModelTiersPanel({ models, reload }: { models: Tier[]; reload: boolean }) {
  const { ShowNotice } = useUiStore();
  const [revision, setRevision] = useState<number | null>(null);
  const [keys, setKeys] = useState<[string, string]>(['', '']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (reload) return;
    let current = true;
    void GetGoalModelTiers().then(config => {
      if (!current) return;
      setRevision(config.revision);
      const [secondary, advanced] = config.tiers;
      setKeys([secondary ? TierKey(secondary) : '', advanced ? TierKey(advanced) : '']);
      setError('');
    }).catch(() => { if (current) { setRevision(null); setError('无法读取模型档次，请重新加载配置。'); } });
    return () => { current = false; };
  }, [reload]);
  const available = new Map(models.map(model => [TierKey(model), model]));
  const [secondary, advanced] = keys.map(key => available.get(key));
  const disabled = revision === null || reload || saving;

  async function Save() {
    if (disabled || revision === null || !secondary || !advanced) return;
    setSaving(true);
    setError('');
    try {
      const next = await SaveGoalModelTiers({ tiers: [secondary, advanced], expectedRevision: revision });
      setRevision(next.revision);
      ShowNotice('模型档次已保存', 'success');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '模型档次保存失败。'); }
    finally { setSaving(false); }
  }

  return <section className="set-fields model-tiers" aria-label="模型档次">
    <div className="set-d-head">
      <h2 className="model-tiers-title">模型档次</h2>
      <div className="set-d-acts">
        <button type="button" className="btn-accent" disabled={disabled || !secondary || !advanced} onClick={() => void Save()}>{saving ? '保存中…' : '保存档次'}</button>
      </div>
    </div>
    <div className="model-tier-selects">
      {TierNames.map((name, index) => {
        const key = keys[index];
        const options: Array<{ value: string; label: string; disabled?: boolean }> = [{ value: '', label: '选择模型' }];
        if (key && !available.has(key)) options.push({ value: key, label: '已保存的模型不可用', disabled: true });
        for (const [value, model] of available) {
          options.push({ value, label: `${model.provider} · ${model.model}` });
        }
        return <div className="set-field" key={name}>
          <span className="lb">{name}</span>
          <Select ariaLabel={name} value={key} options={options} disabled={disabled} onChange={value => setKeys(current => index === 0 ? [value, current[1]] : [current[0], value])} />
        </div>;
      })}
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
