/* 页面和离线测试共用同一份字段规则，避免界面校验与测评导出出现两套标准。 */
(function (root) {
  'use strict';
  const VERSION = '1.0.0';
  const SECTIONS = [['intention', '投递意向'], ['resume', '附件简历'], ['personal', '个人信息'], ['education', '教育经历'], ['work', '工作 / 实习经历'], ['projects', '项目经历'], ['additional', '补充信息']];
  const LOCATIONS = { '浙江省': ['杭州市', '宁波市', '温州市'], '广东省': ['广州市', '深圳市', '佛山市', '珠海市'], '江西省': ['南昌市', '赣州市', '九江市'], '北京市': ['北京市'], '上海市': ['上海市'], '江苏省': ['南京市', '苏州市', '无锡市'], '湖北省': ['武汉市', '宜昌市'], '四川省': ['成都市', '绵阳市'], '福建省': ['福州市', '厦门市'], '其他地区': ['其他城市'] };
  const SUGGESTIONS = {
    school: ['浙江大学', '浙江工业大学', '浙江理工大学', '杭州电子科技大学', '南昌大学', '南昌航空大学', '北京大学', '北京航空航天大学', '清华大学', '复旦大学', '上海交通大学', '中山大学', '华南理工大学', '武汉大学', '其他学校'],
    major: ['工商管理', '工商管理（数字化运营方向）', '信息管理与信息系统', '计算机科学与技术', '软件工程', '工业设计', '产品设计', '电子商务', '人工智能', '数据科学与大数据技术'],
    company: ['序光科技有限公司', '序光信息技术有限公司', '杭州小影创新科技股份有限公司', '广州影子科技有限公司', '杭州云序科技有限公司', '深圳云序科技有限公司', '字节跳动', '腾讯科技', '阿里巴巴', '网易'],
  };
  const SKILLS = ['产品设计', '需求分析', '用户研究', '数据分析', 'SQL', 'Figma', 'Python', '原型设计', '项目管理', 'AI 应用'];
  function emptyEntry(type, id) { return { id, current: false }; }
  function initialState() { return { version: VERSION, intention: {}, personal: {}, additional: { skills: [] }, education: [emptyEntry('education', 'edu-1')], work: [emptyEntry('work', 'work-1')], projects: [emptyEntry('projects', 'project-1')], noWork: false, truth: false, privacy: false, files: {}, nextId: 2, status: 'draft', events: [], submission: null }; }
  function get(object, path) { return path.split('.').reduce((value, key) => value == null ? undefined : value[key], object); }
  function set(object, path, value) { const keys = path.split('.'); const key = keys.pop(); const parent = keys.reduce((target, segment) => target[segment], object); parent[key] = value; }
  const field = (path, label, type = 'text', options = {}) => ({ path, label, type, required: true, ...options });
  function fields(state) {
    const list = [
      field('intention.kind', '申请类型', 'radio', { options: ['实习', '全职'] }),
      field('intention.city', '意向工作城市', 'select', { options: ['杭州', '广州'] }),
      field('intention.arrival', '到岗时间', 'select', { options: ['随时到岗', '1 周内', '2 周内', '1 个月内', '协商确定'] }),
      field('intention.source', '获知渠道', 'select', { options: ['招聘官网', '学校就业网', '招聘平台', '员工内推', '其他'] }),
      field('intention.referral', '内推码', 'text', { required: state.intention.source === '员工内推', hint: '仅通过员工内推申请时必填。' }),
      field('personal.name', '姓名', 'text', { max: 50, autocomplete: 'name' }),
      field('personal.gender', '性别', 'radio', { options: ['男', '女', '不愿透露'] }),
      field('personal.phone', '手机号码', 'tel', { placeholder: '请输入 11 位中国大陆手机号', autocomplete: 'tel' }),
      field('personal.email', '电子邮箱', 'email', { autocomplete: 'email' }),
      field('personal.birthday', '出生日期', 'date'),
      field('personal.nationality', '国籍 / 地区', 'select', { options: ['中国大陆', '中国香港', '中国澳门', '中国台湾', '其他'] }),
      field('personal.province', '现居省份', 'select', { options: Object.keys(LOCATIONS) }),
      field('personal.city', '现居城市', 'select', { options: LOCATIONS[state.personal.province] || [], disabled: !state.personal.province, hint: '修改省份后，请重新选择城市。' }),
      field('personal.address', '详细地址', 'text', { required: false, full: true, max: 160 }),
      field('personal.documentType', '证件类型', 'select', { required: false, options: ['身份证', '护照', '港澳台通行证'] }),
      field('personal.documentNumber', '证件号码', 'text', { required: Boolean(state.personal.documentType), max: 30 }),
      field('personal.emergencyName', '紧急联系人', 'text', { required: false, max: 50 }),
      field('personal.emergencyPhone', '紧急联系电话', 'tel', { required: Boolean(state.personal.emergencyName) }),
    ];
    if (state.intention.kind === '实习') list.splice(4, 0, field('intention.days', '每周可实习天数', 'select', { options: ['3 天', '4 天', '5 天'] }), field('intention.duration', '可连续实习时长', 'select', { options: ['3 个月', '4 个月', '5 个月', '6 个月及以上'] }));
    if (state.intention.kind === '全职') list.splice(4, 0, field('intention.salary', '期望月薪（税前，元）', 'number', { min: 1000, max: 200000 }));
    for (const [type, entries] of [['education', state.education], ['work', state.noWork ? [] : state.work], ['projects', state.projects]]) {
      entries.forEach((entry, index) => {
        const p = `${type}.${index}`;
        if (type === 'education') list.push(
          field(`${p}.school`, '学校名称', 'combo', { dictionary: 'school', hint: '输入后选择候选项；未确认的搜索内容在失焦后不会保留。' }),
          field(`${p}.degree`, '学历', 'select', { options: ['博士研究生', '硕士研究生', '本科', '大专', '高中 / 中专', '其他'] }),
          field(`${p}.major`, '专业名称', 'combo', { dictionary: 'major' }),
          field(`${p}.mode`, '学习形式', 'select', { options: ['全日制', '非全日制', '海外留学'] }),
          field(`${p}.start`, '入学时间', 'month'), field(`${p}.end`, '毕业 / 预计毕业时间', 'month'),
          field(`${p}.gpa`, '个人成绩 / GPA', 'number', { required: false, min: 0, max: 100, hint: '请与右侧的满分制对应。' }),
          field(`${p}.gpaScale`, '成绩满分制', 'select', { required: Boolean(entry.gpa), options: ['4', '4.3', '5', '100'] }),
          field(`${p}.ranking`, '成绩排名', 'select', { required: false, options: ['前 5%', '前 10%', '前 20%', '前 50%', '其他', '不适用'] }),
          field(`${p}.courses`, '主修课程 / 在校荣誉', 'textarea', { required: false, full: true, max: 1000 }),
        );
        if (type === 'work') list.push(
          field(`${p}.company`, '公司名称', 'combo', { dictionary: 'company', hint: '选择完整公司名称；没有匹配项时，可确认使用输入内容。' }),
          field(`${p}.position`, '职位名称', 'text', { max: 100 }),
          field(`${p}.type`, '经历类型', 'select', { options: ['实习', '全职', '兼职'] }),
          field(`${p}.department`, '所在部门', 'text', { required: false, max: 100 }),
          field(`${p}.start`, '开始时间', 'month'), field(`${p}.end`, '结束时间', 'month', { required: !entry.current, disabled: entry.current, currentToggle: true }),
          field(`${p}.description`, '工作职责与成果', 'textarea', { full: true, minLength: 30, max: 2000, hint: '请描述职责、具体行动与成果，至少 30 字。' }),
          field(`${p}.reason`, '离职原因', 'text', { required: false, full: true, max: 200 }),
        );
        if (type === 'projects') list.push(
          field(`${p}.name`, '项目名称', 'text', { max: 120 }), field(`${p}.role`, '担任角色', 'text', { max: 100 }),
          field(`${p}.start`, '开始时间', 'month'), field(`${p}.end`, '结束时间', 'month', { required: !entry.current, disabled: entry.current, currentToggle: true }),
          field(`${p}.url`, '项目 / 作品链接', 'url', { required: false, full: true }),
          field(`${p}.description`, '项目背景、个人贡献与成果', 'textarea', { full: true, minLength: 30, max: 2000, hint: '请区分团队目标与个人贡献，至少 30 字。' }),
        );
      });
    }
    list.push(
      field('additional.skills', '专业技能', 'tags', { full: true, options: SKILLS, hint: '可多选，请只选择你实际掌握的技能。' }),
      field('additional.english', '英语能力', 'select', { required: false, options: ['CET-4', 'CET-6', '雅思', '托福', '其他', '暂无证书'] }),
      field('additional.englishScore', '英语成绩', 'number', { required: ['CET-4', 'CET-6', '雅思', '托福'].includes(state.additional.english), min: 0, max: 710 }),
      field('additional.portfolio', '作品集 / 个人主页', 'url', { required: false, full: true, placeholder: 'https://' }),
      field('additional.intro', '自我评价', 'textarea', { full: true, minLength: 20, max: 1000, hint: '结合申请职位介绍你的优势，至少 20 字。' }),
      field('additional.adjustment', '是否接受工作地点调剂', 'radio', { options: ['接受', '不接受'] }),
      field('additional.accommodation', '招聘流程中的便利支持需求', 'textarea', { required: false, full: true, max: 500, hint: '选填，不影响申请结果。' }),
    );
    if (state.atsProfile === 'beisen') for (const item of list) if (item.dictionary === 'company') { item.type = 'text'; item.hint = '请输入完整公司名称。'; }
    return list;
  }
  function isEmpty(value) { return value == null || (Array.isArray(value) ? value.length === 0 : String(value).trim() === ''); }
  function monthValid(value) { return /^(199\d|20[0-3]\d|2040)-(0[1-9]|1[0-2])$/.test(String(value)); }
  function validateFile(file, kind) {
    if (!file) return kind === 'resume' ? '请上传附件简历' : '';
    const extension = String(file.name).split('.').pop().toLowerCase();
    if (!(kind === 'resume' ? ['pdf', 'doc', 'docx'] : ['pdf', 'zip']).includes(extension)) return '文件格式不支持，请按提示选择文件';
    if (!(file.size > 0)) return '不能上传空文件';
    if (file.size > (kind === 'resume' ? 10 : 20) * 1024 * 1024) return '文件超出允许的大小';
    return '';
  }
  function validate(state) {
    const errors = {};
    const add = (path, message) => { if (!errors[path]) errors[path] = message; };
    for (const f of fields(state)) {
      const value = get(state, f.path);
      if (f.disabled) continue;
      if (isEmpty(value)) { if (f.required) add(f.path, `请${['select', 'radio', 'tags', 'combo', 'month', 'date'].includes(f.type) ? '选择' : '填写'}${f.label}`); continue; }
      const text = String(value).trim();
      if (f.options && f.type !== 'tags' && !f.options.includes(text)) add(f.path, '请选择列表中有效的选项');
      if (f.type === 'tags' && (!Array.isArray(value) || value.some(item => !f.options.includes(item)))) add(f.path, '请选择有效的专业技能');
      if (f.type === 'combo') {
        const parent = get(state, f.path.split('.').slice(0, -1).join('.'));
        if (parent._committed?.[f.path.split('.').pop()] !== value) add(f.path, `请从候选列表中确认${f.label}`);
      }
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) add(f.path, '请输入有效的电子邮箱');
      if (f.type === 'tel' && !/^1[3-9]\d{9}$/.test(text)) add(f.path, '请输入有效的 11 位手机号码');
      if (f.type === 'month' && !monthValid(text)) add(f.path, '请选择有效的年月');
      if (f.type === 'number' && (!Number.isFinite(Number(value)) || Number(value) < (f.min ?? -Infinity) || Number(value) > (f.max ?? Infinity))) add(f.path, `请输入 ${f.min ?? 0} 至 ${f.max ?? '有效范围'} 之间的数值`);
      if (f.type === 'url') { try { const url = new URL(text); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { add(f.path, '请输入以 http:// 或 https:// 开头的有效链接'); } }
      if (f.minLength && text.length < f.minLength) add(f.path, `请至少填写 ${f.minLength} 字`);
      if (f.max && f.type !== 'number' && text.length > f.max) add(f.path, `不能超过 ${f.max} 字`);
    }
    if (!state.education.length) add('education', '请至少添加一段教育经历');
    if (!state.noWork && !state.work.length) add('work', '请添加工作经历，或勾选暂无工作经历');
    if (!state.projects.length) add('projects', '请至少添加一段项目经历');
    for (const type of ['education', 'work', 'projects']) {
      if (type === 'work' && state.noWork) continue;
      state[type].forEach((entry, i) => {
        if (monthValid(entry.start) && monthValid(entry.end) && !entry.current && entry.start > entry.end) add(`${type}.${i}.end`, '结束时间不能早于开始时间');
        if (type !== 'education' && monthValid(entry.start) && entry.start > '2026-10') add(`${type}.${i}.start`, '开始时间不能晚于测评基准月 2026-10');
        if (type !== 'education' && monthValid(entry.end) && !entry.current && entry.end > '2026-10') add(`${type}.${i}.end`, '未结束的经历请勾选“至今”');
        if (type === 'education' && entry.gpa && entry.gpaScale && Number(entry.gpa) > Number(entry.gpaScale)) add(`${type}.${i}.gpa`, '个人成绩不能大于满分制');
      });
    }
    if (state.personal.birthday) {
      const birthday = state.personal.birthday;
      const date = new Date(`${birthday}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== birthday || birthday < '1940-01-01' || birthday > '2010-10-30') add('personal.birthday', '出生日期应为 1940-01-01 至 2010-10-30 之间的有效日期');
    }
    if (state.personal.documentType === '身份证' && state.personal.documentNumber && !/^\d{17}[\dXx]$/.test(state.personal.documentNumber)) add('personal.documentNumber', '请输入 18 位身份证号码');
    const scoreMax = { 'CET-4': 710, 'CET-6': 710, '雅思': 9, '托福': 120 }[state.additional.english];
    if (scoreMax && Number(state.additional.englishScore) > scoreMax) add('additional.englishScore', `该考试成绩不能超过 ${scoreMax}`);
    const fileError = validateFile(state.files.resume, 'resume'); if (fileError) add('files.resume', fileError);
    if (state.files.portfolio) { const error = validateFile(state.files.portfolio, 'portfolio'); if (error) add('files.portfolio', error); }
    if (!state.truth) add('truth', '请确认信息真实性声明');
    if (!state.privacy) add('privacy', '请阅读并同意候选人隐私声明');
    return errors;
  }
  function progress(state) {
    const required = fields(state).filter(f => f.required && !f.disabled);
    const errors = validate(state);
    const total = required.length + 3;
    const count = required.filter(f => !errors[f.path]).length + Number(!errors['files.resume']) + Number(state.truth) + Number(state.privacy);
    return { count, total, percent: Math.floor(count / total * 100) };
  }
  // 输入查询与已确认值分离；失焦只能抛弃查询，不能误删已经选择的有效值。
  function resolveBlur(committed, query) { return { value: committed || '', discarded: query !== (committed || '') }; }
  function commitCombo(state, path, value) {
    set(state, path, value);
    const parent = get(state, path.split('.').slice(0, -1).join('.'));
    parent._committed ||= {};
    parent._committed[path.split('.').pop()] = value;
  }
  function snapshot(state) {
    const copy = JSON.parse(JSON.stringify(state));
    // 忽略已隐藏的条件字段及被“暂无经历”暂存的记录，避免导出错误信息。
    if (copy.noWork) copy.work = [];
    if (copy.intention.kind !== '全职') delete copy.intention.salary;
    if (copy.intention.kind !== '实习') { delete copy.intention.days; delete copy.intention.duration; }
    if (!['CET-4', 'CET-6', '雅思', '托福'].includes(copy.additional.english)) delete copy.additional.englishScore;
    for (const type of ['education', 'work', 'projects']) copy[type].forEach(e => { if (e.current) e.end = '至今'; });
    return { benchmark: 'career-portal-hard-v1', version: VERSION, referenceDate: '2026-10-30', exportedAt: new Date().toISOString(), application: copy, validationErrors: validate(state), completeness: progress(state), metrics: { blurDiscards: state.events.filter(e => e.type === 'combo_blur_discard').length, confirmedSelections: state.events.filter(e => e.type === 'combo_commit').length, submitAttempts: state.events.filter(e => e.type === 'preview_attempt').length } };
  }
  const api = { VERSION, SECTIONS, LOCATIONS, SUGGESTIONS, SKILLS, initialState, emptyEntry, get, set, fields, isEmpty, monthValid, validateFile, validate, progress, resolveBlur, commitCombo, snapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CareerEngine = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
