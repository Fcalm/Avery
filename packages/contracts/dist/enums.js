"use strict";
/** 跨进程稳定英文枚举：中文文案只在前端 label map 中转换，枚举值不进入持久化对比。 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobScoreValues = exports.ProfileCategoryValues = exports.ApplicationStatusValues = exports.ChannelValues = exports.EmploymentTypeValues = void 0;
/** 用工类型：实习 / 正式工。 */
exports.EmploymentTypeValues = ['intern', 'full_time'];
/** 岗位渠道：BOSS 直聘 / 企业官网 / 其他。 */
exports.ChannelValues = ['boss_zhipin', 'company_website', 'other'];
/** 投递状态：已收藏 / 已投递 / 笔试中 / 面试中 / 已结束。 */
exports.ApplicationStatusValues = ['saved', 'applied', 'written_test', 'interviewing', 'ended'];
/** 档案分类：项目经历 / 工作经历 / 教育背景 / 技能证书 / 其他附件。 */
exports.ProfileCategoryValues = ['project', 'work', 'education', 'skill_certificate', 'other'];
/** 岗位匹配分档：待计算 / 较差 / 优良 / 极好。 */
exports.JobScoreValues = ['pending', 'poor', 'good', 'excellent'];
