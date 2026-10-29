/** 已验证的 ATS 日期组件特征；新增 ATS 时在此登记，不按企业域名单独维护填写脚本。 */
export const BrowserDateAdapters = {
  feishu: {
    domains: ['jobs.feishu.cn'],
    signature: '.atsx-date-picker,.atsx-date-picker-dropdown',
    range: '.atsx-date-picker-period-month',
    rangeEdge: '.atsx-date-picker-period-month-label',
    popup: '.atsx-date-picker-dropdown',
    monthPanel: '.atsx-date-picker-period-month-panel',
    optionList: '.atsx-date-picker-period-month-panel-list',
    option: '.atsx-date-picker-period-month-panel-list-item',
  },
  beisen: {
    domains: ['zhiye.com'],
    signature: '.phoenix-select,[class*="phoenix-calendar"]',
    field: '.phoenix-select',
    auxiliaryInput: '.phoenix-select__input--unText',
    monthCalendar: '.phoenix-calendar-month-calendar',
    calendarHeaders: '.phoenix-calendar-year-select,.phoenix-calendar-month-select',
    monthYearButton: '.phoenix-calendar-month-panel-year-select',
    monthYearText: '.phoenix-calendar-month-panel-year-select-content',
  },
  moka: {
    domains: ['mokahr.com'],
    signature: '[class*="apply-block-"],[class*="sd-Select-menu-"],[class*="sd-panal-menu-wrapper-"]',
    block: '[class*="apply-block-"]',
    blockTitle: '[class*="blockTitle-"]',
    record: '[class*="apply-fields-"]',
    field: '[class*="apply-field-"]',
    title: '[class*="title-"]',
    select: '[class*="sd-Select-container-"]',
    display: '[class*="sd-Input-display-value-"]',
    range: '.month-range-select',
    menu: '[class*="sd-Select-menu-"]',
    scrollable: '[class*="sd-Select-scrollable-"]',
    option: '[class*="sd-Select-common-item-"],[class*="sd-Menu-container-"]',
    dayField: 'label.day_info',
    calendar: '[class*="sd-panal-menu-wrapper-"]',
  },
} as const;

export type BrowserDateAdapterId = keyof typeof BrowserDateAdapters;

/**
 * 在当前文档就地选择适配器，不保存跨页面的 ATS 缓存，也不增加浏览器往返。
 * 域名仅提供平台线索，专用交互必须命中实际组件；混合页面按目标元素最近的组件选择。
 */
export const BrowserDateAdapterSelectionScript = `
  const dateAdapters = ${JSON.stringify(BrowserDateAdapters)};
  const dateAdapterEntries = Object.entries(dateAdapters);
  const hostname = location.hostname.toLowerCase();
  const domainHint = dateAdapterEntries.find(([, adapter]) => adapter.domains.some((domain) =>
    hostname === domain || hostname.endsWith('.' + domain)))?.[0] || 'unknown';
  const matchedAdapters = dateAdapterEntries.filter(([, adapter]) => document.querySelector(adapter.signature)).map(([id]) => id);
  const ats = matchedAdapters.length === 1 ? matchedAdapters[0] : matchedAdapters.length > 1 ? 'mixed' : domainHint;
  const dateAdapterFor = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const matches = dateAdapterEntries.filter(([, adapter]) => current.matches(adapter.signature));
      if (matches.length === 1) return matches[0][0];
      if (matches.length > 1) return 'generic';
    }
    return 'generic';
  };
`;

/** 只读诊断入口；识别结果不代表控件已经填写或校验成功。 */
export const BrowserAtsDetectionExpression = `(() => {
  ${BrowserDateAdapterSelectionScript}
  return { ats, domainHint, matchedAdapters };
})()`;
