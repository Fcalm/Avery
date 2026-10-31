# 网申填写测评

## 使用

1. 构建并重启开发版 Avery，连接正常的 Avery Browser 扩展。
2. 打开“开发者 → 新建评测”，选择“网申填写测评 · 拟真平台”。
3. 创建后自动载入 8 个内置案例，默认目标均为只填写、保存，不勾选声明、不预览、不提交。
4. 选择 Prompt 候选并开始评测。执行模型以运行快照为准；不调用 Judge 模型。
5. 展开单题查看字段准确率、关键字段错误、期望与实际差异、Token、耗时和完整轨迹。

内置案例：完整资料、缺少联系方式、城市冲突、同名经历、已有资料、飞书式迟到覆盖、北森式仅填空、Moka 式异步覆盖。它们是行为仿真，不能替代真实 ATS 回归。

## 案例结构

平台源代码位于 `packages/application-benchmark`，由 `@avery/backend` 的现有 Browser Runner 调用。运行时无需启动独立目录中的服务器。

平台项目使用 `config.fixtureBranch = "career-portal"`。案例增加以下配置：

```json
{
  "browser": {
    "fixtureVersion": "career-portal-2",
    "seed": 1,
    "benchmark": { "scenarioId": "baseline", "goal": "fill" }
  }
}
```

`goal` 支持 `fill`、`preview`、`submit`；后两者只操作本地模拟站点。通过现有测试集版本管理导入修改后的 JSONL，不能与旧招聘 Fixture 案例混用。缺失资料场景始终要求留空并停止，不得编造。

首版接入仅接受上述 8 个内置场景。平台独立使用时仍支持自定义案例，Avery 数据集当前不导入自定义平台定义。seed 目前用于标记复现实验，不自动生成不同资料。

## 结果

- `passed` 决定业务是否成功；字段准确率不代替任务成功率。
- 字段准确率统计有期望值的业务字段。额外内容、附件、目标越界等另外参与业务判定。
- 姓名、电话、邮箱、经历主体、学历及起止年月错误单独列为关键字段错误。
- 未通过业务校验的总分最多 40 分；缺失资料按规则停止可为成功阻塞。
- 环境失败、未知来源、无效结果和待复核文本不计任务分；环境失败和待复核不进入任务成功率分母。
- 没有供应商 usage 时 Token 保持未知；缓存输入包含在输入 Token 中，不能再次相加。
- 结束前等待最后一次输入保存和所有解析阶段结束。取消时中断 Agent 并固化取消记录，释放当前测试页、轮次和服务器。

每个案例使用独立随机端口、控制目录和附件。Agent 只获得该轮 URL、合成档案和授权附件，不获得控制令牌、签名私钥及评分期望。内置 PDF 按本轮资料生成，避免缺失项或同名场景混入旧简历。

## 产物目录

默认沿用当前用户数据目录下的 `evaluation-data`。开发测试可在启动 Avery 前指定外部目录：

```powershell
$env:AVERY_EVALUATION_DATA_ROOT = 'D:\Avery\项目外部产物-20261030\avery-evaluations'
npm start
```

该目录保存测试集快照、轨迹、评分和运行数据；数据库登记仍保存在 Avery 用户数据中。已有历史运行时应继续使用原产物目录。

原始签名结果和公钥位于 `runtime/<runId>/<caseRunId>/benchmark-control`；结束后清理该轮活动目录，签名结果保留。界面轨迹中的结果已脱敏，原始验签使用控制目录中的原件。

## 验证

```powershell
npm test --workspace @avery/application-benchmark
npm run check --workspace @avery/application-benchmark
npm run check:types --workspace @avery/application-benchmark
npm run test:vitest -- tests/unit/backend/application-benchmark.test.ts tests/unit/backend/browser-benchmark-runner.test.ts
npm run build
```

平台单元测试、Runner 编排测试及脚本验收不代表真实模型的网申填写准确率。
