/**
 * 为纯 Node 的 Backend Utility Process 提供 pdf-parse 依赖的浏览器几何全局。
 * Electron 主进程由 Chromium 注入 DOMMatrix/ImageData，utilityProcess 缺失；这里提供最小但数学正确的 2D 仿射实现。
 */
/** 在 Backend 启动时注入缺失的浏览器几何全局；已存在则跳过（兼容未来 Chromium 注入）。 */
export declare function InstallBrowserPolyfills(): void;
