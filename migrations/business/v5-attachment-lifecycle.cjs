'use strict';

/** 附件引用账本与延迟清理状态；既有孤立附件从迁移时重新获得完整 7 天宽限期。 */
exports.up = function up(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(attachments)').all().map((column) => column.name));
  if (!columns.has('orphaned_at')) db.exec('ALTER TABLE attachments ADD COLUMN orphaned_at INTEGER;');
  if (!columns.has('cleanup_attempted_at')) db.exec('ALTER TABLE attachments ADD COLUMN cleanup_attempted_at INTEGER;');
  if (!columns.has('cleanup_error')) db.exec('ALTER TABLE attachments ADD COLUMN cleanup_error TEXT;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_links (
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('conversation','message','profile','resume')),
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (attachment_id, owner_type, owner_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_links_owner ON attachment_links(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_attachment_links_attachment ON attachment_links(attachment_id);
  `);
  const now = Date.now();
  db.prepare(`UPDATE attachments SET orphaned_at = ?
    WHERE deleted_at IS NULL AND orphaned_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM attachment_links WHERE attachment_id = attachments.id)`).run(now);
};
