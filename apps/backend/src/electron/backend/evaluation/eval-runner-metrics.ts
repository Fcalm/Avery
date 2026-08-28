/** Kernel 每次模型循环都会追加一个 loop_turn；该事件是两类 Runner 的统一轮数事实源。 */
export function CountEvalModelTurns(events: Array<{ type: string }>): number {
  return events.reduce((count, event) => count + (event.type === 'loop_turn' ? 1 : 0), 0);
}
