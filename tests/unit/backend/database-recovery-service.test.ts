import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidateRecoverySet } from '../../../apps/backend/src/electron/backend/services/database-recovery-service';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ValidateRecoverySet', () => {
  it('未知的未来 Schema 被拒绝，调用方应保持恢复只读模式', () => {
    const directory = mkdtempSync(join(tmpdir(), 'offerget-recovery-'));
    directories.push(directory);
    const databasePath = join(directory, 'offerget.db');
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE workspace_meta (id TEXT PRIMARY KEY, schema_version INTEGER);
      CREATE TABLE schema_migrations (version INTEGER, checksum TEXT);
      CREATE TABLE conversations (id TEXT);
      CREATE TABLE attachments (id TEXT);
    `);
    const seeds = [
      'business-store-v1-initial', 'business-store-v1-state-bridge', 'business-store-v1-attachments',
      'business-store-v1-entity-revision', 'business-store-v1-attachment-lifecycle-7-days', 'business-store-v1-workspace-operations',
      'business-store-v1-cron-tasks-unattended',
    ];
    const insert = db.prepare('INSERT INTO schema_migrations(version, checksum) VALUES(?, ?)');
    seeds.forEach((seed, index) => insert.run(index + 1, createHash('sha256').update(seed).digest('hex')));
    db.prepare("INSERT INTO workspace_meta(id, schema_version) VALUES('workspace', 8)").run();
    db.close();

    expect(() => ValidateRecoverySet(databasePath, join(directory, 'profile.json'))).toThrow('schema version is unsupported');
  });
});
