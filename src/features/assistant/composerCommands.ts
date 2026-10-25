import type { IconName } from '../../shared/components/Icon';

export type ComposerMode = 'plan' | 'goal';
export interface ComposerCommand {
  id: string;
  kind: 'command' | 'skill';
  token: string;
  label: string;
  description: string;
  icon: IconName;
  action: 'reload' | 'placeholder' | 'skill';
  mode?: ComposerMode;
  skillId?: string;
  keywords?: string;
}

/** 面板与键盘行为只消费命令定义；后续命令在此注册，不在渲染循环中增加分支。 */
export const ComposerCommands: readonly ComposerCommand[] = [
  { id: 'reload', kind: 'command', token: '/reload', label: '重载上下文', description: '更新当前会话的上下文配置', icon: 'refresh', action: 'reload', keywords: '重载 刷新 上下文' },
  { id: 'plan', kind: 'command', token: '/plan', label: '计划模式', description: '先梳理目标，再制定执行步骤', icon: 'clipboard-text', action: 'placeholder', mode: 'plan', keywords: '计划 模式' },
  { id: 'goal', kind: 'command', token: '/goal', label: '目标模式', description: '围绕明确目标，持续推进任务', icon: 'target', action: 'placeholder', mode: 'goal', keywords: '目标 模式' },
];
const SkillLabels: Record<string, [string, string]> = {
  'job-discovery': ['岗位发现', '搜索、筛选和比较招聘岗位'],
  'resume-tailoring': ['简历定制', '结合目标岗位分析和优化简历'],
  'job-application': ['官网投递', '处理企业招聘官网的申请流程'],
  'boss-deliver-workflow': ['BOSS 投递', '协作完成 BOSS 招聘平台投递'],
  'company-career-form': ['招聘表单', '处理企业招聘与 ATS 表单'],
};

export function CreateSkillCommands(skills: Array<{ id: string; name: string; description: string }>): ComposerCommand[] {
  const order = Object.keys(SkillLabels);
  const Rank = (id: string) => order.includes(id) ? order.indexOf(id) : order.length;
  return [...skills].sort((left, right) => Rank(left.id) - Rank(right.id)).map((skill) => ({
    id: `skill:${skill.id}`, kind: 'skill', token: `/${skill.id}`, skillId: skill.id,
    label: SkillLabels[skill.id]?.[0] ?? skill.name,
    description: SkillLabels[skill.id]?.[1] ?? skill.description,
    icon: 'codesandbox-logo', action: 'skill', keywords: `${skill.name} ${skill.description} 技能 skill`,
  }));
}

export interface SlashContext { value: string; end: number; query: string; }
/** 只读取整段正文句首至折叠光标之间的半角命令，光标后的草稿不参与搜索。 */
export function ParseSlashContext(value: string, start: number, end: number): SlashContext | null {
  if (start !== end) return null;
  const match = /^\/([a-zA-Z0-9_-]*)$/.exec(value.slice(0, end));
  return match ? { value, end, query: match[1].toLowerCase() } : null;
}
export const SlashSignature = (context: SlashContext) => `${context.value}\u0000${context.end}`;
export function FilterComposerCommands(commands: readonly ComposerCommand[], query: string) {
  return commands.filter((command) => {
    if (query === 'skill') return command.kind === 'skill';
    return command.token.slice(1).startsWith(query)
      || `${command.token.slice(1).replaceAll('-', ' ')} ${command.label} ${command.keywords ?? ''}`.toLowerCase().split(/\s+/).some((word) => word.startsWith(query));
  });
}
