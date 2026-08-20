import { defineConfig } from 'vitest/config';

/** 仅收集仓库测试目录，避免把依赖内置用例纳入执行范围。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
  },
});
