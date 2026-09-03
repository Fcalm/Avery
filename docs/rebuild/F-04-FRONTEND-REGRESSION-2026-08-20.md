# F-04 前端功能回归记录（2026-08-20）

> 状态：**当前可自动化范围通过；完整里程碑验收未完成。**
> 原因：真实 Provider 连接、发送/停止/失败重试、会话 Usage/项目环境切换，以及 1024×680 多页面键盘与拖拽回归尚无可由本地确定性 fixture 驱动的 Electron E2E 脚本；不得以模拟结果代替这些门禁。

## 已通过

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 首次引导 | 通过 | 空工作空间启动截图显示 9 步引导首屏与“下一步”主操作。 |
| 设置、简历、岗位、投递、档案、附件、备份与导出 | 通过 | Electron 生命周期 seed/verify：设置已完成、1 份简历（2 个版本）、1 条岗位、1 条投递、1 条档案、附件保留、备份 1 份，PDF/DOCX/PNG 导出均成功。 |
| Renderer / Backend 启动 | 通过 | `rendererLoaded: true`、`backendReady: true`；verify 启动 1708ms，小于 2 秒门槛。 |
| 1280×800 与 1024×680 主页面 | 通过 | 实际 Electron 依次进入求职助手、岗位库、投递管理、简历库、档案库、开发者工具，共 12 项；均无横向溢出、关键操作越界或 Renderer console error。 |
| Desktop TypeScript 迁移产物 | 通过 | `npm run build --workspace @avery/desktop` 通过。 |
| 构建与已有回归 | 通过 | `npm test`、`npm run build`、`git diff --check` 均通过。Vitest：36 passed、6 expected fail（均为 Agent 已知差距，不属于前端回归失败）。 |

## 发现与处理

直接在全新用户目录执行视觉冒烟时，应用正确进入首次引导，因此不存在导航节点；视觉脚本将其误判为失败且等待满 5 秒。改用同一用户目录按 `seed → verify + visual` 生命周期执行后，导航就绪、截图与视觉检查均通过。该结果说明脚本必须以已完成引导的 fixture 运行，不能把首次启动作为已填充页面视觉场景。

视觉冒烟现已扩展为双窗口档位和六个主页面的检查。其键盘事件在无交互桌面会话中未能由 Chromium 派发到 Renderer，不能据此推断页面键盘路径失败；该项仍保留给带前台焦点的 Playwright/Electron E2E 或人工验证。

## 产物

- `output/f04-lifecycle/seed-result.json`
- `output/f04-lifecycle/visual-result.json`
- `output/f04-lifecycle/installed-home-1280x800.png`
- `output/f04-responsive/visual-result.json`
- `output/f04-responsive/*-1280x800.png`
- `output/f04-responsive/*-1024x680.png`

## 尚未验证的发布门禁

1. 真实 Provider 的连接成功、认证失败、超时、取消、停止与重试。
2. 多会话之间 Usage、项目环境及迟到流事件隔离。
3. 抽屉/弹窗焦点陷阱、键盘路径与拖拽边界；12 个主页面的 1024×680 布局已通过。
4. Windows 安装包安装、升级、卸载保留数据与视觉回归。

这些项目需要稳定的 E2E fixture 或已签发的测试 Provider 凭据后继续执行；在此之前 F-04 不应标记为完全验收通过。
