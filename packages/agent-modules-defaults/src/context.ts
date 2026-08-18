import { createHash, randomUUID } from 'node:crypto';
import type { AgentMessage, ContextBuilderModule, RuntimeContext, SessionContextSnapshot } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';

/** 上下文构建模块：读取业务只读快照并序列化为会话上下文；不读取工作空间或项目规则文件。 */
export function CreateContextBuilderModule(ports: AgentDefaultPorts): ContextBuilderModule {
  /** 会话业务快照内容哈希缓存：仅在内容变化时向 Transcript 追加动态快照消息。 */
  const snapshotHashes = new Map<string, string>();

  return {
    packageName: '@offerget/agent-modules-defaults',
    name: 'offerget.agent-defaults',
    version: '0.1.0',
    sdkVersion: '0.1.0',
    slot: 'context-builder',
    capabilities: ['context'],
    /** 基于用户自定义上下文构建不可变的会话上下文快照。 */
    async BuildSessionContextSnapshot(sessionId, sessionRevision) {
      const settings = (await ports.getStoredSettings()) ?? {};
      const customContext = typeof settings.customContext === 'string' ? settings.customContext.trim() : '';
      const sources: SessionContextSnapshot['sources'] = [];
      if (customContext) {
        sources.push({ type: 'user-context', name: 'user-context', content: customContext, contentHash: createHash('sha256').update(customContext).digest('hex') });
      }
      return { snapshotId: randomUUID(), sessionId, sessionRevision, sources };
    },
    /** 将会话上下文快照序列化为不计轮次的 system 消息；正文做 XML 转义。 */
    SerializeSessionContext(session) {
      const sourcesText = session.sources.map((source) => {
        const content = source.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `# ${source.name}\n${content}`;
      }).join('\n\n');
      return `<system-reminder type="session-context-snapshot" snapshot-id="${session.snapshotId}" session-revision="${session.sessionRevision}">\n${sourcesText}\n</system-reminder>`;
    },
    /** 仅在业务快照内容变化时，向内部 Transcript 追加稳定格式的动态消息。 */
    CreateDynamicSnapshot(sessionId, context) {
      if (!context) return { changed: false, message: null };
      const content = `<runtime-context>\n${JSON.stringify(context)}\n</runtime-context>`;
      const hash = createHash('sha256').update(content).digest('hex');
      if (snapshotHashes.get(sessionId) === hash) return { changed: false, message: null };
      snapshotHashes.set(sessionId, hash);
      return { changed: true, message: { role: 'user', content } };
    },
  };
}
