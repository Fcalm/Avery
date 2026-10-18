-- 采集身份及旧 URL 兼容查询同时包含墓碑，不加唯一约束以兼容存量手动重复岗位。
CREATE INDEX IF NOT EXISTS idx_jobs_collection_identity ON jobs(json_extract(payload_json, '$.collectionIdentity'));
CREATE INDEX IF NOT EXISTS idx_jobs_collection_url ON jobs(channel, json_extract(payload_json, '$.url'));
