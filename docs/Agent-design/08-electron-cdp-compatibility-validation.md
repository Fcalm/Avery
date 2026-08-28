# agent-browser 连接 Electron WebContentsView 的 CDP 兼容性验证

## 1. 验证结论

验证日期：2026-08-24。

`agent-browser 0.34.0` 可以通过 CDP 连接 `Electron 43.3.0` 的专用 `WebContentsView`，导航、快照、读取、填写、点击、按键和截图等基础动作均可工作，因此功能层面兼容。

当前方案不能直接替换独立 Chromium Runtime。Electron 的 `--remote-debugging-port` 暴露整个应用进程的全部 DevTools targets，`agent-browser` 可以切换到 OfferGet 主界面；`--pin-tab` 和直接传入 page WebSocket URL 都不能形成安全隔离。该问题属于发布阻断，不应只依靠 system prompt 或工具白名单规避。

## 2. 验证环境

- Windows
- Electron：`43.3.0`
- agent-browser：`0.34.0`
- 被测对象：与生产实现相同的 `BrowserPanelHost` 和 `WebContentsView`
- 页面：本地隔离测试页，不访问真实招聘网站，不执行真实投递

## 3. 验证结果

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 连接 Electron CDP | 通过 | CLI 返回 `launched: false`、`reused: true`，没有启动或安装额外 Chromium |
| 发现专用 WebContentsView | 通过 | 专用页面作为独立 `page` target 出现 |
| Snapshot / Read | 通过 | 可读取专用页面的可访问性树和文本 |
| Fill | 通过 | 输入框值可正确写入 |
| Click / Press | 条件通过 | 必须先让专用 `webContents` 持有 Electron 输入焦点；未聚焦时 CLI 会错误地报告成功但页面不产生事件 |
| Navigate | 通过 | 导航后仍附着在原 target，可重新生成 refs |
| Screenshot | 通过 | 截图内容为专用页面 |
| 主界面隔离 | 不通过 | 同一 CDP 端口同时列出主界面和专用页面，且可读取主界面内容 |
| `--pin-tab` 隔离 | 不通过 | 启用后仍可执行 `tab` 切换到主界面 |
| page WebSocket 直连隔离 | 不通过 | CLI 会恢复到 browser 级连接，仍可枚举两个 targets |

## 4. 接入时必须满足的条件

1. 每次鼠标或键盘动作前，主进程必须确认目标仍是当前 Browser tab，并显式调用对应 `webContents.focus()`；不能使用定时抢焦点，否则会破坏用户操作主界面。
2. 不能把应用进程的原始远程调试端口直接交给 Agent Runtime。
3. 必须在 Agent 无法枚举、附着或切换到主界面的前提下，才可以复用内置浏览器。
4. target 标识必须由主进程持有，模型和普通 Renderer 不得取得 CDP 地址、端口或主界面 target 信息。
5. 仍需保留既有 URL、重定向、上传文件、确认、取消和 `status_unknown` 边界；CDP 复用不替代 Harness。

## 5. 后续可选方向

### 方向 A：受控 CDP 代理

在本机创建只暴露一个专用 target 的 CDP 代理，并过滤 `Target.*`、BrowserContext 和其他可跨 target 的命令。该方案可以保留 `agent-browser` CLI 和真正的内置 `WebContentsView`，但实现及安全验证难度高。

### 方向 B：Electron 原生工具适配器

不把 CDP 端口交给 `agent-browser`，由主进程通过 `webContents.debugger` 实现原子动作。安全边界更清晰，但不再复用 `agent-browser` CLI 的操作实现。

### 方向 C：独立的 Electron 浏览器伴随进程

使用应用已经携带的 Electron Chromium 启动隔离浏览器进程，再让 `agent-browser` 连接该进程。这样不需要额外安装 Chromium，也不会暴露主应用 target；代价是浏览器仍是独立窗口，无法作为同一进程的 `WebContentsView` 嵌入。

在受控 CDP 代理完成安全原型前，建议继续保留当前独立 Runtime，不直接切换生产实现。

## 6. 方案决定

2026-08-24 决定采用方向 C：使用应用自带 Electron 启动隔离浏览器伴随进程。伴随进程拥有独立 Profile 和随机本地 CDP 端口，不初始化 OfferGet 主界面或 Backend；`agent-browser` 只连接该进程。主进程 `WebContentsView` 的直接 CDP 接入停止推进，Chromium 安装流程删除。

实现验证中确认 `agent-browser` 不能在 Electron 单 target 会话中使用 `Target.createTarget`。最终伴随进程包含无业务数据的内部 Shell target 和覆盖窗口的招聘网页 `WebContentsView` target；Runtime 先在不启用 pin 的情况下发现并选择 `/ready`，随后对原子动作启用 sticky pin，并从模型可见标签列表过滤内部 URL。开发态和打包态均验证 Snapshot、Fill、Click 成功，且没有 OfferGet 主界面 target。
