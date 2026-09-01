export interface EvalFixtureJob {
  id: string;
  company: string;
  title: string;
  type: string;
  city: string;
  employmentType: '全职' | '实习';
  salary: string;
  matchScore: number;
  description: string;
  simulatedLink: string;
}

const Companies = ['星河科技', '云帆智能', '晨曦数据', '北辰网络', '澄海互联', '远景数字'] as const;
const Cities = ['杭州', '上海', '北京', '深圳', '广州', '南京'] as const;

const RoleSpecs = [
  {
    slug: 'agent-platform', type: 'Agent 平台', title: 'Agent 平台工程师',
    responsibility: '负责智能体运行循环、上下文管理、工具注册与权限确认机制的设计开发；建设浏览器自动化、任务恢复、可观测性和评测平台；与产品及业务团队拆解招聘场景，把不稳定的模型行为转化为可验证、可回放的工程流程。',
    requirement: '本科及以上学历，计算机相关专业；熟悉 TypeScript 或 Python，理解 LLM Tool Calling、状态机和并发控制；具备安全边界、幂等与故障恢复意识，有 Agent、浏览器自动化或模型评测实践者优先。',
  },
  {
    slug: 'llm-application', type: '大模型应用', title: '大模型应用工程师',
    responsibility: '负责大模型应用的需求分析、原型验证与生产交付；搭建 RAG、知识索引、提示词版本管理和离线评测链路；持续分析线上失败样本，优化召回、生成质量、延迟与成本，并沉淀可复用的应用组件。',
    requirement: '本科及以上学历，熟练使用 Python，掌握主流模型 API、向量数据库和检索增强技术；能够独立完成数据处理、服务开发和效果评估；具备真实业务落地经验，理解模型幻觉和安全治理者优先。',
  },
  {
    slug: 'frontend', type: '前端开发', title: '前端工程师',
    responsibility: '负责招聘管理桌面端与 Web 端的交互研发，建设复杂表单、数据看板和可访问组件；与设计师共同完善响应式体验和设计系统；通过性能分析、自动化测试与监控提升首屏速度、稳定性和长期可维护性。',
    requirement: '本科及以上学历，熟悉 React、TypeScript、现代 CSS 和前端工程化；理解状态管理、网络协议和浏览器渲染机制；能编写清晰测试并定位性能问题，有 Electron 或大型中后台项目经验者优先。',
  },
  {
    slug: 'backend', type: '后端开发', title: '后端工程师',
    responsibility: '负责岗位、候选人和投递流程的服务端设计，建设稳定的 API、异步任务和审计系统；完善数据一致性、幂等、限流与故障恢复机制；参与容量规划和线上问题排查，推动服务模块化与工程标准落地。',
    requirement: '本科及以上学历，熟悉 Node.js、Java、Go 或 Python 中至少一种技术栈；掌握关系型数据库、缓存和消息队列；理解分布式系统及安全开发原则，具备高并发服务或复杂业务系统经验者优先。',
  },
  {
    slug: 'data-analyst', type: '数据分析', title: '数据分析师',
    responsibility: '负责招聘漏斗、渠道效率和候选人体验的指标体系建设；完成数据清洗、专题分析、异常诊断和实验评估；与业务团队定义口径并输出可执行建议，推动核心报表自动化和数据质量监控持续完善。',
    requirement: '本科及以上学历，统计、数学或计算机相关专业；熟练使用 SQL、Excel 和至少一种分析工具，理解 A/B 实验与基础统计方法；具有良好业务沟通和报告表达能力，有招聘或增长分析经验者优先。',
  },
  {
    slug: 'algorithm', type: '算法研发', title: 'NLP 算法工程师',
    responsibility: '负责简历解析、职位匹配、文本分类和排序算法的研发迭代；建设训练数据、特征与评估体系，分析误差并优化模型效果；与工程团队完成推理服务部署、性能优化和线上监控，保障算法稳定交付。',
    requirement: '硕士优先，计算机或人工智能相关专业；熟悉机器学习、深度学习和自然语言处理，能够使用 PyTorch 完成训练与调优；理解检索、排序及模型评测，有中文文本或推荐系统项目经验者优先。',
  },
  {
    slug: 'product', type: '产品管理', title: 'AI 产品经理',
    responsibility: '负责求职与招聘智能产品的用户研究、需求定义和路线规划；把模型能力拆解为清晰的交互、数据和验收标准；协调设计、研发、算法和运营推进版本交付，通过埋点、访谈与实验持续验证产品价值。',
    requirement: '本科及以上学历，三年以上互联网产品经验；具备结构化分析、原型设计和跨团队项目管理能力；理解生成式 AI 的能力边界、成本和安全风险，做过企业服务、招聘或智能助手产品者优先。',
  },
  {
    slug: 'ux-design', type: '体验设计', title: '交互设计师',
    responsibility: '负责招聘平台和智能助手的端到端体验设计，梳理复杂任务流程并输出信息架构、交互原型和视觉规范；组织可用性测试，分析用户反馈；与研发协作保证组件、动效和多端响应式设计准确落地。',
    requirement: '本科及以上学历，设计相关专业；熟练使用 Figma 等设计工具，具备复杂中后台或工具类产品作品；理解可访问性、设计系统与用户研究方法，能够清晰表达方案依据，有 AI 产品设计经验者优先。',
  },
  {
    slug: 'qa-automation', type: '质量保障', title: '测试开发工程师',
    responsibility: '负责智能招聘产品的质量策略、自动化框架和发布门禁建设；覆盖接口、桌面端、浏览器操作与模型评测场景；设计故障注入和回归数据集，定位不稳定问题并推动研发完善可测试性和线上质量监控。',
    requirement: '本科及以上学历，熟悉 TypeScript、Python 或 Java，掌握接口和 UI 自动化测试；理解持续集成、网络协议和常见数据库；具备复杂系统测试设计与缺陷分析能力，有 Playwright 或 AI 评测经验者优先。',
  },
  {
    slug: 'sre', type: '运维可靠性', title: 'SRE 工程师',
    responsibility: '负责模型服务和招聘业务系统的稳定性、容量与成本治理；建设监控告警、发布回滚、灾备和应急响应流程；通过自动化工具减少重复运维，分析事故根因并推动架构和开发规范持续改进。',
    requirement: '本科及以上学历，熟悉 Linux、容器、云平台和基础网络；掌握一种脚本或后端语言，理解可观测性、容量规划与安全运维；具备生产系统值班和故障处理经验，有 GPU 或模型推理平台经验者优先。',
  },
] as const;

const Levels = [
  { prefix: '高级', employmentType: '全职' as const, salary: '30-45K·15薪' },
  { prefix: '', employmentType: '全职' as const, salary: '20-32K·14薪' },
  { prefix: '初级', employmentType: '全职' as const, salary: '13-20K·13薪' },
] as const;

/** 30 个岗位由稳定模板生成，分数严格降序；模拟链接始终保持在 Case 独占的本地 Origin。 */
export const EvalFixtureJobs: EvalFixtureJob[] = RoleSpecs.flatMap((role, roleIndex) => Levels.map((level, levelIndex) => {
  const ordinal = roleIndex * Levels.length + levelIndex;
  const id = ordinal === 0 ? 'agent-platform' : `${role.slug}-${levelIndex + 1}`;
  const company = Companies[ordinal % Companies.length];
  const city = Cities[(roleIndex + levelIndex) % Cities.length];
  const levelNote = levelIndex === 0 ? '该岗位需要承担关键方案评审和技术带教。' : levelIndex === 2 ? '团队提供导师制度，但仍要求能够独立完成明确模块。' : '岗位强调跨职能协作、过程记录和结果复盘。';
  const description = `岗位职责：${role.responsibility}${levelNote}任职资格/要求：${role.requirement}我们关注真实项目证据和清晰沟通，面试将围绕过往贡献、问题分析与岗位场景展开。`;
  return {
    id, company, title: `${level.prefix}${role.title}`, type: role.type, city, employmentType: level.employmentType,
    salary: level.salary, matchScore: 98 - ordinal * 2, description, simulatedLink: `/jobs/${id}`,
  };
}));
