import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const packageRoot = new URL('../../../packages/agent-sdk/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
const require = createRequire(import.meta.url);

describe('Agent SDK 模块入口', () => {
  it('浏览器 import 使用 ESM 源码，避免开发服务器直接发送 CommonJS 构建', () => {
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './src/index.ts',
      require: './dist/index.js',
    });
    const entry = readFileSync(new URL(manifest.exports['.'].import, packageRoot), 'utf8');
    expect(entry).toContain('GetConversationResult');
    expect(entry).toContain('MatchConversationResourceHref');
    expect(entry).not.toContain('module.exports');
  });

  it('Backend require 保持加载已有 CommonJS 构建及运行时函数', () => {
    const sdk = require('@avery/agent-sdk');
    expect(require.resolve('@avery/agent-sdk').replaceAll('\\', '/')).toMatch(/packages\/agent-sdk\/dist\/index\.js$/);
    expect(sdk.GetConversationResult(sdk.CreateConversationPresentation('entry-test'))).toBe('');
    expect(typeof sdk.MatchConversationResourceHref).toBe('function');
  });
});
