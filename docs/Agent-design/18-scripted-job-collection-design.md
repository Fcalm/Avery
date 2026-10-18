# 脚本化岗位采集方案

> 状态：现行入口已升级为直接入库；下文保留旧版历史实现与验收
> 更新时间：2026-10-18
> 适用场景：投递场景 `application`

> 2026-10-18新入口BOSS真实Agent验收通过：CollectJobs新增5条、ReadJobs查询返回库中14条匹配岗位，与数据库核对一致；无逐条SaveJob或实际投递。证据及覆盖边界见20号规划5.5节。

> 现行规范以[20-岗位库筛选与批量采集规划](20-job-library-collection-development-plan.md)第5节及[工具文档](03-tools.md)为准。`CollectJobs`与页面共享批量入库服务，参数为channel、keyword、targetCount、jobSeekingTypes、educations、city、sourceIds；默认100、最多1000，返回持久任务与真实写入摘要。`ReadJobs`按条件分页读取岗位库，或按jobId读取详情。无需逐个SaveJob；会话删除不删除已入库岗位。取消与超时等待写入收尾；旧集合引用明确失效。

## 历史版本：临时候选采集（非现行规范）

以下10候选、15分钟会话缓存及引用保存规则仅用于记录2026-09版本与当时验收，不约束或指导现行工具调用。

## 1. 目标范围

岗位采集由确定性脚本完成，Agent 负责生成筛选参数、判断候选岗位并选择需要保存的岗位。

第一版单次 `CollectJobs` 调用最多返回 10 个候选岗位。该上限是全部平台、关键词、城市组合去重后的总上限，不按平台或查询组合分别计算。

采集结果不得直接写入岗位库或未投递列表。只有 Agent 对候选岗位完成判断并成功调用 `SaveJob` 后，岗位才进入岗位库。

## 2. 工具流程

```text
用户给出平台和筛选条件
  -> Agent 调用 CollectJobs
  -> 平台采集器搜索、解析、规范化和去重
  -> Host 创建会话级临时候选集合
  -> CollectJobs 返回最多 10 个候选岗位
  -> Agent 判断岗位匹配程度
  -> Agent 对选中岗位调用 SaveJob
  -> Host 根据 collectionId + candidateId 复制可信候选数据
  -> 选中岗位进入岗位库
```

## 3. `CollectJobs`

### 3.1 输入

```json
{
  "platforms": ["boss_zhipin"],
  "queries": [
    {
      "keyword": "产品经理",
      "city": "佛山"
    }
  ],
  "filters": {
    "jobTypes": ["social_recruitment"],
    "experience": ["1-3年", "3-5年"],
    "education": ["本科"],
    "salaryMinMonthlyK": 15,
    "companySizes": ["100-499人", "500-999人"],
    "industries": ["互联网", "人工智能"],
    "excludeKeywords": ["外包", "销售"]
  },
  "sort": "relevance",
  "maxResults": 10
}
```

约束：

- `maxResults` 取值范围为 1 至 10。
- Agent 传入城市名称，平台适配器负责解析平台编码。
- `filters` 使用跨平台规范字段；平台专有筛选项后续通过独立命名空间扩展。
- 模型不得传入选择器、页面脚本、任意 URL 参数或浏览器命令。
- 采集脚本不调用模型评分，不替 Agent 决定保存或联系哪些岗位。

### 3.2 输出

```json
{
  "ok": true,
  "collectionId": "collection-001",
  "candidates": [
    {
      "candidateId": "candidate-001",
      "platform": "boss_zhipin",
      "title": "产品经理",
      "company": "某科技公司",
      "city": "佛山",
      "salary": "18-25K",
      "experience": "3-5年",
      "education": "本科",
      "jobType": "social_recruitment",
      "jd": "岗位职责与任职要求……",
      "url": "https://www.zhipin.com/...",
      "alreadySaved": false,
      "contactStatus": "not_contacted"
    }
  ],
  "counts": {
    "collected": 10,
    "duplicates": 2,
    "filtered": 3
  },
  "truncated": false,
  "warnings": []
}
```

`alreadySaved` 和 `contactStatus` 由 Host 只读关联现有岗位库与投递记录生成。页面 DOM、浏览器动作和完整调试日志不进入工具结果。

### 3.3 企业 ATS 来源

`platforms` 支持 `beisen`、`moka`、`hotjob`，可同时选择三个 ATS，但不得与 `boss_zhipin` 混用。ATS 必须提供 1–10 个 `sources`，每项包含企业名称和公开招聘 URL，可指定 `maxPages: 5 | 10 | 20`，默认 20。BOSS 仍必须提供非空 `queries`；ATS 可使用 `queries: []` 获取来源中的候选，或以关键词和城市执行本地筛选。缺失的薪资、经验、学历、招聘类型不进行猜测。

Hotjob 先支持公开 pb 分类页：`/SU<租户>/pb/social.html`、`school.html`、`interns.html`、`overseas.html`。门户有多种招聘类别时须指定具体分类，不猜选；旧 wt 或 mc 模板尚不支持。公开表单编码用于列表及详情读取，不携带Cookie或认证头。按30s/30请求预算分段，逐条详情游标与事实库一起原子保存；重复调用相同来源续跑，完整集合前始终partial。申请链接使用公开 `posDetail.html?postId=...&postType=...` 路由。

```json
{
  "platforms": ["beisen"],
  "sources": [{"url": "https://iflytek.zhiye.com/", "company": "科大讯飞", "maxPages": 20}],
  "queries": [{"keyword": "算法", "city": "合肥"}],
  "sort": "newest",
  "maxResults": 10
}
```

返回增加 `sourceRuns`，逐来源说明 ATS、健康状态、快照状态、传输方式、岗位数与错误。正常完整、部分、空、授权受阻和不支持来源分别记录；一个来源失败不终止其他来源。候选总上限、缓存期限、会话清理和 SaveJob 引用方式不变。

ATS 使用匿名公开 HTTP 请求，不携带 Cookie、用户登录态或企业授权。完整事实集合写入用户数据目录的 `ats-facts.json`，与用户岗位库分开保存。先采集完整或标记为部分的来源快照，再进行关键词/城市/过滤器筛选；禁止把筛选结果当完整快照关闭岗位。仅非空、成功且完整的快照可关闭缺失岗位；部分、未知、失败和空快照均不关闭。

事实落盘后进入 `AtsCandidateMatcher`。相同平台、查询和过滤条件使用同一匹配分区；新增或关键内容变化重新筛选，未变化复用已有结果。薪资、学历、经验及招聘类型改变也重算相关条件匹配。关闭、unknown、stale 清除匹配记录并排除候选。不同条件各自匹配，最多保留最近 32 组条件；使用 `ats-facts.json.matches.json` 保留跨重启结果，不恢复会话临时候选引用。

工具结果增加 `matching: { processed, reused, failed }`。单岗位匹配异常单独记录，其他岗位继续；匹配存储故障返回明确警告，不回滚事实、不将未筛选岗位作为成功候选。Agent 继续负责简历语义理解与是否保存，不由采集器生成简历匹配分数。

北森从 `/portal/registerSystemInfo` 的 JSON 或 BSGlobal HTML 获取 PortalId，`PageIndex` 从 0 开始，并传入 `DisplayFields` 获取地点、薪资等公开字段。Moka 从标准招聘 URL 提取组织、招聘类型及 siteId，调用匿名可用的公开 Job API；私有加密接口明确返回不支持。具体数据契约与固定 50 企业回归见 [ATS POC](../china-ats-poc-summary.md)。

北森新接口明确返回 Not Found 时检查旧 CMS `/alljob/`。已识别的 `jobsTable` 与 `positionlist-newdefault` 表格按表头映射地点、类别和发布时间，沿公开分页读取 `/zpdetail/<id>` 职责及要求。详情只允许同一公开招聘 origin，不执行页面脚本，不访问登录、内推或申请接口。旧 CMS 使用 `public_portal_html` 传输标记；定制布局不冒充全量，返回不支持原因。

每个来源执行段最多 30s、30 次实际 HTTP 请求（含重试与重定向），页面数仍为 5/10/20。JSON 大列表将 `nextPage`、已收集岗位、总数、租户签名和第一页校验值原子保存至事实库。再次使用同一来源时重读第一页；签名、列表或总数变化、检查点超过 30 分钟则重新从头采集。未遍历完保持 partial，全部遍历且没有异常才发布 complete；完成后删除检查点。`sourceRuns.nextPage` 表示可以继续的来源，不需要模型提交游标或岗位正文。

## 4. 临时候选缓存

Host 使用以下会话级内存结构保存采集结果：

```text
sessionId
  -> collectionId
       -> createdAt
       -> expiresAt
       -> candidates[最多 10 个]
```

缓存不得写入普通岗位库，不在岗位页面展示，也不创建投递记录。

### 4.1 丢弃条件

满足任一条件时删除对应缓存：

1. 从采集成功完成起满 15 分钟；读取和保存操作不延长过期时间。
2. 用户删除会话时，立即删除该会话的全部采集缓存。
3. Avery 关闭、重启或异常退出时，清空全部内存缓存。
4. 采集被取消、执行失败或触发站点风险时，不保存尚未正式返回的部分结果。
5. 同一会话创建第 4 个有效采集批次时，删除创建时间最早的批次。
6. 一个批次的全部候选岗位均已通过 `SaveJob` 保存后，立即删除该批次。

浏览器断开、页面关闭、标签页切换或导航变化不删除已经成功返回且尚未过期的候选集合。

缓存必须在访问时校验有效期，并通过有界定时清理回收无人访问的过期集合。

## 5. `SaveJob` 引用模式

采集结果通过短引用进入岗位库。Agent 不重复提交公司、岗位、URL 和完整 JD。

```json
{
  "collectionId": "collection-001",
  "candidateId": "candidate-003",
  "matchScore": 86
}
```

Host 必须：

1. 校验 `collectionId` 属于当前会话。
2. 校验集合未过期且 `candidateId` 存在。
3. 从缓存复制采集器生成的规范岗位字段。
4. 只接受 Agent 提供的允许决策字段，例如 `matchScore`。
5. 使用平台与来源岗位 ID 执行业务幂等和去重。
6. 成功后返回正式 `jobId` 与岗位 revision。

集合不存在或已过期时返回：

```json
{
  "ok": false,
  "code": "JOB_COLLECTION_EXPIRED",
  "message": "The collected job data has expired. Call CollectJobs again."
}
```

模型不得使用上下文中残留的摘要重建已过期候选数据，必须重新调用 `CollectJobs`。

现有浏览器观察岗位的 `SaveJob` 输入方式保留为独立 Schema 分支；采集引用和页面观察数据不得混合提交。

## 6. 平台适配结构

```text
CollectJobs Tool
  -> JobCollectionService
      -> PlatformCollectorRegistry
          -> BossCollector
      -> AtsSourceRunner
          -> BeisenCareerAdapter
          -> MokaPublicAdapter
          -> AtsFactStore (来源/岗位事实/运行记录/隔离)
      -> JobCollectionCache
      -> Job/Application read ports
```

平台采集器统一输出规范候选岗位：

```text
candidateId
platform
sourceJobId
canonicalUrl
title
company
location
salaryRaw
salaryNormalized
experience
education
jobType
jd
recruiter
collectedAt
contentHash
```

平台特有字段存放在受限的 `sourcePayload` 中，不进入公共工具返回，除非后续版本明确加入公共契约。

## 7. 失败与停止结果

采集结果使用结构化状态：

- `completed`：成功返回候选岗位。
- `completed_with_shortage`：成功执行，但符合条件的岗位少于请求数量。
- `cancelled`：用户或 Run 取消，部分结果不进入缓存。
- `login_required`：平台登录态不可用。
- `risk_detected`：检测到验证码、限流或账号异常并停止。
- `parse_failed`：页面已加载但无法解析稳定岗位结构。
- `browser_unavailable`：授权浏览器不可连接。

失败结果包含已访问数量、失败阶段、稳定错误码和用户可读说明，不返回未完成的候选集合引用。

## 8. 验收标准

- 单次调用跨全部查询组合最多返回 10 个去重候选岗位。
- 采集完成后岗位库和未投递列表没有新增记录。
- Agent 仅能通过有效的 `collectionId + candidateId` 保存采集岗位。
- `SaveJob` 不要求模型重复提交采集岗位正文。
- 15 分钟绝对过期、会话删除、应用重启、失败取消、批次数量和全部保存六类清理条件生效。
- 一个会话不能读取或保存另一个会话的候选岗位。
- 已过期引用稳定返回 `JOB_COLLECTION_EXPIRED`，不会根据模型文本恢复岗位。
- 同一来源岗位重复采集或重复保存不会在岗位库产生重复记录。
- 站点风险、登录失效或浏览器不可用时停止采集并返回结构化错误。
- 平台采集实现通过注册表接入，工具和服务层不包含平台选择器或平台专有浏览器逻辑。

## 9. 开发进度

- [x] `CollectJobs` 工具 Schema 与投递场景白名单
- [x] BOSS 平台采集器与平台注册表
- [x] 会话级 15 分钟临时候选缓存及六类清理条件
- [x] `SaveJob(collectionId, candidateId)` 引用保存模式
- [x] 会话删除与应用关闭生命周期接入
- [x] 单元测试、Workspace 类型构建
- [x] 已登录 Chrome CDP 真实采集 2 个岗位，不写入岗位库
