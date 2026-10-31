import type { BrowserAutomationPort, ToolContext } from '@avery/agent-sdk';

const MaxSnapshotDeltaChain = 128;

type Element = Record<string, unknown>;
type Snapshot = {
  snapshotId: string;
  scope: string;
  documentId: string;
  url: string;
  refs: Record<string, Element>;
  tabs: unknown;
  requiredCallIds: string[];
};

/** 模型只接收决策所需字段；完整字段上下文与风控扫描始终使用底层原始快照。 */
function CompactRefs(value: unknown): Record<string, Element> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([ref, raw]) => {
    const input = raw && typeof raw === 'object' ? raw as Element : {};
    const output: Element = {};
    for (const key of ['role', 'name', 'type', 'section', 'href', 'placeholder', 'value', 'valueLength', 'checked', 'valid', 'validationMessage', 'options']) {
      if (input[key] !== undefined && (key === 'value' || input[key] !== '')) output[key] = input[key];
    }
    for (const key of ['disabled', 'required', 'readOnly', 'textTruncated', 'valueTruncated']) {
      if (input[key] === true) output[key] = true;
    }
    // 无障碍名称可能只是“请输入”；邻近标签是区分学校、专业等同构输入框的必要信息。
    const labels = Array.isArray(input.precedingLabels) ? input.precedingLabels.filter((value): value is string => typeof value === 'string') : [];
    const label = typeof input.rawLabel === 'string' && input.rawLabel ? input.rawLabel : labels.slice(-2).join(' / ');
    if (label && label !== input.name) output.label = label;
    if (!output.section && typeof input.groupHeading === 'string' && input.groupHeading) output.section = input.groupHeading;
    if (typeof input.recordIndex === 'number') output.recordIndex = input.recordIndex;
    if (!label && Array.isArray(input.nearbyTexts) && input.nearbyTexts.length > 0) output.context = input.nearbyTexts.slice(0, 3);
    return [ref, output];
  }));
}

/**
 * 只投影发给模型的观察结果，不改变浏览器业务端口。
 * 基线按浏览器实例、会话和请求隔离；整条依赖链仍在模型上下文中时才允许增量。
 */
export class BrowserSnapshotPresenter {
  private readonly baselines = new WeakMap<BrowserAutomationPort, Snapshot>();
  private nextSnapshotId = 1;

  Present(browser: BrowserAutomationPort, context: ToolContext, callId: string, raw: unknown, forceFull: boolean): Record<string, unknown> {
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const refs = CompactRefs(data.refs);
    const scope = JSON.stringify([context.sessionId, context.requestId, context.runId]);
    const documentId = typeof data.documentId === 'string' ? data.documentId : '';
    const url = String(data.url ?? data.currentUrl ?? '');
    const previous = this.baselines.get(browser);
    const snapshotId = `snapshot-${this.nextSnapshotId++}`;
    const header = { snapshotId, currentUrl: url, title: data.title, pageRevision: data.pageRevision };
    const full = {
      ...header, mode: 'full', refs, tabs: data.tabs,
      truncated: data.truncated === true, partialTextTruncated: data.partialTextTruncated === true,
    };
    const complete = data.truncated !== true && data.partialTextTruncated !== true
      && !Object.values(refs).some((element) => element.valueTruncated === true || element.textTruncated === true);
    let output: Record<string, unknown> = full;
    let requiredCallIds = [callId];
    if (!forceFull && complete && documentId && previous?.documentId === documentId
      && previous.scope === scope && previous.url === url && previous.requiredCallIds.length < MaxSnapshotDeltaChain
      && previous.requiredCallIds.every((id) => context.hasToolResultInContext?.(id) === true)) {
      const added: Record<string, Element> = {};
      const updated: Record<string, Element> = {};
      for (const [ref, element] of Object.entries(refs)) {
        if (!previous.refs[ref]) added[ref] = element;
        else if (JSON.stringify(previous.refs[ref]) !== JSON.stringify(element)) updated[ref] = element;
      }
      const removed = Object.keys(previous.refs).filter((ref) => !refs[ref]);
      const order = Object.keys(refs);
      const orderChanged = JSON.stringify(Object.keys(previous.refs)) !== JSON.stringify(order);
      const changed = Object.keys(added).length > 0 || Object.keys(updated).length > 0 || removed.length > 0 || orderChanged;
      const delta = {
        ...header, mode: changed ? 'delta' : 'unchanged', baseSnapshotId: previous.snapshotId,
        ...(changed ? { added, updated, removed } : {}),
        ...(orderChanged ? { order } : {}),
        ...(JSON.stringify(previous.tabs) !== JSON.stringify(data.tabs) ? { tabs: data.tabs } : {}),
      };
      // 大面积变化时全量更短；不为追求增量而扩大模型输入。
      if (JSON.stringify(delta).length < JSON.stringify(full).length) {
        output = delta;
        requiredCallIds = [...previous.requiredCallIds, callId];
      }
    }
    if (complete && documentId) this.baselines.set(browser, { snapshotId, scope, documentId, url, refs, tabs: data.tabs, requiredCallIds });
    else this.baselines.delete(browser);
    return output;
  }
}
