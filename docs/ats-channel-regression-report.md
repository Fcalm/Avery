# ATS 岗位采集渠道回归报告

验证时间：2026-09-27T11:41:27.090Z
固定样本 SHA-256：`6298cd799f036b27ef301a53ef3edd3353505268d02bc0efb992779edf8331d4`。样本为 [25 家北森 + 25 家 Moka](../tests/fixtures/ats-sources-50.json)，未因测试失败替换企业。

## 验收结果

| 平台 | 提取成功 | 标准化岗位 | 地点完整率 | 描述完整率 | 要求完整率 | 更新时间完整率 | 延迟 P50/P95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beisen | 17/25 (68%) | 3952 | 100.00% | 99.95% | 99.95% | 99.90% | 1020/9495 ms |
| moka | 25/25 (100%) | 1824 | 91.12% | 99.73% | 0.00% | 100.00% | 1940/8289 ms |

两个平台均超过 60% 提取门槛。岗位最低字段（ATS ID、标题、企业、来源 URL）完整率均为 100%。

Moka 的任职要求通常包含在 description 中；不从描述猜测或拆造 requirements，独立字段完整率因此为 0%。北森 8 个旧版站没有当前公开协议要求的 PortalId，返回 SOURCE_SCHEMA_CHANGED，不进行登录或私有协议适配。奇瑞与华大达到 20 页上限，保留 partial，不关闭未返回岗位。

## 各来源结果

| 企业 | 招聘 URL | 平台 | 健康 | 快照 | 岗位数 | 耗时 | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 科大讯飞 | [招聘站](https://iflytek.zhiye.com/) | beisen | healthy | complete | 894 | 8991 ms |  |
| 长江产业投资集团 | [招聘站](https://cjcyjt-campus.zhiye.com/) | beisen | healthy | complete | 110 | 1333 ms |  |
| 东阳光 | [招聘站](https://hec.zhiye.com/) | beisen | healthy | complete | 116 | 1414 ms |  |
| 奇瑞汽车 | [招聘站](https://chery1.zhiye.com/) | beisen | partial | partial | 1000 | 9495 ms | SOURCE_PAGE_LIMIT |
| 联通数科 | [招聘站](https://cudt.zhiye.com/) | beisen | healthy | complete | 159 | 1765 ms |  |
| 来也科技 | [招聘站](https://laiye.zhiye.com/) | beisen | healthy | complete | 3 | 552 ms |  |
| 遥望科技 | [招聘站](https://ywwl.zhiye.com/) | beisen | healthy | complete | 9 | 719 ms |  |
| 华大集团 | [招聘站](https://genomics.zhiye.com/) | beisen | partial | partial | 1000 | 10206 ms | SOURCE_PAGE_LIMIT |
| 新点软件 | [招聘站](https://epoint.zhiye.com/) | beisen | healthy | complete | 28 | 1251 ms |  |
| 南瑞继保 | [招聘站](https://nrec.zhiye.com/) | beisen | healthy | complete | 11 | 1711 ms |  |
| 鼎桥通信 | [招聘站](https://td-tech.zhiye.com/) | beisen | healthy | complete | 193 | 1725 ms |  |
| 中国铁建重工 | [招聘站](https://crchi.zhiye.com/) | beisen | healthy | complete | 30 | 519 ms |  |
| 威高集团 | [招聘站](https://weigao.zhiye.com/) | beisen | healthy | complete | 128 | 1362 ms |  |
| 昂楷科技 | [招聘站](https://ankki.zhiye.com/) | beisen | schema_changed | unknown | 0 | 537 ms | SOURCE_SCHEMA_CHANGED |
| 中国日报社 | [招聘站](https://chinadaily.zhiye.com/) | beisen | schema_changed | unknown | 0 | 501 ms | SOURCE_SCHEMA_CHANGED |
| 科士达 | [招聘站](https://kstar.zhiye.com/) | beisen | schema_changed | unknown | 0 | 546 ms | SOURCE_SCHEMA_CHANGED |
| 蜜雪冰城 | [招聘站](https://careers.mxbc.com/) | beisen | healthy | complete | 56 | 1020 ms |  |
| 科伦博泰 | [招聘站](https://kelunbotai.zhiye.com/) | beisen | schema_changed | unknown | 0 | 521 ms | SOURCE_SCHEMA_CHANGED |
| 苏州科达 | [招聘站](https://kedacom.zhiye.com/) | beisen | schema_changed | unknown | 0 | 489 ms | SOURCE_SCHEMA_CHANGED |
| 奕斯伟 | [招聘站](https://eswin.zhiye.com/) | beisen | schema_changed | unknown | 0 | 523 ms | SOURCE_SCHEMA_CHANGED |
| 挚途科技 | [招聘站](https://zhito.zhiye.com/) | beisen | schema_changed | unknown | 0 | 1551 ms | SOURCE_SCHEMA_CHANGED |
| 星恒电源 | [招聘站](https://xingheng.zhiye.com/) | beisen | healthy | complete | 65 | 3035 ms |  |
| 绿城中国 | [招聘站](https://gtgroup.zhiye.com/) | beisen | schema_changed | unknown | 0 | 516 ms | SOURCE_SCHEMA_CHANGED |
| 振石集团 | [招聘站](https://zhenshigroup.zhiye.com/) | beisen | healthy | complete | 67 | 978 ms |  |
| 宇树科技 | [招聘站](https://unitree.zhiye.com/) | beisen | healthy | complete | 83 | 1000 ms |  |
| 得力集团 | [招聘站](https://app.mokahr.com/campus-recruitment/nbdeli/70019) | moka | healthy | complete | 38 | 428 ms |  |
| 高途 | [招聘站](https://app.mokahr.com/campus-recruitment/bjhl/102145) | moka | healthy | complete | 218 | 7748 ms |  |
| LINE MAN Technology | [招聘站](https://app.mokahr.com/social-recruitment/linecorp/150828) | moka | healthy | complete | 4 | 669 ms |  |
| 毕马威 | [招聘站](https://app.mokahr.com/campus-recruitment/kpmg/74356) | moka | healthy | complete | 186 | 8289 ms |  |
| 延锋 | [招聘站](https://app.mokahr.com/campus-recruitment/yanfeng/45086) | moka | healthy | complete | 200 | 7437 ms |  |
| 锐捷网络 | [招聘站](https://app.mokahr.com/campus-recruitment/ruijie/136206) | moka | healthy | complete | 74 | 739 ms |  |
| 普华永道 | [招聘站](https://app.mokahr.com/campus-recruitment/pwc/140015) | moka | healthy | complete | 1 | 306 ms |  |
| 拓维信息 | [招聘站](https://app.mokahr.com/social-recruitment/talkweb/71920) | moka | healthy | complete | 33 | 399 ms |  |
| 仙乐健康 | [招聘站](https://app.mokahr.com/campus-recruitment/sirio/166467) | moka | healthy | complete | 50 | 1007 ms |  |
| 搜狐畅游 | [招聘站](https://app.mokahr.com/campus-recruitment/cyou-inc/42233) | moka | healthy | complete | 44 | 1160 ms |  |
| 岚图汽车 | [招聘站](https://app.mokahr.com/campus-recruitment/voyah/146293) | moka | healthy | complete | 84 | 6024 ms |  |
| 苏商银行 | [招聘站](https://app.mokahr.com/social-recruitment/snb/45591) | moka | healthy | complete | 17 | 3160 ms |  |
| 拜耳中国 | [招聘站](https://app.mokahr.com/social-recruitment/bayer/148387) | moka | healthy | complete | 50 | 3164 ms |  |
| 卓尔摄影 | [招聘站](https://app.mokahr.com/campus-recruitment/kfconcept/144795) | moka | healthy | complete | 20 | 2564 ms |  |
| 思瑞浦 | [招聘站](https://app.mokahr.com/campus-recruitment/3peakic/67894) | moka | healthy | complete | 25 | 1940 ms |  |
| 特斯拉中国 | [招聘站](https://app.mokahr.com/campus-recruitment/tesla/41460) | moka | healthy | complete | 410 | 10890 ms |  |
| 安捷利美维 | [招聘站](https://app.mokahr.com/campus-recruitment/akmmv/45089) | moka | healthy | complete | 16 | 2021 ms |  |
| 中微公司 | [招聘站](https://app.mokahr.com/campus-recruitment/amec/146254) | moka | healthy | complete | 9 | 1633 ms |  |
| 容知日新 | [招聘站](https://app.mokahr.com/campus-recruitment/anhuirohgzhirixin/73950) | moka | healthy | complete | 28 | 1928 ms |  |
| 星辉游戏 | [招聘站](https://app.mokahr.com/social-recruitment/rastar/96228) | moka | healthy | complete | 56 | 4798 ms |  |
| 星嘉游戏 | [招聘站](https://app.mokahr.com/social-recruitment/xingjia/148964) | moka | healthy | complete | 18 | 1137 ms |  |
| 游族网络 | [招聘站](https://app.mokahr.com/social-recruitment/yoozoo/91950) | moka | healthy | complete | 9 | 1595 ms |  |
| 盛趣游戏 | [招聘站](https://app.mokahr.com/apply/shengqu/4077) | moka | healthy | complete | 53 | 5202 ms |  |
| 蛮啾网络 | [招聘站](https://app.mokahr.com/apply/manjiu/40770) | moka | healthy | complete | 55 | 1550 ms |  |
| 游卡网络 | [招聘站](https://app.mokahr.com/social-recruitment/yokagames/41939) | moka | healthy | complete | 126 | 4890 ms |  |

## 安全与回归证据

- `npm test`：525 项 Vitest 通过，1 项跳过；后端 8 项通过。
- `npm run build`：所有 Workspace 类型构建及 Renderer 构建通过，保留既有包体积警告。
- `ats-collection.test.ts`：分页、页数上限、空结果、坏记录隔离、重复页、PortalId 缺失、自定义域名、Moka 校招/社招、私有接口、来源超时与取消、事实持久化、变化检测和 ATS 保存链路。
- `ats-public-transport.test.ts`：DNS 固定、私网阻断、重定向、无 Cookie/Authorization、401/403 不重试、429/503 退避、400ms 节流、单 Host 两连接及全局五连接、DNS 等待取消。
- `agent-modules-defaults.test.ts`：ATS Schema 和参数透传、混用拒绝、匿名 ATS 定时调用无需 BrowserTaskGrant；BOSS 仍保持原授权要求。
- `job-collection-service.test.ts`：既有 BOSS 候选、显式保存、缓存期限、会话删除和跨会话隔离回归。
- 真实 Host 采集冒烟：科大讯飞完整读取 894 岗位，筛选“算法 + 合肥”返回 3 个候选；无浏览器调用及自动入库；显式保存使用 company_website，删除会话后引用失效。保存回调使用测试替身，未写入用户真实岗位库。

## 复跑命令与产物

```powershell
npm run build:packages
node scripts/evaluate-ats-collection.mjs
```

`artifacts/ats-evaluation/<时间>/` 保存 report.json、report.md、facts.json；报告含各平台提取率、标准化率、字段质量、延迟 P50/P95、部分快照比例、结构错误率、超时率及错误分布。事实文件包含来源、岗位、运行摘要及隔离数据。

本次完整产物：`artifacts/ats-evaluation/2026-09-27T11-40-57-290Z/`。

## 行动 1 跨周期与实际存储验证

```powershell
npm run build --workspace @avery/backend
node scripts/evaluate-ats-collection.mjs --cycles 2 --companies 科大讯飞,奇瑞汽车,昂楷科技
node scripts/evaluate-ats-collection.mjs --cycles 2
node scripts/verify-ats-real-storage.mjs
```

评测根目录必须为新目录；每轮报告独立保存在 `cycle-001`、`cycle-002`，`cycles.json` 保存索引。默认共享根目录内 `facts.json`；使用 `--fact-store <路径>` 可在不同日期的独立报告目录之间复用同一事实库。每轮重建事实存储实例并从磁盘加载。子集运行不评定固定 50 家门槛。

| 验证 | 产物 | 结果 |
| --- | --- | --- |
| 完整/部分/失败来源两轮 | `artifacts/ats-evaluation/2026-09-27T12-28-30-026Z/` | 科大讯飞 complete、奇瑞 partial、昂楷结构失败；每轮 1894 岗位；第二轮全为 UNCHANGED，无关闭 |
| 固定 50 家两轮 | `artifacts/ats-evaluation/2026-09-27T12-29-27-349Z/` | 两轮北森 17/25、3952，Moka 25/25、1824；第二轮 5776 UNCHANGED，0 NEW/UPDATED/CLOSED；首次发现时间全部保留 |
| 生产存储链路 | `artifacts/ats-storage/2026-09-27T12-28-19-646Z/report.json` | 显式保存、重复保存去重、Worker 重启读回、重启缓存失效、删除会话缓存失效、保存岗位保留六项通过 |

隔离的实际数据库位于 `artifacts/ats-storage/2026-09-27T12-28-19-646Z/user-data/avery.db`。保存与读取通过生产 `CreateBusinessStoreClient`、数据库 Worker、`SaveTrackedJob` 及 `LoadViewModel`；没有写入用户真实岗位库。采集前岗位库为空，采集后仍为空，显式保存后只有一个官网渠道岗位。关闭数据库和终止 Worker 后重新创建 Worker，岗位仍可读回。删除真实测试会话后调用同一缓存清理入口，候选不可再保存，已保存岗位继续保留。

本次连续真实采集没有自然 UPDATED/CLOSED，不能作为更新或关闭的实证。受控跨周期测试通过磁盘恢复覆盖部分、未知、超时、空快照不误关闭，并验证完整快照产生 UPDATED/CLOSED、保留首次发现时间。ATS 测试共 26 项通过；后端类型构建通过。

## 行动 2 变化驱动候选匹配

`AtsCandidateMatcher` 已接入生产 `CollectJobs` 链路，缓存条件筛选结果，不代替 Agent 的简历语义理解。相同查询与过滤条件下，新增/内容变化重算，未变化复用；关闭、unknown/stale 排除候选并清理分区记录。匹配错误单独保存，单岗位错误不阻断其余候选；采集事实在匹配前已落盘。用户岗位库仍只接受显式 SaveJob。

真实验证产物：`artifacts/ats-storage/2026-09-27T12-36-40-120Z/report.json`。数据库 Worker 关闭后重建并再次采集科大讯飞，`processed=0`、`reused>0`，匹配结果来自磁盘恢复；保存、去重及会话清理同时通过。

受控回归覆盖新增、关键内容变化、重复事件、条件隔离、关闭/unknown/stale、重新开放、匹配失败记录和重试。相关 4 文件 102 项通过；整体验证 `npm test` 为 531 项 Vitest 与后端 8 项通过、1 项跳过；`npm run build` 通过。

## 行动 3 旧 CMS 与 JSON 全量分段

北森旧 CMS 已接入 `jobsTable`、`positionlist-newdefault` 两种表格和两种详情布局。字段按表头及详情标签映射，源站未提供的更新时间不推测。单条详情结构错误写入隔离记录，其余岗位继续；存在隔离记录、失败、请求或页数上限时均为 partial。

固定 50 家改进回归：`artifacts/ats-evaluation/2026-09-27T12-52-11-101Z/`，北森 23/25、4066 个岗位，Moka 25/25、1824 个岗位。新增提取不等于旧站已完整：中国日报社为空列表；奕斯伟仍为不支持定制布局；部分旧站受请求上限或详情结构影响。

JSON 分段全量使用同一事实库 `artifacts/ats-evaluation/2026-09-27T14-19-16-207Z/facts.json`：

| 来源 | 真实运行 | 最终完整结果 |
| --- | --- | --- |
| 华大集团 | 第一段 1000 partial，第二段 1885 complete | 1885 个岗位；后续新一轮再次两段验证 |
| 奇瑞汽车 | 前四段 1000/2000/3000/4000 partial，额外两段 5000 partial、5833 complete | 5833 个岗位，来源总数一致 |

前四段报告：`artifacts/ats-evaluation/2026-09-27T14-19-16-207Z/`；奇瑞后两段报告：`artifacts/ats-evaluation/2026-09-27T14-21-02-001Z/`。每段重新创建存储实例并读回检查点，30s、30 次 HTTP、最多 20 页预算保持。续跑前重新核对第一页及总数，30 分钟过期或内容变化从头开始；完整后清除检查点。两组运行首次发现时间与 Diff 不变量异常为 0。

```powershell
node scripts/evaluate-ats-collection.mjs --cycles 4 --companies 奇瑞汽车,华大集团
node scripts/evaluate-ats-collection.mjs --cycles 2 --companies 奇瑞汽车 --fact-store artifacts/ats-evaluation/2026-09-27T14-19-16-207Z/facts.json
```

受控测试补充新/旧列表、newdefault 表头、真实字段缺失、跨域链接拒绝、部分读取、异常隔离、请求预算、检查点重启、第一页变化重置，以及最终完整集合才关闭缺失岗位。541 项 Vitest 与后端 8 项通过，1 项跳过；完整构建通过。后续详情异常隔离的新增回归正在复跑。

最终固定 50 家复跑：`artifacts/ats-evaluation/2026-09-27T14-24-56-560Z/`，北森 23/25、4080 个岗位，Moka 25/25、1824 个岗位；首次发现时间与 Diff 不变量异常均为 0。旧详情的异常已逐条隔离，快照保留 partial，不将局部失败当完整集合。

全套首次复跑有一项浏览器旧配对测试因计时差异失败，实际为提前命中读取超时，未发现旧配对被放行；该次失败保留在进度记录。未修改浏览器实现，单独 24 项与全套复验均通过。最终为 542 项 Vitest、后端 8 项通过，1 项跳过；脚本语法与 `git diff --check` 通过。

## 行动 3 自定义入口及字段缺失

`artifacts/ats-custom-domains/2026-09-27T14-36-47-011Z/`：游卡官网唯一公开Moka入口，6岗位complete；幻方入口识别成功但API限制IP；江苏规划同时暴露社招/校招，要求明确入口；Klook匿名跳转循环。全部保留真实失败原因，不增加Cookie或认证凭证。

固定50回归 `artifacts/ats-evaluation/2026-09-27T14-37-55-034Z/`：北森23/25、4090岗位；Moka25/25、1824岗位。Moka缺地点162条为源站空数组，requirements1824条未提供，description5条空值；没有非空无法映射记录。缺失字段不推测补齐。

## 行动 4 固定100覆盖报告

```powershell
node scripts/evaluate-ats-collection.mjs tests/fixtures/ats-sources-100.json
```

真实报告 `artifacts/ats-evaluation/2026-09-27T14-51-00-365Z/report.md` 与同目录JSON：固定100个来源，原50家清单由哈希锁定，未替换失败样本。北森23/25、4090岗位，Moka25/25、1824岗位；新增50家无提取结果。总体41个complete非空、7个partial、1个empty、3个不支持、23个平台未知、25个访问/网络失败。岗位覆盖以公开API总数为对照，缺少分母显示unverified。

新增可调查渠道为MiniMax公开飞书招聘站、中国中车公开Hotjob站，各1个可访问线索。其余4个飞书域名网络失败，不计为可访问的适配收益。未知/访问失败来源尚不能证明非Moka/北森，归类要求保留待补证。

## 行动 5 趋势验证

`scripts/report-ats-trends.mjs` 从事实库运行摘要生成平台/来源/UTC日期趋势和异常记录。科大讯飞两轮真实趋势 `artifacts/ats-trends/2026-09-27T14-58-46-573Z/report.json`：2/2完整成功，1788条历史质量样本，地点/描述/要求/更新时间完整率均100%。旧历史兼容 `artifacts/ats-trends/2026-09-27T14-58-46-782Z/` 不补造字段统计，明确unverified。

新增适配器尚未完成。MiniMax匿名职位接口POST返回405；Hotjob已解析中国中车租户公开页面，正在验证职位数据协议。原始调查不作为采集成功证据。

### Hotjob 固定分类页回归

后续已完成Hotjob匿名pb分类页适配与CollectJobs接入。固定三来源清单`tests/fixtures/ats-hotjob-sources.json`在运行前建立；不替换固定100中的门户失败项。

| 来源 | 完整遍历 | 公开总数对照 | 数据质量 |
| --- | --- | --- | --- |
| 中国中车社招 | 6段，155岗位 | 155/155 complete | 职责/要求完整；12条海外岗位源站未提供地点；独立更新时间未提供 |
| 中国科学院力学研究所校招 | 7段，171岗位 | 171/171 complete | 地点/职责/要求完整；独立更新时间未提供 |
| 中国中车门户 | 未猜选分类 | unknown | 明确SOURCE_MULTIPLE_PORTALS |

产物`artifacts/ats-hotjob/2026-09-27T15-17-25-590Z/report.json`。单段最多30请求，存储实例逐段重建，剩余详情游标读回后继续；完整集合前始终partial，不误关闭遗漏岗位。完成后清除游标。正确申请URL由公开脚本确认；公开总数包括已截止岗位，326个事实岗位不等于326个可投递候选。

首轮地点完整断言未通过的证据保留在`artifacts/ats-hotjob/2026-09-27T15-14-06-057Z/`。缺失字段验收要求解释源站原因，不虚构地点。真实详情返回无地点的12条，记录source_missing。

新增适配后原100家复跑`artifacts/ats-evaluation/2026-09-27T15-18-01-971Z/`，北森23/25、4090岗位，Moka25/25、1824岗位，无首次发现时间或Diff异常，原门槛保持。中车原入口继续多分类失败，没有为了提升数字更换URL。

趋势按平台hotjob生成`artifacts/ats-trends/2026-09-27T15-22-33-065Z/`，6段有进展运行不误触发连续失败；连续停滞、结构/访问异常、完整集合骤降由受控测试验证。

最终整套Vitest以`npm run test:vitest -- --maxWorkers=2`执行，559项通过、1项跳过，没有排除任何用例；后端8项通过，完整构建通过。默认高并发曾出现既有浏览器旧配对计时失败，详细失败记录保留在开发进度中，浏览器生产代码未改动。

## 固定 100 家样本资格审查结论

行动4的样本资格验收未通过。`artifacts/ats-registry-evidence/2026-09-27T15-31-23-691Z/report.json` 保存了四家企业的官方公开响应与内容哈希；智谱、阶跃星辰的官方前端脚本均明确链接Moka招聘入口，与新增50家必须非Moka/北森的要求矛盾。理想汽车、海尔原飞书地址缺乏官方依据，已找到官方入口但底层平台仍未验证。

既有100家报告及冻结清单保持不变，其数字仅描述该清单的实际运行，不能作为合格的50+50覆盖验收。原北森/Moka回归与Hotjob固定分类页回归仍有效。需确认版本化纠正清单后重新冻结、运行和验收，不以替换失败来源提高成功率。

### v2清单与2026-09-28回归

用户已确认版本化纠正。清单 `tests/fixtures/ats-sources-100-v2.json` 保留原基线哈希和前版哈希，仅替换智谱、阶跃星辰为经官方入口/门户元数据核验的无问芯穹、商汤，并纠正理想汽车、海尔的官方入口；其他失败来源未替换，前版清单和所有报告保留。

实际产物 `artifacts/ats-evaluation/2026-09-28T08-30-05-831Z/report.json`：北森23/25、4087岗位，Moka25/25、1820岗位，原平台提取门槛通过；首次发现时间和Diff异常均0。100个来源中41 complete、7 partial、1 empty、7 unsupported_source、22 unknown_platform、22 access_or_network_failure。

新增50家平台资格单独验收：6家verified_other、0家contradicted、44家unverified，未通过。确认的其他平台为字节跳动/MiniMax/无问芯穹/商汤的飞书入口、中国银行的中华英才网入口、中国中车的Hotjob入口。其余来源仍须补证；无特征或网络失败不能证明使用非Moka/北森平台。

回归测试562项Vitest及后端8项通过，1项跳过；两文件定向45项通过。普通beisen集成字段不会将飞书/自建站错误识别为北森，飞书自定义招聘站须同时验证站点元数据及平台招聘静态资源。
