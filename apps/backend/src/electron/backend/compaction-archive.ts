import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentMessage } from '@avery/agent-sdk';

/** 原文按摘要 ID 独立归档，异步写盘；只有归档成功后才允许提交缩小后的历史视图。 */
export class CompactionArchive {
  constructor(private readonly root: string) {}

  private File(sessionId: string, summaryId: string): string {
    if (!/^summary-[a-zA-Z0-9-]{1,200}$/.test(summaryId)) throw new Error('Invalid compaction archive id.');
    const session = createHash('sha256').update(sessionId).digest('hex');
    return path.join(this.root, session, `${summaryId}.json`);
  }

  /** 目录由固定长度哈希构成，只删除本归档根下当前会话的数据。 */
  async RemoveSession(sessionId: string): Promise<void> {
    const directory = path.dirname(this.File(sessionId, 'summary-cleanup'));
    if (path.dirname(directory) !== path.resolve(this.root)) throw new Error('Invalid archive cleanup path.');
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  async Save(sessionId: string, archive: { summaryId: string; messages: AgentMessage[]; original?: AgentMessage[]; activity?: { instructions: string; compressionInstructions: string; beforeTokens: number; afterTokens: number; createdAt: string } }, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const file = this.File(sessionId, archive.summaryId);
    await mkdir(path.dirname(file), { recursive: true });
    const clean = (messages: AgentMessage[]) => messages.map(({ providerContent: _transient, ...message }) => message);
    const text = JSON.stringify({ messages: clean(archive.messages), original: clean(archive.original ?? archive.messages), activity: archive.activity });
    await writeFile(`${file}.tmp`, text, { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    await rename(`${file}.tmp`, file);
  }

  /** 定向重做摘要只展开当前会话的可信摘要来源，不读取其他会话或任意路径。 */
  async Expand(sessionId: string, messages: AgentMessage[], signal: AbortSignal, depth = 0): Promise<AgentMessage[]> {
    if (depth > 32) throw new Error('摘要来源层级过多，请缩小压缩范围。');
    const result: AgentMessage[] = [];
    for (const message of messages) {
      signal.throwIfAborted();
      if (message.metadata?.kind !== 'context_summary') { result.push(message); continue; }
      const file = this.File(sessionId, message.metadata.summaryId);
      if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('摘要原文过大，请缩小压缩范围。');
      const data = JSON.parse(await readFile(file, { encoding: 'utf8', signal })) as { messages?: AgentMessage[] };
      if (!Array.isArray(data.messages)) throw new Error('摘要原文已损坏，原上下文未改变。');
      result.push(...await this.Expand(sessionId, data.messages, signal, depth + 1));
      if (result.length > 50000) throw new Error('摘要原文记录过多，请缩小压缩范围。');
    }
    return result;
  }
}
