import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CjkTextIcon, Icon } from '../../../shared/components/Icon';
import { DialogButton, Modal } from '../../../shared/components/UI';
import { useUiStore } from '../../../app/UiStore';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { ComposerCommands, CreateSkillCommands, FilterComposerCommands, SplitCompactCommandDraft, ParseSlashContext, SlashSignature, type ComposerCommand, type ComposerMode, type SlashContext } from '../composerCommands';

interface Props {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLSpanElement | null>;
  sessionId: string | null;
  scenarioId: 'default' | 'application';
  busy: boolean;
  placeholder: string;
  skill: ComposerCommand | null;
  mode: ComposerMode | null;
  onSkillChange: (skill: ComposerCommand | null) => void;
  onModeChange: (mode: ComposerMode | null) => void;
  onSend: () => void;
  onReload: () => Promise<boolean>;
  onCompositionChange: (composing: boolean) => void;
  reloadTrigger: number;
}

/** 正文与标签共用首行，标签独立于可编辑 DOM，避免混入请求文本和字符偏移。 */
export function ComposerInput({ value, onChange, inputRef, sessionId, scenarioId, busy, placeholder, skill, mode, onSkillChange, onModeChange, onSend, onReload, onCompositionChange, reloadTrigger }: Props) {
  const { ShowNotice } = useUiStore();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const mounted = useRef(true);
  const valueRef = useRef(value); valueRef.current = value;
  const skillRef = useRef(skill); skillRef.current = skill;
  const dismissed = useRef<string | null>(null);
  const [context, setContext] = useState<SlashContext | null>(null);
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const [height, setHeight] = useState(312);
  const [skills, setSkills] = useState<ComposerCommand[]>([]);
  const [skillState, setSkillState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [pendingReload, setPendingReload] = useState<SlashContext | null>(null);
  const [reloading, setReloading] = useState(false);
  const [placeholderMode, setPlaceholderMode] = useState<ComposerMode | null>(null);
  const lastContext = useRef<SlashContext | null>(null);
  if (context) lastContext.current = context;
  const query = context?.query ?? lastContext.current?.query ?? '';
  const commands = useMemo(() => [...ComposerCommands, ...skills], [skills]);
  const matches = useMemo(() => FilterComposerCommands(commands, query), [commands, query]);
  const open = context !== null && !busy && !pendingReload && !reloading && !placeholderMode;
  const current = matches[Math.min(active, Math.max(0, matches.length - 1))];
  const { prefix: commandPrefix, text: editorValue } = SplitCompactCommandDraft(value);
  const compactCommand = commandPrefix ? ComposerCommands.find((command) => command.action === 'compact') : undefined;
  const previousCommandPrefix = useRef(commandPrefix);

  const Selection = useCallback(() => {
    const input = inputRef.current, selection = window.getSelection();
    if (!input || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!input.contains(range.startContainer) || !input.contains(range.endContainer)) return null;
    const before = range.cloneRange(); before.selectNodeContents(input); before.setEnd(range.startContainer, range.startOffset);
    const through = range.cloneRange(); through.selectNodeContents(input); through.setEnd(range.endContainer, range.endOffset);
    return { start: before.toString().length, end: through.toString().length };
  }, [inputRef]);

  const Caret = useCallback((offset: number) => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode(), last = node, remaining = offset;
    while (node) {
      last = node;
      if (remaining <= (node.textContent?.length ?? 0)) break;
      remaining -= node.textContent?.length ?? 0; node = walker.nextNode();
    }
    const range = document.createRange();
    // 空编辑器只有占位 br 时仍可把光标定位到正文开头，不插入会污染草稿的隐藏字符。
    if (last) range.setStart(last, Math.min(remaining, last.textContent?.length ?? 0));
    else range.setStart(input, 0);
    range.collapse(true);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    if (offset === 0) { const editor = root.current?.querySelector('.slash-editor-line'); if (editor) editor.scrollTop = 0; }
  }, [inputRef]);

  const Update = useCallback((force = false) => {
    const input = inputRef.current, selection = Selection();
    const next = input && document.activeElement === input && selection && !commandPrefix && !composing.current && !busy && !reloading
      ? ParseSlashContext(input.textContent ?? '', selection.start, selection.end) : null;
    const accepted = next && (force || dismissed.current !== SlashSignature(next)) ? next : null;
    setContext((old) => old?.value === accepted?.value && old?.end === accepted?.end ? old : accepted);
  }, [Selection, inputRef, busy, reloading, commandPrefix]);

  const Dismiss = useCallback(() => {
    if (context) dismissed.current = SlashSignature(context);
    setContext(null);
  }, [context]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onCompositionChange(false); }; }, [onCompositionChange]);
  const previousReloadTrigger = useRef(reloadTrigger);
  useEffect(() => {
    if (pendingReload) document.getElementById(`${id}-reload-cancel`)?.focus({ preventScroll: true });
  }, [pendingReload, id]);
  useEffect(() => {
    if (previousReloadTrigger.current === reloadTrigger) return;
    previousReloadTrigger.current = reloadTrigger;
    const text = valueRef.current;
    const token = /^\/reload(?:-session)?(?=\s|$)/.exec(text);
    if (token) {
      setPendingReload({ value: text, end: token[0].length, query: 'reload' }); setContext(null);
    }
  }, [reloadTrigger]);
  useEffect(() => {
    let live = true;
    setSkills([]); setSkillState('loading');
    void Unwrap(platformClient.agent.GetCommandSkills({ ...(sessionId ? { sessionId } : {}), scenarioId })).then((items) => {
      if (live) {
        setSkills(CreateSkillCommands(items)); setSkillState('ready');
        if (skillRef.current && !items.some((item) => item.id === skillRef.current?.skillId)) {
          onSkillChange(null); ShowNotice('原先选择的技能在当前场景不可用，已移除标签，正文保留。');
        }
      }
    }).catch(() => { if (live) setSkillState('error'); });
    return () => { live = false; };
  }, [sessionId, scenarioId, catalogRevision, onSkillChange, ShowNotice]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || composing.current) return;
    const selection = Selection();
    const focused = document.activeElement === input;
    const previousPrefix = previousCommandPrefix.current;
    previousCommandPrefix.current = commandPrefix;
    // 仅同步外部预填或发送清空；普通输入保持浏览器的光标与输入法 DOM。
    if (input.textContent !== editorValue) {
      input.textContent = editorValue;
      // 从手输命令切换成标签时，光标偏移需扣除移出编辑区的命令，后缀仍可正常编辑。
      if (focused && selection && selection.start === selection.end) Caret(Math.max(0, selection.start + previousPrefix.length - commandPrefix.length));
    }
    const sentinel = input.querySelector('br[data-sentinel]');
    // 空的行内 contenteditable 没有稳定的光标行盒；原生 br 建立编辑行，占位文案留在外部。
    if (!editorValue && (input.childNodes.length !== 1 || !sentinel)) {
      const focused = document.activeElement === input;
      const br = document.createElement('br'); br.dataset.sentinel = 'true'; input.replaceChildren(br);
      if (focused) Caret(0);
    }
    else if (editorValue.endsWith('\n') && !sentinel) { const br = document.createElement('br'); br.dataset.sentinel = 'true'; input.append(br); }
    else if (editorValue && !editorValue.endsWith('\n')) sentinel?.remove();
    Update();
  }, [editorValue, commandPrefix, inputRef, Update, Caret, Selection]);
  useEffect(() => {
    const SelectionChanged = () => Update();
    const Outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) Dismiss(); };
    document.addEventListener('selectionchange', SelectionChanged); document.addEventListener('pointerdown', Outside);
    return () => { document.removeEventListener('selectionchange', SelectionChanged); document.removeEventListener('pointerdown', Outside); };
  }, [Update, Dismiss]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (open) { setPhase('open'); return; }
    if (phase === 'closed') return;
    setPhase('closing');
    const timer = window.setTimeout(() => setPhase('closed'), 120);
    return () => window.clearTimeout(timer);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const Fit = () => {
      const composer = root.current?.closest('.composer');
      if (composer) setHeight(Math.max(32, Math.min(312, composer.getBoundingClientRect().top - (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) - 16)));
    };
    Fit(); const observer = new ResizeObserver(Fit);
    if (root.current) observer.observe(root.current);
    window.addEventListener('resize', Fit); window.addEventListener('scroll', Fit, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', Fit); window.removeEventListener('scroll', Fit, true); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !list.current || !current) return;
    const row = document.getElementById(`${id}-${current.id}`), container = list.current;
    if (!row) return;
    const deltaTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    if (deltaTop < 0) container.scrollTop += deltaTop;
    else if (deltaTop + row.offsetHeight > container.clientHeight) container.scrollTop += deltaTop + row.offsetHeight - container.clientHeight;
  }, [current?.id, open, id]);

  function Write(next: string, position: number) {
    if (!inputRef.current) return;
    const draft = SplitCompactCommandDraft(next);
    inputRef.current.textContent = draft.text; valueRef.current = next;
    onChange(next); dismissed.current = null; Caret(Math.max(0, position - draft.prefix.length));
  }
  function ChangeEditor(next: string) { onChange(compactCommand ? `${compactCommand.token} ${next}` : next); }
  function Consume(selected: SlashContext) {
    if (valueRef.current !== selected.value) return false;
    Write(selected.value.slice(selected.end), 0); setContext(null); return true;
  }
  function Choose(command: ComposerCommand) {
    if (!context || busy || reloading) return;
    if (command.action === 'compact') {
      if (skill || mode) { ShowNotice('请先移除技能或模式标签，再选择压缩上下文。'); return; }
      const suffix = context.value.slice(context.end);
      Write(`/compact${/^\s/.test(suffix) ? '' : ' '}${suffix}`, '/compact '.length);
      Dismiss(); return;
    }
    if (command.action === 'reload') { setPendingReload(context); Dismiss(); return; }
    if (!Consume(context)) return;
    if (command.action === 'skill') onSkillChange(command);
    if (command.action === 'placeholder') {
      if (command.mode) { onModeChange(command.mode); setPlaceholderMode(command.mode); }
      else ShowNotice(`${command.label}功能暂未接入，当前仅为占位。`);
    }
  }
  function Insert(text: string) {
    const selection = Selection() ?? { start: editorValue.length, end: editorValue.length };
    const prefix = compactCommand ? `${compactCommand.token} ` : '';
    Write(prefix + editorValue.slice(0, selection.start) + text + editorValue.slice(selection.end), prefix.length + selection.start + text.length);
  }
  async function Reload() {
    const pending = pendingReload;
    if (!pending || reloading) return;
    if (pending.value !== valueRef.current) { setPendingReload(null); ShowNotice('草稿已变化，请重新选择重载上下文。'); return; }
    setReloading(true);
    try {
      const success = await onReload();
      if (!mounted.current) return;
      if (success) { Consume(pending); setCatalogRevision((revision) => revision + 1); }
      else { dismissed.current = SlashSignature(pending); Caret(pending.end); }
    } finally { if (mounted.current) { setReloading(false); setPendingReload(null); } }
  }
  function CloseReload() {
    if (reloading) return;
    const pending = pendingReload; setPendingReload(null);
    if (pending) { dismissed.current = SlashSignature(pending); Caret(pending.end); }
  }

  const chips = [
    ...(mode ? [{ key: 'mode', token: `/${mode}`, icon: 'target' as const, label: '目标模式（功能未完善）', remove: () => onModeChange(null) }] : []),
    ...(skill ? [{ key: 'skill', token: skill.token, icon: skill.icon, label: skill.label, remove: () => onSkillChange(null) }] : []),
  ];
  return <div ref={root} className="slash-input-root">
    {phase !== 'closed' && <div className={`slash-palette is-${phase}`} aria-hidden={!open}>
      <div ref={list} className="slash-list" id={`${id}-commands`} role="listbox" aria-label="命令与技能" style={{ maxHeight: height }}>
        {matches.map((command, index) => <Fragment key={command.id}>
          {(index === 0 || matches[index - 1].kind !== command.kind) && <div className="slash-group" role="presentation">{command.kind === 'skill' ? '技能 · 指定调用' : '命令'}</div>}
          <button id={`${id}-${command.id}`} className="slash-option" type="button" role="option" aria-selected={current?.id === command.id} tabIndex={-1}
            title={`${command.label} · ${command.description} (${command.token})`} onPointerDown={(event) => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => Choose(command)}>
            <span className="slash-option-main"><span className="slash-option-title"><CjkTextIcon name={command.icon} className="slash-glyph" size={15} />{command.label}</span><span className="slash-description">{command.description}</span><span className="slash-token">{command.token}</span></span><span className="slash-enter" aria-hidden="true">↵</span>
          </button>
        </Fragment>)}
        {skillState === 'loading' && <div className="slash-state" role="status">正在读取可用技能…</div>}
        {skillState === 'error' && <div className="slash-state" role="status">技能加载失败<button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => setCatalogRevision((revision) => revision + 1)}>重试</button></div>}
        {!matches.length && skillState === 'ready' && <div className="slash-empty">没有匹配的命令或技能<small>继续修改关键词，或按 Esc 保留输入并收起</small></div>}
      </div>
    </div>}
    <div className="slash-editor-line" onClick={(event) => { if (event.target === event.currentTarget) Caret(editorValue.length); }}>
      <span className="slash-chips" aria-label="当前模式与技能">{chips.map((chip) => <span key={chip.key} className="slash-chip" title={chip.key === 'skill' ? `${chip.label} · 在正文开头按 Backspace 或 Delete 移除` : chip.label}>
        <CjkTextIcon name={chip.icon} size={16} /><span>{chip.token}</span>{chip.key === 'mode' && <button type="button" aria-label={`移除${chip.label}`} disabled={busy || reloading} onClick={() => { chip.remove(); Caret(Selection()?.end ?? 0); }}><Icon name="close" size={11} /></button>}
      </span>)}</span>
      {compactCommand && <span className="slash-chip" title="压缩上下文 · 在正文开头按 Backspace 或 Delete 整体移除"><CjkTextIcon name={compactCommand.icon} size={16} /><span>{compactCommand.token}</span></span>}
      <span ref={inputRef} className={`slash-editor${!editorValue ? ' is-empty' : ''}`} contentEditable={reloading ? false : 'plaintext-only'} suppressContentEditableWarning role="combobox" aria-label="消息输入框" aria-placeholder={placeholder} aria-multiline="true" aria-autocomplete="list" aria-haspopup="listbox" aria-controls={`${id}-commands`} aria-expanded={open} aria-activedescendant={open && current ? `${id}-${current.id}` : undefined} aria-disabled={reloading} spellCheck={false}
        onInput={(event) => { dismissed.current = null; ChangeEditor(event.currentTarget.textContent ?? ''); Update(); }} onFocus={() => Update()} onClick={() => Update()} onKeyUp={() => Update()} onBlur={() => { if (!pendingReload && !placeholderMode) Dismiss(); }}
        onCompositionStart={() => { composing.current = true; onCompositionChange(true); setContext(null); }} onCompositionEnd={(event) => { composing.current = false; onCompositionChange(false); dismissed.current = null; ChangeEditor(event.currentTarget.textContent ?? ''); Update(); }}
        onPaste={(event) => { event.preventDefault(); Insert(event.clipboardData.getData('text/plain')); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
          if (reloading) { event.preventDefault(); return; }
          // 压缩标签不在可编辑 DOM 中，只在正文句首消费删除键，保留后缀及其原生删除行为。
          if (compactCommand && !busy && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === 'Backspace' || event.key === 'Delete')) {
            const selection = Selection();
            if (selection?.start === 0 && selection.end === 0) {
              event.preventDefault(); event.stopPropagation(); Write(editorValue, 0); setContext(null); return;
            }
          }
          // 技能位于正文之前：仅在正文句首且没有文本选区时消费删除键，不吞掉正文删除操作。
          if (skill && !busy && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === 'Backspace' || event.key === 'Delete')) {
            const selection = Selection();
            if (selection?.start === 0 && selection.end === 0) {
              event.preventDefault(); event.stopPropagation(); onSkillChange(null); Caret(0); return;
            }
          }
          if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); Dismiss(); return; }
          if (event.key === 'ArrowDown' && !open && !commandPrefix) { const selection = Selection(); if (selection && ParseSlashContext(editorValue, selection.start, selection.end)) { event.preventDefault(); dismissed.current = null; Update(true); return; } }
          if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setActive((index) => Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return; }
          if (open && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) { event.preventDefault(); if (current) Choose(current); return; }
          if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) Insert('\n'); else { Dismiss(); onSend(); } }
        }} />
      {!editorValue && <span className="slash-placeholder" aria-hidden="true">{placeholder}</span>}
    </div>
    <Modal open={pendingReload !== null} title="重载当前会话上下文？" onClose={CloseReload} footer={<><DialogButton id={`${id}-reload-cancel`} disabled={reloading} onClick={CloseReload}>取消</DialogButton><DialogButton tone="accent" disabled={reloading} onClick={() => void Reload()}>{reloading ? '正在重载…' : '确认重载'}</DialogButton></>}>
      更新当前会话的上下文配置与技能索引。消息和草稿正文会保留，不会重新加载应用。
    </Modal>
    <Modal open={placeholderMode !== null} title="目标模式尚未完善" onClose={() => { setPlaceholderMode(null); Caret(0); }} footer={<DialogButton tone="accent" onClick={() => { setPlaceholderMode(null); Caret(0); }}>我知道了</DialogButton>}>
      当前版本仅提供模式占位标签，暂未启用对应执行能力。发送消息后仍按普通模式处理，你可以点击标签旁的 × 移除。
    </Modal>
  </div>;
}
