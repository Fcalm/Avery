/** 档案的唯一事实源 profile.json；以临时文件写入后 fsync 原子替换，并维护哈希基线供外部修改检测。 */
export declare class ProfileRepository {
    private profilePath;
    private profileHash;
    constructor({ profilePath }: {
        profilePath: string;
    });
    /** 读取档案并认可当前磁盘内容为哈希基线；缺失或损坏时返回安全回退值。 */
    Load(fallback: any[]): {
        items: any[];
        hash: string | null;
    };
    /** 判断磁盘文件是否在应用认可基线后被外部修改；从未读取或文件缺失时视为未修改。 */
    IsModified(): boolean;
    /** 通过临时文件、fsync 和原子替换保存档案；检测到外部修改时除非强制覆盖否则拒绝。 */
    Save(items: any[], force?: boolean): {
        count: number;
        hash: string;
    };
    /** 重新读取磁盘档案并更新哈希基线，供冲突界面「重新加载磁盘版本」使用。 */
    Reload(fallback: any[]): {
        items: any[];
        hash: string | null;
    };
    /** 返回最近一次认可的档案哈希基线。 */
    GetHash(): string | null;
}
