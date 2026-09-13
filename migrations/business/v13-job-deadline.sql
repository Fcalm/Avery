-- 岗位截止时间：到时的岗位由岗位库自动清理。截止时间投影为独立列并建部分索引，
-- 使清理语句只扫描已设置截止时间且未删除的岗位，而不必反序列化 payload_json。
ALTER TABLE jobs ADD COLUMN deadline INTEGER;
CREATE INDEX IF NOT EXISTS idx_jobs_deadline ON jobs(deadline) WHERE deadline IS NOT NULL AND deleted_at IS NULL;
