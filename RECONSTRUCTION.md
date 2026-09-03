# Avery 重建说明

本目录是从磁盘损坏后的残留文件和已打包应用恢复出的独立工作区；原目录 `C:\Users\fanweiqian\Desktop\avery` 未被修改。

## 已恢复且可维护的源码

- `src/`：React 渲染进程源码。
- `packages/*/src`：contracts、agent-sdk、agent-core、agent-module-host、agent-modules-defaults 的 TypeScript 源码。
- `public/`、`scripts/`：静态资源和发布验证脚本。
- `migrations/business`：业务数据库迁移。

## 从打包产物恢复的运行时层

- `apps/backend/dist`：后端编译后的 CommonJS JavaScript。
- `apps/desktop/dist`：Electron 主进程和 Gateway 编译后的 CommonJS JavaScript。
- `electron/preload.cjs`：预加载桥接。

这三部分的原 TypeScript 源文件、原始构建配置和 Git 历史均未能从磁盘恢复。它们保留为可运行 JS，后续修改时应逐步迁移回新的 TypeScript 源文件，而不应声称它们是原始源码。

## 验证结果

- `npm run build`：通过，重新编译五个 TypeScript workspace 包及 Vite 前端。
- Electron 隔离冒烟测试：通过，前端已加载，后端状态为 `ready`。

## 当前限制

- 该工作区暂以复制的 `node_modules` 进行验证，尚未成功生成全新的 `package-lock.json`；全局 npm 缓存的权限错误阻断了干净安装。
- 原始 Git 提交历史不可恢复；需在确认重建目录后重新初始化版本库。
- 正式 Windows 安装包仍需补充稳定的 `.ico` 图标资源和独立依赖安装后再生成。
