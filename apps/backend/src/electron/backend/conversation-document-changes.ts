import type { ConversationResource, ProfileSnapshotItem, ProfileWritePort, ResumeSnapshot, ResumeWritePort } from '@avery/agent-sdk';

type DocumentKind = 'resume' | 'profile';
interface DocumentBaseline { requestId: string; kind: DocumentKind; id: string; content: string }

/** 末尾换行是上一行的结束符；空正文没有行，内部空行仍计入统计。 */
function Lines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** 按最长公共子序列统计增删；替换一行记作一增一删，不受视觉折行影响。 */
export function CountDocumentLineChanges(before: string, after: string): { added: number; removed: number } {
  const previous = Lines(before), next = Lines(after);
  let start = 0, previousEnd = previous.length, nextEnd = next.length;
  while (start < previousEnd && start < nextEnd && previous[start] === next[start]) start++;
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) { previousEnd--; nextEnd--; }
  let left = previous.slice(start, previousEnd), right = next.slice(start, nextEnd);
  const removed = left.length, added = right.length;
  if (!removed || !added) return { added, removed };
  // 位集保存 LCS 的相邻长度差，避免分配行数乘积大小的二维矩阵；短序列作为位集轴。
  if (left.length > right.length) [left, right] = [right, left];
  const common = new Set(right);
  const masks = new Map<string, bigint>();
  left.forEach((line, index) => {
    if (common.has(line)) masks.set(line, (masks.get(line) ?? 0n) | (1n << BigInt(index)));
  });
  let state = 0n;
  for (const line of right) {
    const matches = (masks.get(line) ?? 0n) | state;
    state = matches & ~(matches - ((state << 1n) | 1n));
  }
  let unchanged = 0;
  while (state) { state &= state - 1n; unchanged++; }
  return { added: added - unchanged, removed: removed - unchanged };
}

/** 首次成功写入前的正文只保存在宿主运行状态；页面仅接收行数，不接收基线正文。 */
export class ConversationDocumentChanges {
  private baselines = new Map<string, DocumentBaseline>();

  constructor(private readonly changed: (requestId: string, resource: ConversationResource) => void, private readonly persist: () => void) {}

  Restore(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const baseline = item as DocumentBaseline;
      if (typeof baseline.requestId !== 'string' || (baseline.kind !== 'resume' && baseline.kind !== 'profile')
        || typeof baseline.id !== 'string' || typeof baseline.content !== 'string') continue;
      this.baselines.set(this.Key(baseline.requestId, baseline.kind, baseline.id), baseline);
    }
  }

  Snapshot(): DocumentBaseline[] { return [...this.baselines.values()]; }

  Forget(requestId: string): void {
    for (const [key, baseline] of this.baselines) if (baseline.requestId === requestId) this.baselines.delete(key);
  }

  /** 包装实际保存端口，因此直接执行与用户确认后执行共用统计，锁和版本校验仍由原端口负责。 */
  ResumePort(requestId: string, source: ResumeWritePort, read: (id: string) => Promise<ResumeSnapshot | null>): ResumeWritePort {
    return {
      AcquireLock: (input) => source.AcquireLock(input),
      ReleaseLock: (id, ownerId) => source.ReleaseLock(id, ownerId),
      Save: async (input) => {
        const before = await read(input.resume.id);
        const saved = await source.Save(input);
        this.Record(requestId, { kind: 'resume', id: saved.id, title: input.resume.name, revision: saved.revision }, before?.content ?? '', input.resume.content);
        this.persist();
        return saved;
      },
    };
  }

  /** 档案以真实磁盘快照比较；读取不得刷新外部改动检测基线，失败保存不会产生记录。 */
  ProfilePort(requestId: string, source: ProfileWritePort, read: () => Promise<ProfileSnapshotItem[]>): ProfileWritePort {
    return {
      Save: async (input) => {
        const previous = new Map((await read()).map((item) => [item.id, item]));
        const saved = await source.Save(input);
        for (const item of input.profiles) {
          this.Record(requestId, { kind: 'profile', id: item.id, title: item.title }, previous.get(item.id)?.content ?? '', item.content);
        }
        this.persist();
        return saved;
      },
    };
  }

  private Key(requestId: string, kind: DocumentKind, id: string): string { return JSON.stringify([requestId, kind, id]); }

  private Record(requestId: string, resource: ConversationResource & { kind: DocumentKind }, before: string, after: string): void {
    const key = this.Key(requestId, resource.kind, resource.id);
    const baseline = this.baselines.get(key) ?? { requestId, kind: resource.kind, id: resource.id, content: before };
    this.baselines.set(key, baseline);
    this.changed(requestId, { ...resource, produced: true, lineChanges: CountDocumentLineChanges(baseline.content, after) });
  }
}
