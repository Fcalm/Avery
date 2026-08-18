import type { AgentStreamEvent } from './events';
import type { AttachmentDescriptor, ProfileSnapshotItem, ResumeSnapshot, TaskItem } from './types';
/** 已注册工具：定义 + 超时 + 并发安全标记；并发屏障由 Kernel 调度。 */
export interface RegisteredAgentTool {
    definition: {
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        };
    };
    timeoutMs: number;
    isConcurrencySafe: boolean;
}
/** 文件读取端口：由宿主注入（agent-file-reader）；路径校验与资源边界由宿主持有，模块不可绕过。 */
export interface FileReadPort {
    ReadAuthorizedFile(filePath: string, sourceName?: string): Promise<{
        content: string;
        truncated: boolean;
        warnings?: string[];
        pages?: number;
        needsOcr?: boolean;
        ocr?: {
            engine: string;
            version: string;
            languages: string[];
            confidence: number;
            lowConfidence: boolean;
            cacheHit: boolean;
            source: {
                page: number;
                regions: Array<Record<string, unknown>>;
            };
        };
    }>;
    ReadTextFile(filePath: string): {
        content: string;
        truncated: boolean;
    };
    /** 枚举项目内常规文件：path 为可读取的绝对路径，name 为相对项目的 POSIX 路径（供展示与匹配）。 */
    ListProjectFiles(projectPath: string, limit?: number): Array<{
        path: string;
        name: string;
    }>;
    ResolveProjectPath(projectRoot: string | null, requestedPath: string): string;
    /** 将 attachment:// 虚拟 URI 解析为宿主私有物理路径；展示名取自 ToolContext.attachments。 */
    ResolveAttachmentUri(uri: string): Promise<string | null>;
    CreateGlobMatcher(pattern: string): RegExp;
}
/** 简历只读端口：宿主按 resumeId 提供当前只读快照（含 revision）。 */
export interface ResumeReadPort {
    ReadCurrent(resumeId: string): Promise<ResumeSnapshot | null>;
}
/** 简历互斥锁信息；owner 区分用户与 Agent。 */
export interface ResumeEditLock {
    resumeId: string;
    owner: 'user' | 'agent';
    ownerId: string;
    baseRevision?: number;
    acquiredAt: number;
    leaseExpiresAt: number;
}
/** 简历写端口：后端落库 + 互斥锁 + 乐观锁；用户与 Agent 共用同一锁。 */
export interface ResumeWritePort {
    /** 尝试获取简历互斥锁；被其他 owner 占用时返回未获取及错误码。 */
    AcquireLock(input: {
        resumeId: string;
        owner: 'user' | 'agent';
        ownerId: string;
        baseRevision?: number;
    }): Promise<{
        acquired: true;
        lock: ResumeEditLock;
    } | {
        acquired: false;
        code: 'RESUME_LOCKED_BY_USER' | 'RESOURCE_LOCKED';
    }>;
    /** 释放指定 owner 持有的简历锁。 */
    ReleaseLock(resumeId: string, ownerId: string): Promise<void>;
    /** 保存简历并校验乐观锁版本；冲突时返回 RESUME_REVISION_CONFLICT 失败。 */
    Save(input: {
        resume: ResumeSnapshot;
        baseRevision?: number;
    }): Promise<{
        id: string;
        revision: number;
    }>;
}
/** Agent 权限上限内的窄端口集合：无岗位/投递/导出/浏览器/Shell/任意网络能力。 */
export interface ToolPorts {
    file: FileReadPort;
    resumeRead: ResumeReadPort;
    resumeWrite: ResumeWritePort;
}
/** 宿主逐会话构造的工具执行上下文：承载只读快照、交互态、持久化回调与事件出口。 */
export interface ToolContext {
    sessionId: string;
    requestId: string;
    confirmationMode: '需要确认' | '无需确认';
    resumeEditing: boolean;
    projectRoot: string | null;
    attachments: AttachmentDescriptor[];
    profileSnapshot: ProfileSnapshotItem[];
    resumeSnapshot: ResumeSnapshot | null;
    resumeId?: string;
    ports: ToolPorts;
    /** 会话内任务表：宿主持有的 Map 引用，工具直接增删。 */
    tasks: Map<string, TaskItem>;
    /** 待确认简历补丁：宿主持有的 Map 引用。 */
    pendingEdits: Map<string, unknown>;
    /** 澄清提问状态：宿主持有的 Map 引用。 */
    pendingQuestions: Map<string, unknown>;
    emit: (event: AgentStreamEvent) => void;
    /** 工具改动会话状态后回调宿主持久化（如任务保存）。 */
    persistSessionState: () => void;
}
