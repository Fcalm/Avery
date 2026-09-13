-- 会话创建时的场景与项目空间随会话落库：scenario_id / environment_id 列在 v1 已预留，
-- 项目空间显示名此前没有存储列，补齐后侧栏才能按项目空间分组展示。
ALTER TABLE conversations ADD COLUMN environment_name TEXT;
