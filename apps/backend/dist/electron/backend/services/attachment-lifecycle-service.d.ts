export declare const SevenDaysMs: number;
export declare function ExtractAttachmentIds(value: unknown): string[];
/** attachment_links 是唯一引用事实源；最后引用移除后开始 7 天宽限，清理只触碰工作空间副本与派生缓存。 */
export declare class AttachmentLifecycleService {
    private db;
    private workspacePath;
    constructor({ db, workspacePath }: {
        db: any;
        workspacePath: string;
    });
    ReplaceLinks(ownerType: string, ownerId: string, value: unknown): string[];
    RemoveLinks(ownerType: string, ownerId: string): string[];
    RemoveConversationLinks(conversationId: string): void;
    MarkOrphanIfUnreferenced(attachmentId: string, now?: number): void;
    SafeWorkspaceFile(rootName: string, fileName: string): string;
    RemoveRegularFile(target: string): boolean;
    Cleanup({ now, limit }?: {
        now?: number;
        limit?: number;
    }): any;
}
