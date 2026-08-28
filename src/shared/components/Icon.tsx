import type { CSSProperties, ImgHTMLAttributes } from 'react';

type IconName = 'assistant' | 'jobs' | 'applications' | 'resumes' | 'profiles' | 'developer' | 'plus' | 'resume' | 'resume-panel' | 'browser' | 'panel-expand' | 'panel-shrink' | 'brand' | 'more' | 'settings' | 'developer-mode' | 'balance' | 'logout' | 'sidebar-expand' | 'sidebar-collapse' | 'chevron-down' | 'chevron-up' | 'send' | 'edit' | 'delete' | 'heart' | 'map-pin' | 'arrow-right' | 'loading' | 'error' | 'recovery' | 'refresh' | 'close' | 'stop' | 'music' | 'user-check' | 'user-x' | 'deepseek' | 'window-minimize' | 'window-restore' | 'window-maximize' | 'trace' | 'logs' | 'search';

/** Iconfont 集合 16880 的 PNG 资源，采用 mask 保留当前组件可继承的色彩状态。 */
const assets: Record<IconName, string> = {
  assistant: 'drafts', jobs: 'folders', applications: 'bookmark2', resumes: 'file-text', profiles: 'id', developer: 'pc-analytics', plus: 'plus', resume: 'file-text', 'resume-panel': '简历', browser: '浏览器', 'panel-expand': '../coolicons/panel-expand', 'panel-shrink': '../coolicons/panel-shrink', brand: 'brightness', more: 'more', settings: 'brightness', 'developer-mode': 'code', balance: 'money', logout: 'logout', 'sidebar-expand': 'layout-sidebar-right-expand', 'sidebar-collapse': 'layout-sidebar-left-expand', 'chevron-down': 'chevron-down', 'chevron-up': 'chevron-up', send: 'telegram', edit: 'edit', delete: 'clean', heart: 'star', 'map-pin': 'map-pin', 'arrow-right': 'layout-sidebar-left-expand', loading: 'loading-circle', error: 'warning-filled', recovery: 'reload', refresh: 'reload', close: 'close', stop: 'pause-filled', music: 'microphone', 'user-check': 'user-check', 'user-x': 'user-x', deepseek: 'deepseek-color', 'window-minimize': 'minus', 'window-restore': 'copy', 'window-maximize': 'checkbox', trace: 'code', logs: 'list-line', search: 'search',
};

function Icon({ name, size = 20, className = '', style, ...props }: { name: IconName; size?: number } & Omit<ImgHTMLAttributes<HTMLSpanElement>, 'children' | 'src'>) {
  // Vite 的 Electron 构建以 file:// 打开 index.html；这里必须是相对路径，不能从磁盘根目录解析。
  const path = `./assets/iconfont/${assets[name]}.png`;
  return <span className={`iconfont-png iconfont-${name} ${className}`} style={{ '--icon-image': `url("${path}")`, width: size, height: size, ...style } as CSSProperties} aria-hidden="true" {...props} />;
}

export { Icon, type IconName };
