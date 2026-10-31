# 浏览器快照与增量观察

## 返回契约

- `BrowserSnapshot({ mode?: 'auto' | 'full' })` 默认自动选择输出形式。
- `mode=full` 返回精简 `refs`、当前 `snapshotId`、URL、标题、`pageRevision`、标签页和截断状态。
- `mode=delta` 返回 `baseSnapshotId`、新增 `added`、修改 `updated`、删除 `removed`；节点顺序变化时附带当前完整引用顺序 `order`。
- `mode=unchanged` 表示交互元素没有变化，仍携带当前 `snapshotId` 和 `pageRevision`。
- 增量中的元素是完整的当前元素描述。删除引用不得继续操作。
- 首次读取、URL 或文档变化、新请求、显式 `full`、依赖回执不在模型上下文中、截断或增量体积更大时返回全量。
- 内部业务、权限与页面风险判断继续读取完整快照；模型输出不重复携带正文与内部字段匹配特征。
- 精简字段保留邻近标签，区分多个“请输入”控件；采集无 role 但可交互的短文本列表项、日历单元格，并排除视口内被弹层遮挡的控件。

## 引用与操作

- 同一真实节点在插入、重排和重新观察后保留引用编号。
- 节点被替换、页面文档切换时，旧引用不得绑定到同名或同路径的新节点。
- 引用身份在任务页的隔离世界中维护，页面脚本不能访问该映射。
- 动作继续要求当前 `pageRevision`；编号稳定不取消过期引用、可见性、命中与权限校验。
- 紧接成功 `BrowserFill` 的 Enter 返回 `referencesPreserved: true` 时，可继续使用同批已观察引用，填写结束后统一用快照或支持的截图核对。独立 Enter 和其他按键仍清空引用。驱动每次操作继续校验文档与真实节点；URL 改变、同 URL 文档重载、节点替换或不可见时不能凭保留引用继续写入。
- 扩展新增 `Page.getFrameTree`、`Page.createIsolatedWorld` 白名单能力；Worker 与 Host 协议指纹为 `avery-browser-extension-bridge-v2`。开发环境更新后需重新加载扩展。

## 验证顺序

| 顺序 | 优先级 | 验证项 | 本次范围 |
| --- | --- | --- | --- |
| 1 | P0 | 插入与重排后，原节点编号保持稳定 | 单元测试和真实 Chrome |
| 2 | P0 | 同名同路径节点替换后，旧引用被拒绝且未触发新节点 | 单元测试和真实 Chrome |
| 3 | P0 | 同 URL 文档重载不复用旧引用；相关控件操作无回归 | 真实 Chrome |
| 4 | P1 | Chrome、DeepSeek V4 Flash、low 思考强度，教育经历场景的 Token 与成功率 | 真实网站对比；以页面状态和 Provider usage 为准 |
| 最后 | 压缩集成 | 上下文压缩后的全量恢复 | 由压缩模块回归与隔离真实页面验证覆盖；见 [上下文压缩](./22-context-compaction-plan.md) |

P0 本地验证命令：`node scripts/verify-browser-snapshot.mjs`。需先构建 Backend，并安装 Google Chrome。结果和截图写入 `output/snapshot-eval/p0/`。

参考：[ego-lite Page 引用注册机制](https://github.com/citrolabs/ego-lite/blob/d392204d1ea1a8027a591ab2b0129c2e11d85f26/package/ego-browser/src/page-ref-registry.ts)。
