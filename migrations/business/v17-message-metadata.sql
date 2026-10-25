-- 技能标签与正文分别保存；历史消息保持原文，未记录的技能不从文本推断。
ALTER TABLE conversation_messages ADD COLUMN metadata_json TEXT;
