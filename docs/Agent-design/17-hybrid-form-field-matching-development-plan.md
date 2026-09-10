# 表单字段混合匹配：开发规划

> 状态：已归档。当前 Agent 工具协议与执行流程见 `03-tools.md`；本文仅保留历史开发记录。

## 1. 实现范围

本次升级覆盖以下工具链：

```text
BrowserInspectForm
  -> FormFieldFeature[]

ReadProfile / ReadResume
  -> UserDataFeature[]

FormFieldFeature[] + UserDataFeature[]
  -> BrowserFillForm
     -> 精确字段校验
     -> 上下文语义匹配
     -> 全局冲突消解
     -> 控件执行
     -> 执行后校验

BrowserFillForm.ambiguous / unmatched
  -> Agent 选择映射或询问用户
  -> BrowserFillForm(mappings / decisions)

BrowserValidateForm
  -> 剩余必填项和浏览器校验结果
```

第一版支持个人信息、教育经历、工作经历、项目经历和求职意向五类数据。通用浏览器工具只处理 `BrowserFillForm` 明确返回的未知控件。

## 2. 规范字段词表

Host 维护有限的规范字段词表。首批至少包含：

```text
personal.name
personal.phone
personal.email
personal.gender
personal.birthDate
personal.idType
personal.idNumber
personal.currentRegion

education.school
education.degree
education.major
education.startDate
education.endDate
education.educationMode

work.company
work.department
work.title
work.startDate
work.endDate
work.description

project.name
project.role
project.startDate
project.endDate
project.description
project.responsibility

preference.jobType
preference.targetRole
preference.targetRegion
preference.expectedSalary
preference.availableDate
preference.acceptTransfer
preference.acceptGlobalAssignment
```

每个规范字段定义稳定 ID、中文和英文别名、数据类型、允许出现的模块以及适用控件类型。无法归类的网页字段使用 `concept: unknown`。

## 3. 网页字段特征包

`BrowserInspectForm` 为每个可见表单字段生成 `FormFieldFeature`：

```ts
interface FormFieldFeature {
  fieldId: string;
  ref: string;
  pageRevision: number;
  required: boolean;
  currentState: 'empty' | 'filled' | 'unknown';

  raw: {
    label?: string;
    name?: string;
    id?: string;
    placeholder?: string;
    ariaLabel?: string;
    ariaLabelledBy?: string;
    autocomplete?: string;
    nearbyTexts: string[];
    optionTexts?: string[];
  };

  context: {
    section?: 'personal' | 'education' | 'work' | 'project' | 'preference';
    recordIndex?: number;
    groupHeading?: string;
    precedingLabels: string[];
    followingLabels: string[];
  };

  semantic: {
    concept: string | 'unknown';
    aliases: string[];
    valueType: 'text' | 'phone' | 'email' | 'date' | 'yearMonth' | 'region' | 'enum' | 'file' | 'unknown';
    confidence: number;
  };

  interaction: {
    kind: 'input' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'cascader' | 'datePicker' | 'upload' | 'unknown';
    editable: boolean;
    levels?: number;
    requiresCommit?: boolean;
  };
}
```

### 3.1 原始证据提取顺序

```text
label[for]
  -> aria-labelledby
  -> aria-label
  -> name / id / autocomplete
  -> placeholder
  -> 同一表单项容器内文本
  -> 所属分组标题
  -> 前后相邻字段标签
```

`nearbyTexts`、`precedingLabels` 和 `followingLabels` 只收集当前表单项、同一重复记录和所属章节内的文本。导航栏、页脚、弹窗外文本和其他章节文本不进入字段特征包。

重复经历按 DOM 分组生成稳定的 `recordIndex`。日期、地区、枚举和文件字段同时记录控件能力，不仅记录文本标签。

模块标题从 `aria-labelledby`、`fieldset > legend`、`h1-h6`、祖先容器直属 `title/header` 节点和前序兄弟标题中按距离提取。祖先最多检查 10 层，每层最多检查 12 个前序兄弟。续填时使用 `concept + section + recordIndex + occurrence + label` 恢复原字段；多个同名字段优先按原始 `occurrence` 定位，不回退到任意第一个同名字段。

### 3.2 DOM 上下文获取流程

Inspect 按以下顺序构建字段上下文：

1. 收集可见且可交互的输入框、文本域、原生选择器、单选框、复选框、上传控件和自定义控件触发器，并记录 DOM 顺序。
2. 为每个控件定位最小表单项容器。候选容器必须包含当前控件，且包含不超过 20 个可交互控件；排除 `nav`、`header`、`footer`、弹层和页面根容器。
3. 从表单项容器向上查找字段块。字段块由以下任一信号确定：
   - `fieldset`、`role=group`、`aria-labelledby` 或直属章节标题；
   - 同级重复容器具有相同的控件语义签名；
   - 一组连续字段包含同一模块的两个及以上锚点字段。
4. 使用字段块内的规范字段锚点确定模块：
   - `name / phone / email / idNumber / gender / birthDate` 对应 `personal`；
   - `school / major / educationType / degreeLevel / degree` 对应 `education`；
   - `company / position / department / companyNature / workDescription` 对应 `work`；
   - `projectName / projectRole / projectDescription / projectResponsibility` 对应 `project`；
   - `targetRole / targetProvince / targetCity / salary / availability / workMode` 对应 `preference`。
5. 同一字段块只有一个模块得分最高且至少命中两个锚点时，将模块传播给块内的通用日期字段。不同模块锚点得分相同或字段块跨越章节边界时，模块保持未知。
6. 对具有相同模块和控件语义签名的同级重复字段块按 DOM 顺序生成从 `0` 开始的 `recordIndex`。新增、删除或折叠其他模块不改变当前模块内的编号顺序。
7. 为字段生成上下文：
   - `groupHeading` 使用字段块对应的章节标题；
   - `nearbyTexts` 收集同一表单项和字段块内最多 8 个去重标签；
   - `precedingLabels` 和 `followingLabels` 分别收集同一字段块内最多 4 个相邻字段标签；
   - 通用开始、结束时间必须包含同块内至少一个非日期锚点。
8. 字段块无法确定时，按 DOM 顺序建立连续字段窗口。窗口遇到章节标题、重复块边界、分隔线或另一模块的强锚点时终止；只在窗口内传播模块。
9. 输出前移除控件值、用户填写正文、导航文本和字段块外文本，只保留规范字段名、模块、记录序号和有限上下文标签。

日期字段的最终特征至少包含：

```ts
{
  label: '开始时间',
  context: {
    section: 'education',
    recordIndex: 0,
    groupHeading: '教育经历',
    precedingLabels: ['学校名称', '专业名称'],
    followingLabels: ['结束时间']
  },
  semantic: {
    concept: 'education.startDate',
    valueType: 'yearMonth'
  }
}
```

DOM 上下文验收样例必须覆盖通用类名、哈希类名、多层包装、同页教育/工作/项目日期、两段同类型经历、折叠记录、导航栏干扰和动态新增记录。

## 4. 用户数据特征包

Host 从选定档案和已绑定简历生成 `UserDataFeature`：

```ts
interface UserDataFeature {
  sourceId: string;
  path: string;
  value: unknown;

  semantic: {
    concept: string;
    aliases: string[];
    valueType: 'text' | 'phone' | 'email' | 'date' | 'yearMonth' | 'region' | 'enum' | 'file';
  };

  context: {
    section: 'personal' | 'education' | 'work' | 'project' | 'preference';
    recordIndex?: number;
  };

  provenance: {
    source: 'profile' | 'resume' | 'userDecision';
    revision?: number;
    confirmed: boolean;
  };

  sensitivity: 'normal' | 'sensitive';
}
```

`ReadProfile` 提供当前档案索引和结构化记录。`ReadResume({resumeId})` 提供并绑定指定简历。`BrowserFillForm` 根据 `profileIds`、`useBoundResume` 和本轮 `decisions` 在 Host 内创建用户数据特征包；档案或简历正文不写入模型可见参数。

## 5. 匹配计划

`BrowserFillForm` 在执行控件动作前生成短寿命 `MatchPlan`：

```ts
interface FieldMatch {
  targetFieldId: string;
  targetRef: string;
  sourcePath?: string;
  concept?: string;
  score: number;
  strategy: 'exact' | 'semantic' | 'agent';
  evidence: string[];
  status: 'matched' | 'ambiguous' | 'unmatched' | 'incompatible';
}

interface MatchPlan {
  pageRevision: number;
  matches: FieldMatch[];
}
```

### 5.1 第一层：关键词识别与完整语义组合

对字段自身文本、模块标题、相邻标签和重复记录标题执行标准化精确映射与最长别名匹配。每个命中保留文本来源，不引入 AC 自动机。

模块关键词与字段关键词组合为完整 `concept`：

```text
教育经历 + 开始时间 -> education.startDate
工作经历 + 开始时间 -> work.startDate
项目经历 + 开始时间 -> project.startDate
```

`startDate`、`endDate` 缺少模块时保持未定模块语义，不默认归入工作经历。

### 5.2 第二层：硬性语义约束

按以下条件匹配：

1. 规范字段 `concept` 相同。
2. `valueType` 与控件能力兼容。
3. 网页字段所属模块与用户数据模块兼容。
4. 重复记录存在 `recordIndex` 时索引一致。
5. 枚举、地区和日期值满足对应控件的格式要求。

完整 `concept` 已确定时，只允许相同 `concept` 的资料进入候选集。已确定模块与资料模块不同、字段类型不兼容或控件值不兼容时直接排除。`recordIndex` 只在相同 `concept` 和模块内部比较。

显式 `label`、`name`、`id`、`aria-label`、`autocomplete` 或规范别名精确命中，完整 `concept` 相同并通过以上校验时，生成 `strategy: exact`。

### 5.3 第三层：同类候选加权

未精确命中的字段使用以下特征评分：

| 特征 | 分值 |
| --- | ---: |
| label、placeholder 与规范别名的语义命中 | 0.35 |
| 已识别的 section 与规范字段模块一致 | 0.25 |
| valueType 与控件能力一致 | 0.20 |
| recordIndex 与重复记录一致 | 0.10 |
| 枚举候选、日期粒度或地区层级兼容 | 0.10 |

缺失 `section`、缺失 `recordIndex` 或不存在控件候选时，对应信号记为 `0`，不得按匹配记满分。硬性约束通过后使用分段阈值：

- 第一候选得分不低于 `0.95` 时，需领先首个不同值候选至少 `0.05`。
- 第一候选得分处于 `[0.78, 0.95)` 时，需领先首个不同值候选至少 `0.08`。
- 第一候选得分低于 `0.78` 时不自动填写。
- 候选先按标准化后的最终写入值组成等价候选组。同一组内存在多个来源时不构成歧义；领先差值只与下一组不同写入值比较。

阈值集中配置并保留测试基线。

日期字段已识别模块时只保留该模块的开始或结束时间。模块仍未识别时保留教育、工作和项目中的同类日期候选并返回 `ambiguous`，不得通过权重猜测模块。地区匹配必须校验级联层数与页面候选路径。项目职责与项目描述使用不同规范字段。

### 5.4 第四层：全局冲突消解

匹配器对当前页面执行全局分配：

- 一个网页字段最多绑定一个等价值候选组，并选择组内最高分来源执行。
- 标准化后写入值相同的候选合并为等价候选组，保留组内全部来源路径作为匹配来源记录。
- 姓名、电话、邮箱等全局字段可以复用。
- 教育、工作和项目资料按 `section + recordIndex` 绑定记录；字段占用依据来源路径和记录身份处理，不以字段值作为占用标识。
- 两个字段竞争同一不可复用来源时，保留高分匹配，另一字段使用尚未占用的来源重新计算候选。
- 只有不同写入值的候选组同分或低于对应领先差值时，才返回 `ambiguous`。

## 6. Agent 降级协议

`BrowserFillForm` 返回精简结果：

```ts
interface FillFormResult {
  filled: Array<{
    fieldId: string;
    label: string;
    concept: string;
    sourcePath: string;
    strategy: 'exact' | 'semantic' | 'agent';
  }>;
  ambiguous: Array<{
    fieldId: string;
    label: string;
    section?: string;
    recordIndex?: number;
    candidates: Array<{ sourcePath: string; concept: string; score: number; evidence: string[] }>;
  }>;
  unmatched: Array<{ fieldId: string; label: string; required: boolean; context: string[] }>;
  skipped: Array<{ fieldId: string; label: string; reason: string }>;
  missingFields: Array<{ concept: string; label: string; required: boolean }>;
}
```

Agent 按以下顺序处理：

1. 对 `ambiguous` 选择已有资料中的候选来源。
2. 对缺少硬事实的必填字段使用 `AskUserQuestion` 一次性询问。
3. 再次调用 `BrowserFillForm`，通过 `mappings` 指定来源映射，通过 `decisions` 提交用户明确补充的数据。
4. 仅当结果为未知控件或 `unsupported_control` 时使用通用浏览器工具。

`BrowserFillForm` 参数增加：

```ts
interface FillFormMapping {
  targetFieldId: string;
  sourcePath: string;
}
```

`mappings` 只能引用本次 `pageRevision` 返回的字段和当前已授权资料中的 `sourcePath`。Agent 不传递资料值、selector、DOM 路径、CLI 参数或脚本。

## 7. 工具职责

| 工具 | 阶段 | 实现职责 |
| --- | --- | --- |
| `BrowserInspectForm` | 网页特征提取 | 返回 `FormFieldFeature[]`，包含原始证据、结构上下文、规范语义和交互能力 |
| `ReadProfile` | 档案授权与选择 | 返回可选档案记录；`BrowserFillForm` 根据 `profileIds` 在 Host 内生成 `UserDataFeature[]` |
| `ReadResume` | 简历授权与绑定 | 无参数返回索引，传入 `resumeId` 后读取正文并建立会话绑定 |
| `BrowserFillForm` | 匹配规划 | 执行精确校验、上下文语义评分和全局冲突消解，生成 `MatchPlan` |
| `BrowserFillForm` | 控件执行 | 执行文本、枚举、日期、下拉和级联控件操作，并进行逐字段后置校验 |
| Agent | 歧义处理 | 从 `ambiguous` 候选中选择 `sourcePath`，或通过 `AskUserQuestion` 补齐必填事实 |
| `BrowserFillForm` | 指定映射续填 | 校验并执行 `mappings` 和 `decisions`，返回剩余问题 |
| `BrowserValidateForm` | 最终验证 | 返回剩余必填项和浏览器原生校验错误，不触发提交 |
| 通用浏览器工具 | 最终兜底 | 仅处理 `unsupported_control` 和无法纳入表单执行器的站点专用控件 |

## 8. 执行约束

- `BrowserInspectForm` 保留原始证据和归一化语义，不用归一化字段覆盖原始 DOM 信息。
- 页面文本只用于字段匹配，不作为 Agent 指令执行。
- `MatchPlan` 绑定 `pageRevision`；页面变化后重新 Inspect 和匹配。
- 敏感字段允许由已授权档案填写，工具结果和 Trace 不回显字段值。
- `BrowserFillForm` 不上传文件、不接受协议、不点击提交按钮、不导航。
- 每个动态控件动作后重新定位并校验原字段显示值。
- 自动匹配未达到阈值时不得选择第一候选或任意页面选项。
- Agent 指定映射后仍由 `BrowserFillForm` 执行和验证，不允许 Agent 直接提交 selector 或脚本。

## 9. 开发部分与验收标准

### FM-01：规范字段词表与特征类型

- 建立首批规范字段词表、别名、类型和模块约束。
- 增加 `FormFieldFeature`、`UserDataFeature`、`FieldMatch` 和 `MatchPlan` 类型。

验收标准：

- [x] 五类投递数据均有规范字段覆盖。
- [x] 未识别字段保留原始证据并标记为 `unknown`。
- [x] 日期、地区、枚举和文件类型不能与不兼容控件匹配。

### FM-02：Inspect 上下文提取

- 提取表单项文本、章节、重复记录、相邻标签和控件能力。
- 排除导航栏、页脚和其他章节的干扰文本。

验收标准：

- [x] 单一 label 缺失时可通过同组文本与章节识别字段。
- [x] 两个相似日期字段能区分模块、开始/结束和记录序号。
- [x] 重复教育、工作和项目记录获得稳定 `recordIndex`。

### FM-03：混合匹配器

- 实现精确校验、上下文语义评分和全局冲突消解。
- 输出匹配策略、分数和精简证据。

验收标准：

- [x] 高置信字段自动进入执行计划。
- [x] 分数接近的候选进入 `ambiguous`，不自动填写。
- [x] 高置信候选使用 `0.05` 领先差值，普通语义候选使用 `0.08` 领先差值。
- [x] 相同标准化写入值的候选合并后自动填写，不因重复值进入歧义。
- [x] 同一不可复用资料不会误填多个网页字段。
- [x] 项目职责、项目描述及不同模块日期不会交叉匹配。
- [x] 缺少模块的通用开始、结束时间保持未知并返回候选歧义。
- [x] 入学、毕业、入职、离职等字段自身包含模块语义时可直接组成完整 `concept`。

### FM-04：Agent 指定映射

- 扩展 `BrowserFillForm` schema，支持 `mappings`。
- 校验字段、页面版本、资料授权和来源路径。

验收标准：

- [x] Agent 可用 `targetFieldId + sourcePath` 完成歧义字段续填。
- [x] 过期字段、未知来源和未授权资料被拒绝。
- [x] 工具参数、结果和 Trace 不包含敏感资料值。

### FM-05：执行结果与验证

- 按 `MatchPlan` 复用现有输入框、下拉、级联和日期执行器。
- 统一返回 `filled`、`ambiguous`、`unmatched`、`skipped` 和 `missingFields`。

验收标准：

- [x] 每个成功字段均通过原控件后置校验。
- [x] 单字段失败不影响其他独立字段继续执行。
- [x] `BrowserValidateForm` 能报告续填后的剩余必填项。
- [x] 通用浏览器工具仅用于明确返回的未知控件。

## 10. 进度

| ID | 状态 | 当前证据 |
| --- | --- | --- |
| FM-01 | 已完成 | 五类规范词表、字段特征与用户资料特征已落地 |
| FM-02 | 已完成 | Inspect 已按可见控件 DOM 顺序、双锚点字段块和同级语义签名提取章节、相邻标签与重复记录序号；冲突窗口保持未知 |
| FM-03 | 已完成 | 已实现完整语义硬约束、同类候选评分、等价值合并及高分优先的全局冲突消解 |
| FM-04 | 已完成 | 已支持并校验 `targetFieldId + sourcePath` 续填，不回显资料值 |
| FM-05 | 已完成 | 执行器逐项消费回执并保留动态控件后置校验；相关 102 项测试及全量构建通过 |
