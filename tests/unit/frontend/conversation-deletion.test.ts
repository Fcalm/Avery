import { describe, expect, it } from 'vitest';
import { ResolveActiveConversationAfterDeletion } from '../../../src/features/conversation/conversationDeletion';

describe('会话删除后的导航状态', () => {
  it('删除当前会话后进入没有旧 ID 的新建会话页', () => {
    expect(ResolveActiveConversationAfterDeletion('conversation-old', 'conversation-old')).toBeNull();
  });

  it('删除其他历史会话时保留当前会话', () => {
    expect(ResolveActiveConversationAfterDeletion('conversation-current', 'conversation-old')).toBe('conversation-current');
  });
});
