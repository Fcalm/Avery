import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

describe('v12 会话场景与项目空间迁移', () => {
  it('为既有 conversations 表补项目空间名称列，存量行保持原值', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, scenario_id TEXT NOT NULL DEFAULT 'resume-copilot', environment_id TEXT, revision INTEGER NOT NULL);
    `);
    db.prepare('INSERT INTO conversations(id, title, scenario_id, environment_id, revision) VALUES(?, ?, ?, ?, ?)').run('conversation-1', '旧会话', 'resume-copilot', null, 1);

    db.exec(readFileSync(new URL('../../../migrations/business/v12-conversation-scene-environment.sql', import.meta.url), 'utf8'));

    const columns = db.prepare('PRAGMA table_info(conversations)').all().map((column: any) => column.name);
    expect(columns).toContain('environment_name');
    expect(db.prepare('SELECT scenario_id, environment_id, environment_name FROM conversations WHERE id = ?').get('conversation-1'))
      .toEqual({ scenario_id: 'resume-copilot', environment_id: null, environment_name: null });
    db.close();
  });
});
