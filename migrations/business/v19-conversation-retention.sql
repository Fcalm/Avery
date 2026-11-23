-- 旧归档没有可靠的起始时间，保留 NULL，升级不追溯删除。
ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
ALTER TABLE conversations ADD COLUMN auto_delete_at INTEGER;
CREATE INDEX idx_conversations_archive_expiry ON conversations(auto_delete_at) WHERE archived = 1 AND auto_delete_at IS NOT NULL;

-- 删除会话与登记清理任务同事务完成，进程退出后仍可继续清除 Agent 私有资源。
CREATE TABLE conversation_cleanup (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);
