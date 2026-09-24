# 个人浏览器轻量 CDP 验证归档

> 状态：历史方案，后续由 [Browser Tools：个人浏览器迁移规划](./07-browser-tools-development-plan.md) 替代

## 1. 验证结论

2026-09-04 的逐项测试确认：浏览器级 CDP 连接、单 target 附着、导航、截图、鼠标事件和逐字符输入不会单独触发 BOSS 风控；`agent-browser 0.34.0` 初始化执行 `Runtime.enable` 后，BOSS 页面会立即进入异常状态。

因此，个人浏览器曾改为 Avery 内部轻量 CDP 驱动，并禁止 `Runtime.enable`、`Page.enable`、`Network.enable`、`WebMCP.enable` 和 `Target.setAutoAttach`。该过渡实现能够复用登录态并完成 BOSS 核心操作，但仍要求用户开启远程调试，无法稳定覆盖未知企业官网和 CronTask 无人值守启动。

## 2. 历史实现边界

- 只连接用户已经启动并授权远程调试的 Chrome 或 Edge。
- 只创建并附着一个 BOSS 任务 target。
- 不读取或暴露其他私人标签页。
- 模型只使用既有 `Browser*` 工具，不接触 CDP 方法和参数。
- 关闭 Runtime 只断开 WebSocket，不结束用户浏览器或清理 Profile。
- CronTask 授权与浏览器在线状态分离；连接、登录或验证码失败进入 `needsAttention`。

## 3. 历史验证记录

- 轻量 CDP Runtime、Runtime 分流和 14 个浏览器工具映射已完成。
- 相关 4 个测试文件共 41 项通过，Backend、Contracts、Agent SDK 和 Renderer 构建通过。
- 真实 Chrome 冒烟能够创建专用 BOSS 任务页并取得可交互引用。
- 后续 BOSS 采集、打招呼、图片上传和失焦操作验证均以该 Runtime 完成。

## 4. 替代决定

个人浏览器目标实现改为 Avery 浏览器扩展和本地 Browser Bridge：

- 不再要求开启远程调试端口。
- 一次设备级启用后可操作任务创建的招聘网站标签页。
- 同时覆盖 BOSS、第三方招聘平台和未知企业招聘官网。
- CronTask 可以正常启动用户浏览器并等待扩展连接，不需要执行时人工批准 CDP。

旧 CDP Runtime 在扩展方案通过真实流程和 CronTask 验收前保留；删除条件、执行步骤和验收标准统一以 `07-browser-tools-development-plan.md` 为准。
