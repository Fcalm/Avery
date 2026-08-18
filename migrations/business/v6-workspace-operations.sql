-- 跨 SQLite / 文件系统写入的持久化 Saga 状态；payload 仅保存恢复所需元数据。
CREATE TABLE IF NOT EXISTS workspace_operations (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  operation_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('prepared','file_written','db_committed','completed','rollback_required','failed')),
  payload_json TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workspace_operations_recovery ON workspace_operations(state, created_at);
