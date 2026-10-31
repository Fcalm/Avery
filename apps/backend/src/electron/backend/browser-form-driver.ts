import {
  AgentBrowserError,
  CanonicalFormField,
  EncodedFormFieldPrefix,
  FormFieldAliases,
  FormFields,
  FormTextSimilarity,
  NormalizeFormLabel,
  NormalizeFormOption,
  type FormField,
  type FormFillOperation,
  type FormOptionObservation,
} from './browser-form-service';
import { BrowserDateAdapters, BrowserDateAdapterSelectionScript } from './browser-date-adapters';
import { FeishuSelectEnrichmentScript, FeishuSelectOptionsExpression, FeishuSelectValueScript } from './browser-feishu-form';
import { MokaDateControlsScript, MokaDateOptionRevealExpression, MokaDatePreparationExpression, MokaFormEnrichmentScript, MokaFormTargetRevealExpression, MokaFormValueScript, MokaOptionEnrichmentScript, MokaSearchOptionsWaitExpression } from './browser-moka-form';

const DynamicPollIntervalMs = 60;
const DynamicTransitionDelayMs = 60;
const DynamicConfirmationDelayMs = 180;
const OverlayTransitionDelayMs = 240;

export const FormSemanticEnrichmentExpression = (() => {
  const aliases = [...new Set(FormFieldAliases.flatMap(([, values]) => values))]
    .sort((left, right) => NormalizeFormLabel(right).length - NormalizeFormLabel(left).length);
  const fieldAliases = Object.fromEntries(FormFieldAliases);
  const sectionAnchors = {
    personal: ['name', 'phone', 'email', 'idNumber', 'gender', 'birthDate'],
    education: ['school', 'major', 'educationType', 'degreeLevel', 'degree'],
    work: ['company', 'position', 'department', 'companyNature', 'workDescription'],
    project: ['projectName', 'projectRole', 'projectDescription', 'projectResponsibility'],
    preference: ['targetRole', 'targetProvince', 'targetCity', 'salary', 'availability', 'workMode'],
  };
  return `(() => {
    ${BrowserDateAdapterSelectionScript}
    ${FeishuSelectValueScript}
    const aliases = ${JSON.stringify(aliases)};
    const fieldAliases = ${JSON.stringify(fieldAliases)};
    const sectionAnchors = ${JSON.stringify(sectionAnchors)};
    const sectionNames = { personal: '个人信息', education: '教育经历', work: '工作经历', project: '项目经历', preference: '求职意向' };
    const controlSelector = 'input,textarea,select,[contenteditable="true"],[role="combobox"],[aria-haspopup="listbox"]';
    const normalize = (value) => String(value || '').toLowerCase()
      .replace(/[\\s_\\-—–·:：()（）[\\]【】*＊]/g, '')
      .replace(/必填/g, '');
    const genericNames = new Set(['', '请输入', '请选择', '请填写', 'pleaseenter', 'pleaseselect']);
    const canonicalLabel = (value) => {
      const normalized = normalize(value);
      if (!normalized || normalized.length > 80) return '';
      for (const alias of aliases) {
        const normalizedAlias = normalize(alias);
        if (normalized === normalizedAlias
          || normalized === normalizedAlias + '请输入'
          || normalized === normalizedAlias + '请选择'
          || (normalizedAlias.length >= 2 && normalized.includes(normalizedAlias))) return alias;
      }
      return '';
    };
    const text = (element) => String(element?.innerText || element?.textContent || '').replace(/\\s+/g, ' ').trim();
    const sectionLabel = (value) => {
      const normalized = normalize(value);
      if (!normalized || normalized.length > 40) return '';
      const sections = [
        ['个人信息', ['个人信息', '基本信息', 'personalinformation', 'basicinformation']],
        ['教育经历', ['教育经历', '教育背景', 'educationexperience', 'educationbackground']],
        ['工作经历', ['工作经历', '任职经历', '工作经验', 'workexperience', 'employmentexperience']],
        ['项目经历', ['项目经历', '项目经验', '在校实践', '校园实践', 'projectexperience']],
        ['求职意向', ['求职意向', '职业意向', '求职偏好', 'jobintention', 'jobpreference']],
      ];
      const matches = sections.filter(([, values]) => values.some((candidate) => normalized.includes(normalize(candidate))));
      const codes = { '个人信息': 'personal', '教育经历': 'education', '工作经历': 'work', '项目经历': 'project', '求职意向': 'preference' };
      return matches.length === 1 ? codes[matches[0][0]] || '' : '';
    };
    const explicitLabel = (element) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const value = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
        const matched = canonicalLabel(value);
        if (matched) return matched;
      }
      if (element.id) {
        const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
        const matched = canonicalLabel(text(label));
        if (matched) return matched;
      }
      return canonicalLabel(text(element.closest('label')));
    };
    const nearbyLabel = (element) => {
      let branch = element;
      for (let depth = 0; branch?.parentElement && depth < 10; depth += 1) {
        let sibling = branch.previousElementSibling;
        for (let distance = 0; sibling && distance < 3; distance += 1, sibling = sibling.previousElementSibling) {
          if (!sibling.querySelector('input,textarea,select,[contenteditable="true"]')) {
            const matched = canonicalLabel(text(sibling));
            if (matched) return matched;
          }
        }
        const parent = branch.parentElement;
        const labelledChildren = parent.querySelectorAll(':scope > label, :scope > [class*="label" i]');
        for (const candidate of labelledChildren) {
          if (candidate !== branch && !candidate.contains(element)) {
            const matched = canonicalLabel(text(candidate));
            if (matched) return matched;
          }
        }
        branch = parent;
      }
      return '';
    };
    const rawExplicitLabel = (element) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const value = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
        if (text({ textContent: value })) return text({ textContent: value }).slice(0, 180);
      }
      if (element.id) {
        const value = text(document.querySelector('label[for="' + CSS.escape(element.id) + '"]'));
        if (value) return value.slice(0, 180);
      }
      const wrapped = text(element.closest('label'));
      if (wrapped) return wrapped.slice(0, 180);
      // ATS 常用相邻标题而非 label[for]；保留原始业务标题，即使尚无规范字段别名。
      const item = element.closest('.form-item') || element.closest('[class*="formItem"],[class*="form-item"]');
      return text(item?.querySelector(':scope > [class*="title" i],:scope > label,:scope > [class*="label" i]')).slice(0, 180);
    };
    const canonicalKey = (value) => {
      const matched = canonicalLabel(value);
      const normalized = normalize(matched);
      if (!normalized) return '';
      for (const [key, values] of Object.entries(fieldAliases)) {
        if (values.some((candidate) => normalize(candidate) === normalized)) return key;
      }
      return '';
    };
    const anchorSection = (key) => {
      for (const [section, keys] of Object.entries(sectionAnchors)) {
        if (keys.includes(key)) return section;
      }
      return '';
    };
    const visibleForContext = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
        && rect.width > 0 && rect.height > 0;
    };
    const excludedContextRoot = (element) => !element
      || ['HTML', 'BODY'].includes(element.tagName)
      || Boolean(element.closest('nav,header,footer,[role="navigation"]'))
      || ['dialog', 'alertdialog'].includes(String(element.getAttribute('role') || '').toLowerCase())
      || /(^|[-_\\s])(modal|popup|popover|tooltip|overlay)([-_\\s]|$)/i.test(String(element.className || ''));
    const contextLabel = (element) => [
      rawExplicitLabel(element),
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('name'),
      element.id,
      nearbyLabel(element),
    ].map(canonicalLabel).find(Boolean) || '';
    const structuralEntries = [...document.querySelectorAll(controlSelector)]
      .filter((element) => !element.closest('nav,header,footer,[role="navigation"]'))
      .filter((element) => !element.closest(dateAdapters.feishu.popup))
      .map((element) => {
        const label = contextLabel(element);
        const key = canonicalKey(label);
        return { element, label, key, anchor: anchorSection(key) };
      })
      .filter((entry) => entry.label);
    const contextEntries = structuralEntries.filter((entry) => visibleForContext(entry.element));
    const visibleControlCount = (root) => [...root.querySelectorAll(controlSelector)].filter(visibleForContext).length;
    const entriesWithin = (root) => contextEntries.filter((entry) => root === entry.element || root.contains(entry.element));
    const structuralEntriesWithin = (root) => structuralEntries.filter((entry) => root === entry.element || root.contains(entry.element));
    const unique = (values, limit) => [...new Set(values.map((value) => String(value || '').replace(/\\s+/g, ' ').trim()).filter(Boolean))].slice(0, limit);
    const explicitSectionsWithin = (root) => unique([
      ...(root.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => sectionLabel(text(document.getElementById(id)))),
      ...[...root.querySelectorAll(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > [class*="title" i],:scope > [class*="header" i]')]
        .map((heading) => sectionLabel(text(heading))),
    ], 5);
    const precedingSection = (root) => {
      let sibling = root.previousElementSibling;
      for (let distance = 0; sibling && distance < 8; distance += 1, sibling = sibling.previousElementSibling) {
        if (visibleControlCount(sibling) > 0) break;
        const section = sectionLabel(text(sibling)) || sectionLabel(text(sibling.querySelector('legend,h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="header" i]')));
        if (section) return section;
      }
      return '';
    };
    const inferredSection = (entries) => {
      const keysBySection = new Map();
      for (const entry of entries) {
        if (!entry.anchor) continue;
        const keys = keysBySection.get(entry.anchor) || new Set();
        keys.add(entry.key);
        keysBySection.set(entry.anchor, keys);
      }
      const ranked = [...keysBySection.entries()].sort((left, right) => right[1].size - left[1].size);
      if ((ranked[0]?.[1].size || 0) < 2 || ranked[0]?.[1].size === ranked[1]?.[1].size) return '';
      return ranked[0][0];
    };
    const formItemOf = (element) => {
      const explicit = element.closest('label,fieldset,[class*="form-item" i],[class*="formitem" i],[class*="field" i],[class*="row" i]');
      if (explicit && !excludedContextRoot(explicit) && visibleControlCount(explicit) <= 20) return explicit;
      let current = element.parentElement;
      let fallback = current;
      for (let depth = 0; current && depth < 8 && !excludedContextRoot(current); depth += 1, current = current.parentElement) {
        const count = visibleControlCount(current);
        if (count > 20) break;
        if (count <= 3) fallback = current;
        if (count <= 3 && canonicalLabel(text(current))) return current;
      }
      return fallback || element;
    };
    const blockOf = (item) => {
      let current = item;
      for (let depth = 0; current && depth < 10 && !excludedContextRoot(current); depth += 1, current = current.parentElement) {
        const controlCount = visibleControlCount(current);
        if (controlCount > 20) continue;
        const explicitSections = explicitSectionsWithin(current);
        if (explicitSections.length === 1) return { root: current, section: explicitSections[0], heading: sectionNames[explicitSections[0]] || '' };
        if (explicitSections.length > 1) continue;
        const preceding = precedingSection(current);
        if (preceding) return { root: current, section: preceding, heading: sectionNames[preceding] || '' };
        const section = inferredSection(entriesWithin(current));
        if (section) return { root: current, section, heading: sectionNames[section] || '' };
      }
      return undefined;
    };
    const orderedIndex = (element, entries) => {
      const direct = entries.findIndex((entry) => entry.element === element || entry.element.contains(element) || element.contains(entry.element));
      if (direct >= 0) return direct;
      return entries.findIndex((entry) => Boolean(element.compareDocumentPosition(entry.element) & Node.DOCUMENT_POSITION_FOLLOWING));
    };
    const fallbackContext = (element) => {
      const index = orderedIndex(element, contextEntries);
      if (index < 0) return undefined;
      const collectDirection = (step) => {
        const entries = [];
        let firstAnchor = '';
        for (let offset = 1; offset <= 6; offset += 1) {
          const entry = contextEntries[index + step * offset];
          if (!entry) break;
          if (entry.anchor && firstAnchor && entry.anchor !== firstAnchor) break;
          if (entry.anchor && !firstAnchor) firstAnchor = entry.anchor;
          entries.push(entry);
        }
        return step < 0 ? entries.reverse() : entries;
      };
      const before = collectDirection(-1);
      const after = collectDirection(1);
      const beforeSection = [...before].reverse().find((entry) => entry.anchor)?.anchor || '';
      const afterSection = after.find((entry) => entry.anchor)?.anchor || '';
      if (beforeSection && afterSection && beforeSection !== afterSection) return undefined;
      const entries = [...before, ...contextEntries.slice(index, index + 1), ...after];
      const section = inferredSection(entries);
      return section ? { root: undefined, section, heading: sectionNames[section] || '', entries } : undefined;
    };
    const blockSignature = (root, section) => [...new Set(structuralEntriesWithin(root)
      .filter((entry) => !entry.anchor || entry.anchor === section)
      .map((entry) => entry.key).filter(Boolean))].sort().join('|');
    const repeatedRecord = (block) => {
      let root = block.root;
      for (let depth = 0; root?.parentElement && depth < 3; depth += 1, root = root.parentElement) {
        const signature = blockSignature(root, block.section);
        if (!signature) continue;
        const peers = [...root.parentElement.children].filter((candidate) => !excludedContextRoot(candidate)
          && blockSignature(candidate, block.section) === signature
          && inferredSection(structuralEntriesWithin(candidate)) === block.section);
        if (peers.length > 1) return { root, index: peers.indexOf(root) };
      }
      return undefined;
    };
    const contextOf = (element) => {
      const item = formItemOf(element);
      const resolved = blockOf(item) || fallbackContext(element);
      const blockEntries = resolved?.root ? entriesWithin(resolved.root) : resolved?.entries || [];
      const index = orderedIndex(element, blockEntries);
      const itemLabels = entriesWithin(item).map((entry) => entry.label);
      const surroundingLabels = blockEntries.map((entry) => entry.label);
      const record = resolved?.root ? repeatedRecord(resolved) : undefined;
      // 北森把一条经历拆成多个 form-part；ux-standard-form 才是名称、日期和描述的共同记录边界。
      const beisenRecord = matchedAdapters.includes('beisen') ? element.closest('.ux-standard-form') : null;
      const beisenSection = beisenRecord ? inferredSection(structuralEntriesWithin(beisenRecord)) : '';
      const beisenPeers = beisenSection ? [...document.querySelectorAll('.ux-standard-form')].filter(root => inferredSection(structuralEntriesWithin(root)) === beisenSection) : [];
      return {
        x: unique([...itemLabels, ...surroundingLabels], 8),
        r: index > 0 ? unique(blockEntries.slice(Math.max(0, index - 4), index).map((entry) => entry.label), 4) : [],
        f: index >= 0 ? unique(blockEntries.slice(index + 1, index + 5).map((entry) => entry.label), 4) : [],
        s: String(resolved?.section || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
        g: String(resolved?.heading || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
        o: beisenSection ? beisenPeers.indexOf(beisenRecord) : record && record.index >= 0 ? record.index : undefined,
      };
    };
    const encodedName = (element, fallbackLabel, forceLabel = false, overrides = {}) => {
      // WeakMap 随文档销毁；同 URL 重载或重复经历重排不能沿用旧的目标身份。
      const identities = window.__averyFormIdentities ||= { prefix: crypto.randomUUID(), next: 0, nodes: new WeakMap() };
      if (!identities.nodes.has(element)) identities.nodes.set(element, identities.prefix + ':' + (++identities.next));
      const recordRoot = matchedAdapters.includes('beisen') ? element.closest('.ux-standard-form')
        : matchedAdapters.includes('moka') ? element.closest(moka.record) : null;
      if (recordRoot && !identities.nodes.has(recordRoot)) identities.nodes.set(recordRoot, identities.prefix + ':' + (++identities.next));
      const context = contextOf(element);
      const rawLabel = forceLabel ? fallbackLabel : rawExplicitLabel(element) || context.x[0] || fallbackLabel;
      const rangeEdge = dateAdapterFor(element) === 'feishu' && element.matches(dateAdapters.feishu.rangeEdge);
      const dateValue = rangeEdge
        ? text(element).replace(/\\s+/g, '')
        : dateAdapterFor(element) === 'beisen' && element.matches(dateAdapters.beisen.field) && ['birthDate', 'startDate', 'endDate', 'availability'].includes(canonicalKey(fallbackLabel))
          ? String(element.querySelector('input')?.value || '') : undefined;
      const value = String(dateValue ?? feishuSelectedValue(element) ?? (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
        ? String(element.checked) : 'value' in element ? element.value
          : element.querySelector('.phoenix-select__content')?.innerText ?? element.getAttribute('title') ?? text(element)));
      const currentValue = /^(?:请选择|请输入|请填写)$/.test(value.trim()) ? '' : value;
      const filled = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
        ? element.checked
        : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? String(element.value || '').trim().length > 0
          : rangeEdge ? /^\\d{4}-\\d{1,2}$/.test(currentValue) : currentValue.trim().length > 0;
      const payload = {
        l: String(rawLabel || fallbackLabel || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
        n: String(element.getAttribute('name') || '').slice(0, 120),
        i: String(element.id || '').slice(0, 120),
        p: String(element.getAttribute('placeholder') || '').slice(0, 180),
        a: String(element.getAttribute('aria-label') || '').slice(0, 180),
        b: String(element.getAttribute('aria-labelledby') || '').slice(0, 120),
        v: filled,
        j: identities.nodes.get(element),
        k: recordRoot ? identities.nodes.get(recordRoot) : undefined,
        u: element.required === true || element.getAttribute('aria-required') === 'true' || Boolean(element.closest('.form-item')?.querySelector('.form-item__required')) ? true : undefined,
        ...context,
        ...overrides,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return '${EncodedFormFieldPrefix}' + btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
    };
    const preserve = (element, attribute) => {
      const suffix = attribute === 'aria-label' ? 'aria-label' : 'role';
      element.setAttribute('data-avery-had-' + suffix, element.hasAttribute(attribute) ? '1' : '0');
      if (element.hasAttribute(attribute)) element.setAttribute('data-avery-original-' + suffix, element.getAttribute(attribute) || '');
    };
    ${MokaFormEnrichmentScript}
    ${FeishuSelectEnrichmentScript}
    const mokaFormOnly = matchedAdapters.length === 1 && matchedAdapters[0] === 'moka';
    let annotated = 0;
    let auxiliary = 0;
    for (const element of document.querySelectorAll('input,textarea,select,[contenteditable="true"]')) {
      if (!(element instanceof HTMLElement)) continue;
      if (mokaFormOnly && !element.closest(dateAdapters.moka.field)) { mokaAuxiliary(element); continue; }
      if (element.hasAttribute('data-avery-form-semantic') || (dateAdapterFor(element) === 'moka' && element.closest(dateAdapters.moka.field))) continue;
      if (element.closest(dateAdapters.feishu.popup)) continue;
      const type = String(element.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || type === 'password') continue;
      if (element.closest('nav,header,footer,[role="navigation"]')) {
        preserve(element, 'aria-label');
        element.setAttribute('aria-label', '__avery_internal_form_control__');
        element.setAttribute('data-avery-form-semantic', 'auxiliary');
        auxiliary += 1;
        continue;
      }
      const currentName = element.getAttribute('aria-label') || element.getAttribute('placeholder') || '';
      const genericName = genericNames.has(normalize(currentName));
      const interactiveAncestor = element.parentElement?.closest('[role="combobox"],[aria-haspopup="listbox"],[class*="select" i],[class*="cascader" i],[class*="picker" i],[class*="dropdown" i],[onclick]');
      const ancestorMarker = String(interactiveAncestor?.className || '').toLowerCase();
      const pickerAncestor = interactiveAncestor && (interactiveAncestor.getAttribute('role') === 'combobox'
        || interactiveAncestor.getAttribute('aria-haspopup') === 'listbox'
        || /(^|[-_\\s])(select|selector|cascader|picker|dropdown)([-_\\s]|$)/.test(ancestorMarker)
        || normalize(text(interactiveAncestor)) === '请选择');
      const nativeIdentity = canonicalLabel([
        element.getAttribute('name'), element.id, element.getAttribute('autocomplete'),
      ].filter(Boolean).join(' '));
      const popupInput = type === 'search' || element.getAttribute('role') === 'searchbox'
        || element.hasAttribute('aria-autocomplete') || element.hasAttribute('aria-controls');
      const nativeInputType = ['tel', 'email', 'number', 'date', 'month'].includes(type);
      // 自定义组件内部的可见搜索框也可能可编辑，不能仅凭尺寸将其当作普通字段。
      // 手机号等真实输入框通过原生类型或稳定 name/id/autocomplete 保留。
      const strongNativeField = !popupInput && (nativeInputType || Boolean(nativeIdentity));
      if (genericName && pickerAncestor && interactiveAncestor !== element && !strongNativeField) {
        preserve(element, 'aria-label');
        element.setAttribute('aria-label', '__avery_internal_form_control__');
        element.setAttribute('data-avery-form-semantic', 'auxiliary');
        auxiliary += 1;
        continue;
      }
      const directLabel = rawExplicitLabel(element);
      const label = directLabel ? canonicalLabel(directLabel) || directLabel : canonicalLabel(currentName) || explicitLabel(element) || nearbyLabel(element);
      if (!label) continue;
      preserve(element, 'aria-label');
      element.setAttribute('aria-label', encodedName(element, label));
      element.setAttribute('data-avery-form-semantic', 'label');
      element.setAttribute('data-avery-form-key', canonicalKey(label));
      annotated += 1;
    }
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
        && rect.width > 0 && rect.height > 0;
    };
    const decoratedTriggers = new WeakSet();
    const decoratedContainers = new WeakMap();
    let customSelects = 0;
    // 飞书 ATS 的年月范围由两个 div 承载，隐藏 input 仅用于焦点；分别暴露两端，禁止把整段范围当作文本框。
    for (const range of document.querySelectorAll(dateAdapters.feishu.range)) {
      if (!(range instanceof HTMLElement) || !visible(range)) continue;
      if (dateAdapterFor(range) !== 'feishu') continue;
      const edges = [...range.children].filter((element) => element.matches(dateAdapters.feishu.rangeEdge));
      if (edges.length !== 2) continue;
      for (const [index, trigger] of edges.entries()) {
        if (dateAdapterFor(trigger) !== 'feishu') continue;
        const label = index === 0 ? '开始时间' : '结束时间';
        preserve(trigger, 'aria-label');
        preserve(trigger, 'role');
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-label', encodedName(trigger, label, true));
        trigger.setAttribute('data-avery-form-semantic', 'custom-select');
        trigger.setAttribute('data-avery-form-key', index === 0 ? 'startDate' : 'endDate');
        trigger.setAttribute('data-avery-form-section', contextOf(trigger).s);
        trigger.setAttribute('data-avery-form-label', label);
        decoratedTriggers.add(trigger);
        customSelects += 1;
      }
    }
    const seeds = document.querySelectorAll('[role="combobox"],[aria-haspopup="listbox"],[class*="select" i],[class*="cascader" i],[class*="picker" i],[class*="dropdown" i]');
    for (const seed of seeds) {
      if (!(seed instanceof HTMLElement) || !visible(seed)) continue;
      // Moka 的账号菜单与招聘导航位于申请区块外，不能按附近文字推断成“职位”等待填字段。
      if (mokaFormOnly && !seed.closest(dateAdapters.moka.block)) { mokaAuxiliary(seed); continue; }
      if (dateAdapterFor(seed) === 'moka' && seed.closest(dateAdapters.moka.field)) continue;
      // 日期弹层中的年月选项不是申请表字段；否则每个年份都会触发整张表单的语义推断。
      if (seed.closest(dateAdapters.feishu.popup)) continue;
      if (seed.hasAttribute('data-avery-form-semantic')) continue;
      if (seed.closest('.atsx-select,.atsx-select-dropdown') || seed.querySelector('.atsx-select')) continue;
      if (seed.closest('nav,header,footer,[role="navigation"]')) {
        preserve(seed, 'aria-label');
        seed.setAttribute('aria-label', '__avery_internal_form_control__');
        seed.setAttribute('data-avery-form-semantic', 'auxiliary');
        auxiliary += 1;
        continue;
      }
      const seedText = normalize(text(seed));
      const seedMarker = String(seed.className || '').toLowerCase();
      const hasCustomSemantics = seed.getAttribute('role') === 'combobox' || seed.getAttribute('aria-haspopup') === 'listbox'
        || /(^|[-_\\s])(select|selector|cascader|picker|dropdown)([-_\\s]|$)/.test(seedMarker);
      if (!seedText || seedText.length > 80 || (seedText !== '请选择' && !hasCustomSemantics)) continue;
      let trigger = seed;
      for (let depth = 0; trigger.parentElement && depth < 4; depth += 1) {
        const parent = trigger.parentElement;
        const marker = String(parent.className || '').toLowerCase();
        if (normalize(text(parent)) !== seedText) break;
        if (parent.getAttribute('role') === 'combobox' || parent.getAttribute('aria-haspopup') === 'listbox'
          || /(^|[-_\\s])(select|selector|cascader|picker|dropdown)([-_\\s]|$)/.test(marker)) trigger = parent;
        else break;
      }
      if (['input', 'textarea', 'select'].includes(trigger.tagName.toLowerCase())) continue;
      // 多个嵌套 seed 可指向同一触发器；不能覆盖第一次备份，否则清理会恢复成编码标签。
      if (trigger.hasAttribute('data-avery-form-semantic')) continue;
      if (decoratedTriggers.has(trigger)) continue;
      const directLabel = rawExplicitLabel(trigger);
      const label = directLabel ? canonicalLabel(directLabel) || directLabel : explicitLabel(trigger) || nearbyLabel(trigger);
      if (!label) continue;
      const container = trigger.closest('label,[class*="form-item" i],[class*="formitem" i],[class*="field" i]') || trigger;
      const containerLabels = decoratedContainers.get(container) || new Set();
      const normalizedLabel = normalize(label);
      if (containerLabels.has(normalizedLabel)) continue;
      containerLabels.add(normalizedLabel);
      decoratedContainers.set(container, containerLabels);
      preserve(trigger, 'aria-label');
      preserve(trigger, 'role');
      trigger.setAttribute('role', 'combobox');
      trigger.setAttribute('aria-label', encodedName(trigger, label));
      trigger.setAttribute('data-avery-form-semantic', 'custom-select');
      trigger.setAttribute('data-avery-form-key', canonicalKey(label));
      trigger.setAttribute('data-avery-form-section', /毕业时间/.test(label) ? 'education' : contextOf(trigger).s);
      trigger.setAttribute('data-avery-form-label', label);
      decoratedTriggers.add(trigger);
      customSelects += 1;
    }
    return { annotated, auxiliary, customSelects, ats, dateAdapters: matchedAdapters };
  })()`;
})();

/** 恢复 Inspect 临时写入的可访问性属性；旧版本遗留标记也在下次 Inspect 时一并清理。 */
export const FormSemanticCleanupExpression = `(() => {
  let cleaned = 0;
  for (const element of document.querySelectorAll('[data-avery-form-semantic]')) {
    if (!(element instanceof HTMLElement)) continue;
    for (const attribute of ['aria-label', 'role']) {
      const suffix = attribute === 'aria-label' ? 'aria-label' : 'role';
      const had = element.getAttribute('data-avery-had-' + suffix);
      const original = element.getAttribute('data-avery-original-' + suffix);
      if (had === '1') element.setAttribute(attribute, original || '');
      else if (had === '0'
        || (had === null && attribute === 'aria-label')
        || (had === null && attribute === 'role' && element.getAttribute('data-avery-form-semantic') === 'custom-select')) element.removeAttribute(attribute);
      element.removeAttribute('data-avery-had-' + suffix);
      element.removeAttribute('data-avery-original-' + suffix);
    }
    element.removeAttribute('data-avery-form-semantic');
    element.removeAttribute('data-avery-form-key');
    element.removeAttribute('data-avery-form-section');
    element.removeAttribute('data-avery-form-label');
    element.removeAttribute('data-avery-form-record');
    cleaned += 1;
  }
  return { cleaned };
})()`;

/** 将当前日期浮层的编辑器、年/月/日与确认动作临时编码为稳定语义，不读取或返回日期值。 */
export const DateEditorEnrichmentExpression = `(() => {
  ${BrowserDateAdapterSelectionScript}
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const text = (element) => String(element?.innerText || element?.textContent || '').replace(/\\s+/g, '').trim();
  const roots = new Set([...document.querySelectorAll('[class*="calendar" i],[class*="datepicker" i],[class*="date-picker" i],[class*="month-picker" i],[role="dialog"]')]
    .filter((element) => element instanceof HTMLElement && visible(element)
      && dateAdapterFor(element) !== 'feishu'
      && (element.querySelector('[role="grid"],[role="gridcell"],[class*="year-panel" i],[class*="month-panel" i]') || element.matches('[class*="calendar" i]'))));
  // 哈希类名日期浮层：定位层中同时出现年份或月份动作时才纳入，避免扫描表单正文。
  for (const root of document.querySelectorAll('body *')) {
    if (!(root instanceof HTMLElement) || !visible(root)) continue;
    const position = getComputedStyle(root).position;
    if (!['absolute', 'fixed'].includes(position)) continue;
    if (dateAdapterFor(root) === 'feishu') continue;
    const labels = [...root.querySelectorAll('[role="button"],[role="gridcell"],button,a')].slice(0, 200).map(text);
    if (labels.some((label) => /^\\d{4}年?$/.test(label))
      && labels.some((label) => /^(?:\\d{1,2}|[一二三四五六七八九十]{1,3})月$/.test(label))) roots.add(root);
  }
  const preserve = (element) => {
    if (element.hasAttribute('data-avery-date-editor')) return false;
    element.setAttribute('data-avery-date-editor', '1');
    element.setAttribute('data-avery-date-original-label', element.getAttribute('aria-label') || '');
    element.setAttribute('data-avery-date-had-label', element.hasAttribute('aria-label') ? '1' : '0');
    element.setAttribute('data-avery-date-original-role', element.getAttribute('role') || '');
    element.setAttribute('data-avery-date-had-role', element.hasAttribute('role') ? '1' : '0');
    return true;
  };
  const annotate = (element, role, label) => {
    if (!(element instanceof HTMLElement) || !visible(element) || !preserve(element)) return false;
    element.setAttribute('role', role);
    element.setAttribute('aria-label', label);
    return true;
  };
  const monthNumber = (label) => {
    const numeric = label.match(/^(\\d{1,2})月$/);
    if (numeric) return Number(numeric[1]);
    const chinese = { 一月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6, 七月: 7, 八月: 8, 九月: 9, 十月: 10, 十一月: 11, 十二月: 12 };
    if (chinese[label]) return chinese[label];
    const english = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const index = english.findIndex((value) => label.toLowerCase().startsWith(value));
    return index < 0 ? undefined : index + 1;
  };
  let annotated = 0;
  // 飞书年月面板是年、月两个滚动列表，选中月份即提交，不应继续等待日网格或确认按钮。
  ${MokaDateControlsScript}
  for (const panel of document.querySelectorAll(dateAdapters.feishu.monthPanel)) {
    if (!(panel instanceof HTMLElement) || !visible(panel)) continue;
    if (dateAdapterFor(panel) !== 'feishu') continue;
    if (annotate(panel, 'group', '__avery_date_month_only__')) annotated += 1;
    for (const item of panel.querySelectorAll(dateAdapters.feishu.option)) {
      if (dateAdapterFor(item) !== 'feishu') continue;
      if (item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled') || /disabled/i.test(String(item.className))) continue;
      const label = text(item);
      const prefix = /^\\d{4}$/.test(label) ? '__avery_date_year_option__:' : /^0?[1-9]$|^1[0-2]$/.test(label) ? '__avery_date_month_option__:' : '';
      if (prefix && annotate(item, 'option', prefix + Number(label))) annotated += 1;
    }
  }
  for (const root of roots) {
    for (const input of root.querySelectorAll('input')) {
      if (['feishu', 'moka'].includes(dateAdapterFor(input))) continue;
      // Phoenix 的 unText input 只是选择器的事件入口，直接 fill 会被组件判为无效并保持弹层打开。
      // 将它交给后面的年/月/日点选状态机，避免先做一轮必然失败的写入与提交轮询。
      if ((dateAdapterFor(input) === 'beisen' && input.matches(dateAdapters.beisen.auxiliaryInput)) || input.readOnly || input.type === 'hidden') continue;
      if (annotate(input, 'textbox', '__avery_date_editor__')) annotated += 1;
    }
    const candidates = root.querySelectorAll('[role="button"],[role="gridcell"],button,a,select,[class*="year-select" i],[class*="month-select" i]');
    for (const element of [...candidates].slice(0, 500)) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      if (['feishu', 'moka'].includes(dateAdapterFor(element))) continue;
      // Phoenix 把文字 a 放在可点击 td 内；只标记事件实际绑定的 gridcell，避免同一动作产生两个 ref。
      const containingCell = element.closest('[role="gridcell"],[data-avery-date-original-role="gridcell"]');
      if (containingCell && containingCell !== element) continue;
      const beisen = dateAdapterFor(element) === 'beisen';
      const monthOnlyCalendar = beisen && Boolean(element.closest(dateAdapters.beisen.monthCalendar));
      // 月选择器同时渲染通用日历头和月面板头；前者不会驱动当前月面板，不能作为年份入口。
      if (monthOnlyCalendar && element.matches(dateAdapters.beisen.calendarHeaders)) continue;
      // 年份按钮的文字 span 也会命中 class*=year-select；只标记实际绑定点击行为的父按钮。
      const monthPanelYearButton = beisen ? element.closest(dateAdapters.beisen.monthYearButton) : null;
      if (monthPanelYearButton && monthPanelYearButton !== element) continue;
      const monthPanelYear = beisen && element.matches(dateAdapters.beisen.monthYearButton)
        ? text(element.querySelector(dateAdapters.beisen.monthYearText))
        : '';
      const label = monthPanelYear || text(element);
      const marker = String(element.className || '').toLowerCase();
      const inYearPanel = Boolean(element.closest('[class*="year-panel" i]'));
      const inMonthPanel = Boolean(element.closest('[class*="month-panel" i]'));
      const disabled = element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled')
        || /(^|[-_\\s])disabled([-_\\s]|$)/i.test(marker);
      if (disabled) continue;
      if (/^\\d{4}年?$/.test(label)) {
        const year = label.match(/\\d{4}/)?.[0];
        const option = inYearPanel || element.getAttribute('role') === 'gridcell';
        const headerPrefix = monthOnlyCalendar ? '__avery_date_month_year_header__:' : '__avery_date_year_header__:';
        if (year && annotate(element, option ? 'option' : 'button', option ? '__avery_date_year_option__:' + year : headerPrefix + year)) annotated += 1;
        continue;
      }
      const month = monthNumber(label);
      if (month && (inMonthPanel || /month/.test(marker))) {
        const header = /month-select/.test(marker) && !inMonthPanel;
        if (annotate(element, header ? 'button' : 'option', header ? '__avery_date_month_header__:' + month : '__avery_date_month_option__:' + month)) annotated += 1;
        continue;
      }
      if (/^\\d{1,2}日?$/.test(label) && element.getAttribute('role') === 'gridcell'
        && !inYearPanel && !inMonthPanel && !/(last|next).*(month)|month.*(last|next)/i.test(marker)) {
        const day = Number(label.replace(/\\D/g, ''));
        if (day >= 1 && day <= 31 && annotate(element, 'option', '__avery_date_day_option__:' + day)) annotated += 1;
        continue;
      }
      if (/^(确定|确认|完成|ok)$/i.test(label) && annotate(element, 'button', '__avery_date_confirmation__')) annotated += 1;
    }
  }
  return { found: annotated > 0, annotated, ats, dateAdapters: matchedAdapters };
})()`;

export const DateEditorCleanupExpression = `(() => {
  for (const element of document.querySelectorAll('[data-avery-date-editor]')) {
    if (element.getAttribute('data-avery-date-had-label') === '1') element.setAttribute('aria-label', element.getAttribute('data-avery-date-original-label') || '');
    else element.removeAttribute('aria-label');
    if (element.getAttribute('data-avery-date-had-role') === '1') element.setAttribute('role', element.getAttribute('data-avery-date-original-role') || '');
    else element.removeAttribute('role');
    element.removeAttribute('data-avery-date-editor');
    element.removeAttribute('data-avery-date-original-label');
    element.removeAttribute('data-avery-date-had-label');
    element.removeAttribute('data-avery-date-original-role');
    element.removeAttribute('data-avery-date-had-role');
  }
  return { cleaned: true };
})()`;

/** 将门户式下拉/级联弹层中的真实可见条目临时暴露为 option，供原生 ref 点击。 */
export function DynamicOptionEnrichmentFor(onlyMoka = false): string { return `(() => {
  const onlyMoka = ${JSON.stringify(onlyMoka)};
  const mokaMenu = ${JSON.stringify(BrowserDateAdapters.moka.menu)};
  const mokaScope = ${JSON.stringify(BrowserDateAdapters.moka.block + ',' + BrowserDateAdapters.moka.menu)};
  const mokaRelated = (element) => Boolean(element.closest(mokaScope) || element.querySelector(mokaScope));
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const roots = new Set([...document.querySelectorAll('[role="listbox"],[role="menu"],[class*="select-dropdown" i],[class*="dropdown-menu" i],[class*="cascader-menu" i],[class*="picker-panel" i],[class*="popup" i],[class*="popover" i],[class*="area-selector-container" i],[class*="constant-main-selector-container" i],[class*="constant-main-layer-container" i]')]
    .filter((element) => !onlyMoka && element instanceof HTMLElement && visible(element) && !mokaRelated(element)));
  // 部分招聘站使用哈希类名和无 ARIA 的门户浮层；只把当前可见的定位层纳入候选范围，避免扫描整页正文。
  for (const element of [...document.body.querySelectorAll('*')].slice(0, 5000)) {
    if (onlyMoka) break;
    if (!(element instanceof HTMLElement) || !visible(element) || mokaRelated(element)) continue;
    const style = getComputedStyle(element);
    if (style.position !== 'absolute' && style.position !== 'fixed') continue;
    const text = String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text && text.length <= 5000 && element.querySelector('li,[role="option"],[role="menuitem"],[role="treeitem"],[class*="option" i],[class*="menu-item" i],[class*="area-item" i]')) roots.add(element);
  }
  // React/Vue 的 portal 根节点本身可能是 static；由实际候选节点向上寻找最小可见控件根，不能只依赖定位样式。
  for (const seed of document.querySelectorAll('[class*="area-item-container" i],[class*="area-text-label" i],[class*="list-item-container" i],[class*="item-text-label" i],[role="option"],[role="treeitem"],[class*="menu-item" i],[class*="option" i]')) {
    if (onlyMoka) break;
    if (!(seed instanceof HTMLElement) || !visible(seed) || mokaRelated(seed)) continue;
    let root = seed.parentElement;
    for (let depth = 0; root?.parentElement && depth < 8; depth += 1, root = root.parentElement) {
      if (root.matches('[class*="area-selector-container" i],[class*="constant-main-selector-container" i],[role="listbox"],[role="menu"],[class*="dropdown" i],[class*="popup" i],[class*="popover" i]')) break;
      if (root.querySelectorAll('[class*="area-item-container" i],[role="option"],[role="treeitem"],[class*="menu-item" i],[class*="option" i]').length > 300) break;
    }
    if (root instanceof HTMLElement && visible(root) && !mokaRelated(root) && !['BODY', 'HTML'].includes(root.tagName)) roots.add(root);
  }
  const candidateText = new Map();
  const confirmations = new Set();
  ${MokaOptionEnrichmentScript}
  for (const root of roots) {
    // Moka 只使用已确认的候选行，不能再用通用扫描覆盖其标签或纳入“添加自定义值”。
    if (root.matches(mokaMenu)) continue;
    // 表单容器和导航不能冒充弹层，否则会把“首页”“提交”等误当作目标字段候选。
    if (root.closest('nav,header,footer,[role="navigation"]') || root.querySelector('[data-avery-form-semantic="label"],[data-avery-form-semantic="custom-select"]')) continue;
    // 北森民族等常量选择器采用虚拟列表；目标项未渲染时，后续可通过这个固定搜索入口收窄列表。
    for (const element of root.querySelectorAll('input[placeholder*="搜索"],input[placeholder*="search" i]')) {
      if (!(element instanceof HTMLInputElement) || !visible(element) || element.hasAttribute('data-avery-dynamic-search')) continue;
      element.setAttribute('data-avery-dynamic-search', '1');
      element.setAttribute('data-avery-option-had-role', element.hasAttribute('role') ? '1' : '0');
      element.setAttribute('data-avery-option-role', element.getAttribute('role') || '');
      element.setAttribute('data-avery-option-had-label', element.hasAttribute('aria-label') ? '1' : '0');
      element.setAttribute('data-avery-option-label', element.getAttribute('aria-label') || '');
      element.setAttribute('data-avery-option-had-tabindex', element.hasAttribute('tabindex') ? '1' : '0');
      element.setAttribute('data-avery-option-tabindex', element.getAttribute('tabindex') || '');
      element.setAttribute('role', 'textbox');
      element.setAttribute('aria-label', '__avery_dynamic_search__');
    }
    const elements = root.querySelectorAll('[role="option"],[role="menuitem"],[role="treeitem"],li,button,[tabindex],div,span,[class*="option" i],[class*="menu-item" i],[class*="menuitem" i],[class*="cascader-item" i]');
    for (const element of [...elements].slice(0, 500)) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const text = String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length > 80 || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled')) continue;
      const role = element.getAttribute('role');
      const regionRow = (element.matches('[class*="area-item-container" i]')
          && Boolean(element.querySelector('[class*="area-item-name" i],[class*="icon-container" i]')))
        || (element.matches('[class*="area-item-name" i]')
          && Boolean(element.parentElement?.matches('[class*="area-item-container" i]')))
        || element.matches('[class*="area-text-label" i]');
      // 北森文字 span 的无障碍 ref 点击坐标不稳定；使用它的 area-item-name 父节点承载同一导航动作。
      if (element.matches('[class*="area-text-label" i]')
        && element.parentElement?.matches('[class*="area-item-name" i]')) continue;
      const interactive = element.tagName === 'LI' || element.tagName === 'BUTTON'
        || role === 'option' || role === 'menuitem' || role === 'treeitem'
        || element.hasAttribute('tabindex') || typeof element.onclick === 'function'
        || getComputedStyle(element).cursor === 'pointer' || regionRow;
      if (interactive) candidateText.set(element, text);
    }
    // 地区选择器常把“继续展开”和“选中当前项”拆成文字与无文本单选图标；为后者补上同级文字。
    for (const element of [...root.querySelectorAll('[role="radio"],input[type="radio"],[class*="radio" i],[class*="icon-container" i]')].slice(0, 300)) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      if (String(element.innerText || element.textContent || '').trim()) continue;
      const container = element.closest('[class*="item" i],li');
      const label = String(container?.innerText || container?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 80) continue;
      candidateText.set(element, label);
    }
    for (const element of [...root.querySelectorAll('button,div,span')].slice(0, 500)) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const label = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const disabled = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
        || /(^|[-_\s])(disabled|disable)([-_\s]|$)/i.test(String(element.className || ''));
      if (!disabled && /^(确定|确认|完成)$/.test(label)) {
        candidateText.set(element, label);
        confirmations.add(element);
      }
    }
  }
  const rawCandidates = [...candidateText].map(([element, text]) => ({
    element,
    text,
    selectionControl: !confirmations.has(element) && !String(element.innerText || element.textContent || '').trim(),
  }));
  // 容器和内部文字节点可能同时可点击；地区文字行和无文本单选图标用途不同，必须同时保留。
  const candidates = rawCandidates.filter((candidate, index) => !rawCandidates.some((other, otherIndex) => (
    otherIndex !== index && candidate.element.contains(other.element) && candidate.text === other.text
      && !(other.selectionControl && !candidate.selectionControl)
  )));
  let annotated = 0;
  for (const { element, text, selectionControl } of candidates.slice(0, 300)) {
    element.setAttribute('data-avery-dynamic-option', '1');
    element.setAttribute('data-avery-option-had-role', element.hasAttribute('role') ? '1' : '0');
    element.setAttribute('data-avery-option-role', element.getAttribute('role') || '');
    element.setAttribute('data-avery-option-had-label', element.hasAttribute('aria-label') ? '1' : '0');
    element.setAttribute('data-avery-option-label', element.getAttribute('aria-label') || '');
    element.setAttribute('data-avery-option-had-tabindex', element.hasAttribute('tabindex') ? '1' : '0');
    element.setAttribute('data-avery-option-tabindex', element.getAttribute('tabindex') || '');
    const confirmation = confirmations.has(element);
    // Phoenix Select 会把嵌套 option 从无障碍树折叠为空名称 listitem；button + tabindex 可稳定保留候选名称和 ref。
    element.setAttribute('role', confirmation || !selectionControl ? 'button' : 'radio');
    element.setAttribute('tabindex', '0');
    element.setAttribute('aria-label', confirmation ? '__avery_dynamic_confirmation__' : text.slice(0, 120));
    annotated += 1;
  }
  const observed = [...new Set(candidates.filter(candidate => !confirmations.has(candidate.element)).map(candidate => candidate.text.slice(0,120)))];
  return { roots: roots.size, annotated, observedOptions:observed.slice(0,40), optionsTruncated:observed.length>40 };
})()`; }

export const DynamicOptionEnrichmentExpression = DynamicOptionEnrichmentFor();

export const DynamicOptionCleanupExpression = `(() => {
  for (const element of document.querySelectorAll('[data-avery-dynamic-option],[data-avery-dynamic-search]')) {
    if (element.getAttribute('data-avery-option-had-role') === '1') element.setAttribute('role', element.getAttribute('data-avery-option-role') || '');
    else element.removeAttribute('role');
    if (element.getAttribute('data-avery-option-had-label') === '1') element.setAttribute('aria-label', element.getAttribute('data-avery-option-label') || '');
    else element.removeAttribute('aria-label');
    if (element.getAttribute('data-avery-option-had-tabindex') === '1') element.setAttribute('tabindex', element.getAttribute('data-avery-option-tabindex') || '');
    else element.removeAttribute('tabindex');
    for (const attribute of ['data-avery-dynamic-option', 'data-avery-dynamic-search', 'data-avery-option-had-role', 'data-avery-option-role', 'data-avery-option-had-label', 'data-avery-option-label', 'data-avery-option-had-tabindex', 'data-avery-option-tabindex']) element.removeAttribute(attribute);
  }
  return { cleaned: true };
})()`;

/** 读取已由候选检查器标记的可见项；不能把整页按钮、正文或搜索词当成选项回传。 */
export const DynamicOptionObservationExpression = `(() => {
  const labels = [];
  for (const element of document.querySelectorAll('[data-avery-dynamic-option]')) {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
    const label = String(element.getAttribute('aria-label') || element.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!label || label.startsWith('__avery_') || /^(确定|确认|完成|取消|关闭)$/.test(label) || labels.includes(label)) continue;
    labels.push(label.slice(0, 120));
    if (labels.length > 40) break;
  }
  return { observedOptions: labels.slice(0, 40), optionsTruncated: labels.length > 40 };
})()`;

/** 只向页面根节点发送取消交互事件；不会点击按钮、提交表单或修改字段值。 */
export const DismissTransientOverlayExpression = `(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const root = document.documentElement;
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) root.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
  return { dismissed: true };
})()`;

export function DynamicOptionMatch(
  data: Record<string, any>,
  fieldKey: string,
  desiredValue: string,
  visitedActions: Set<string>,
  exactOnly = false,
): { ref: string; label: string; complete: boolean; role: string; actionKey: string } | undefined {
  const refs = data?.refs && typeof data.refs === 'object' ? data.refs as Record<string, Record<string, unknown>> : {};
  const clickable = new Set<string>();
  const snapshot = String(data?.snapshot ?? '');
  for (const match of snapshot.matchAll(/\[[^\]\r\n]*\bref=(e\d+)\b[^\]\r\n]*\][^\r\n]*\bclickable\b/g)) clickable.add(match[1]);
  const normalizeOption = (value: unknown) => {
    const normalized = NormalizeFormOption(fieldKey, value);
    if (fieldKey === 'workYears') {
      if (/^(在校学生|在读学生|学生)$/.test(normalized)) return 'student';
      if (/^(刚毕业|应届毕业生|应届生)$/.test(normalized)) return 'graduate';
    }
    if (fieldKey === 'degree' && normalized === '本科') return '学士';
    // 档案可能保存“汉”，而招聘站枚举通常展示“汉族”；仅去掉末尾族字，不做宽泛模糊匹配。
    if (fieldKey === 'ethnicity') return normalized.replace(/族$/, '');
    return normalized;
  };
  const desired = normalizeOption(desiredValue);
  const regionField = ['nativePlace', 'residence', 'hukou', 'targetProvince', 'targetCity'].includes(fieldKey);
  const geographic = (value: string) => value.replace(/特别行政区|自治区|省|市|区|县|[\/><>,，]/g, '');
  const desiredGeographic = geographic(desired);
  const candidates: Array<{ ref: string; label: string; score: number; complete: boolean; role: string; actionKey: string }> = [];
  for (const [rawRef, metadata] of Object.entries(refs)) {
    const role = String(metadata?.role ?? '').toLowerCase();
    const label = String(metadata?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const normalized = normalizeOption(label);
    if (!normalized || normalized.length > 80 || /^(请选择|请输入|确定|取消|关闭)$/.test(normalized)) continue;
    // 这些枚举只接受确切同义项，不能把“非全日制”或不同周期凭子串相似选中。
    if (['educationType', 'availability'].includes(fieldKey) && normalized !== desired) continue;
    if (exactOnly && normalized !== desired) continue;
    // 浏览器快照可能沿用标记前的可访问性角色，因此已补为 option 的原生 li 仍会回报 listitem。
    if (!clickable.has(rawRef.replace(/^@/, '')) && !['button', 'option', 'listitem', 'menuitem', 'treeitem', 'radio'].includes(role)) continue;
    const actionKey = `${role}:${normalized}`;
    if (visitedActions.has(actionKey)) continue;
    const normalizedGeographic = geographic(normalized);
    let score = 0;
    let complete = false;
    if (normalized === desired) { score = 100; complete = true; }
    else if (regionField && normalizedGeographic && normalizedGeographic === desiredGeographic) { score = 95; complete = true; }
    else if (regionField && normalizedGeographic.length >= 2 && desiredGeographic.endsWith(normalizedGeographic)) { score = 90; complete = true; }
    else if (normalized.length >= 2 && desired.includes(normalized)) score = 85;
    else if (regionField && normalizedGeographic.length >= 2 && desiredGeographic.includes(normalizedGeographic)) score = 75;
    else if (desired.length >= 2 && normalized.includes(desired)) { score = 65; complete = true; }
    // 北森地区级联的中间层圆点只会选中当前级，不能展开下一级；仅允许在目标末级使用。
    if (score && !(regionField && role === 'radio' && !complete)) {
      candidates.push({ ref: `@${rawRef.replace(/^@/, '')}`, label, score, complete, role, actionKey });
    }
  }
  // 北森同时暴露文字行和旁侧圆点。文字行承担级联导航和末级选择，圆点只是辅助选中态；
  // 优先点击文字可避免停在省级或命中尺寸过小、易重建的图标节点。
  const actionPriority = (candidate: typeof candidates[number]) => candidate.role === 'radio' ? 0 : 2;
  candidates.sort((left, right) => right.score - left.score
    || actionPriority(right) - actionPriority(left)
    || left.label.length - right.label.length);
  if (!candidates.length) return undefined;
  const best = candidates[0];
  const tied = candidates.find((candidate) => candidate.score === best.score && NormalizeFormLabel(candidate.label) !== NormalizeFormLabel(best.label));
  return tied ? undefined : best;
}

export function DynamicSearchMatch(data: Record<string, any>): { ref: string } | undefined {
  const refs = data?.refs && typeof data.refs === 'object' ? data.refs as Record<string, Record<string, unknown>> : {};
  const matches = Object.entries(refs).flatMap(([rawRef, metadata]) => {
    const role = String(metadata?.role ?? '').toLowerCase();
    const label = String(metadata?.name ?? '').replace(/\s+/g, ' ').trim();
    return role === 'textbox' && label === '__avery_dynamic_search__'
      ? [{ ref: `@${rawRef.replace(/^@/, '')}` }]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function MatchingDynamicFormFields(fields: FormField[], operation: FormFillOperation): FormField[] {
  const dynamic = fields.filter((field) => field.control === 'select' && !field.options?.length);
  const semantic = dynamic.filter((field) => field.semantic.concept === operation.concept);
  if (operation.targetOccurrence !== undefined) {
    return semantic.filter((field) => NormalizeFormLabel(field.label) === NormalizeFormLabel(operation.label)
      && (operation.targetRecordIndex === undefined || field.context.recordIndex === operation.targetRecordIndex));
  }
  return semantic.length ? semantic : dynamic.filter((field) => CanonicalFormField(field.label) === operation.key);
}

function DynamicFormTarget(fields: FormField[], operation: FormFillOperation): FormField | undefined {
  const matches = MatchingDynamicFormFields(fields, operation);
  if (operation.targetRecordIndex !== undefined) return matches.length === 1 ? matches[0] : undefined;
  return operation.targetOccurrence === undefined ? matches[operation.occurrence] ?? matches[0] : matches[operation.targetOccurrence];
}

export function DynamicConfirmationMatch(data: Record<string, any>): { ref: string; label: string } | undefined {
  const refs = data?.refs && typeof data.refs === 'object' ? data.refs as Record<string, Record<string, unknown>> : {};
  const clickable = new Set<string>();
  const snapshot = String(data?.snapshot ?? '');
  for (const match of snapshot.matchAll(/\[[^\]\r\n]*\bref=(e\d+)\b[^\]\r\n]*\][^\r\n]*\bclickable\b/g)) clickable.add(match[1]);
  const matches = Object.entries(refs).flatMap(([rawRef, metadata]) => {
    const label = String(metadata?.name ?? '').replace(/\s+/g, ' ').trim();
    const role = String(metadata?.role ?? '').toLowerCase();
    if (label !== '__avery_dynamic_confirmation__' && !/^(确定|确认|完成)$/.test(label)) return [];
    if (!clickable.has(rawRef.replace(/^@/, '')) && !['button', 'option', 'listitem', 'menuitem'].includes(role)) return [];
    return [{ ref: `@${rawRef.replace(/^@/, '')}`, label }];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

type DateTarget = { year: number; month: number; day?: number };

export function ParseDateTarget(value: string): DateTarget | undefined {
  const match = value.trim().match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : undefined;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || (day !== undefined && (day < 1 || day > 31))) return undefined;
  return { year, month, ...(day === undefined ? {} : { day }) };
}

export function DynamicDateRef(
  data: Record<string, any>,
  predicate: (label: string, role: string) => boolean,
): { ref: string; label: string; role: string } | undefined {
  const refs = data?.refs && typeof data.refs === 'object' ? data.refs as Record<string, Record<string, unknown>> : {};
  const clickable = new Set<string>();
  const snapshot = String(data?.snapshot ?? '');
  for (const match of snapshot.matchAll(/\[[^\]\r\n]*\bref=(e\d+)\b[^\]\r\n]*\][^\r\n]*\bclickable\b/g)) clickable.add(match[1]);
  const matches = Object.entries(refs).flatMap(([rawRef, metadata]) => {
    const role = String(metadata?.role ?? '').toLowerCase();
    const label = String(metadata?.name ?? '').replace(/\s+/g, '').trim();
    if (!predicate(label, role)) return [];
    if (!clickable.has(rawRef.replace(/^@/, '')) && !['button', 'gridcell', 'option', 'listitem'].includes(role)) return [];
    return [{ ref: `@${rawRef.replace(/^@/, '')}`, label, role }];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function DynamicSelectionVerificationExpression(operation: FormFillOperation, selectedLabels: string[]): string {
  const selected = selectedLabels.map(NormalizeFormLabel).filter(Boolean);
  return `(() => {
    ${MokaFormValueScript}
    ${FeishuSelectValueScript}
    const normalize = (value) => String(value || '').toLowerCase().replace(/[\\s_\\-—–·:：()（）[\\]【】*＊]/g, '');
    const triggers = [...document.querySelectorAll('[data-avery-form-semantic="custom-select"]')]
      .filter((element) => element.getAttribute('data-avery-form-key') === ${JSON.stringify(operation.key)});
    if (${operation.adapter === 'feishu'}) {
      const identity = ${JSON.stringify(operation.targetNodeIdentity)};
      const target = typeof identity === 'string' && identity ? triggers.find(element => window.__averyFormIdentities?.nodes.get(element) === identity) : undefined;
      const value = target && feishuSelectedValue(target);
      return {filled: value !== undefined && normalize(value) === normalize(${JSON.stringify(operation.value)})};
    }
    if (${JSON.stringify(operation.adapter === 'moka' && operation.targetOccurrence !== undefined)}) {
      const candidates = triggers.filter((element) => element.getAttribute('data-avery-form-section') === ${JSON.stringify(operation.concept.split('.')[0])}
        && normalize(element.getAttribute('data-avery-form-label')) === normalize(${JSON.stringify(operation.label)})
        && (${operation.targetRecordIndex === undefined} || element.getAttribute('data-avery-form-record') === ${JSON.stringify(String(operation.targetRecordIndex))}));
      const target = candidates[${operation.targetRecordIndex === undefined ? operation.targetOccurrence ?? 0 : 0}];
      if (!(target instanceof HTMLElement)) return { filled: false };
      if (${operation.kind === 'custom_date'}) {
        const parse = (value) => String(value || '').match(/^(\\d{4})[-/.年](\\d{1,2})(?:[-/.月](\\d{1,2}))?[月日]?$/);
        const actual = parse(mokaSelectedValue(target)), desired = parse(${JSON.stringify(operation.value)});
        return { filled: Boolean(actual && desired && Number(actual[1]) === Number(desired[1]) && Number(actual[2]) === Number(desired[2])) };
      }
      return { filled: normalize(mokaSelectedValue(target)) === normalize(${JSON.stringify(operation.value)}) };
    }
    // 日期只比较本次字段的真实值；禁止从另一端、相邻经历或仍打开的日历文本中借用目标日期。
    if (${JSON.stringify(operation.kind === 'custom_date' && operation.targetOccurrence !== undefined)}) {
      const candidates = triggers.filter((element) => element.getAttribute('data-avery-form-section') === ${JSON.stringify(operation.concept.split('.')[0])}
        && normalize(element.getAttribute('data-avery-form-label')) === normalize(${JSON.stringify(operation.label)}));
      const target = candidates[${operation.targetOccurrence ?? 0}];
      if (!(target instanceof HTMLElement)) return { filled: false };
      const input = target.querySelector('input');
      const value = target.matches(${JSON.stringify(BrowserDateAdapters.feishu.rangeEdge)}) ? target.textContent : input?.value;
      const parse = (raw) => String(raw || '').trim().match(/^(\\d{4})[-/.年](\\d{1,2})(?:[-/.月](\\d{1,2}))?[月日]?$/);
      const desired = parse(${JSON.stringify(operation.value)});
      const actual = parse(value);
      return { filled: Boolean(desired && actual && Number(desired[1]) === Number(actual[1])
        && Number(desired[2]) === Number(actual[2]) && (!desired[3] || Number(desired[3]) === Number(actual[3]))) };
    }
    const trigger = triggers[${operation.occurrence}] || triggers[0];
    if (!(trigger instanceof HTMLElement)) return { filled: false };
    const visibleControls = (root) => [...root.querySelectorAll('input,textarea,select,[role="combobox"],[aria-haspopup="listbox"]')]
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }).length;
    let displayRoot = trigger;
    for (let current = trigger; current?.parentElement; current = current.parentElement) {
      if (['BODY', 'HTML'].includes(current.tagName)) break;
      if (visibleControls(current) > 4) break;
      displayRoot = current;
      if (current.matches('label,[class*="form-item" i],[class*="formitem" i],[class*="field" i]')) break;
    }
    const inputValues = [...displayRoot.querySelectorAll('input,textarea')]
      .map((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '')
      .join(' ');
    const selectedState = [...displayRoot.querySelectorAll('[aria-selected="true"],[aria-checked="true"],input:checked,[class*="selected" i],[class*="checked" i]')]
      .map((element) => element instanceof HTMLInputElement ? element.value : element.textContent || '')
      .join(' ');
    const displayText = [displayRoot.innerText, displayRoot.textContent, inputValues, selectedState].filter(Boolean).join(' ');
    const display = normalize(displayText);
    const selected = ${JSON.stringify(selected)};
    const geographic = (value) => value.replace(/特别行政区|自治区|省|市|区|县|[\\/><>,，]/g, '');
    const dateParts = (value) => {
      const match = String(value || '').match(/(\\d{4})\\D{0,4}(\\d{1,2})(?:\\D{0,4}(\\d{1,2}))?/);
      return match ? [Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined] : undefined;
    };
    const geographicField = ${JSON.stringify(['nativePlace', 'residence', 'hukou', 'targetProvince', 'targetCity'].includes(operation.key))};
    const exactOrContained = !geographicField && selected.some((label) => label && display.includes(label));
    const geographicDisplay = geographic(display);
    const desiredGeographic = geographic(normalize(${JSON.stringify(operation.value)}));
    const selectedLeaf = geographic(selected[selected.length - 1] || '');
    const geographicMatch = geographicField
      && desiredGeographic.length >= 2
      && (geographicDisplay.includes(desiredGeographic)
        || (selectedLeaf.length >= 2
          && desiredGeographic.endsWith(selectedLeaf) && geographicDisplay.includes(selectedLeaf)));
    const desiredDate = dateParts(${JSON.stringify(operation.value)});
    const observedDate = dateParts(displayText);
    const dateMatch = ${JSON.stringify(['birthDate', 'startDate', 'endDate', 'availability'].includes(operation.key))}
      && desiredDate && observedDate && desiredDate[0] === observedDate[0] && desiredDate[1] === observedDate[1]
      && (desiredDate[2] === undefined || desiredDate[2] === observedDate[2]);
    return { filled: display !== '请选择' && (exactOrContained || geographicMatch || dateMatch) };
  })()`;
}

/** 仅在动态弹层仍可见时切换本次字段的触发器；固定字段语义由 Host 生成，模型不能提供选择器。 */
export function DynamicOverlayDismissExpression(operation: FormFillOperation): string {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
        && rect.width > 0 && rect.height > 0;
    };
    const overlays = [...document.querySelectorAll('[role="listbox"],[role="menu"],[class*="dropdown" i],[class*="cascader" i],[class*="picker" i],[class*="calendar" i],[class*="popover" i],[class*="popup" i],[class*="layer" i],[class*="selectList" i],[class*="area-selector-container" i]')]
      .filter((element) => element instanceof HTMLElement && visible(element)
        && (element.matches('[role="listbox"],[role="menu"],[class*="calendar" i],[class*="selectList" i],[class*="area-selector-container" i]')
          || ['absolute', 'fixed'].includes(getComputedStyle(element).position))
        && (element.matches('[role="listbox"],[role="menu"]') || element.querySelector('li,[role="option"],[role="gridcell"],[role="radio"],button,[class*="area-item" i]')));
    if (!overlays.length) return { toggled: false };
    const triggers = [...document.querySelectorAll('[data-avery-form-semantic="custom-select"]')]
      .filter((element) => element.getAttribute('data-avery-form-key') === ${JSON.stringify(operation.key)});
    const trigger = triggers[${operation.occurrence}] || triggers[0];
    if (!(trigger instanceof HTMLElement)) return { toggled: false };
    let branch = trigger;
    let active = trigger.getAttribute('aria-expanded') === 'true';
    for (let depth = 0; branch && depth < 4 && !active; depth += 1, branch = branch.parentElement) {
      const marker = String(branch.className || '').toLowerCase();
      active = /(select|picker|cascader|dropdown).*(active|open)|(active|open).*(select|picker|cascader|dropdown)/.test(marker);
    }
    if (!active) return { toggled: false };
    trigger.click();
    return { toggled: true };
  })()`;
}

export type BrowserFormCommandEnvelope = { success?: boolean; data?: any; error?: string; message?: string };

export type BrowserFormDriverPort = {
  runCommand: (command: string[], options?: { signal?: AbortSignal; deadline?: number; json?: boolean; stdin?: string }) => Promise<BrowserFormCommandEnvelope>;
  delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  pageRevision: () => number;
};

/** 值独立回读，避免长项目描述把 aria-label 特征包截断；只读本次已标记的表单控件。 */
export const FormRetainedValuesExpression = `(() => {
  ${MokaFormValueScript}
  ${FeishuSelectValueScript}
  const result = [];
  const identities = window.__averyFormIdentities;
  if (!identities) return result;
  for (const element of document.querySelectorAll('[data-avery-form-semantic]')) {
    const name = element.getAttribute('aria-label') || '';
    if (!name.startsWith('${EncodedFormFieldPrefix}')) continue;
    const nodeIdentity = identities.nodes.get(element);
    if (!nodeIdentity) continue;
    let value;
    if (feishuSelectRoot(element)) value = feishuSelectedValue(element);
    else if (element instanceof HTMLInputElement && ['radio','checkbox'].includes(element.type)) value = String(element.checked);
    else if ('value' in element) value = String(element.value || '');
    else if (element.matches(moka.select + ',' + moka.dayField) || element.parentElement?.matches(moka.range)) value = mokaSelectedValue(element);
    else value = String(element.querySelector('.phoenix-select__content')?.innerText ?? element.querySelector('input')?.value ?? element.innerText ?? '').trim();
    if (/^(?:请选择|请输入|请填写)$/.test(value.trim())) value = '';
    result.push({ nodeIdentity, value: value.slice(0, 20000), truncated: value.length > 20000 });
  }
  return result;
})()`;

/** 只处理表单 DOM 和控件状态机，不持有浏览器进程、Agent 提案或用户资料。 */
export class BrowserFormDriver {
  constructor(private readonly port: BrowserFormDriverPort) {}

  /** 不生成新快照引用，避免为上传建立基线时把刚观察到的 file-input 引用作废。 */
  async CaptureResumeForm(options: { signal?: AbortSignal; deadline?: number }): Promise<{ fields: FormField[]; url: string }> {
    const expression = `(() => {
      try {
        ${FormSemanticEnrichmentExpression};
        const values = ${FormRetainedValuesExpression};
        if (values.some(value=>value.truncated)) return {error:'pre_upload_value_truncated'};
        const byId = new Map(values.map(value => [value.nodeIdentity, value]));
        const refs = {};
        for (const element of document.querySelectorAll('[data-avery-form-semantic]')) {
          const name = element.getAttribute('aria-label') || '';
          if (!name.startsWith('${EncodedFormFieldPrefix}')) continue;
          const identity = window.__averyFormIdentities?.nodes.get(element), retained = byId.get(identity);
          const custom = element.getAttribute('data-avery-form-semantic') === 'custom-select';
          const role = custom || element.tagName === 'SELECT' ? 'combobox' : element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : 'textbox';
          refs['e' + (Object.keys(refs).length + 1)] = {name,role,tag:element.tagName.toLowerCase(),type:element.type,
            ...(retained && !retained.truncated ? {currentValue:retained.value,valueLength:retained.value.length} : {}),
            ...(element.tagName === 'SELECT' ? {options:[...element.options].map(o=>({label:o.text,value:o.value,selected:o.selected}))} : {})};
          if (Object.keys(refs).length > 300) return {error:'pre_upload_form_too_large'};
        }
        return {refs,url:location.href};
      } finally { ${FormSemanticCleanupExpression}; }
    })()`;
    const response = await this.port.runCommand(['eval','-b',Buffer.from(expression,'utf8').toString('base64')],options);
    const data = response.data?.result as {refs?:Record<string,unknown>;url?:string} | undefined;
    if (!data?.refs || typeof data.url !== 'string') throw new AgentBrowserError('BROWSER_RESUME_BASELINE_UNAVAILABLE','Cannot read the form before uploading; no file was uploaded.');
    return {fields:FormFields(data.refs,this.port.pageRevision()),url:data.url};
  }

  async StartResumeImport(id: string, options: { signal?: AbortSignal; deadline?: number }): Promise<void> {
    await this.port.runCommand(['eval','-b',Buffer.from(`(() => {
      window.__averyResumeImport = {id:${JSON.stringify(id)},startedAt:Date.now(),lastChangedAt:Date.now(),signature:null,sawBusy:false};
      return {started:true};
    })()`,'utf8').toString('base64')],options);
  }

  /** 页面内有界等待，只回传最终状态；安静窗口只能证明观察稳定，不能保证服务器永远不会再次解析。 */
  async WaitForResumeImport(id: string, options: { signal?: AbortSignal; deadline?: number }): Promise<{parseStatus:'stable'|'pending'|'failed';completionObserved:boolean;readyForFill:boolean;reason:string}> {
    const timeoutMs = Math.max(0,Math.min(30_000,(options.deadline ?? Date.now()+31_000)-Date.now()-1_000));
    const expression = `(async () => {
      const state = window.__averyResumeImport;
      if (!state || state.id !== ${JSON.stringify(id)}) return {parseStatus:'pending',completionObserved:false,readyForFill:false,reason:'upload_watch_unavailable'};
      const stopAt = Date.now()+${timeoutMs};
      const visible = e => {const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
      while(Date.now()<stopAt){
        const text = document.body.innerText.slice(0,80_000);
        const busy = /正在(?:上传|解析|识别)|(?:简历)?解析中|上传中|parsing\\s+(?:your\\s+)?resume|extracting\\s+resume/i.test(text)
          || [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible);
        if (busy) state.sawBusy=true;
        const failed = /简历解析失败|解析失败|简历上传失败|上传失败|resume\\s+(?:parsing|upload)\\s+failed/i.test(text);
        const completion = /解析完成|解析成功|已完成解析|resume\\s+parsed|parsing\\s+completed/i.test(text);
        const signature = JSON.stringify([...document.querySelectorAll('input,textarea,select,[contenteditable="true"],[class*="sd-Input-display-value-"],.atsx-date-picker-period-month-label')].slice(0,1200)
          .map(e=>[e.type,e.value??e.textContent,e.checked,e.disabled]));
        if (signature!==state.signature){state.signature=signature;state.lastChangedAt=Date.now();}
        if (failed) return {parseStatus:'failed',completionObserved:false,readyForFill:false,reason:'website_reported_failure'};
        if (!busy && Date.now()-state.startedAt>=3500 && Date.now()-state.lastChangedAt>=1500)
          return {parseStatus:'stable',completionObserved:completion||state.sawBusy,readyForFill:true,reason:completion?'completion_message':state.sawBusy?'busy_then_quiet':'quiet_window_only'};
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      return {parseStatus:'pending',completionObserved:false,readyForFill:false,reason:'observation_timeout'};
    })()`;
    const response = await this.port.runCommand(['eval','-b',Buffer.from(expression,'utf8').toString('base64')],options);
    const data = response.data?.result as {parseStatus?:string;completionObserved?:boolean;readyForFill?:boolean;reason?:string} | undefined;
    if (!data || !['stable','pending','failed'].includes(data.parseStatus ?? '')) throw new AgentBrowserError('BROWSER_OUTPUT_INVALID','Resume parsing observation returned an invalid result; do not repeat the upload.');
    return {parseStatus:data.parseStatus as 'stable'|'pending'|'failed',completionObserved:data.completionObserved===true,readyForFill:data.readyForFill===true,reason:data.reason??'unknown'};
  }

  async InspectForm(
    options: { signal?: AbortSignal; deadline?: number },
    retainSemantics = false,
    target?: FormFillOperation,
  ): Promise<BrowserFormCommandEnvelope> {
    const cleanup = ['eval', '-b', Buffer.from(FormSemanticCleanupExpression, 'utf8').toString('base64')];
    await this.port.runCommand(cleanup, options);
    await this.port.runCommand(['eval', '-b', Buffer.from(FormSemanticEnrichmentExpression, 'utf8').toString('base64')], options);
    if (target?.adapter === 'moka') await this.port.runCommand(['eval', '-b', Buffer.from(MokaFormTargetRevealExpression(target), 'utf8').toString('base64')], options);
    try {
      const snapshot = await this.port.runCommand(['snapshot', '-i', '-c', '--urls', '--form'], options);
      const readback = await this.port.runCommand(['eval', '-b', Buffer.from(FormRetainedValuesExpression, 'utf8').toString('base64')], options);
      const values = Array.isArray(readback.data?.result) ? readback.data.result as Array<{nodeIdentity:string;value:string;truncated?:boolean}> : [];
      const byIdentity = new Map(values.map(v => [v.nodeIdentity,v]));
      const refs = snapshot.data?.refs as Record<string, Record<string, unknown>> | undefined;
      if (refs) for (const field of FormFields(refs, this.port.pageRevision())) {
        const value = field.nodeIdentity ? byIdentity.get(field.nodeIdentity) : undefined;
        const metadata = refs[field.ref.slice(1)] ?? refs[field.ref];
        if (value && metadata && !value.truncated) metadata.currentValue = value.value;
      }
      return snapshot;
    } finally {
      if (!retainSemantics) {
        try { await this.port.runCommand(cleanup, options); } catch { /* 快照结果优先，临时属性会在下次 Inspect 前再次清理。 */ }
      }
    }
  }

  private async SnapshotDynamicOptions(options: { signal?: AbortSignal; deadline?: number }, operation?: FormFillOperation): Promise<BrowserFormCommandEnvelope> {
    const cleanup = ['eval', '-b', Buffer.from(DynamicOptionCleanupExpression, 'utf8').toString('base64')];
    await this.port.runCommand(cleanup, options);
    const expression = operation?.adapter === 'feishu' ? FeishuSelectOptionsExpression(operation) : DynamicOptionEnrichmentFor(operation?.adapter === 'moka');
    const enrichment = await this.port.runCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], options);
    if (operation?.adapter === 'feishu' && enrichment.data?.result?.ready !== true) {
      throw new AgentBrowserError('BROWSER_FORM_MENU_NOT_READY', 'The Feishu select menu is unavailable or still moving. Observe the field before selecting.');
    }
    // 个人浏览器的 ref 包含严格语义指纹；标记必须保留到本次点击完成，下次快照会先清理。
    const snapshot = await this.port.runCommand(['snapshot', '-i', '-c', '--urls'], options);
    if (Array.isArray(enrichment.data?.result?.observedOptions)) snapshot.data = {...snapshot.data,optionObservation:enrichment.data.result};
    return snapshot;
  }

  async DismissTransientOverlay(
    options: { signal?: AbortSignal; deadline?: number },
    operation?: FormFillOperation,
  ): Promise<void> {
    let toggled = false;
    if (operation) {
      const cleanup = ['eval', '-b', Buffer.from(FormSemanticCleanupExpression, 'utf8').toString('base64')];
      try {
        await this.port.runCommand(cleanup, options);
        await this.port.runCommand(['eval', '-b', Buffer.from(FormSemanticEnrichmentExpression, 'utf8').toString('base64')], options);
        const response = await this.port.runCommand(['eval', '-b', Buffer.from(DynamicOverlayDismissExpression(operation), 'utf8').toString('base64')], options);
        const value = response.data?.result ?? response.data;
        toggled = value?.toggled === true;
      } catch { /* 关闭失败时继续使用通用取消事件，不覆盖字段本身的执行结果。 */ }
      finally { try { await this.port.runCommand(cleanup, options); } catch { /* 下次 Inspect 会再次清理。 */ } }
    }
    if (!toggled) {
      try { await this.port.runCommand(['press', 'Escape'], options); } catch { /* 部分组件不消费 Escape，继续发送固定的页面外点击事件。 */ }
      try {
        await this.port.runCommand(['eval', '-b', Buffer.from(DismissTransientOverlayExpression, 'utf8').toString('base64')], options);
      } catch { /* 页面导航或卸载时无需继续清理旧弹层。 */ }
    }
    if (!options.signal?.aborted) {
      // Phoenix 等组件使用退出动画；过早处理下一字段会让正在消失的弹层继续遮挡页面。
      try { await this.port.delay(toggled ? OverlayTransitionDelayMs : 30, options.signal); } catch { /* 清理等待不覆盖原工具结果。 */ }
    }
  }

  /** 优先使用原生可操作性检查；仅在固定页头/页尾遮挡时做两次有界滚动重试。 */
  private async ClickDynamicRef(ref: string, options: { signal?: AbortSignal; deadline?: number }): Promise<void> {
    try { await this.port.runCommand(['scrollintoview', ref], options); } catch { /* click 自身仍会执行完整可操作性检查。 */ }
    try {
      await this.port.runCommand(['click', ref], options);
      return;
    } catch (error) {
      if (!(error instanceof AgentBrowserError) || !/covered by/i.test(error.message)) throw error;
    }
    await this.DismissTransientOverlay(options);
    await this.port.runCommand(['scroll', 'down', '240'], options);
    try {
      await this.port.runCommand(['click', ref], options);
      return;
    } catch (error) {
      if (!(error instanceof AgentBrowserError) || !/covered by/i.test(error.message)) throw error;
    }
    await this.port.runCommand(['scroll', 'up', '480'], options);
    await this.port.runCommand(['click', ref], options);
  }

  /** 重新定位原字段并只返回布尔后置条件，所选资料值不会进入工具结果或 Trace。 */
  private async VerifyDynamicSelection(
    operation: FormFillOperation,
    selectedLabels: string[],
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<boolean> {
    const cleanup = ['eval', '-b', Buffer.from(FormSemanticCleanupExpression, 'utf8').toString('base64')];
    await this.port.runCommand(cleanup, options);
    try {
      await this.port.runCommand(['eval', '-b', Buffer.from(FormSemanticEnrichmentExpression, 'utf8').toString('base64')], options);
      const expression = DynamicSelectionVerificationExpression(operation, selectedLabels);
      const response = await this.port.runCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], options);
      const value = response.data?.result ?? response.data;
      return value?.filled === true;
    } finally {
      try { await this.port.runCommand(cleanup, options); } catch { /* 后置条件结果优先，下次 Inspect 仍会先清理。 */ }
    }
  }

  private async WaitForDynamicConfirmation(
    options: { signal?: AbortSignal; deadline?: number },
    operation?: FormFillOperation,
  ): Promise<{ ref: string; label: string } | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const snapshot = await this.SnapshotDynamicOptions(options,operation);
      const confirmation = DynamicConfirmationMatch(snapshot.data ?? {});
      if (confirmation) return confirmation;
      if (attempt < 9) await this.port.delay(DynamicPollIntervalMs, options.signal);
    }
    return undefined;
  }

  private async WaitForDateRef(
    matcher: (data: Record<string, any>) => { ref: string; label: string; role: string } | undefined,
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<{ ref: string; label: string; role: string } | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const snapshot = await this.SnapshotDateControls(options);
      const match = matcher(snapshot.data ?? {});
      if (match) return match;
      if (attempt < 9) await this.port.delay(DynamicPollIntervalMs, options.signal);
    }
    return undefined;
  }

  private async SnapshotDateControls(options: { signal?: AbortSignal; deadline?: number }): Promise<BrowserFormCommandEnvelope> {
    await this.port.runCommand(['eval', '-b', Buffer.from(DateEditorCleanupExpression, 'utf8').toString('base64')], options);
    await this.port.runCommand(['eval', '-b', Buffer.from(DateEditorEnrichmentExpression, 'utf8').toString('base64')], options);
    return this.port.runCommand(['snapshot', '-i', '-c', '--urls'], options);
  }

  /** 滚动年月列表以显露目标项，再由快照与点击执行原有命中检查；不发布被裁剪或遮挡的引用。 */
  private async RevealDatePickerChoices(value: string, options: { signal?: AbortSignal; deadline?: number }): Promise<void> {
    const desired = ParseDateTarget(value);
    if (!desired) return;
    const expression = `(() => {
      ${BrowserDateAdapterSelectionScript}
      const desired = ${JSON.stringify(desired)};
      for (const panel of document.querySelectorAll(dateAdapters.feishu.monthPanel)) {
        if (!(panel instanceof HTMLElement) || panel.getBoundingClientRect().height <= 0) continue;
        if (dateAdapterFor(panel) !== 'feishu') continue;
        for (const list of panel.querySelectorAll(dateAdapters.feishu.optionList)) {
          const items = [...list.querySelectorAll(dateAdapters.feishu.option)];
          const isYear = items.some((item) => /^\\d{4}$/.test(item.textContent.trim()));
          const item = items.find((item) => Number(item.textContent.trim()) === (isYear ? desired.year : desired.month));
          if (!item) continue;
          const rect = item.getBoundingClientRect(), bounds = list.getBoundingClientRect();
          list.scrollTop += rect.top - bounds.top - (list.clientHeight - rect.height) / 2;
        }
      }
      return { revealed: true };
    })()`;
    await this.port.runCommand(['eval', '-b', Buffer.from(expression, 'utf8').toString('base64')], options);
  }

  /** 等待日期弹层暴露可编辑输入框或年、月控件，避免在前端尚未完成渲染时读取空快照。 */
  private async WaitForDatePickerSnapshot(
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<BrowserFormCommandEnvelope> {
    let latest: BrowserFormCommandEnvelope = { success: true, data: {} };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      latest = await this.SnapshotDateControls(options);
      const refs = latest.data?.refs && typeof latest.data.refs === 'object'
        ? latest.data.refs as Record<string, Record<string, unknown>>
        : {};
      const ready = Object.values(refs).some((metadata) => {
        const label = String(metadata?.name ?? '').replace(/\s+/g, '').trim();
        return label === '__avery_date_editor__'
          || label.startsWith('__avery_date_year_')
          || label.startsWith('__avery_date_month_')
          || label.startsWith('__avery_date_day_');
      });
      if (ready) return latest;
      if (attempt < 9) await this.port.delay(DynamicPollIntervalMs, options.signal);
    }
    return latest;
  }

  /** 日期组件提交可能晚于点击事件；在同一工具 deadline 内轮询原字段的最终显示值。 */
  private async WaitForDateSelectionCommit(
    operation: FormFillOperation,
    selectedLabels: string[],
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await this.VerifyDynamicSelection(operation, selectedLabels, options)) return true;
      if (attempt < 9) await this.port.delay(DynamicPollIntervalMs, options.signal);
    }
    return false;
  }

  private async ExecuteDatePickerChoices(
    operation: FormFillOperation,
    initialData: Record<string, any>,
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<{ filled: boolean; reason?: string }> {
    const desired = ParseDateTarget(operation.value);
    if (!desired) return { filled: false, reason: 'date_value_unsupported' };
    const marker = (prefix: string, target?: number) => (data: Record<string, any>) => DynamicDateRef(
      data,
      (label) => label === `${prefix}${target ?? ''}`,
    );
    const desiredYearOption = marker('__avery_date_year_option__:', desired.year);
    let yearOption = desiredYearOption(initialData);
    const monthYearHeader = DynamicDateRef(initialData, (label) => label.startsWith('__avery_date_month_year_header__:'));
    const monthOnly = Boolean(monthYearHeader) || Object.values(initialData.refs ?? {}).some((entry) =>
      (entry as Record<string, unknown>)?.name === '__avery_date_month_only__');
    const yearHeader = yearOption ? undefined : monthYearHeader
      ?? DynamicDateRef(initialData, (label) => label.startsWith('__avery_date_year_header__:'))
      ?? await this.WaitForDateRef((data) => DynamicDateRef(data, (label) => label.startsWith('__avery_date_month_year_header__:')
        || label.startsWith('__avery_date_year_header__:')), options);
    const currentYear = yearHeader ? Number(yearHeader.label.split(':').pop()) : undefined;
    if (!yearOption && currentYear !== desired.year) {
      if (!yearHeader) return { filled: false, reason: 'date_year_control_not_found' };
      await this.ClickDynamicRef(yearHeader.ref, options);
      await this.port.delay(DynamicTransitionDelayMs, options.signal);
      yearOption = await this.WaitForDateRef(desiredYearOption, options);
      if (!yearOption) return { filled: false, reason: 'date_year_not_found' };
      await this.ClickDynamicRef(yearOption.ref, options);
      await this.port.delay(DynamicTransitionDelayMs, options.signal);
    } else if (yearOption) {
      await this.ClickDynamicRef(yearOption.ref, options);
      await this.port.delay(DynamicTransitionDelayMs, options.signal);
    }

    await this.RevealDatePickerChoices(operation.value, options);
    const monthControl = await this.WaitForDateRef(
      (data) => marker('__avery_date_month_option__:', desired.month)(data)
        ?? DynamicDateRef(data, (label) => label.startsWith('__avery_date_month_header__:')),
      options,
    );
    let monthOption = monthControl?.label === `__avery_date_month_option__:${desired.month}` ? monthControl : undefined;
    if (!monthOption) {
      const monthHeader = monthControl;
      if (!monthHeader) return { filled: false, reason: 'date_month_control_not_found' };
      await this.ClickDynamicRef(monthHeader.ref, options);
      await this.port.delay(DynamicTransitionDelayMs, options.signal);
      monthOption = await this.WaitForDateRef(
        marker('__avery_date_month_option__:', desired.month),
        options,
      );
    }
    if (!monthOption) return { filled: false, reason: 'date_month_not_found' };
    await this.ClickDynamicRef(monthOption.ref, options);
    await this.port.delay(DynamicTransitionDelayMs, options.signal);

    // 教育、工作和项目经历常使用纯年月面板；月份本身就是最终选择，不应继续等待不存在的日期网格。
    if (monthOnly) return { filled: true };

    // 北森的年月资料仍由完整日历承载；选择月份只切换视图，不会提交字段，因此在日面板存在时补选首日。
    const targetDay = desired.day ?? 1;
    const dayOption = await this.WaitForDateRef(
      marker('__avery_date_day_option__:', targetDay),
      options,
    );
    if (dayOption) {
      await this.ClickDynamicRef(dayOption.ref, options);
      await this.port.delay(DynamicTransitionDelayMs, options.signal);
    } else if (desired.day !== undefined) {
      return { filled: false, reason: 'date_day_not_found' };
    }
    const finalSnapshot = await this.SnapshotDateControls(options);
    const confirmation = marker('__avery_date_confirmation__')(finalSnapshot.data ?? {});
    if (confirmation) {
      await this.ClickDynamicRef(confirmation.ref, options);
      await this.port.delay(DynamicConfirmationDelayMs, options.signal);
    }
    return { filled: true };
  }

  /**
   * 自定义下拉和级联菜单在 Host 内部有限收敛；每层候选项都必须来自新快照，
   * 模型既不能提供 selector，也不会参与逐层 Click/Snapshot 编排。
   */
  async ExecuteCustomSelect(
    operation: FormFillOperation,
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<{ filled: boolean; reason?: string } & Partial<FormOptionObservation>> {
    const formSnapshot = await this.InspectForm(options, true, operation);
    const fields = FormFields(formSnapshot.data?.refs && typeof formSnapshot.data.refs === 'object' ? formSnapshot.data.refs : {}, this.port.pageRevision());
    const target = DynamicFormTarget(fields, operation);
    if (target?.interaction.adapter === 'feishu') operation = { ...operation, adapter: 'feishu', targetNodeIdentity: target.nodeIdentity };
    const selectedLabels: string[] = [];
    const region = ['nativePlace', 'residence', 'hukou', 'targetProvince', 'targetCity'].includes(operation.key);
    let committed = false;
    let searchedDynamicList = false;
    let lastObservation: {observedOptions?:unknown;optionsTruncated?:boolean} | undefined;
    let optionsBeforeSearch: string[] | undefined;
    const failure = async (reason: string) => {
      const response = lastObservation ? undefined : await this.port.runCommand(['eval', '-b', Buffer.from(DynamicOptionObservationExpression, 'utf8').toString('base64')], options);
      const data = lastObservation ?? response?.data?.result as { observedOptions?: unknown; optionsTruncated?: boolean } | undefined;
      if (!Array.isArray(data?.observedOptions)) return {filled:false,reason,requestedValue:operation.value,selectedPath:[...selectedLabels],searchAttempted:searchedDynamicList};
      return { filled: false, reason, requestedValue: operation.value,
        observedOptions: Array.isArray(data?.observedOptions) ? data.observedOptions.filter((value): value is string => typeof value === 'string').slice(0, 40) : [],
        optionsTruncated: data?.optionsTruncated === true, observationScope: 'visible_options' as const,
        selectedPath: [...selectedLabels], searchAttempted: searchedDynamicList, ...(optionsBeforeSearch ? {optionsBeforeSearch} : {}) };
    };

    try {
      if (!target) return { filled: false, reason: 'dynamic_field_not_found' };
      if (target.disabled || target.readOnly) return { filled: false, reason: 'field_not_editable' };
      await this.ClickDynamicRef(target.ref, options);
      const visitedActions = new Set<string>();
      let selectedAny = false;
      let selectionControlUsed = false;
      let directSelectionCompleted = false;
      // 三层级联可能同时包含“展开文字”和“选择图标”，因此动作上限高于层级上限，但仍是固定小常数。
      for (let action = 0; action < 7; action += 1) {
        let option: ReturnType<typeof DynamicOptionMatch> = undefined;
        let latestOptionSnapshot: BrowserFormCommandEnvelope = { success: true, data: {} };
        for (let attempt = 0; attempt < 10 && !option; attempt += 1) {
          latestOptionSnapshot = await this.SnapshotDynamicOptions(options,operation);
          lastObservation = latestOptionSnapshot.data?.optionObservation;
          option = DynamicOptionMatch(latestOptionSnapshot.data ?? {}, operation.key, operation.value, visitedActions, operation.adapter === 'moka' && !region);
          if (!option && !searchedDynamicList && operation.adapter === 'moka') {
            const search = DynamicSearchMatch(latestOptionSnapshot.data ?? {});
            if (search) {
              if (Array.isArray(lastObservation?.observedOptions)) optionsBeforeSearch = lastObservation.observedOptions.filter((value):value is string=>typeof value==='string').slice(0,40);
              await this.port.runCommand(['fill', search.ref, operation.value], options);
              searchedDynamicList = true;
              const timeoutMs = Math.max(0, Math.min(6000, (options.deadline ?? Date.now() + 6000) - Date.now() - 100));
              await this.port.runCommand(['eval', '-b', Buffer.from(MokaSearchOptionsWaitExpression(operation.value, timeoutMs), 'utf8').toString('base64')], options);
            }
          }
          if (!option && attempt < 9) await this.port.delay(DynamicPollIntervalMs, options.signal);
        }
        if (!option) {
          if (operation.key === 'ethnicity' && !searchedDynamicList) {
            const search = DynamicSearchMatch(latestOptionSnapshot.data ?? {});
            if (search) {
              await this.port.runCommand(['fill', search.ref, operation.value], options);
              await this.port.delay(DynamicTransitionDelayMs, options.signal);
              searchedDynamicList = true;
              continue;
            }
          }
          if (region && selectedAny) break;
          return await failure(selectedAny ? 'cascade_incomplete' : 'option_not_found');
        }
        try {
          await this.port.runCommand(['click', option.ref], options);
        } catch (error) {
          // 虚拟列表可能在快照后立即重建候选节点；只在 ref 失效时重新生成一次候选快照，
          // 再按相同语义选择，避免重复执行已完成的级联步骤。
          if (!(error instanceof AgentBrowserError) || error.code !== 'BROWSER_STALE_PAGE_REF') throw error;
          const refreshedSnapshot = await this.SnapshotDynamicOptions(options,operation);
          lastObservation = refreshedSnapshot.data?.optionObservation;
          const refreshed = DynamicOptionMatch(refreshedSnapshot.data ?? {}, operation.key, operation.value, visitedActions, operation.adapter === 'moka' && !region);
          if (!refreshed) throw error;
          option = refreshed;
          await this.port.runCommand(['click', option.ref], options);
        }
        selectedAny = true;
        visitedActions.add(option.actionKey);
        if (!selectedLabels.includes(option.label)) selectedLabels.push(option.label);
        if (option.role === 'radio') { selectionControlUsed = true; break; }
        if (option.complete) { directSelectionCompleted = true; break; }
        await this.port.delay(DynamicTransitionDelayMs, options.signal);
      }
      if (!selectionControlUsed && !directSelectionCompleted && !(region && selectedAny)) {
        return await failure('cascade_incomplete');
      }
      if (region) {
        // 自动提交型地区控件不需要确认；仍显示旧值时，确认是不可省略的提交步骤。
        committed = await this.VerifyDynamicSelection(operation, selectedLabels, options);
        if (committed) return { filled: true };
        // 北森文字行负责进入下一级；末级仍可能要求点选同名圆点后再确认。
        const selectionSnapshot = await this.SnapshotDynamicOptions(options,operation);
        lastObservation = selectionSnapshot.data?.optionObservation;
        const selection = DynamicOptionMatch(selectionSnapshot.data ?? {}, operation.key, operation.value, visitedActions);
        if (selection?.role === 'radio' && selection.complete) {
          await this.port.runCommand(['click', selection.ref], options);
          visitedActions.add(selection.actionKey);
          if (!selectedLabels.includes(selection.label)) selectedLabels.push(selection.label);
          await this.port.delay(DynamicTransitionDelayMs, options.signal);
        }
        const confirmation = await this.WaitForDynamicConfirmation(options,operation);
        if (!confirmation) return await failure('confirmation_not_available');
        await this.port.runCommand(['click', confirmation.ref], options);
        await this.port.delay(DynamicConfirmationDelayMs, options.signal);
        committed = await this.VerifyDynamicSelection(operation, selectedLabels, options);
        return committed ? { filled: true } : await failure('confirmation_not_committed');
      }
      committed = await this.VerifyDynamicSelection(operation, selectedLabels, options);
      if (!committed) {
        const selectionSnapshot = await this.SnapshotDynamicOptions(options,operation);
        lastObservation = selectionSnapshot.data?.optionObservation;
        const selection = DynamicOptionMatch(selectionSnapshot.data ?? {}, operation.key, operation.value, visitedActions);
        if (selection?.role === 'radio' && selection.complete) {
          await this.port.runCommand(['click', selection.ref], options);
          visitedActions.add(selection.actionKey);
          if (!selectedLabels.includes(selection.label)) selectedLabels.push(selection.label);
          await this.port.delay(DynamicTransitionDelayMs, options.signal);
        }
        const confirmation = await this.WaitForDynamicConfirmation(options,operation);
        if (confirmation) {
          await this.port.runCommand(['click', confirmation.ref], options);
          await this.port.delay(DynamicConfirmationDelayMs, options.signal);
          committed = await this.VerifyDynamicSelection(operation, selectedLabels, options);
        }
      }
      return committed ? { filled: true } : await failure('selection_not_committed');
    } finally {
      try { await this.port.runCommand(['eval', '-b', Buffer.from(DynamicOptionCleanupExpression, 'utf8').toString('base64')], options); } catch { /* 字段结果优先，下次候选快照仍会先清理。 */ }
      try { await this.port.runCommand(['eval', '-b', Buffer.from(FormSemanticCleanupExpression, 'utf8').toString('base64')], options); } catch { /* 下次 Inspect 会再次清理。 */ }
      // 地区确认成功后组件应自行关闭；再次切换触发器可能反而重开弹层。失败路径才执行恢复性收尾。
      if (!committed || !region) await this.DismissTransientOverlay(options, target ? operation : undefined);
    }
  }

  /** 日期控件优先使用编辑器；纯点选面板则按年、月、日逐步推进，每一步都使用新快照。 */
  async ExecuteCustomDate(
    operation: FormFillOperation,
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<{ filled: boolean; reason?: string }> {
    const formSnapshot = await this.InspectForm(options, true, operation);
    const fields = FormFields(formSnapshot.data?.refs && typeof formSnapshot.data.refs === 'object' ? formSnapshot.data.refs : {}, this.port.pageRevision());
    const matchingFields = MatchingDynamicFormFields(fields, operation);
    const target = operation.targetRecordIndex !== undefined ? DynamicFormTarget(fields, operation) : matchingFields[operation.targetOccurrence ?? operation.occurrence];
    let committed = false;

    try {
      if (!target) return { filled: false, reason: 'dynamic_field_not_found' };
      if (target.disabled || target.readOnly) return { filled: false, reason: 'field_not_editable' };
      if (operation.adapter === 'moka') return await this.ExecuteMokaDate(operation, target.ref, options);
      await this.ClickDynamicRef(target.ref, options);
      await this.port.delay(DynamicTransitionDelayMs, options.signal);
      await this.RevealDatePickerChoices(operation.value, options);
      let editorSnapshot: BrowserFormCommandEnvelope;
      const cleanupDateEditor = ['eval', '-b', Buffer.from(DateEditorCleanupExpression, 'utf8').toString('base64')];
      try {
        editorSnapshot = await this.WaitForDatePickerSnapshot(options);
      } catch (error) {
        try { await this.port.runCommand(cleanupDateEditor, options); } catch { /* 保留原始快照错误。 */ }
        throw error;
      }
      const refs = editorSnapshot.data?.refs && typeof editorSnapshot.data.refs === 'object'
        ? editorSnapshot.data.refs as Record<string, Record<string, unknown>>
        : {};
      const editorEntry = Object.entries(refs).find(([, metadata]) => metadata?.name === '__avery_date_editor__');
      let choiceData = editorSnapshot.data ?? {};
      if (editorEntry) {
        const editorRef = `@${editorEntry[0].replace(/^@/, '')}`;
        try {
          await this.port.runCommand(['fill', editorRef, operation.value], options);
          await this.port.runCommand(['press', 'Enter'], options);
          await this.port.delay(DynamicTransitionDelayMs, options.signal);
          committed = await this.WaitForDateSelectionCommit(operation, [operation.value], options);
        } catch (error) {
          if (options.signal?.aborted || (error instanceof AgentBrowserError && (error.statusUnknown
            || ['CANCELLED', 'BROWSER_COMMAND_TIMEOUT'].includes(error.code)))) throw error;
          // 部分日期面板暴露了不可实际操作的辅助输入框；明确失败后改走年份、月份点选状态机。
        } finally {
          try { await this.port.runCommand(cleanupDateEditor, options); } catch { /* 点选路径会重新获取页面快照。 */ }
        }
        if (committed) return { filled: true };
        // Phoenix 的无效输入不会关闭日历。优先复用当前弹层，避免再次点击被弹层覆盖的原字段。
        const existingPanel = await this.SnapshotDateControls(options);
        const existingRefs = existingPanel.data?.refs && typeof existingPanel.data.refs === 'object'
          ? existingPanel.data.refs as Record<string, Record<string, unknown>>
          : {};
        const panelStillOpen = Object.values(existingRefs).some((metadata) => {
          const label = String(metadata?.name ?? '');
          return label.startsWith('__avery_date_year_')
            || label.startsWith('__avery_date_month_')
            || label.startsWith('__avery_date_day_');
        });
        if (panelStillOpen) {
          choiceData = existingPanel.data ?? {};
        } else {
          try { await this.port.runCommand(cleanupDateEditor, options); } catch { /* 重新 Inspect 前尽力清理临时标记。 */ }
          const refreshedForm = await this.InspectForm(options, true);
          const refreshedFields = FormFields(refreshedForm.data?.refs && typeof refreshedForm.data.refs === 'object' ? refreshedForm.data.refs : {}, this.port.pageRevision());
          const refreshedMatches = MatchingDynamicFormFields(refreshedFields, operation);
          const refreshedTarget = operation.targetRecordIndex !== undefined ? DynamicFormTarget(refreshedFields, operation) : refreshedMatches[operation.targetOccurrence ?? operation.occurrence];
          if (!refreshedTarget) return { filled: false, reason: 'dynamic_field_not_found' };
          await this.ClickDynamicRef(refreshedTarget.ref, options);
          await this.port.delay(DynamicTransitionDelayMs, options.signal);
          choiceData = (await this.WaitForDatePickerSnapshot(options)).data ?? {};
        }
      }
      if (!committed) {
        const choiceResult = await this.ExecuteDatePickerChoices(operation, choiceData, options);
        if (!choiceResult.filled) return choiceResult;
        committed = await this.WaitForDateSelectionCommit(operation, [operation.value], options);
        return committed ? { filled: true } : { filled: false, reason: 'selection_not_committed' };
      }
      return { filled: true };
    } finally {
      if (operation.adapter === 'moka') {
        try { await this.port.runCommand(['eval', '-b', Buffer.from("(() => { for (const element of document.querySelectorAll('[data-avery-moka-active-date]')) element.removeAttribute('data-avery-moka-active-date'); return { cleaned: true }; })()", 'utf8').toString('base64')], options); } catch { /* 不覆盖原字段结果。 */ }
      }
      try { await this.port.runCommand(['eval', '-b', Buffer.from(DateEditorCleanupExpression, 'utf8').toString('base64')], options); } catch { /* 下次日期操作仍会先清理。 */ }
      try { await this.port.runCommand(['eval', '-b', Buffer.from(FormSemanticCleanupExpression, 'utf8').toString('base64')], options); } catch { /* 下次 Inspect 会再次清理。 */ }
      await this.DismissTransientOverlay(options, target ? operation : undefined);
    }
  }

  /** Moka 就读时间必须分别选择年、月；输入搜索词或按 Tab 均不构成选中。 */
  private async ExecuteMokaDate(operation: FormFillOperation, ref: string, options: { signal?: AbortSignal; deadline?: number }): Promise<{ filled: boolean; reason?: string }> {
    const desired = ParseDateTarget(operation.value);
    if (!desired) return { filled: false, reason: 'date_value_unsupported' };
    const prepared = await this.port.runCommand(['eval', '-b', Buffer.from(MokaDatePreparationExpression(operation), 'utf8').toString('base64')], options);
    const data = prepared.data?.result;
    if (!data?.found) return { filled: false, reason: 'dynamic_field_not_found' };
    if (!data.range) {
      await this.ClickDynamicRef(ref, options);
      let snapshot = await this.WaitForDatePickerSnapshot(options);
      const header = DynamicDateRef(snapshot.data ?? {}, label => label.startsWith('__avery_date_year_header__:'));
      if (header && Number(header.label.split(':').pop()) !== desired.year) {
        await this.ClickDynamicRef(header.ref, options);
        // 年份面板每次展示一个十年区间，最多跨越 ParseDateTarget 允许的 1900—2200 年范围。
        for (let step = 0; step < 32; step += 1) {
          snapshot = await this.SnapshotDateControls(options);
          const year = DynamicDateRef(snapshot.data ?? {}, label => label === `__avery_date_year_option__:${desired.year}`);
          if (year) break;
          const refs = snapshot.data?.refs as Record<string, Record<string, unknown>> | undefined;
          const decade = Object.values(refs ?? {}).map(entry => String(entry.name ?? '')).find(label => label.startsWith('__avery_moka_decade__:'));
          if (!decade) return { filled: false, reason: 'date_year_control_not_found' };
          const [, start, end] = decade.split(':');
          const direction = desired.year < Number(start) ? '__avery_moka_previous_years__' : desired.year > Number(end) ? '__avery_moka_next_years__' : '';
          const navigation = DynamicDateRef(snapshot.data ?? {}, label => label === direction);
          if (!navigation) return { filled: false, reason: 'date_year_not_found' };
          await this.ClickDynamicRef(navigation.ref, options);
        }
      }
      const result = await this.ExecuteDatePickerChoices(operation, snapshot.data ?? {}, options);
      if (!result.filled) return result;
    } else {
      for (const [controlName, prefix, value] of [
        ['__avery_moka_year_control__', '__avery_date_year_option__:', desired.year],
        ['__avery_moka_month_control__', '__avery_date_month_option__:', desired.month],
      ] as const) {
        const control = await this.WaitForDateRef(snapshot => DynamicDateRef(snapshot, label => label === controlName), options);
        if (!control) return { filled: false, reason: 'date_control_not_found' };
        await this.ClickDynamicRef(control.ref, options);
        await this.port.runCommand(['eval', '-b', Buffer.from(MokaDateOptionRevealExpression(value), 'utf8').toString('base64')], options);
        const option = await this.WaitForDateRef(snapshot => DynamicDateRef(snapshot, label => label === `${prefix}${value}`), options);
        if (!option) return { filled: false, reason: 'date_option_not_found' };
        await this.ClickDynamicRef(option.ref, options);
      }
    }
    return await this.WaitForDateSelectionCommit(operation, [operation.value], options) ? { filled: true } : { filled: false, reason: 'selection_not_committed' };
  }

}
