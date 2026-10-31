(async function () {
  'use strict';
  const E = window.CareerEngine;
  const $ = selector => document.querySelector(selector);
  const KEY = 'career-portal-hard-v1-draft';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const idFor = path => 'f-' + path.replaceAll('.', '-');
  let state = E.initialState();
  let errors = {};
  let saveTimer;
  let toastTimer;
  let database;
  let activePopup;
  let lastFocus;
  let storageError = '';
  let runtime;
  let outbox = [];
  let remoteQueue = Promise.resolve();
  let saving = 0;
  let remoteEpoch = 0;
  let polling = false;
  let ended = false;
  const legacyProfile = { searchDelayMs: 180, blur: 'discard', optionLimit: 30, month: 'grid', company: 'confirm' };
  const profile = () => runtime?.view.profile || legacyProfile;
  const log = (type, detail = {}) => { const event = { id: crypto.randomUUID(), type, at: new Date().toISOString(), ...detail }; state.events.push(event); if (runtime) { outbox.push(event); scheduleSave(); } };

  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500); }
  function closePopup() { if (activePopup) { activePopup(); activePopup = null; } }
  // 附件本体进入 IndexedDB；文本草稿只存元数据，刷新后必须核对本体，不能凭文件名假装上传成功。
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('career-portal-hard-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function storeFile(mode, kind, file) {
    return new Promise((resolve, reject) => {
      if (!database) { reject(new Error('当前浏览器不支持附件本地存储，请使用本地服务器打开页面')); return; }
      const tx = database.transaction('files', mode === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('files');
      const request = mode === 'put' ? store.put(file, kind) : mode === 'delete' ? store.delete(kind) : store.get(kind);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || new Error('本地附件存储失败'));
      tx.onabort = () => reject(tx.error || new Error('本地附件存储被中止'));
    });
  }
  function persist(manual = false) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (runtime) {
      if (ended || state.status === 'submitted') return remoteQueue;
      const snapshot = structuredClone(state), batch = outbox.splice(0), epoch = remoteEpoch;
      saving++; document.documentElement.dataset.syncState = 'saving';
      const task = remoteQueue.catch(() => undefined).then(async () => {
        try {
          if (epoch !== remoteEpoch) throw new Error('较早的输入已被解析更新取代，请检查最新资料');
          const base = structuredClone(runtime.view.state), baseRevision = runtime.revision;
          let view;
          try { view = await runtime.save(snapshot, batch); }
          catch (error) {
            if (error.code !== 'REVISION_CONFLICT' || !error.details) throw error;
            const latest = error.details;
            const overwritten = latest.state.events.filter(event => event.type === 'parser_applied' && event.revision > baseRevision).flatMap(event => event.changed.map(item => item.path));
            remoteEpoch++; runtime.adopt(latest);
            state = window.CareerSync.rebase(base, state, latest.state, overwritten);
            state.files = latest.state.files; state.events = latest.state.events;
            outbox.unshift(...batch); render(); scheduleSave();
            toast('解析更新已合并，未冲突的输入已保留；请核对更新内容');
            return latest;
          }
          state.events = view.state.events;
          $('#save-state').textContent = '✓ 本轮资料已保存';
          if (manual) toast('本轮资料已保存');
          return view;
        } catch (error) {
          if (['RUN_ENDED', 'RUN_SUBMITTED', 'RUN_NOT_FOUND'].includes(error.code)) { ended = true; outbox = []; clearTimeout(saveTimer); saveTimer = undefined; $('#application-form').inert = true; $('#save-draft').disabled = true; $('#preview-submit').disabled = true; $('#save-state').textContent = '本轮已提交、结束或清理'; toast(error.message); }
          else { outbox.unshift(...batch); storageError = error.message; $('#save-state').textContent = '保存失败'; toast('本轮保存失败：' + error.message); }
          throw error;
        } finally { saving--; document.documentElement.dataset.syncState = saving ? 'saving' : outbox.length ? 'unsaved' : 'saved'; }
      });
      remoteQueue = task.catch(() => undefined); return task;
    }
    try { localStorage.setItem(KEY, JSON.stringify(state)); $('#save-state').textContent = '✓ 草稿已保存至本机'; if (manual) toast('草稿已保存，附件也会在刷新后保留'); }
    catch { storageError = '浏览器本地存储不可用或空间不足，请导出测评记录备份'; $('#save-state').textContent = '本地保存失败'; toast(storageError); }
  }
  function scheduleSave() { $('#save-state').textContent = '保存中…'; document.documentElement.dataset.syncState = 'unsaved'; clearTimeout(saveTimer); saveTimer = setTimeout(() => { Promise.resolve(persist()).catch(() => undefined); }, runtime ? 160 : 500); }
  function setValue(path, value, kind = 'field_change') {
    E.set(state, path, value);
    log(kind, { path });
    if (path === 'personal.province') { state.personal.city = ''; log('cascade_reset', { path: 'personal.city' }); }
    scheduleSave(); updateProgress();
    if (Object.keys(errors).length) { errors = E.validate(state); renderErrors(); }
  }

  function renderField(f) {
    if (f.type === 'combo' && profile().blur === 'exact') f.hint = '可输入完整候选名称并失焦确认；其他内容请从列表选择。';
    const id = idFor(f.path), value = E.get(state, f.path) ?? '', required = f.required ? '<span class="required">*</span>' : '<span class="optional">选填</span>';
    const attr = `id="${id}" data-path="${f.path}" aria-describedby="${id}-hint ${id}-error" ${f.required ? 'aria-required="true"' : ''} ${f.disabled ? 'disabled' : ''}`;
    let control = '';
    if (f.type === 'radio') control = `<div class="radio-group" role="radiogroup" aria-labelledby="${id}-label">${f.options.map((option, index) => `<label><input type="radio" name="${f.path}" data-path="${f.path}" value="${esc(option)}" ${value === option ? 'checked' : ''} ${index === 0 ? `id="${id}"` : ''}>${esc(option)}</label>`).join('')}</div>`;
    else if (f.type === 'select') control = `<select ${attr}><option value="">请选择${esc(f.label)}</option>${f.options.map(option => `<option value="${esc(option)}" ${value === option ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select>`;
    else if (f.type === 'combo') control = `<div class="combo-shell"><input ${attr} class="combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-options" autocomplete="off" placeholder="输入关键词后选择" value="${esc(value)}" data-combo="${f.dictionary}"><span class="combo-arrow" aria-hidden="true">⌄</span><div class="combo-popup" id="${id}-options" role="listbox" aria-label="${esc(f.label)}候选项" hidden></div></div>`;
    else if (f.type === 'month') control = `<div class="month-shell"><button type="button" ${attr} class="month-button ${value ? '' : 'placeholder'}" role="combobox" aria-readonly="true" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(f.label)}${value ? ' ' + esc(value) : ''}"><span>${f.disabled ? '至今' : value ? esc(value).replace('-', ' 年 ') + ' 月' : '请选择年月'}</span></button></div>${f.currentToggle ? `<label class="date-current"><input type="checkbox" data-current="${f.path.replace(/\.end$/, '.current')}" ${f.disabled ? 'checked' : ''}>至今</label>` : ''}`;
    else if (f.type === 'textarea') control = `<textarea ${attr} maxlength="${f.max || 2000}" placeholder="${esc(f.placeholder || '请输入' + f.label)}">${esc(value)}</textarea><div class="counter"><span data-count="${f.path}">${String(value).length}</span> / ${f.max || 2000}</div>`;
    else if (f.type === 'tags') control = `<div class="tag-options" id="${id}" role="group" aria-labelledby="${id}-label">${f.options.map(option => `<button type="button" class="tag-option" data-tag="${esc(option)}" aria-pressed="${value.includes(option)}">${esc(option)}</button>`).join('')}</div>`;
    else control = `<input ${attr} type="${f.type}" value="${esc(value)}" placeholder="${esc(f.placeholder || '请输入' + f.label)}" ${f.max && f.type !== 'number' ? `maxlength="${f.max}"` : ''} ${f.type === 'number' ? `step="any" min="${f.min ?? 0}" max="${f.max ?? 999999}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''} ${f.type === 'date' ? 'min="1940-01-01" max="2010-10-30"' : ''}>`;
    return `<div class="field ${f.full ? 'full' : ''}" data-field="${f.path}"><label id="${id}-label" for="${id}">${esc(f.label)} ${required}</label>${control}<p class="field-hint" id="${id}-hint">${esc(f.hint || '')}</p><div class="field-error" id="${id}-error"></div></div>`;
  }
  function renderSection(section) { const all = E.fields(state); $(`#${section}-fields`).innerHTML = all.filter(f => f.path.startsWith(section + '.')).map(renderField).join(''); }
  function renderEntries(type) {
    const all = E.fields(state);
    const names = { education: '教育经历', work: '工作 / 实习经历', projects: '项目经历' };
    $(`#${type}-entries`).innerHTML = type === 'work' && state.noWork ? '<p class="field-hint">已选择暂无工作经历，可以继续填写项目经历。</p>' : state[type].map((entry, index) => `<article class="entry" data-entry="${esc(entry.id)}"><div class="entry-head"><span class="entry-badge">${String(index + 1).padStart(2, '0')}</span><span>${names[type]}</span><button type="button" class="entry-delete" data-remove="${type}" data-index="${index}" aria-label="删除第 ${index + 1} 段${names[type]}">删除</button></div><div class="field-grid">${all.filter(f => f.path.startsWith(`${type}.${index}.`)).map(renderField).join('')}</div></article>`).join('');
    $(`[data-add="${type}"]`).hidden = type === 'work' && state.noWork;
  }
  function render() {
    closePopup();
    ['intention', 'personal', 'additional'].forEach(renderSection);
    ['education', 'work', 'projects'].forEach(renderEntries);
    $('#no-work').checked = state.noWork; $('#truth').checked = state.truth; $('#privacy').checked = state.privacy;
    renderFile('resume'); renderFile('portfolio'); updateProgress(); renderErrors();
    if (state.status === 'submitted') lockSubmitted();
    if (runtime) {
      const pending = runtime.view.parserPending;
      $('#parser-state').hidden = !pending;
      $('#parser-state').textContent = pending ? '正在解析简历，完成后请核对回填信息…' : '';
      document.documentElement.dataset.parserPending = String(pending);
      if (runtime.view.manifest.endedAt) { ended = true; $('#application-form').inert = true; $('#save-draft').disabled = true; $('#preview-submit').disabled = true; $('#save-state').textContent = '本轮测评已结束'; }
    }
  }
  function renderFile(kind) {
    const file = state.files[kind];
    const container = $(`#${kind}-file-card`);
    container.hidden = !file;
    if (kind === 'resume') $('#resume-drop').hidden = Boolean(file);
    container.innerHTML = file ? `<span class="attachment-icon">${esc(file.name.split('.').pop().toUpperCase())}</span><span class="attachment-name">${esc(file.name)}<small>${(file.size / 1024).toFixed(1)} KB · 已保存在本机</small></span><button type="button" class="icon-button" data-remove-file="${kind}" aria-label="移除${kind === 'resume' ? '附件简历' : '作品集'}">×</button>` : '';
    if (kind === 'portfolio') container.classList.toggle('attachment-card', Boolean(file));
  }
  function updateProgress() {
    const allFields = E.fields(state), allErrors = E.validate(state);
    const p = E.progress(state); $('#completion-value').textContent = p.percent + '%'; $('#completion-progress').value = p.percent;
    for (const f of allFields) {
      const node = document.querySelector(`[data-field="${f.path}"]`);
      const label = node?.querySelector('label');
      if (label) label.innerHTML = `${esc(f.label)} ${f.required ? '<span class="required">*</span>' : '<span class="optional">选填</span>'}`;
      node?.querySelectorAll('input:not([type=checkbox]),select,textarea').forEach(input => { if (f.required) input.setAttribute('aria-required', 'true'); else input.removeAttribute('aria-required'); });
    }
    $('#completion-hint').textContent = p.percent === 100 ? '必填信息已齐全，请预览并核对。' : `已完成 ${p.count} / ${p.total} 项必填信息`;
    for (const [key] of E.SECTIONS) {
      const f = allFields.filter(item => item.path.startsWith(key + '.') && item.required);
      const complete = key === 'resume' ? !allErrors['files.resume'] : key === 'work' && state.noWork ? true : f.length > 0 && f.every(item => !allErrors[item.path]);
      const check = $(`[data-nav="${key}"] .nav-check`); if (check) check.textContent = complete ? '✓' : '';
    }
  }
  function renderErrors() {
    document.querySelectorAll('[data-field]').forEach(node => {
      const path = node.dataset.field, error = errors[path]; node.classList.toggle('has-error', Boolean(error));
      const output = node.querySelector('.field-error'); if (output) output.textContent = error || '';
      node.querySelectorAll('input,select,textarea,button.month-button').forEach(input => { if (error) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); });
    });
    $('#resume-error').textContent = errors['files.resume'] || '';
    $('#declaration-error').textContent = [errors.truth, errors.privacy].filter(Boolean).join('；');
    const entries = Object.entries(errors), banner = $('#error-summary');
    banner.hidden = !entries.length;
    banner.innerHTML = entries.length ? `<b>还有 ${entries.length} 项信息需要检查</b><div>${entries.slice(0, 6).map(([path, message]) => `<button type="button" data-error="${path}">${esc(message)}</button>`).join('')}</div>` : '';
  }

  // 候选项在固定延迟后出现；pointerdown 先保留焦点，避免真实点击被 blur 清空竞态吞掉。
  function openCombo(input) {
    closePopup();
    const popup = $(`#${input.id}-options`), path = input.dataset.path;
    let selectedIndex = -1, composing = false, timer, generation = 0, showAll = false;
    const options = () => Array.from(popup.querySelectorAll('[role=option]'));
    function refresh() {
      const currentGeneration = ++generation;
      const query = input.value.trim();
      popup.hidden = false; input.setAttribute('aria-expanded', 'true'); selectedIndex = -1;
      const rect = input.getBoundingClientRect();
      popup.classList.toggle('opens-up', innerHeight - rect.bottom < 325 && rect.top > 250);
      input.removeAttribute('aria-activedescendant'); popup.innerHTML = '<div class="combo-loading" role="status">正在查找匹配项…</div>';
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (generation !== currentGeneration) return;
        const source = E.SUGGESTIONS[input.dataset.combo];
        const matching = source.filter(item => !query || item.toLowerCase().includes(query.toLowerCase()));
        const sourceValues = matching.map(item => ({ value: item, custom: false }));
        const values = showAll ? sourceValues : sourceValues.slice(0, profile().optionLimit);
        if (query && !source.includes(query)) values.push({ value: query, custom: true });
        popup.innerHTML = (values.map((item, index) => `<button type="button" tabindex="-1" class="combo-option" role="option" id="${input.id}-o${index}" data-value="${esc(item.value)}" aria-selected="${E.get(state, path) === item.value}">${item.custom ? '使用「' + esc(item.value) + '」' : esc(item.value)}${item.custom ? '<small>没有合适选项？确认使用此内容</small>' : ''}</button>`).join('') || '<div class="combo-loading">请输入完整名称</div>') + (!showAll && sourceValues.length > values.length ? '<button type="button" class="combo-option" data-more="true">显示更多匹配项</button>' : '');
      }, profile().searchDelayMs);
    }
    function commit(value) {
      E.commitCombo(state, path, value); input.value = value; log('combo_commit', { path, source: E.SUGGESTIONS[input.dataset.combo].includes(value) ? 'option' : 'custom' });
      closePopup(); scheduleSave(); updateProgress();
      if (Object.keys(errors).length) { errors = E.validate(state); renderErrors(); }
    }
    function onInput() { refresh(); }
    function onPointerDown(event) { if (event.target.closest('[role=option],[data-more]')) event.preventDefault(); }
    function onClick(event) { if (event.target.closest('[data-more]')) { showAll = true; refresh(); return; } const option = event.target.closest('[role=option]'); if (option) commit(option.dataset.value); }
    function onKey(event) {
      if (event.isComposing || composing) return;
      if (event.key === 'Escape') { event.preventDefault(); closePopup(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const items = options(); if (!items.length) return;
        selectedIndex = selectedIndex < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1 : (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((item, index) => item.classList.toggle('highlighted', index === selectedIndex));
        input.setAttribute('aria-activedescendant', items[selectedIndex].id); items[selectedIndex].scrollIntoView({ block: 'nearest' });
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const items = options();
        if (items.length) commit(items[selectedIndex >= 0 ? selectedIndex : 0].dataset.value);
      }
    }
    function onStart() { composing = true; } function onEnd() { composing = false; refresh(); }
    function onBlur() { closePopup(); }
    activePopup = () => {
      ++generation; clearTimeout(timer); popup.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      if (profile().blur === 'exact' && E.SUGGESTIONS[input.dataset.combo].includes(input.value.trim())) {
        const value = input.value.trim(); if (E.get(state, path) !== value) { E.commitCombo(state, path, value); log('combo_commit', { path, source: 'exact_blur' }); scheduleSave(); updateProgress(); }
      }
      const result = E.resolveBlur(E.get(state, path), input.value);
      if (result.discarded) { log('combo_blur_discard', { path, queryLength: input.value.length, retainedPreviousValue: Boolean(result.value) }); scheduleSave(); }
      input.value = result.value;
      input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKey); input.removeEventListener('blur', onBlur);
      input.removeEventListener('compositionstart', onStart); input.removeEventListener('compositionend', onEnd);
      popup.removeEventListener('pointerdown', onPointerDown); popup.removeEventListener('click', onClick);
    };
    input.addEventListener('input', onInput); input.addEventListener('keydown', onKey); input.addEventListener('blur', onBlur);
    input.addEventListener('compositionstart', onStart); input.addEventListener('compositionend', onEnd);
    popup.addEventListener('pointerdown', onPointerDown); popup.addEventListener('click', onClick); refresh();
  }
  function openMonth(button) {
    if (button.disabled) return;
    if (button.getAttribute('aria-expanded') === 'true') { closePopup(); return; }
    closePopup();
    const path = button.dataset.path;
    const current = E.get(state, path);
    let year = current ? Number(current.split('-')[0]) : 2026;
    const panel = document.createElement('div'); panel.className = 'month-popup'; panel.role = 'dialog'; panel.setAttribute('aria-label', '选择' + E.fields(state).find(f => f.path === path).label);
    button.parentElement.appendChild(panel); button.setAttribute('aria-expanded', 'true');
    const rect = button.getBoundingClientRect();
    panel.classList.toggle('opens-up', innerHeight - rect.bottom < 360 && rect.top > 280);
    function draw() {
      panel.innerHTML = `<div class="month-top"><button type="button" data-year="-1" aria-label="上一年">‹</button><select aria-label="年份">${Array.from({ length: 51 }, (_, i) => i + 1990).map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select><button type="button" data-year="1" aria-label="下一年">›</button></div><div class="month-grid">${Array.from({ length: 12 }, (_, i) => `<button type="button" data-month="${String(i + 1).padStart(2, '0')}" class="${current === year + '-' + String(i + 1).padStart(2, '0') ? 'selected' : ''}">${i + 1} 月</button>`).join('')}</div><button type="button" class="month-clear">清除日期</button>`;
      if (profile().month === 'split') panel.querySelector('.month-grid').outerHTML = `<div class="field-grid"><select class="month-select" aria-label="月份"><option value="">请选择月份</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}" ${current?.split('-')[1] === String(i + 1).padStart(2, '0') ? 'selected' : ''}>${i + 1} 月</option>`).join('')}</select><button type="button" class="button primary" data-apply="true">确定</button></div>`;
    }
    panel.addEventListener('change', event => { if (event.target.matches('.month-top select')) { year = Number(event.target.value); draw(); } });
    panel.addEventListener('click', event => {
      const target = event.target.closest('button'); if (!target) return;
      if (target.dataset.year) { year = Math.max(1990, Math.min(2040, year + Number(target.dataset.year))); draw(); }
      else { const month = target.dataset.apply ? panel.querySelector('.month-select').value : target.dataset.month; if (target.dataset.apply && !month) { toast('请先选择月份'); return; } setValue(path, month ? year + '-' + month : '', 'month_commit'); closePopup(); button.querySelector('span').textContent = month ? year + ' 年 ' + month + ' 月' : '请选择年月'; button.classList.toggle('placeholder', !month); button.setAttribute('aria-label', E.fields(state).find(f => f.path === path).label + ' ' + (E.get(state, path) || '')); button.focus(); }
    });
    activePopup = () => { panel.remove(); button.setAttribute('aria-expanded', 'false'); };
    draw(); panel.querySelector('select').focus();
  }

  async function handleFile(file, kind) {
    if (!file || state.status === 'submitted') return;
    const error = E.validateFile(file, kind);
    if (error) { toast(error); log('upload_reject', { kind, reason: error }); return; }
    if (runtime) {
      try { await persist(); const view = await runtime.upload(kind, file); state.files = view.state.files; state.events = view.state.events; renderFile(kind); updateProgress(); $('#parser-state').hidden = !view.parserPending; $('#parser-state').textContent = view.parserPending ? '正在解析简历，完成后请核对回填信息…' : ''; document.documentElement.dataset.parserPending = String(view.parserPending); toast('附件已上传至本轮本地测评'); }
      catch (error) { toast(error.message); }
      finally { $(`#${kind}-file`).value = ''; }
      return;
    }
    try {
      const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      const ext = file.name.split('.').pop().toLowerCase();
      const signatures = { pdf: bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70 && bytes[4] === 45, doc: bytes[0] === 208 && bytes[1] === 207 && bytes[2] === 17 && bytes[3] === 224, docx: bytes[0] === 80 && bytes[1] === 75, zip: bytes[0] === 80 && bytes[1] === 75 };
      if (!signatures[ext]) { toast('文件内容与扩展名不符，请上传有效文件'); log('upload_reject', { kind, reason: 'signature_mismatch' }); return; }
      await storeFile('put', kind, file);
      state.files[kind] = { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified };
      log('upload_success', { kind }); renderFile(kind); updateProgress(); persist();
      if (Object.keys(errors).length) { errors = E.validate(state); renderErrors(); }
      toast('附件已保存至本机');
    } catch (error) { toast('附件保存失败：' + error.message); log('upload_error', { kind }); }
    finally { $(`#${kind}-file`).value = ''; }
  }
  function download(data, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function openModal(title, html, actions = []) {
    closePopup(); const modal = $('#modal'); if (!modal.open) lastFocus = document.activeElement;
    $('#modal-title').textContent = title; $('#modal-content').innerHTML = html; $('#modal-actions').replaceChildren();
    actions.forEach(({ text, kind, action }) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'button ' + (kind || 'secondary'); button.textContent = text; button.addEventListener('click', action); $('#modal-actions').appendChild(button); });
    if (!modal.open) modal.showModal();
    $('#modal-content').scrollTop = 0;
  }
  function closeModal() { $('#modal').close(); lastFocus?.focus(); }
  function previewHTML() {
    let html = '<p class="field-hint">请核对完整信息，确认后本轮申请将锁定。所有提交仅发生在本地。</p>';
    for (const [section, title] of E.SECTIONS) {
      html += `<h3>${esc(title)}</h3>`;
      if (section === 'resume') { html += `<div class="preview-entry">${esc(state.files.resume?.name)} · ${((state.files.resume?.size || 0) / 1024).toFixed(1)} KB</div>`; continue; }
      if (section === 'work' && state.noWork) { html += '<p>暂无工作或实习经历</p>'; continue; }
      const f = E.fields(state).filter(item => item.path.startsWith(section + '.'));
      html += '<div class="preview-grid">' + f.map(item => {
        const val = item.disabled ? '至今' : E.get(state, item.path);
        if (E.isEmpty(val)) return '';
        const number = ['education', 'work', 'projects'].includes(section) ? Number(item.path.split('.')[1]) + 1 + ' · ' : '';
        return `<div class="preview-item ${item.full ? 'wide' : ''}"><small>${number}${esc(item.label)}</small>${esc(Array.isArray(val) ? val.join('、') : val)}</div>`;
      }).join('') + '</div>';
    }
    if (state.files.portfolio) html += `<h3>作品集附件</h3><p>${esc(state.files.portfolio.name)}</p>`;
    return html;
  }
  function lockSubmitted() { $('#application-form').inert = true; $('#preview-submit').textContent = '查看投递结果'; $('#save-draft').disabled = true; $('#save-state').textContent = '✓ 本轮申请已提交'; }
  function showReceipt() {
    const receipt = state.submission;
    openModal('申请已提交', `<div class="success-state"><span class="success-icon">✓</span><h3>你的申请，我们收到了</h3><p>AI 产品经理 · 序光科技</p><p class="field-hint">本地申请编号：${esc(receipt.id)}<br>提交时间：${esc(new Date(receipt.at).toLocaleString('zh-CN'))}<br>本轮内容已锁定，认证测评结果由控制端生成。</p></div>`, [{ text: runtime ? '导出界面快照' : '导出投递结果', action: () => download(runtime ? { ...E.snapshot(state), format: 'career-ui-snapshot-v2', manifest: runtime.view.manifest } : E.snapshot(state), runtime ? 'unverified-ui-snapshot.json' : 'application-result.json') }, { text: '完成', kind: 'primary', action: closeModal }]);
  }
  async function preview() {
    if (state.status === 'submitted') { showReceipt(); return; }
    if (runtime) {
      closePopup();
      try {
        await persist(); const view = await runtime.preview(); state = view.state; errors = {}; renderErrors();
        openModal('预览申请资料', previewHTML(), [{ text: '返回修改', action: closeModal }, { text: '确认提交', kind: 'primary', action: async () => {
          $('#modal-actions .primary').disabled = true;
          try { const submitted = await runtime.submit(); state = submitted.state; lockSubmitted(); showReceipt(); }
          catch (error) { toast(error.message); $('#modal-actions .primary').disabled = false; }
        } }]);
      } catch (error) {
        if (error.code === 'FORM_INVALID') { errors = error.details; renderErrors(); $('#error-summary').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        toast(error.message);
      }
      return;
    }
    closePopup(); log('preview_attempt'); errors = E.validate(state); renderErrors();
    if (Object.keys(errors).length) { $('#error-summary').scrollIntoView({ block: 'center', behavior: 'smooth' }); toast(`请先完成 ${Object.keys(errors).length} 项信息校验`); persist(); return; }
    log('preview_open');
    openModal('预览申请资料', previewHTML(), [{ text: '返回修改', action: closeModal }, { text: '确认提交', kind: 'primary', action: async () => {
      const submit = $('#modal-actions .primary'); submit.disabled = true;
      // 最终提交再次校验附件本体及字段，提交号只创建一次，重复点击不能产生多份记录。
      for (const kind of Object.keys(state.files)) {
        const saved = await storeFile('get', kind).catch(() => null);
        if (!saved) { delete state.files[kind]; errors = E.validate(state); renderFile(kind); renderErrors(); updateProgress(); closeModal(); toast('本地附件已丢失，请重新上传'); return; }
      }
      errors = E.validate(state);
      if (Object.keys(errors).length) { closeModal(); renderErrors(); return; }
      state.status = 'submitted'; state.submission = { id: 'SG-' + Date.now().toString(36).toUpperCase(), at: new Date().toISOString() };
      log('submission_success'); persist(); lockSubmitted(); showReceipt();
    } }]);
  }
  function showConsole() {
    const result = E.snapshot(state);
    if (runtime) {
      openModal('本轮测评状态', `<p>场景：${esc(runtime.view.manifest.scenarioId)} / ${esc(runtime.view.manifest.scenarioVersion)}<br>轮次：${esc(runtime.id)}<br>目标：${esc(runtime.view.manifest.goal)} · seed ${runtime.view.manifest.seed}<br>状态：${ended ? '已结束' : state.status === 'submitted' ? '已提交' : '填写中'}</p><p>本轮资料、实际附件和事件独立存于本地服务。自动评分与结束清理由控制端完成；界面快照不作为认证结果。</p><pre class="console-log">${esc(state.events.slice(-50).map(event => `${event.sequence || '-'} ${event.type} ${event.path || ''}`).join('\n'))}</pre>`, [{ text: '新建手工体验轮次', action: () => { location.href = '/?scenario=' + encodeURIComponent(runtime.view.manifest.scenarioId); } }, { text: '导出界面快照', action: () => download({ format: 'career-ui-snapshot-v2', manifest: runtime.view.manifest, ...E.snapshot(state) }, 'unverified-ui-snapshot.json') }, { text: '关闭', kind: 'primary', action: closeModal }]);
      return;
    }
    openModal('测评控制台', `<p>场景：<b>career-portal-hard-v1</b> · 基准日期：2026-10-30<br>预览与提交仅在本机进行，数据不会发往任何外部服务。</p><div class="console-stats"><span>完整度 ${result.completeness.percent}%</span><span>失焦丢弃 ${result.metrics.blurDiscards} 次</span><span>确认选择 ${result.metrics.confirmedSelections} 次</span><span>预览尝试 ${result.metrics.submitAttempts} 次</span><span>状态 ${state.status === 'submitted' ? '已提交' : '草稿'}</span></div><p>姓名等普通文本框正常保存。学校、专业、公司为确认型控件：搜索文字与已确认值独立，未确认文字失焦后丢弃；若已有选择，则恢复原选择。</p><h3>当前校验</h3><pre class="console-log">${esc(JSON.stringify(result.validationErrors, null, 2))}</pre><h3>操作记录（最近 60 条 / 共 ${state.events.length} 条）</h3><pre class="console-log">${esc(state.events.slice(-60).map(event => `${event.at.slice(11, 23)}  ${event.type} ${event.path || event.kind || ''}`).join('\n')) || '暂无记录'}</pre><p class="field-hint">附件本体保存在浏览器 IndexedDB；导出的 JSON 含文件元数据与表单快照，不包含附件本体。${esc(storageError)}</p>`, [{ text: '开始新一轮', kind: 'danger', action: confirmReset }, { text: '导出测评记录', action: () => download(E.snapshot(state), 'application-evaluation.json') }, { text: '关闭', kind: 'primary', action: closeModal }]);
  }
  function confirmReset() {
    openModal('开始新一轮测评？', '<p>这会清除本平台的草稿、附件、操作记录与提交结果。其他网站和 Avery 的数据不会受到影响。</p><p>如需保留本轮结果，请先导出测评记录。</p>', [{ text: '返回', action: showConsole }, { text: '清空并重新开始', kind: 'danger', action: async () => {
      try {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        if (database) { await storeFile('delete', 'resume'); await storeFile('delete', 'portfolio'); }
        localStorage.removeItem(KEY); state = E.initialState(); errors = {}; $('#application-form').inert = false; $('#save-draft').disabled = false; $('#preview-submit').innerHTML = '预览并提交 <span>→</span>'; $('#save-state').textContent = '尚未保存';
        render(); closeModal(); window.scrollTo({ top: 0, behavior: 'instant' }); toast('已开始新一轮测评');
      } catch { toast('重置失败，请检查浏览器本地存储权限'); }
    } }]);
  }

  $('#section-links').innerHTML = E.SECTIONS.map(([key, title], index) => `<li><a href="#${key}" data-nav="${key}"><span class="nav-index">${String(index + 1).padStart(2, '0')}</span>${title}<span class="nav-check"></span></a></li>`).join('');
  try {
    runtime = await window.CareerRuntime.connect();
    if (runtime) { state = runtime.view.state; $('#save-state').textContent = '✓ 已载入独立测评轮次'; }
    else {
    database = await openDatabase();
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const draft = JSON.parse(raw);
      if (draft.version !== E.VERSION || !['education', 'work', 'projects', 'events'].every(key => Array.isArray(draft[key])) || !draft.personal || !draft.intention || !draft.additional || !draft.files) throw new Error('草稿格式不匹配，请在测评控制台重置');
      state = draft;
      for (const kind of Object.keys(state.files)) { if (!await storeFile('get', kind)) { delete state.files[kind]; toast('未找到本地附件，请重新上传'); } }
      $('#save-state').textContent = '✓ 已恢复本地草稿';
    }
    }
  } catch (error) {
    storageError = error.message || '本地存储初始化失败'; toast(storageError);
    if (/^\/runs\//.test(location.pathname)) { $('#application-form').inert = true; $('#save-draft').disabled = true; $('#preview-submit').disabled = true; $('#save-state').textContent = '测评轮次加载失败'; document.documentElement.dataset.ready = 'error'; return; }
  }
  render();
  if (!runtime) $('.local-status').lastChild.textContent = '手工演示 · 无认证评分';
  document.documentElement.dataset.ready = 'true';

  $('#application-form').addEventListener('submit', event => event.preventDefault());
  document.addEventListener('focusin', event => { if (event.target.matches('[data-combo]')) openCombo(event.target); });
  document.addEventListener('pointerdown', event => { if (activePopup && !event.target.closest('.combo-shell,.month-shell')) closePopup(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closePopup(); });
  $('#application-form').addEventListener('input', event => {
    const input = event.target, path = input.dataset.path;
    if (input.dataset.combo) { if (input.getAttribute('aria-expanded') !== 'true') openCombo(input); return; }
    if (!path || input.type === 'radio' || input.tagName === 'SELECT') return;
    setValue(path, input.value);
    const counter = document.querySelector(`[data-count="${path}"]`); if (counter) counter.textContent = input.value.length;
  });
  $('#application-form').addEventListener('change', event => {
    const input = event.target;
    if (input.id === 'resume-file' || input.id === 'portfolio-file') { void handleFile(input.files[0], input.id === 'resume-file' ? 'resume' : 'portfolio'); return; }
    if (input.dataset.combo) return;
    if (input.dataset.current) { setValue(input.dataset.current, input.checked); renderEntries(input.dataset.current.split('.')[0]); renderErrors(); return; }
    if (input.id === 'no-work') { state.noWork = input.checked; log('no_work_toggle'); scheduleSave(); renderEntries('work'); errors = Object.keys(errors).length ? E.validate(state) : {}; renderErrors(); updateProgress(); return; }
    if (['truth', 'privacy'].includes(input.id)) { setValue(input.id, input.checked); return; }
    const path = input.dataset.path;
    if (path && (input.tagName === 'SELECT' || input.type === 'radio')) {
      setValue(path, input.value);
      if (path.startsWith('intention.')) renderSection('intention');
      else if (['personal.province', 'personal.documentType'].includes(path)) renderSection('personal');
      else if (path === 'additional.english') renderSection('additional');
      else if (path.endsWith('.gpaScale')) { errors = Object.keys(errors).length ? E.validate(state) : {}; }
      renderErrors();
    }
  });
  document.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.add) {
      const type = target.dataset.add; if (state[type].length >= 8) { toast('每类最多添加 8 段经历'); return; }
      state[type].push(E.emptyEntry(type, `${type}-${state.nextId++}`)); log('entry_add', { kind: type }); renderEntries(type); scheduleSave(); updateProgress();
    } else if (target.dataset.remove) {
      const type = target.dataset.remove, index = Number(target.dataset.index);
      openModal('删除这段经历？', '<p>该段已填写的信息将被删除，其他经历不受影响。</p>', [{ text: '取消', action: closeModal }, { text: '确认删除', kind: 'danger', action: () => { state[type].splice(index, 1); log('entry_remove', { kind: type }); renderEntries(type); errors = Object.keys(errors).length ? E.validate(state) : {}; renderErrors(); scheduleSave(); updateProgress(); closeModal(); } }]);
    } else if (target.dataset.tag) {
      const tags = state.additional.skills, value = target.dataset.tag, index = tags.indexOf(value);
      if (index >= 0) tags.splice(index, 1); else tags.push(value);
      target.setAttribute('aria-pressed', String(tags.includes(value))); log('skills_change'); scheduleSave(); updateProgress();
      if (Object.keys(errors).length) { errors = E.validate(state); renderErrors(); }
    } else if (target.matches('.month-button')) openMonth(target);
    else if (target.dataset.removeFile) {
      const kind = target.dataset.removeFile;
      if (runtime) {
        try { await persist(); const view = await runtime.removeFile(kind); state.files = view.state.files; state.events = view.state.events; renderFile(kind); updateProgress(); $('#parser-state').hidden = true; document.documentElement.dataset.parserPending = 'false'; }
        catch (error) { toast(error.message); }
        return;
      }
      try { await storeFile('delete', kind); delete state.files[kind]; log('upload_remove', { kind }); renderFile(kind); updateProgress(); persist(); }
      catch { toast('附件删除失败，请重试'); }
    } else if (target.dataset.error) {
      const path = target.dataset.error, element = document.getElementById(idFor(path)) || document.getElementById(path === 'files.resume' ? 'resume' : path) || $('#declaration-error');
      element.scrollIntoView({ block: 'center', behavior: 'smooth' }); element.focus({ preventScroll: true });
    } else if (target.dataset.info) openModal(target.dataset.info, '<p>这是离线招聘模拟站点。为保持测评路径稳定，当前仅开放申请表、资料预览和本地提交。</p>', [{ text: '返回填写', kind: 'primary', action: closeModal }]);
  });
  const drop = $('#resume-drop');
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragging'); void handleFile(event.dataTransfer.files[0], 'resume'); });
  $('#save-draft').addEventListener('click', () => { closePopup(); Promise.resolve(persist(true)).catch(() => undefined); });
  $('#preview-submit').addEventListener('click', preview);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', event => { if (event.target === $('#modal')) closeModal(); });
  $('#console-open').addEventListener('click', showConsole);
  $('#privacy-link').addEventListener('click', () => openModal('候选人隐私声明', `<div class="privacy-body"><p>本页面为离线 Agent 网申测评环境，并非任何真实企业的招聘官网。</p><p>${runtime ? '资料、附件及操作记录仅保存于本机测评服务，每轮独立存储。控制端结束轮次后可以清理活动资料，保留签名结果用于复核。' : '资料、附件及操作记录仅保存在当前浏览器的本地存储中。'}</p><p>页面不访问外部招聘接口，不进行实际招聘投递。资料用于本次本地表单填写、预览和测评。</p><p>请使用合成测试资料。是否同意由你在申请表中自行勾选，阅读声明不会自动同意。</p></div>`, [{ text: '我已阅读', kind: 'primary', action: closeModal }]));
  $('#job-details').addEventListener('click', () => openModal('AI 产品经理 · J10934', '<h3>和好的想法，一起发生</h3><p>序光科技 · 产品与体验 · 杭州 / 广州</p><h3>你将参与</h3><p>1. 参与 AI 应用的需求分析、场景研究与产品设计。<br>2. 和设计、研发一起完成原型、验证与迭代。<br>3. 通过用户反馈和数据分析持续提升产品体验。</p><h3>我们期待</h3><p>本科及以上，对 AI 产品有持续关注；善于沟通，能清晰表达复杂问题。实习每周至少 3 天，持续至少 3 个月。</p><p class="field-hint">此职位为本地测评虚构岗位，不代表真实招聘机会。</p>', [{ text: '继续申请', kind: 'primary', action: closeModal }]));
  window.addEventListener('pagehide', () => { if (saveTimer && !runtime) persist(); });
  // Runner 可在结束前等待 flush，确保最后一次输入已落到本轮服务；不暴露答案或控制权限。
  window.CareerBench = Object.freeze({ flush: async () => {
    // 保存与解析的版本交替变化时仅做有界的状态收敛；无法稳定必须向控制端报告同步失败。
    for (let attempt = 0; attempt < 10; attempt++) {
      await persist();
      if (!saveTimer && !outbox.length && !saving) {
        if (runtime && !ended) {
          const view = await runtime.load();
          if (saveTimer || outbox.length || saving) continue;
          const changed = view.revision !== runtime.revision;
          runtime.adopt(view);
          if (changed) { remoteEpoch++; state = view.state; render(); }
          document.documentElement.dataset.parserPending = String(view.parserPending);
        }
        return { revision: runtime?.revision ?? null, parserPending: runtime?.view.parserPending ?? false };
      }
    }
    throw new Error('资料仍在更新，无法确认最后一次输入已保存');
  } });
  document.documentElement.dataset.syncState = 'saved';
  if (runtime) setInterval(async () => {
    if (saving || polling || saveTimer || outbox.length || activePopup || ended) return;
    polling = true;
    try {
      const revision = runtime.revision;
      const view = await runtime.load();
      if (saving || saveTimer || outbox.length) return;
      runtime.adopt(view);
      if (view.revision !== revision || view.manifest.endedAt) { remoteEpoch++; state = view.state; render(); if (view.revision !== revision) toast('简历解析结果已更新，请核对填写内容'); }
      else { state.events = view.state.events; document.documentElement.dataset.parserPending = String(view.parserPending); }
    } catch (error) { $('#save-state').textContent = '本轮服务连接失败'; document.documentElement.dataset.syncState = 'error'; if (error.code === 'RUN_NOT_FOUND') { ended = true; $('#application-form').inert = true; } }
    finally { polling = false; }
  }, 500);
  const updateNavigation = () => {
    let active = E.SECTIONS[0][0];
    for (const [section] of E.SECTIONS) if (document.getElementById(section).getBoundingClientRect().top < 160) active = section;
    document.querySelectorAll('[data-nav]').forEach(node => { node.classList.toggle('active', node.dataset.nav === active); if (node.dataset.nav === active) node.setAttribute('aria-current', 'location'); else node.removeAttribute('aria-current'); });
  };
  let scrollFrame = 0;
  window.addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateNavigation(); }); }, { passive: true });
  updateNavigation();
})();
