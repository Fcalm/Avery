# 岗位数据结构

岗位契约位于 `packages/contracts/src/dto.ts` 的 `JobDto`。

| 字段 | 含义 |
| --- | --- |
| id | 岗位 ID |
| company、title、city | 企业、岗位名称、城市 |
| salary、experience、education、companySize | 薪资、经验、学历、企业规模 |
| jobSeekingType、channel | 求职类型、来源渠道 |
| favorite | 收藏状态 |
| url、jd | 原始链接、岗位正文 |
| deadline | 截止时间，可缺省 |
| createdAt、revision | 入库时间与版本，由后端提供 |

采集身份、来源事实及用户编辑保护信息由 Repository 维护，投递记录独立关联岗位 ID。

## 移除匹配分（2026-11-06）

- 删除岗位契约与 Agent 工具中的 `matchScore`，列表和详情不再展示分数，不再提供分数排序；缺省按入库时间降序，仍可按薪资排序。
- v20 数据库迁移移除 `jobs.match_score` 并清理存量岗位 JSON 中的旧分数；保持 ID、版本、时间、收藏、删除状态及投递关联不变。
- 下次启动后自动迁移，旧客户端或备份带来的分数字段在读写边界剔除，不能重新写回。
- 本地浏览器测评站中的模拟排序分属于独立的版本化测评夹具，不属于岗位库契约或持久岗位字段。
- 验证覆盖空库升级、存量迁移、旧输入兼容、收藏写回、查询分页、Agent 读写、采集以及真实业务 Worker；界面的列表、详情与排序由用户重启后实测。
