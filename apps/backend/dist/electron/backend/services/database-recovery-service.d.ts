/** 校验候选数据库的 integrity、迁移 checksum、核心表和 profile；只读打开，绝不触发隐式建库。 */
export declare function ValidateRecoverySet(databasePath: string, profilePath: string, manifestPath?: string | null): any;
export declare class DatabaseRecoveryStore {
    private workspacePath;
    private databasePath;
    private profilePath;
    private reason;
    constructor({ workspacePath, cause }: {
        workspacePath: string;
        cause: Error;
    });
    private AssertDirectoryWithin;
    ListBackups(): any[];
    GetDatabaseRecoveryStatus(): any;
    GetStatus(): any;
    LoadViewModel(): any;
    GetStoredSettings(): any;
    GetProfiles(): any;
    GetWorkspaceRecoveryStatus(): any;
    RestoreLatestBackup(): any;
    RestoreBackup(backupId: string): any;
    ExportRecoveryDiagnostic(): any;
    Close(): void;
}
