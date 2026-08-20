/** 中英枚举映射：契约层使用稳定英文值，持久化层保持存量中文兼容；双向转换集中在本模块供各 Repository 读写边界使用。 */
export declare const EmploymentTypeStorage: Record<string, string>;
export declare const EmploymentTypeDisplay: Record<string, string>;
export declare const ChannelStorage: Record<string, string>;
export declare const ChannelDisplay: Record<string, string>;
export declare const ApplicationStatusStorage: Record<string, string>;
export declare const ApplicationStatusDisplay: Record<string, string>;
export declare const ProfileCategoryStorage: Record<string, string>;
export declare const ProfileCategoryDisplay: Record<string, string>;
/** 英文值映射为存储中文值；已是中文或未知值原样透传（容忍存量与未列枚举）。 */
export declare function ToStorage(value: unknown, storageMap: Record<string, string>): unknown;
/** 存储中文值映射为契约英文值；已是英文或未知值原样透传。 */
export declare function ToDisplay(value: unknown, displayMap: Record<string, string>): unknown;
/** 岗位写入前映射为存储形状；不修改原始对象。 */
export declare function JobToStorage(job: any): any;
/** 岗位读取后映射为契约英文形状；不修改原始对象。 */
export declare function JobToDisplay(job: any): any;
/** 投递写入前映射为存储形状；不修改原始对象。 */
export declare function ApplicationToStorage(application: any): any;
/** 投递读取后映射为契约英文形状；不修改原始对象。 */
export declare function ApplicationToDisplay(application: any): any;
/** 档案项写入前映射为存储形状；不修改原始对象。 */
export declare function ProfileItemToStorage(item: any): any;
/** 档案项读取后映射为契约英文形状；不修改原始对象。 */
export declare function ProfileItemToDisplay(item: any): any;
/** 归一化展示用时间字段为 UTC epoch 毫秒；缺失或非法时回退到调用方提供的时间，禁止「刚刚」类展示串落库。 */
export declare function NormalizeEpochMs(value: unknown, fallback: number): number;
