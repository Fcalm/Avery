import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatMessageInputSchema } from '../../../packages/contracts/src/write-schemas';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

describe('用户消息技能元数据', () => {
  it('v17 给旧表补充可空字段，不改变历史消息正文和创建时间', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE conversation_messages(id TEXT PRIMARY KEY, content TEXT, created_at INTEGER); INSERT INTO conversation_messages VALUES('old', '旧消息', 100);");
      db.exec(readFileSync(join(process.cwd(), 'migrations/business/v17-message-metadata.sql'), 'utf8'));
      expect(db.prepare('SELECT * FROM conversation_messages').get()).toEqual({ id: 'old', content: '旧消息', created_at: 100, metadata_json: null });
    } finally { db.close(); }
  });

  it('写入契约只接收用户消息的技能名称快照，不接收权限字段或无效标识', () => {
    const input = { id: 'u1', role: 'user', content: '修改简历', skill: { id: 'resume-tailoring', label: '简历定制' } };
    expect(ChatMessageInputSchema.safeParse(input).success).toBe(true);
    expect(ChatMessageInputSchema.safeParse({ ...input, role: 'assistant' }).success).toBe(false);
    expect(ChatMessageInputSchema.safeParse({ ...input, skill: { ...input.skill, permissions: ['write'] } }).success).toBe(false);
    expect(ChatMessageInputSchema.safeParse({ ...input, skill: { ...input.skill, id: 'a/b' } }).success).toBe(false);
  });
});
