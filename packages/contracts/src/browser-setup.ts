/** 三种 Chromium 浏览器统一通过 Avery 扩展接入。 */
export type ExtensionBrowserEngine = 'chrome' | 'edge' | 'ego';

/** 打开安装入口不等于安装或连接成功，连接结果仍由真实握手决定。 */
export interface BrowserExtensionSetup {
  engine: ExtensionBrowserEngine;
  extensionDirectory: string;
  directoryOpened: boolean;
}

/** ego lite 直接启动并握手；尚未安装时只打开官网，不伪报安装成功。 */
export type EgoBrowserSetup =
  | { engine: 'ego'; action: 'launched'; status: import('./bridge').AgentBrowserRuntimeStatus }
  | { engine: 'ego'; action: 'download_opened' };
