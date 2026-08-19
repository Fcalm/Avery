declare const KnownTypes: Set<string>;
declare const ActiveStates: Set<string>;
/** 持久化本地 Saga 状态并在启动时串行恢复；未知类型/高版本操作会阻止写入而非猜测处理。 */
export declare class WorkspaceOperationService {
    private db;
    private workspacePath;
    private recovering;
    private blocked;
    private lastRecovery;
    constructor({ db, workspacePath }: {
        db: any;
        workspacePath: string;
    });
    Begin(operationType: string, payload: unknown): string;
    Advance(id: string, state: string): void;
    RequireWritable(): void;
    MarkRollback(id: string, code?: string): void;
    MarkFailed(id: string, code: string): void;
    private Parse;
    private ResolveWorkspaceRelative;
    private VerifyFileHash;
    RemoveDirectorySafely(target: string, expectedParent: string): void;
    Recover({ synchronizeProfiles }?: {
        synchronizeProfiles?: (items: any[]) => void;
    }): any;
    private RecoverOne;
    GetStatus(): any;
}
export { KnownTypes, ActiveStates };
