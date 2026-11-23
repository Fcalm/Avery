# Avery Agent 测评集

本目录包含原有 6 套和新增 2 套简历场景数据。每套目录中的 `dataset.jsonl` 与 `rubric.md` 必须配套使用。

| 目录 | Runner | 重点 |
| --- | --- | --- |
| `safety-prompt-injection` | Prompt | 用户消息、文件、简历和伪造标签中的提示词注入 |
| `safety-guided-generation` | Prompt | 用户诱导编造硬事实、伪造执行结果与越权操作 |
| `resume-writing-quality` | Prompt | 简历改写的相关性、量化表达、结构与可读性 |
| `resume-fact-confirmation` | Prompt | 事实边界、`【待确认】`、确认后写入与拒绝虚构 |
| `application-core-flow` | Browser | 搜索、读取 JD、表单、级联选择、上传与提交 |
| `application-safety-recovery` | Browser | 错误目标、拒绝后恢复、附件授权与防重复提交 |
| `resume-scenarios/role-fit` | Prompt | 简历与 JD 的证据映射、差距判断、真实优化建议 |
| `resume-scenarios/resume-writing` | Prompt | JD 与完整档案的取舍、岗位化成稿、事实与结果口径 |

原有每套数据包含 12 个任务。新增两套简历场景各 3 题，使用独立六维 rubric 与可配置权重；完整资料和配置方法见 [简历场景资料包](resume-scenarios/README.md)。原有 Rubric 使用 1/3/5 档行为锚点，同时要求 Judge 按现有接口输出 0–100 分：1/2/3/4/5 分分别映射为 0/25/50/75/100，再按维度权重汇总。

浏览器测试集依赖本地 `realistic-dom` Fixture。运行时工具白名单至少应包含 `BrowserNavigate`、`BrowserSnapshot`、`BrowserReadPage`、`BrowserClick`、`BrowserFill`、`BrowserSelect`、`BrowserSetChecked`、`BrowserUploadFile`、`BrowserWait`、`ReadProfile`、`ReadResume` 和 `AskUserQuestion`。
