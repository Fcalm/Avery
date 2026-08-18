# OfferGet 完整项目重建计划

> 本文档用于指导将灾后恢复的 OfferGet 工作区重建为可维护、可测试、可发布的 TypeScript 项目。
>
> 当前工作区：`D:\OfferGet-Rebuild\project`。原始损坏目录 `C:\Users\fanweiqian\Desktop\offerget` 仅保留作证据与回退，不得被本计划覆盖。

## 1. 当前状态与原则

### 1.1 已保留的资产

- `src/`：React 渲染进程 TypeScript 源码。
- `packages/*/src`：`contracts`、`agent-sdk`、`agent-core`、`agent-module-host`、`agent-modules-defaults` 的 TypeScript 源码。
- `public/`、`scripts/`、`migrations/business/`：静态资源、验证脚本与业务数据库迁移。
- `apps/backend/dist`、`apps/desktop/dist`、`electron/preload.cjs`：从已打包应用提取的、可运行的 JavaScript 运行时。
- 可运行的 Electron 目录包和 NSIS 安装包。

### 1.2 不可恢复的资产

- `apps/backend`、`apps/desktop`、`electron` 的原始 TypeScript 源文件。
- 原始根构建配置、完整锁文件和本地 Git 提交历史。

### 1.3 重建原则

1. 不覆盖原项目目录；所有恢复与重建均在 D 盘独立工作区进行。
2. 将已打包 JS 视为行为基准，不将其误标为已恢复的原始源码。
3. 先恢复可重复构建与可验证运行，再逐步将运行时 JS 迁移为 TypeScript。
4. 每个模块迁移前后均需做行为对照和自动化测试。
5. 不伪造 Git 历史；新仓库应从“灾后重建基线”开始。

## 2. 需要准备的文档与材料

| 优先级 | 文档或材料 | 用途 | 缺失时的替代方案 |
| --- | --- | --- | --- |
| P0 | `AGENTS.md` 与开发约束 | 约束代码、测试、打包和提交方式 | 按当前已知约束执行，并将新规则补充到本目录 |
| P0 | V1 产品完成计划、需求文档 | 确认功能范围、验收项和优先级 | 由运行包、历史需求、截图和 UI 源码反推 |
| P0 | 数据模型与迁移说明 | 恢复 SQLite 表、版本迁移、备份策略 | 以 `migrations/business` 与仓储代码为准 |
| P0 | IPC/Bridge 契约说明 | 恢复 Renderer、Preload、Electron、Backend 的边界 | 以 `packages/contracts` 和 `preload.cjs` 反推 |
| P1 | Agent、Usage、Trace 设计说明 | 恢复真实 usage、压缩管道、可观测性和 provider 行为 | 以已编译后端、前端调用和测试需求反推 |
| P1 | UI 规范、截图、交互说明 | 恢复求职助手、拖拽、图标、侧边栏等细节 | 当前前端源码和历史截图为基准 |
| P1 | 发布说明、版本号、图标源文件 | 恢复签名、安装包、升级和图标策略 | 当前 `.ico` 与安装包为临时基线 |
| P2 | DeepSeek 官方 API 文档、测试账号 | 联调模型调用和真实 usage | 先使用 mock；最终联调需要测试 Key |

若找到旧 `Docs` 目录、旧截图、旧产品计划或其他电脑上的项目副本，应整体复制到 D 盘归档后再阅读，禁止直接覆盖本工程。

## 3. 里程碑与执行步骤

### 里程碑 A：冻结证据与建立源码基线

1. 将当前 D 盘重建工程作为唯一可编辑工程。
2. 保存当前可运行目录包与安装包，并记录 SHA-256。
3. 在 `docs/rebuild/` 维护恢复记录、缺失清单和验证结果。
4. 初始化新的 Git 仓库；首个提交说明为“灾后重建基线”，不得伪造丢失提交。
5. 将旧项目目录设为只读参考来源。

**验收标准**：源码、运行包、安装包、恢复记录互相独立；任何后续失败均可回退到当前目录包。

### 里程碑 B：恢复工程骨架与依赖可重复性

1. 固化根 `package.json`、workspace、Vite、TypeScript 和 Electron Builder 配置。
2. 在干净环境生成新的 `package-lock.json`。
3. 明确区分：
   - `dependencies`：应用运行必需依赖；
   - `devDependencies`：构建、测试和打包依赖；
   - `@offerget/*`：内部 workspace 包。
4. 固化 Windows 图标路径为 `build/icon.ico`。
5. 统一命令：`dev`、`build`、`test`、`smoke`、`pack:win`。

**验收标准**：删除 `node_modules` 后，执行 `npm ci && npm run build` 可以成功。

### 里程碑 C：恢复共享契约与 Agent 包源码

按以下顺序恢复和验证：

1. `packages/contracts`
2. `packages/agent-sdk`
3. `packages/agent-core`
4. `packages/agent-module-host`
5. `packages/agent-modules-defaults`

每个包都应补齐：导出 API 文档、单元测试、包间依赖说明和 TypeScript 构建约束。

重点测试：Agent 生命周期、取消、并发屏障、上下文压缩、trace 事件与 usage 事件。

**验收标准**：五个包可独立编译、类型检查和测试通过。

### 里程碑 D：从编译 JS 重建后端 TypeScript

当前行为基准位于 `apps/backend/dist`。迁移必须模块化进行，不能一次性把全部编译 JS 当作源码替换。

建议顺序：

1. 入口与进程宿主：`index`、`host`、`worker-host`、`router`。
2. 基础设施：SQLite Store、Worker RPC、幂等记录、可观测性 Store。
3. 仓储层：会话、简历、岗位、投递、Profile。
4. 业务服务：会话与消息、Agent Run、设置、项目环境、Trace/Developer、附件、备份与导出。
5. 每迁移一个模块，以相同输入对比 TypeScript 实现与旧 JS 行为，并补充测试。

**验收标准**：Electron 启动时实际加载由新 TypeScript 编译得到的后端文件；旧 `dist` 不再是唯一后端来源。

### 里程碑 E：重建 Electron 主进程与 Preload

当前行为基准：`apps/desktop/dist` 与 `electron/preload.cjs`。

建议顺序：

1. `preload`：定义最小、受限的 `contextBridge`。
2. `gateway`：逐个恢复 IPC channel。
3. `adapters`：文件选择、窗口控制和桌面能力。
4. `main`：窗口创建、安全策略、开发/生产加载逻辑与冒烟模式。

安全约束：

- Renderer 不得拥有 Node 权限。
- 所有业务调用必须经 Preload/IPC。
- IPC 类型必须以 `packages/contracts` 为唯一来源。
- 禁止为“先跑起来”而开启 `nodeIntegration` 或放宽 sandbox。

**验收标准**：IPC 合约测试通过；Preload 暴露能力与前端调用完全一致。

### 里程碑 F：前端功能回归

按 V1 产品计划逐项验证：

1. 首次引导、设置和模型配置。
2. 会话、消息流、取消和重新加载。
3. 每会话独立 usage 与独立项目环境。
4. DeepSeek 真实 usage 与开发者 Trace。
5. 简历、岗位、投递、档案、附件、备份与导出。
6. 求职助手的拖拽、最小宽度、控件固定、图标收缩状态。
7. 侧边栏、标题栏与窄窗口适配。

**验收标准**：按 V1 产品完成计划逐项走通；关键页面截图与当前可运行包无重大回归。

### 里程碑 G：真实 Usage 与 DeepSeek 联调

实现规则：

1. 以模型 API 返回的 `usage` 作为实际 token 用量的唯一权威来源。
2. 会话 UI 以 `total_tokens / context_limit` 表达压缩前的上下文压力。
3. `prompt_tokens` 用于展示本次发送给 API 的完整上下文规模。
4. 开发者 Trace 使用同一份真实 usage 记录，不得重复估算。
5. API 未返回 usage 时明确标记“未知/未返回”，不能伪造为真实值。
6. 历史会话重载后，usage 与项目环境必须从持久化记录恢复。

**验收标准**：真实请求后，UI、数据库和 Trace 的 usage 数值一致。

### 里程碑 H：测试、发布与验收

建立四层测试：

1. 单元测试：contracts、usage、压缩、会话状态、仓储。
2. 集成测试：SQLite、迁移、Backend IPC、Provider mock。
3. Electron 冒烟测试：Renderer 已加载、Backend ready、关键路由可用。
4. 打包测试：Windows 目录包与 NSIS 安装包。

发布流程：

1. `npm ci`
2. `npm run build`
3. `npm test`
4. Electron 冒烟测试
5. `pack:win`
6. 检查 `.ico`、`OfferGet.exe` 和安装包图标
7. 在隔离目录安装并启动
8. 生成 SHA-256、版本说明与发布清单

**验收标准**：在没有源码和全局 Node 环境的 Windows 机器上，可以安装、启动并完成核心流程。

## 4. 推荐执行顺序

1. 先完成可重复安装、构建和打包。
2. 再稳定共享包与 IPC 契约。
3. 按后端、主进程、前端的顺序迁移 TypeScript。
4. 然后做 V1 功能回归。
5. 最后完成真实 usage 联调、发布验收和新的 Git 基线。

## 5. 当前已验证结果

- 五个 TypeScript workspace 包和 Vite 前端可以构建。
- Electron 重建目录包的隔离冒烟测试通过：Renderer 已加载，Backend 状态为 `ready`。
- Windows 图标已生成并用于 `OfferGet.exe` 与 NSIS 安装包。
- 当前正式安装包：`D:\OfferGet-Rebuild\package-project\release-rebuild\OfferGet Setup 0.1.0.exe`。

## 6. 风险与待办

- 原始 Git 历史无法恢复，只能重新建立历史。
- 当前工作区曾使用复制的依赖副本完成验证；必须优先解决干净安装与锁文件生成。
- 后端、主进程和 Preload 的原始 TypeScript 仍需逐步重建。
- 旧无图标 release 在新包完成手工安装验证前应保留作回退。
