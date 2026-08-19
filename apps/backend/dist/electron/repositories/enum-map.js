"use strict";
/** 中英枚举映射：契约层使用稳定英文值，持久化层保持存量中文兼容；双向转换集中在本模块供各 Repository 读写边界使用。 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileCategoryDisplay = exports.ProfileCategoryStorage = exports.ApplicationStatusDisplay = exports.ApplicationStatusStorage = exports.ChannelDisplay = exports.ChannelStorage = exports.EmploymentTypeDisplay = exports.EmploymentTypeStorage = void 0;
exports.ToStorage = ToStorage;
exports.ToDisplay = ToDisplay;
exports.JobToStorage = JobToStorage;
exports.JobToDisplay = JobToDisplay;
exports.ApplicationToStorage = ApplicationToStorage;
exports.ApplicationToDisplay = ApplicationToDisplay;
exports.ProfileItemToStorage = ProfileItemToStorage;
exports.ProfileItemToDisplay = ProfileItemToDisplay;
exports.NormalizeEpochMs = NormalizeEpochMs;
exports.EmploymentTypeStorage = { intern: '实习', full_time: '正式工' };
exports.EmploymentTypeDisplay = { 实习: 'intern', 正式工: 'full_time' };
exports.ChannelStorage = { boss_zhipin: 'BOSS直聘', company_website: '企业官网', other: '其他' };
exports.ChannelDisplay = { BOSS直聘: 'boss_zhipin', 企业官网: 'company_website', 其他: 'other' };
exports.ApplicationStatusStorage = { saved: '已收藏', applied: '已投递', written_test: '笔试中', interviewing: '面试中', ended: '已结束' };
exports.ApplicationStatusDisplay = { 已收藏: 'saved', 已投递: 'applied', 笔试中: 'written_test', 面试中: 'interviewing', 已结束: 'ended' };
exports.ProfileCategoryStorage = { project: '项目经历', work: '工作经历', education: '教育背景', skill_certificate: '技能/证书', other: '其他附件' };
exports.ProfileCategoryDisplay = { 项目经历: 'project', 工作经历: 'work', 教育背景: 'education', '技能/证书': 'skill_certificate', 其他附件: 'other' };
/** 英文值映射为存储中文值；已是中文或未知值原样透传（容忍存量与未列枚举）。 */
function ToStorage(value, storageMap) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(storageMap, value) ? storageMap[value] : value;
}
/** 存储中文值映射为契约英文值；已是英文或未知值原样透传。 */
function ToDisplay(value, displayMap) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(displayMap, value) ? displayMap[value] : value;
}
/** 岗位写入前映射为存储形状；不修改原始对象。 */
function JobToStorage(job) {
    if (!job || typeof job !== 'object')
        return job;
    return { ...job, employmentType: ToStorage(job.employmentType, exports.EmploymentTypeStorage), channel: ToStorage(job.channel, exports.ChannelStorage) };
}
/** 岗位读取后映射为契约英文形状；不修改原始对象。 */
function JobToDisplay(job) {
    if (!job || typeof job !== 'object')
        return job;
    return { ...job, employmentType: ToDisplay(job.employmentType, exports.EmploymentTypeDisplay), channel: ToDisplay(job.channel, exports.ChannelDisplay) };
}
/** 投递写入前映射为存储形状；不修改原始对象。 */
function ApplicationToStorage(application) {
    if (!application || typeof application !== 'object')
        return application;
    return { ...application, status: ToStorage(application.status, exports.ApplicationStatusStorage) };
}
/** 投递读取后映射为契约英文形状；不修改原始对象。 */
function ApplicationToDisplay(application) {
    if (!application || typeof application !== 'object')
        return application;
    return { ...application, status: ToDisplay(application.status, exports.ApplicationStatusDisplay) };
}
/** 档案项写入前映射为存储形状；不修改原始对象。 */
function ProfileItemToStorage(item) {
    if (!item || typeof item !== 'object')
        return item;
    return { ...item, category: ToStorage(item.category, exports.ProfileCategoryStorage) };
}
/** 档案项读取后映射为契约英文形状；不修改原始对象。 */
function ProfileItemToDisplay(item) {
    if (!item || typeof item !== 'object')
        return item;
    return { ...item, category: ToDisplay(item.category, exports.ProfileCategoryDisplay) };
}
/** 归一化展示用时间字段为 UTC epoch 毫秒；缺失或非法时回退到调用方提供的时间，禁止「刚刚」类展示串落库。 */
function NormalizeEpochMs(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
