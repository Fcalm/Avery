import { createHash, randomUUID } from 'node:crypto';
import type { AgentMessage, ContextBuilderModule, RuntimeContext, SessionContextSnapshot } from '@avery/agent-sdk';
import { AgentDefaultPorts } from './ports';

/** 上下文构建模块：读取业务只读快照并序列化为会话上下文；不读取工作空间或项目规则文件。 */
export function CreateContextBuilderModule(ports: AgentDefaultPorts): ContextBuilderModule {
  /** 会话业务快照内容哈希缓存：用于标识相对上一轮是否变化。 */
  const snapshotHashes = new Map<string, string>();

  return {
    packageName: '@avery/agent-modules-defaults',
    name: 'avery.agent-defaults',
    version: '0.1.0',
    sdkVersion: '0.1.0',
    slot: 'context-builder',
    capabilities: ['context'],
    /** 基于用户自定义上下文构建不可变的会话上下文快照。 */
    async BuildSessionContextSnapshot(sessionId, sessionRevision, options = {}) {
      const settings = (await ports.getStoredSettings()) ?? {};
      const customContext = typeof settings.customContext === 'string' ? settings.customContext.trim() : '';
      const sources: SessionContextSnapshot['sources'] = [];
      if (customContext) {
        sources.push({ type: 'user-context', name: 'user-context', content: customContext, contentHash: createHash('sha256').update(customContext).digest('hex') });
      }
      const snapshotId = randomUUID();
      const createdAtMs = options.now ?? Date.now();
      const createdAt = new Date(createdAtMs).toISOString();
      const expiresAt = new Date(createdAtMs + (options.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString();
      const sourcesText = sources.map((source) => {
        const content = source.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `# ${source.name}\n${content}`;
      }).join('\n\n');
      const compiledPrefix = `<system-reminder type="session-context-snapshot" snapshot-id="${snapshotId}" session-revision="${sessionRevision}">\n${sourcesText}\n</system-reminder>`;
      return {
        snapshotId,
        sessionId,
        sessionRevision,
        createdAt,
        expiresAt,
        refreshReason: options.refreshReason ?? 'session_created',
        sources,
        compiledPrefix,
        compiledHash: createHash('sha256').update(compiledPrefix).digest('hex'),
      };
    },
    /** 直接返回快照内保存的字节稳定 system 前缀，禁止逐请求重新序列化。 */
    SerializeSessionContext(session) {
      return session.compiledPrefix;
    },
    /** 每轮注入当前业务快照；该消息仅用于当前模型请求，Kernel 不得将其写入历史。 */
    CreateDynamicSnapshot(sessionId, context) {
      if (!context) return { changed: false, message: null };
      const content = `<runtime-context>\n${JSON.stringify(context)}\n</runtime-context>`;
      const hash = createHash('sha256').update(content).digest('hex');
      const changed = snapshotHashes.get(sessionId) !== hash;
      snapshotHashes.set(sessionId, hash);
      return {
        changed,
        message: { role: 'user', content, metadata: { source: 'runtime', visibility: 'hidden', kind: 'runtime_context' } },
      };
    },
  };
}
