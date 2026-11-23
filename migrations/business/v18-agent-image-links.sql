-- Agent 图片引用独立于界面消息和会话快照，压缩归档期间仍保留；沿用附件的统一清理账本。
CREATE TABLE attachment_links_next (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('conversation','message','profile','resume','agent')),
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, owner_type, owner_id)
);
INSERT INTO attachment_links_next SELECT attachment_id, owner_type, owner_id, created_at FROM attachment_links;
DROP TABLE attachment_links;
ALTER TABLE attachment_links_next RENAME TO attachment_links;
CREATE INDEX idx_attachment_links_owner ON attachment_links(owner_type, owner_id);
CREATE INDEX idx_attachment_links_attachment ON attachment_links(attachment_id);
