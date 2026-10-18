import type { RecruitmentSource } from '@avery/contracts';
import { CreateSource } from './ats/source-runner';

/** 首批仅发布已验证入口；本地启停覆盖单独保存，不修改随版本发布的名单。 */
export const BuiltinRecruitmentSources: RecruitmentSource[] = [
  ['iflytek', '科大讯飞', 'https://iflytek.zhiye.com/', 'beisen', 'mixed'],
  ['hec', '东阳光', 'https://hec.zhiye.com/', 'beisen', 'mixed'],
  ['epoint', '新点软件', 'https://epoint.zhiye.com/', 'beisen', 'mixed'],
  ['unitree', '宇树科技', 'https://unitree.zhiye.com/', 'beisen', 'mixed'],
  ['deli', '得力集团', 'https://app.mokahr.com/campus-recruitment/nbdeli/70019', 'moka', 'campus'],
  ['ruijie', '锐捷网络', 'https://app.mokahr.com/campus-recruitment/ruijie/136206', 'moka', 'campus'],
  ['talkweb', '拓维信息', 'https://app.mokahr.com/social-recruitment/talkweb/71920', 'moka', 'social'],
  ['cyou', '搜狐畅游', 'https://app.mokahr.com/campus-recruitment/cyou-inc/42233', 'moka', 'campus'],
  ['crrc', '中国中车', 'https://crrc.hotjob.cn/SU64d47c466202cc36e27a52d4/pb/social.html', 'hotjob', 'social'],
  ['imech', '中科院力学研究所', 'https://wecruit.hotjob.cn/SU67b689391eb80555b7a914d0/pb/school.html', 'hotjob', 'campus'],
].map(([companyId, company, url, platform, category]) => ({
  sourceId: CreateSource({ company, url }).id, companyId, company, url,
  platform: platform as RecruitmentSource['platform'], category: category as RecruitmentSource['category'],
  enabled: true, origin: 'builtin', lastValidatedAt: '2026-10-11T09:30:09.433Z',
}));
