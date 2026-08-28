import { describe, expect, it } from 'vitest';
import { EvalTestBusiness } from '../../../apps/backend/src/electron/backend/evaluation/eval-test-business';

describe('EvalTestBusiness', () => {
  it('每个实例独立复制 Fixture，写入不会污染来源或其他 CaseRun', () => {
    const fixtures = { profile: [{ id: 'p1', content: 'original' }], resume: { id: 'r1', content: 'original', revision: 1 } };
    const left = new EvalTestBusiness(fixtures);
    const right = new EvalTestBusiness(fixtures);
    left.SaveProfiles([{ id: 'p1', content: 'changed' }]);
    left.UpsertResume({ id: 'r1', content: 'changed' }, 1);
    expect(left.Snapshot()).not.toEqual(right.Snapshot());
    expect(fixtures.profile[0].content).toBe('original');
    expect(fixtures.resume.content).toBe('original');
  });
});
