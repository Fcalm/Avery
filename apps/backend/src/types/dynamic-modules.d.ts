/**
 * 原生或动态加载依赖的模块声明。
 * 这些模块仅在 Backend Worker / 解析路径中按需 require，不进入 Backend 启动热路径；
 * 声明为 any 仅用于让 TypeScript 编译通过，具体调用处仍以运行时防御校验为准。
 */
declare module 'better-sqlite3';
declare module 'pdf-parse';
declare module 'mammoth';
declare module 'tesseract.js';
declare module '@tesseract.js-data/eng';
declare module '@tesseract.js-data/chi_sim';
declare module '@napi-rs/canvas';
