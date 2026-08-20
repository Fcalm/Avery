import { describe, expect, it } from 'vitest';
import { ScrubTraceContent } from '../../packages/agent-core/src/kernel';

describe('Trace 脱敏契约', () => {
  it('移除 Key、Authorization 和 Windows/POSIX 绝对路径', () => {
    const scrubbed = ScrubTraceContent('Authorization: Bearer secret-token apiKey=secret-2 path=C:\\Users\\alice\\offerget.db unix=/Users/alice/offerget.db');

    expect(scrubbed).not.toMatch(/secret-token|secret-2|C:\\Users|\/Users\/alice/i);
    expect(scrubbed).toContain('[REDACTED]');
    expect(scrubbed).toContain('[REDACTED_PATH]');
  });
});
