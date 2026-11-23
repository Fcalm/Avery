-- 退役岗位匹配分，清理 JSON 与投影列；保留岗位版本、时间及所有关联记录。
BEGIN;
UPDATE jobs SET payload_json = json_remove(payload_json, '$.matchScore', '$.match_score')
WHERE json_type(payload_json, '$.matchScore') IS NOT NULL OR json_type(payload_json, '$.match_score') IS NOT NULL;
ALTER TABLE jobs DROP COLUMN match_score;
COMMIT;
