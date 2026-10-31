export interface TutorialImage { file: string; alt: string }
export interface TutorialContent {
  title: string;
  description: string;
  steps: Array<{ title: string; text: string }>;
  tip: string;
  images: TutorialImage[];
  prompt?: string;
  detail?: { title: string; paragraphs: string[] };
}

export const Tutorials: TutorialContent[] = [
  {
    title: '先存下一段真实经历',
    description: '档案是 Avery 了解你的依据。先记录教育、项目、实习或技能中的一项，之后准备不同简历时，就能重复使用。',
    steps: [
      { title: '打开档案', text: '在左侧选择「档案」，点击「添加条目」。' },
      { title: '写清你做了什么', text: '选择分类，写明时间、你的工作和结果。' },
      { title: '保存资料', text: '先保存一段真实经历，不确定的内容可以之后再补。' },
    ],
    tip: '只有确认过的数字和成果，才适合放进档案。',
    images: [{ file: '03-profile-form', alt: '档案中的项目经历表单与保存资料按钮' }, { file: '03-profile-list', alt: '档案列表与添加条目入口' }],
  },
  {
    title: '说清目标，让 Avery 帮你推进',
    description: '在对话里说明想申请的岗位，并提供岗位要求。Avery 可以结合你的档案准备材料；信息不足时，让它先向你提问。',
    steps: [
      { title: '新建对话', text: '准备材料可以使用「聊天」场景。' },
      { title: '提供资料与要求', text: '粘贴岗位要求；已有简历也可以通过附件按钮提供。' },
      { title: '选择合适的权限', text: '只讨论建议时用「只读」；需要保存或修改简历时选择「可编辑」，并检查确认内容。' },
    ],
    prompt: '请根据我的档案和下面的岗位要求，准备一份前端开发实习简历，并保存到简历库。突出 React、TypeScript 和表单开发经历。缺少的信息请先问我，不要补写没有依据的数字。\n\n岗位要求：熟悉 React / TypeScript，能够开发可复用组件，具备表单交互与团队协作经验。',
    tip: '允许编辑仍受当前场景和数据授权范围限制。',
    images: [{ file: '04-composer', alt: '对话输入区中的附件、权限、模型与发送入口' }, { file: '04-assistant', alt: '演示对话中的提问与回复' }],
  },
  {
    title: '核对这一版，再拿去申请',
    description: 'Avery 保存的简历会出现在左侧「简历」中。不同岗位可以保留不同版本，使用前先核对内容。',
    steps: [
      { title: '核对正文', text: '打开一份简历，检查联系方式、经历时间和项目成果。' },
      { title: '确定使用的版本', text: '需要修改时点击「编辑」；希望助手使用这一份时，点击「设为当前版本」。' },
      { title: '下载 PDF', text: '确认无误后再导出；有版本历史时，也能查看旧版本。' },
    ],
    tip: '相似岗位也值得检查侧重点是否合适。',
    images: [{ file: '05-resume', alt: '简历详情中的正文预览' }, { file: '05-resume-actions', alt: '编辑、设为当前版本与下载 PDF 操作栏' }],
  },
  {
    title: '找到合适的岗位，留在这里',
    description: '手动保存已找到的岗位，自己设置条件采集，或直接告诉 Avery 想找什么。公司、岗位要求和申请链接，都留在岗位库。',
    steps: [
      { title: '手动保存', text: '在「岗位」点击「手动添加」，填写公司、岗位名称、完整 JD 和来源链接。' },
      { title: '自己设置条件采集', text: '点击「采集岗位」，填写关键词、数量、渠道等条件，再点击「开始采集」。结果直接保存到岗位库，不需要调用模型。' },
      { title: '让 Avery 按要求采集', text: '连接模型后，新建对话并选择「工作」场景，说明岗位关键词、渠道和数量，让 Avery 采集并汇报结果。' },
    ],
    prompt: '请从已启用的企业官网招聘来源中，帮我采集 20 个前端开发实习岗位，学历要求选择本科，保存到岗位库，并告诉我实际找到和新增了多少个。',
    tip: '保存、收藏或采集岗位后，还需要完成申请才算投递。',
    images: [{ file: '06-collection', alt: '应用内采集岗位弹窗：前端开发、企业官网、20 个、实习、本科' }, { file: '06-job', alt: '岗位库中的岗位列表与职位详情' }],
    detail: { title: '了解采集条件', paragraphs: ['企业官网可以选择招聘来源；BOSS 直聘还需填写城市，并先连接已登录的浏览器。', '采集数量包含新增和已经在库的唯一岗位，不保证全部为新增。尽量保存完整职责和任职要求，而不只是岗位标题。'] },
  },
  {
    title: '网页上的申请，也可以一起完成',
    description: '需要在招聘网页填写申请时，先连接 Chrome、Edge 或 ego lite，再选择「工作」场景。Avery 会使用自己创建的任务标签页协助操作。',
    steps: [
      { title: '选择浏览器', text: '在「设置 → 浏览器控制」选择 Chrome、Edge 或 ego lite。' },
      { title: '检测连接', text: '在所选浏览器中加载 Avery Browser 扩展，再回到 Avery 点击「检测状态」。' },
      { title: '切换到工作场景', text: '新建对话，在输入框下方选择「工作」，说明目标岗位、申请链接和要使用的简历。' },
    ],
    prompt: '请打开我提供的岗位链接，使用当前简历协助填写申请；提交前让我核对。',
    tip: '遇到登录、验证码或无法判断的字段时，先在浏览器中处理，再回到对话继续。提交前检查公司、岗位、简历和附件。',
    images: [{ file: '07-browser', alt: '设置中的浏览器选择、未连接状态与检测按钮' }, { file: '07-scene', alt: '对话输入区的聊天与工作场景菜单' }],
    detail: { title: '如何安装扩展？', paragraphs: ['Chrome、Edge 和 ego lite 均使用 Avery Browser 扩展；在「设置 → 浏览器控制」点击「一键接入」，打开所选浏览器的扩展管理页和扩展目录。', 'Edge 使用 edge://extensions；Chrome 和 ego lite 使用 chrome://extensions。', '开启开发者模式，选择「加载解压缩的扩展」或「加载已解压的扩展程序」，选择 Avery 随附的 Browser 扩展文件夹。', '回到 Avery 点击「检测状态」。开发环境的扩展位于项目 apps/browser-extension；安装版使用应用随附的扩展目录。'] },
  },
  {
    title: '记住进度，也记住下一步',
    description: '申请完成后，在「投递记录」查看进展。把后续安排记下来，下一次打开 Avery 时就知道该做什么。',
    steps: [
      { title: '查看投递记录', text: '按「已投递 / 笔试 / 面试」查看当前进度。' },
      { title: '更新状态', text: '收到新的安排后，更新记录的阶段和备注。' },
      { title: '记下下一步日期', text: '把笔试、面试或跟进日期留在记录中，方便再次查看。' },
    ],
    tip: '记录应与实际进展一致；没有完成申请的岗位不要标记为已投递。',
    images: [{ file: '08-applications', alt: '投递记录看板中的已投递、笔试与面试' }, { file: '08-stages', alt: '投递记录中的阶段、备注与下一步日期' }],
  },
];
