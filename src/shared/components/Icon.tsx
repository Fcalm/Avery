import type { CSSProperties, ImgHTMLAttributes } from 'react';

/** 图标字重：对应 Phosphor 的 Regular / Light / Fill 三套本地字体。 */
type IconWeight = 'regular' | 'light' | 'fill';

type IconName = 'assistant' | 'jobs' | 'applications' | 'resumes' | 'profiles' | 'developer' | 'plus' | 'resume' | 'resume-panel' | 'browser' | 'panel-expand' | 'panel-shrink' | 'brand' | 'more' | 'settings' | 'developer-mode' | 'balance' | 'logout' | 'sidebar-expand' | 'sidebar-collapse' | 'chevron-down' | 'chevron-up' | 'chevron-right' | 'send' | 'edit' | 'delete' | 'archive' | 'heart' | 'map-pin' | 'arrow-right' | 'arrow-left' | 'loading' | 'error' | 'recovery' | 'refresh' | 'close' | 'stop' | 'music' | 'user-check' | 'user-x' | 'deepseek' | 'window-minimize' | 'window-restore' | 'window-maximize' | 'trace' | 'logs' | 'search' | 'moon' | 'sun' | 'check' | 'check-circle' | 'pin' | 'account' | 'workspace' | 'sliders' | 'paperclip' | 'brain' | 'gauge' | 'folder-simple' | 'shield-check' | 'pencil-simple' | 'robot' | 'lightning' | 'briefcase' | 'clock' | 'copy' | 'info' | 'cpu' | 'list-bullets' | 'sparkle' | 'user' | 'wrench' | 'download-simple' | 'eye' | 'eye-slash' | 'lock-simple';

/**
 * IconName 到 Phosphor 字形的映射。深松绿设计系统的图标统一来自
 * Phosphor 本地字体（public/fonts/phosphor，随安装包离线加载）；
 * 字形清单见 src/styles/phosphor.css，新增图标需同步补充码点声明。
 */
const glyphs: Record<IconName, string> = {
  assistant: 'chats-circle', jobs: 'stack', applications: 'kanban', resumes: 'file-text', profiles: 'identification-card', developer: 'code', plus: 'plus', resume: 'file-text', 'resume-panel': 'file-text', browser: 'globe', 'panel-expand': 'arrows-out-simple', 'panel-shrink': 'arrows-in-simple', brand: 'sparkle', more: 'dots-three', settings: 'gear-six', 'developer-mode': 'code', balance: 'coins', logout: 'sign-out', 'sidebar-expand': 'sidebar-simple', 'sidebar-collapse': 'sidebar-simple', 'chevron-down': 'caret-down', 'chevron-up': 'caret-up', 'chevron-right': 'caret-right', send: 'paper-plane-right', edit: 'pencil-simple', delete: 'trash', archive: 'archive', heart: 'heart', 'map-pin': 'map-pin', 'arrow-right': 'arrow-right', loading: 'circle-notch', error: 'warning', recovery: 'arrows-counter-clockwise', refresh: 'arrows-clockwise', close: 'x', stop: 'stop', music: 'microphone', 'user-check': 'user-check', // Phosphor 无 user-x，语义最接近的是授权盾牌
  'user-x': 'shield-check', deepseek: 'deepseek', 'window-minimize': 'minus', 'window-restore': 'corners-in', 'window-maximize': 'corners-out', trace: 'tree-structure', logs: 'list-dashes', search: 'magnifying-glass', moon: 'moon', sun: 'sun', check: 'check', 'check-circle': 'check-circle', pin: 'push-pin', account: 'user-circle', workspace: 'folder-open', sliders: 'sliders-horizontal',
  'arrow-left': 'arrow-left',
  paperclip: 'paperclip', brain: 'brain', gauge: 'gauge', 'folder-simple': 'folder-simple',
  'shield-check': 'shield-check', 'pencil-simple': 'pencil-simple', robot: 'robot', lightning: 'lightning', briefcase: 'briefcase',
  // 对话轨迹（原型一比一）：创建时间 / 模型 / 角色筛选与角色徽标
  clock: 'clock', cpu: 'cpu', 'list-bullets': 'list-bullets', sparkle: 'sparkle', user: 'user', wrench: 'wrench',
  // 档案界面（原型一比一）：复制内容
  copy: 'copy',
  // 投递详情（原型一比一）：下一步提示条的普通态
  info: 'info',
  // 简历抽屉（原型一比一）：下载 PDF
  'download-simple': 'download-simple',
  // 模型配置（原型一比一）：API Key 显示与隐藏、弹窗里固定输入类型的锁标记
  eye: 'eye', 'eye-slash': 'eye-slash', 'lock-simple': 'lock-simple',
};

/** 未收录于 Phosphor 的品牌图标继续走本地 PNG 资源。 */
const pngAssets: Partial<Record<IconName, string>> = { deepseek: 'deepseek-color' };

function Icon({ name, size = 20, weight = 'regular', className = '', style, ...props }: { name: IconName; size?: number; weight?: IconWeight } & Omit<ImgHTMLAttributes<HTMLElement>, 'children' | 'src'>) {
  // Vite 的 Electron 构建以 file:// 打开 index.html；PNG 路径必须按文档基址解析成绝对 URL，
  // 否则构建产物的 CSS（/assets/index-*.css）会把样式表里的相对 url 解析到 /assets/assets/ 下。
  const png = pngAssets[name];
  if (png) {
    const path = new URL(`./assets/iconfont/${png}.png`, document.baseURI).href;
    return <span className={`iconfont-png iconfont-${name} ${className}`} style={{ '--icon-image': `url("${path}")`, width: size, height: size, ...style } as CSSProperties} aria-hidden="true" {...props} />;
  }
  // 字重通过三套字体族表达：Regular 用基础 .ph，Light/Fill 追加修饰类。
  const weightClass = weight === 'regular' ? '' : ` ph-${weight}`;
  return <i className={`ph${weightClass} ph-${glyphs[name]} ${className}`} style={{ fontSize: size, width: size, height: size, ...style } as CSSProperties} aria-hidden="true" {...props} />;
}

export { Icon, type IconName, type IconWeight };
