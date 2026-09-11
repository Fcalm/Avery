# 脚本化岗位采集方案

> 状态：已实现，真实 BOSS 冒烟通过
> 更新时间：2026-09-11
> 适用场景：投递场景 `application`

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
          -> FuturePlatformCollector
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
