import type { EvalDatasetCase, EvalScriptedResponse } from '@avery/contracts';

/** 一个案例只有一条有序脚本；确认和输入共享游标，类型不符或耗尽必须停止，不能猜测用户答案。 */
export class EvalInteractionScript {
  private cursor = 0;
  readonly responses: EvalScriptedResponse[];
  constructor(testCase: EvalDatasetCase) {
    if (testCase.scriptedResponses && testCase.browser?.scriptedResponses) this.Fail('EVAL_SCRIPT_AMBIGUOUS', '不能同时提供两处交互脚本。');
    this.responses = testCase.scriptedResponses ?? testCase.browser?.scriptedResponses ?? [];
  }
  get consumed(): number { return this.cursor; }
  private Fail(code: string, message: string): never { throw Object.assign(new Error(message), { code, scriptIndex: this.cursor }); }
  Next(kind: EvalScriptedResponse['kind']): EvalScriptedResponse {
    const response = this.responses[this.cursor];
    if (!response) this.Fail('EVAL_SCRIPT_EXHAUSTED', `交互脚本在第 ${this.cursor + 1} 步耗尽，需要 ${kind}。`);
    if (response.kind !== kind) this.Fail('EVAL_SCRIPT_KIND_MISMATCH', `交互脚本第 ${this.cursor + 1} 步为 ${response.kind}，实际需要 ${kind}。`);
    this.cursor += 1;
    return response;
  }
  Answers(questions: Array<{ id: string }>): Record<string, string> {
    const response = this.Next('input');
    if (response.answers) {
      const expected = questions.map(item => item.id);
      if (Object.keys(response.answers).length !== expected.length || expected.some(id => !(id in response.answers!))) this.Fail('EVAL_SCRIPT_ANSWERS_MISMATCH', '脚本答案必须完整对应本次提问的问题 ID。');
      return { ...response.answers };
    }
    if (typeof response.content !== 'string') this.Fail('EVAL_SCRIPT_INPUT_INVALID', '脚本输入必须提供 content 或 answers。');
    return Object.fromEntries(questions.map(item => [item.id, response.content!]));
  }
  AssertComplete(): void {
    if (this.cursor !== this.responses.length) this.Fail('EVAL_SCRIPT_UNUSED', `交互脚本还有 ${this.responses.length - this.cursor} 步未执行。`);
  }
}

export function AssertSupportedEvalInitialState(testCase: EvalDatasetCase): void {
  if (testCase.browser?.initialState !== undefined) throw Object.assign(new Error('当前浏览器 Fixture 不支持 initialState；请删除该字段并用场景、seed 及目标断言表达案例。'), { code: 'EVAL_INITIAL_STATE_UNSUPPORTED' });
}
