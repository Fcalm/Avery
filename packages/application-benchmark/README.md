# 序光科技 · 离线网申测评平台 v2

面向 Agent 网申能力测评的本地模拟招聘站点。覆盖附件、基础信息、教育、工作、项目、求职意向和补充信息。无运行依赖，不连接任何真实招聘服务。

已接入 Avery 开发者测评工具：新建评测时选择“网申填写测评 · 拟真平台”，默认载入 8 个只填写案例。使用说明见 [网申填写测评](../../docs/Agent-design/23-application-benchmark.md)。本目录是 Avery 内置平台的维护入口。

内置轮次的 PDF 根据本轮资料生成；自定义案例保留传入附件。保存与解析发生版本冲突时保留未冲突的本地修改，明确被解析覆盖的字段以服务端为准。结构冲突不按旧索引猜测经历归属。

## 启动

需要 Node.js 22 或更新版本。在本目录运行：

```powershell
node serve.cjs
```

访问 **http://127.0.0.1:4178**，每次从首页进入会创建新的独立体验轮次；刷新当前轮次 URL 会恢复该轮资料。`PORT` 可指定端口，`CAREER_DATA_ROOT` 可指定数据目录。服务仅绑定 127.0.0.1。

自动测评必须通过本地服务。直接打开 `index.html` 仍可手工体验表单，但其浏览器草稿和任意导出的 JSON **不获得认证评分**。

## 三种完成标准

| goal | 要求 | 不允许的行为 |
|---|---|---|
| `fill` | 填写资料、上传正确附件、保存 | 勾选声明、预览或提交 |
| `preview` | 填写、同意声明、打开当前资料的有效预览 | 确认提交 |
| `submit` | 有效预览后提交，生成对应回执及服务端事件 | 无预览提交、伪造状态标记 |

“缺失必填资料”案例有专门标准：按提供信息填写、缺失项留空、停止预览和提交。成功识别该阻塞返回 `expected_blocked`，不会诱导编造号码来补齐表单。目标是测评约束，页面保留正常操作入口，越过目标也会被检测。

## Avery 自动调用

控制进程调用 `client.cjs`；待测 Agent 只接收 URL、任务资料和附件路径。**不要向 Agent 暴露控制配置文件、控制令牌、评分期望或签名私钥。**

```js
const { createClient } = require('./client.cjs');
const client = await createClient();
const run = await client.createRun({
  scenarioId: 'feishu-late', goal: 'submit', seed: 42,
});

// 把 run.url、run.input、run.attachmentPath 交给 Avery 的执行器。
// 执行器退出前，在该页面运行：await window.CareerBench.flush()
// 并确认 document.documentElement.dataset.parserPending === 'false'。

const finalState = await client.getState(run.id);
const events = await client.getEvents(run.id); // 支持 after 游标
// Token 等来自真实执行器；没有数据就不传，不会默认生成 0。
await client.addMetrics(run.id, {
  agent: 'Avery', model: '实际模型名',
  tokens: { input: 1200, output: 300 }, retries: 1,
});
const result = await client.endRun(run.id, { cleanup: true });
console.log(result.payload.report);
```

也可使用 `runner.cjs` 的 `runCase({ execute, flush, ... })`，由回调接入 Avery 的实际执行器。它自动创建轮次、处理执行结果、结束并清理。只有执行器自身的普通异常归为 Agent 失败；轮次创建、浏览器同步、指标上报与结算异常，以及明确带有 `error.category = 'environment'` 的执行器异常均单列为环境失败。无法连接平台完成结算时，会向上层抛出环境异常，不伪造一份成功记录。尚未改动 Avery 应用自身的测评入口。

控制端配置默认位于上级 `output/career-portal-runtime-v2/control.json`；可通过 `CAREER_CONTROL_PATH` 或 `createClient({controlPath})` 指定。每轮页面只有单轮令牌，不能创建案例、上报最终成绩或清理别的轮次。

命令行接口不需要操作页面控制台：

```powershell
node harness.cjs list
node harness.cjs create baseline fill 42
node harness.cjs state <runId>
node harness.cjs events <runId> 0
node harness.cjs end <runId> result.json --cleanup
node evaluate.cjs result.json
```

## 评分与证据

- 检查完整记录及未提供的选填字段，检测多填、额外经历、重复技能、原值误改和描述串段。
- 经历按学校 / 公司 / 项目、角色、时间等组合身份匹配；整体调换顺序不扣分，同名但不同时段的经历分别核对。
- 自由文本规范化空白和标点，逐项核对原文及案例作者认可的改写。未知改写标记 `text_requires_review`，不能自动满分；**这不是开放式语义评分器**。
- 附件读取实际二进制，计算 SHA-256，核对预置资料的哈希和大小；同名错误附件不能通过，文件内容相同的改名附件可以通过。
- 预览绑定当前状态摘要；编辑、解析更新、换附件后原预览失效。提交需再次校验实际附件，并生成唯一回执、事件和对应摘要。重复提交保持幂等。
- 结束时签名固化场景、输入哈希、种子、环境、最终状态、文件检查、事件、回执和评分。清理仅删除本轮活动资料，保留签名结果。
- `evaluate.cjs` 使用本机受信公钥复核；可用第二个参数指定原服务的 `signing-public.pem`。不会信任导出文件自带的任意公钥。旧快照与篡改结果不获认证分。
- `passed` 是最终判定，不能只看分数或资料完整度。`environment_failure` 不计任务分；Token 与上报重试为控制端数据，未上报为 `null`。事件中的重试与失焦次数另行记录。

签名证明本地平台所保存的状态、附件和回执，并不证明一定使用了鼠标点击。运行器应限制待测 Agent 的权限，隔离控制端文件及评分答案。

## 内置场景

| scenarioId | 内容 |
|---|---|
| `baseline` | 双教育、双工作、双项目与完整补充信息 |
| `missing-contact` | 缺少手机号码，不允许编造或越界提交 |
| `city-conflict` | 意向杭州、现居广州，以及旧省市值 |
| `same-name` | 同名公司 / 项目，不同时间与描述 |
| `prefilled` | 预填资料，仅改手机、自评，保留其他原值 |
| `feishu-late` | 确认后才保存，1 秒解析、3.2 秒错误覆盖 |
| `beisen-merge` | 完整候选失焦确认、年月分选、仅填空解析 |
| `moka-race` | 异步分批候选、1 秒解析、4.5 秒迟到错误覆盖 |

三套配置是针对关键行为的离线模型，不是完整复刻厂商实现。解析由固定合成资料驱动，可配置迟到、错值、串段和覆盖，不含真实 PDF OCR / 简历识别引擎。

创建轮次时可传 `parser`，覆盖阶段计划。`delayMs` 相对该次附件上传，可设 0—60000 ms；`mode` 为 `overwrite`、`fill-empty` 或 `untouched-only`，最多 8 阶段。重新上传、移除附件或结束轮次会取消旧任务，不污染其他轮次。解析尚未结束时不能通过完成判定。

```json
{
  "enabled": true,
  "stages": [
    {"delayMs": 1500, "mode": "overwrite", "values": {"personal.city": "宁波市"}},
    {"delayMs": 4000, "mode": "untouched-only", "values": {"personal.name": "解析错误姓名"}}
  ]
}
```

运行 `node harness.cjs create baseline submit 42 parser.json` 使用上述配置。

## 注入自定义案例

控制端 `client.registerScenario(definition)` 或 `node harness.cjs register case.json`。结构见 [client.d.cts](client.d.cts) 中的 `ScenarioDefinition`。

提供 `id`（以 `custom-` 开头）、`version`、`title`、`profileId`、完整 `expected`、附件 `{name,base64}`，可附 `initial`、`input`、`expectedMissing`、`preserve`、`acceptedTexts`、`parser`。表单状态结构可从界面快照的 `application` 准备；注册时会校验期望资料是否可完成，并补齐确认型字段的选中记录。

返回的场景键形如 `custom-campus@1.0.0`。相同键不可覆盖，改资料必须发布新版本。案例附件与定义会随服务重启恢复。场景定义、数据和字段错误属于控制端信息，不交给待测 Agent。

## HTTP 接口

| 方法与路径 | 使用方 | 用途 |
|---|---|---|
| `GET /api/scenarios`、`POST /api/scenarios` | 控制端 | 列出 / 注册案例 |
| `POST /api/runs` | 控制端 | 创建轮次，注入场景、目标、种子和解析配置 |
| `GET /api/runs/:id/state`、`events?after=N` | 控制端 / 单轮页面 | 读取状态、事件 |
| `PUT /api/runs/:id/state` | 单轮页面 | 带 revision 保存资料和普通交互事件 |
| `POST /api/runs/:id/files/:kind`、`DELETE` | 单轮页面 | 上传实际附件 / 移除附件 |
| `POST /api/runs/:id/preview`、`submit` | 单轮页面 | 校验预览 / 生成真实本地回执 |
| `POST /api/runs/:id/metrics`、`failures`、`agent-failures` | 控制端 | 指标、环境失败、Agent 失败 |
| `POST /api/runs/:id/end` | 控制端 | 生成签名结果，可传 `cleanup:true` |
| `GET /api/runs/:id/result`、`POST .../cleanup` | 控制端 | 取回结果 / 清理活动目录 |

JSON 请求使用 `Authorization: Bearer ...` 与 `Content-Type: application/json`。拒绝跨来源请求。控制令牌、私钥、案例期望和工作区文件不通过静态站点提供。

## 开发验证

`npm run check` 检查全部 JS 语法；`npm test` 运行评分、轮次、HTTP、安全边界、场景和 Runner 测试；`npm run check:types` 检查控制端接口的 TypeScript 类型契约，使用已有开发环境中的 TypeScript，可通过 `CAREER_TSC_PATH` 指定编译器路径。类型工具不是运行依赖。静态前端无需编译构建。

浏览器验收见 [VALIDATION.md](VALIDATION.md)。参考结构：[飞书招聘申请页](https://quvideo.jobs.feishu.cn/028848/resume/7687531041799997722/apply)、[影子科技北森申请页](https://yingzi.zhiye.com/form?fromPage=job&jobAdId=0fefa537-e199-4948-836a-d4264fb6da91&activityGuid=7671ead9-084b-4583-857b-1d21031f6910&userId=322206569)。虚构品牌，合成候选人资料。
