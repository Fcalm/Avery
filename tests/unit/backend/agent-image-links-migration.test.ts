import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
describe('Agent 图片引用迁移', () => {
  it('迁移保留既有四类引用与外键，并允许独立 Agent 引用', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      db.exec(`CREATE TABLE attachments(id TEXT PRIMARY KEY);
        CREATE TABLE attachment_links(attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
          owner_type TEXT NOT NULL CHECK(owner_type IN ('conversation','message','profile','resume')),owner_id TEXT NOT NULL,created_at INTEGER NOT NULL,
          PRIMARY KEY(attachment_id,owner_type,owner_id));
        CREATE INDEX idx_attachment_links_owner ON attachment_links(owner_type,owner_id);
        CREATE INDEX idx_attachment_links_attachment ON attachment_links(attachment_id);
        INSERT INTO attachments VALUES('image');`);
      for (const type of ['conversation', 'message', 'profile', 'resume']) db.prepare('INSERT INTO attachment_links VALUES(?,?,?,1)').run('image', type, type);
      db.transaction(() => db.exec(readFileSync(resolve('migrations/business/v18-agent-image-links.sql'), 'utf8')))();
      expect(db.prepare('SELECT COUNT(*) AS count FROM attachment_links').get().count).toBe(4);
      db.prepare("INSERT INTO attachment_links VALUES('image','agent','session',1)").run();
      expect(() => db.prepare("INSERT INTO attachment_links VALUES('missing','agent','session',1)").run()).toThrow();
      db.prepare("DELETE FROM attachments WHERE id='image'").run();
      expect(db.prepare('SELECT COUNT(*) AS count FROM attachment_links').get().count).toBe(0);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });
});
