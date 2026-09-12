import type { PageId } from '../types/domain';
import type { IconName } from '../shared/components/Icon';

export const MainRoutes: Array<{ id: PageId; label: string; icon: IconName; group: 'scene' | 'mine' | 'developer' }> = [
  { id: 'assistant', label: '对话', icon: 'assistant', group: 'scene' },
  { id: 'jobs', label: '岗位', icon: 'jobs', group: 'scene' },
  { id: 'resumes', label: '简历', icon: 'resumes', group: 'mine' },
  { id: 'applications', label: '投递记录', icon: 'applications', group: 'scene' },
  { id: 'profiles', label: '档案', icon: 'profiles', group: 'mine' },
  { id: 'developer', label: '开发者工具', icon: 'developer', group: 'developer' },
];
