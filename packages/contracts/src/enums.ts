/** 跨进程稳定英文枚举：中文文案只在前端 label map 中转换，枚举值不进入持久化对比。 */

/** 用工类型：实习 / 正式工。 */
export const EmploymentTypeValues = ['intern', 'full_time'] as const;
export type EmploymentType = (typeof EmploymentTypeValues)[number];

/** 岗位渠道：BOSS 直聘 / 企业官网 / 其他。 */
export const ChannelValues = ['boss_zhipin', 'company_website', 'other'] as const;
export type Channel = (typeof ChannelValues)[number];

/** 投递状态：已收藏 / 已投递 / 笔试中 / 面试中 / 已结束。 */
export const ApplicationStatusValues = ['saved', 'applied', 'written_test', 'interviewing', 'ended'] as const;
export type ApplicationStatus = (typeof ApplicationStatusValues)[number];

/** 档案分类：项目经历 / 工作经历 / 教育背景 / 技能证书 / 其他附件。 */
export const ProfileCategoryValues = ['project', 'work', 'education', 'skill_certificate', 'other'] as const;
export type ProfileCategory = (typeof ProfileCategoryValues)[number];

/** 岗位匹配分档：待计算 / 较差 / 优良 / 极好。 */
export const JobScoreValues = ['pending', 'poor', 'good', 'excellent'] as const;
export type JobScore = (typeof JobScoreValues)[number];
