import type { PageId } from '../types/domain';
import type { IconName } from '../shared/components/Icon';

export const MainRoutes: Array<{ id: PageId; label: string; icon: IconName; group: 'scene' | 'mine' | 'developer' }> = [
  { id: 'assistant', label: '求职助手', icon: 'assistant', group: 'scene' },
  { id: 'jobs', label: '岗位库', icon: 'jobs', group: 'scene' },
  { id: 'applications', label: '投递管理', icon: 'applications', group: 'scene' },
  { id: 'resumes', label: '简历库', icon: 'resumes', group: 'mine' },
  { id: 'profiles', label: '档案库', icon: 'profiles', group: 'mine' },
  { id: 'developer', label: '开发者工具', icon: 'developer', group: 'developer' },
];
