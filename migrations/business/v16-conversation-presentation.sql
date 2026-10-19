-- 用户可见过程随业务消息持久化，不受调试 Trace 清理与留存数量影响。
ALTER TABLE conversation_messages ADD COLUMN presentation_json TEXT;
