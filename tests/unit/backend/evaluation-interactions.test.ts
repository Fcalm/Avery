import { describe, expect, it } from 'vitest';
import { EvalInteractionScript, AssertSupportedEvalInitialState } from '../../../apps/backend/src/electron/backend/evaluation/eval-interaction-script';
import { ParseEvalDataset } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { DiagnoseDataset } from '../../../apps/backend/src/electron/backend/evaluation/dataset-validation';
import { BrowserUserSimulator } from '../../../apps/backend/src/electron/backend/evaluation/browser-user-simulator';

const base = { id: 'script', category: '简历', input: { userMessage: '按回答编写' }, fixtures: {}, tags: [], expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' } };
describe('有序模拟用户脚本与不支持配置', () => {
  it('确认、拒绝、含糊输入和多问题答案按共享游标消费', () => {
    const script = new EvalInteractionScript({ ...base, scriptedResponses: [{ kind: 'confirmation', accepted: true }, { kind: 'confirmation', accepted: false }, { kind: 'input', content: '可能参与过，但记不清了' }, { kind: 'input', answers: { q1: '没有', q2: '3 次' } }] });
    expect(script.Next('confirmation').accepted).toBe(true);
    expect(script.Next('confirmation').accepted).toBe(false);
    expect(script.Answers([{ id: 'q' }])).toEqual({ q: '可能参与过，但记不清了' });
    expect(script.Answers([{ id: 'q1' }, { id: 'q2' }])).toEqual({ q1: '没有', q2: '3 次' });
    expect(script.consumed).toBe(4); expect(() => script.AssertComplete()).not.toThrow();
  });
  it('耗尽、类型不符、未用脚本、错问题 ID 都明确停止', () => {
    expect(() => new EvalInteractionScript(base).Next('input')).toThrow(/耗尽/);
    const script = new EvalInteractionScript({ ...base, scriptedResponses: [{ kind: 'input', content: '回答' }] });
    expect(() => script.Next('confirmation')).toThrow(/实际需要/); expect(script.consumed).toBe(0);
    expect(() => script.AssertComplete()).toThrow(/未执行/);
    expect(() => new EvalInteractionScript({ ...base, scriptedResponses: [{ kind: 'input', answers: { wrong: '答案' } }] }).Answers([{ id: 'q' }])).toThrow(/问题 ID/);
  });
  it('脚本 Schema 拒绝不完整确认或混用两种输入方式', () => {
    expect(() => ParseEvalDataset(JSON.stringify({ ...base, scriptedResponses: [{ kind: 'confirmation' }] }))).toThrow(/schema/);
    expect(() => ParseEvalDataset(JSON.stringify({ ...base, scriptedResponses: [{ kind: 'input', content: 'a', answers: { q: 'b' } }] }))).toThrow(/schema/);
    const value = ParseEvalDataset(JSON.stringify({ ...base, scriptedResponses: [{ kind: 'input', content: 'a' }] }));
    expect(value[0].scriptedResponses).toHaveLength(1);
    expect(DiagnoseDataset({ runnerType: 'prompt', config: { userSimulator: 'approve_valid' } }, value, JSON.stringify(value[0])).diagnostics[0].code).toBe('SCRIPT_STRATEGY_MISMATCH');
  });
  it('initialState 在导入预检和直接 Runner 入口均明确拒绝', () => {
    const testCase = { ...base, browser: { fixtureVersion: '2', initialState: {}, assertions: [{ id: 's', type: 'state_equals' as const, path: 'fixture.submissionCount', expected: 0, weight: 100 }] } };
    expect(DiagnoseDataset({ runnerType: 'browser', config: {} }, [testCase], JSON.stringify(testCase)).diagnostics.map(item => item.code)).toContain('INITIAL_STATE_UNSUPPORTED');
    expect(() => AssertSupportedEvalInitialState(testCase)).toThrow(/不支持 initialState/);
  });
  it('浏览器旧位置脚本兼容，安全拒绝不能消费或放宽脚本批准', () => {
    const testCase = { ...base, browser: { forbiddenTargets: ['blocked'], scriptedResponses: [{ kind: 'confirmation' as const, accepted: true }, { kind: 'input' as const, content: '真实回答' }, { kind: 'confirmation' as const, accepted: false }] } };
    const simulator = new BrowserUserSimulator();
    const config = { strategy: 'scripted' as const, testCase, fixtureState: {} as any, authorizedFileIds: new Set<string>() };
    expect(simulator.Decide({ ...config, proposal: { toolName: 'BrowserClick', summary: 'blocked' } })).toMatchObject({ accepted: false, reason: 'forbidden_target' });
    expect(simulator.Script(testCase).consumed).toBe(0);
    expect(simulator.Decide({ ...config, proposal: { toolName: 'BrowserClick' } }).accepted).toBe(true);
    expect(simulator.NextInput(testCase)).toBe('真实回答');
    expect(simulator.Decide({ ...config, proposal: { toolName: 'BrowserClick' } }).accepted).toBe(false);
    expect(() => simulator.Script(testCase).AssertComplete()).not.toThrow();
  });
});
