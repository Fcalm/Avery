import type { ConversationPart } from '@avery/contracts';

export type ConversationProcessEvent = Extract<ConversationPart, { type: 'reasoning' | 'tool' }>;
export type ConversationProcessBlock =
  | { type: 'process'; id: string; events: ConversationProcessEvent[] }
  | Extract<ConversationPart, { type: 'text' }>;

/** 正文是分组边界，资源引用和空正文不打断过程；首个事件 ID 保证流式追加不会重置展开状态。 */
export function GroupConversationProcess(parts: readonly ConversationPart[]): ConversationProcessBlock[] {
  const blocks: ConversationProcessBlock[] = [];
  for (const part of parts) {
    if (part.type === 'resource') continue;
    if (part.type === 'text') {
      if (part.text.trim()) blocks.push(part);
      continue;
    }
    const previous = blocks.at(-1);
    if (previous?.type === 'process') previous.events.push(part);
    else blocks.push({ type: 'process', id: `process:${part.id}`, events: [part] });
  }
  return blocks;
}
