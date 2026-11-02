import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { SelectMenu } from './SelectMenu';
import { GetNextEnabledOption } from './selectMenuLayout';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  children: ReactNode;
}

function Button({ variant = 'secondary', className = '', children, ...props }: ButtonProps) {
  return <button className={`button button-${variant} ${className}`} type="button" {...props}>{children}</button>;
}

function PageHeader({ eyebrow, title, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-header">
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </div>;
}

function EmptyState({ icon = <Icon name="assistant" size={24} />, title, description, action, className = '', role, ariaLive }: { icon?: ReactNode; title: string; description: string; action?: ReactNode; className?: string; role?: 'status' | 'alert'; ariaLive?: 'polite' | 'assertive' }) {
  return <div className={`empty-state ${className}`} role={role} aria-live={ariaLive}>
    <div className="empty-state-icon" aria-hidden="true">{icon}</div>
    <h2>{title}</h2>
    <p>{description}</p>
    {action}
  </div>;
}

function useDialogKeyboard(open: boolean, onClose: () => void, containerRef: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  let previous: HTMLElement | null = null;
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    const focusable = () => Array.from(container?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
    const first = focusable()[0];
    first?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [containerRef, open]);
}

function IsDrawerForm(node: ReactNode): node is ReactElement<{ className?: string; children?: ReactNode }> {
  return isValidElement<{ className?: string; children?: ReactNode }>(node) && typeof node.props.className === 'string' && node.props.className.split(' ').includes('drawer-form');
}

function IsDrawerActionBar(node: ReactNode): node is ReactElement<{ className?: string }> {
  return isValidElement<{ className?: string }>(node) && typeof node.props.className === 'string' && node.props.className.split(' ').includes('drawer-actions');
}

function Drawer({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  useDialogKeyboard(open, onClose, drawerRef);
  if (!open) return null;
  const childList = Children.toArray(children);
  const form = childList.length === 1 && IsDrawerForm(childList[0]) ? childList[0] : null;
  const formChildren = form ? Children.toArray(form.props.children) : [];
  const actionIndex = formChildren.findIndex(IsDrawerActionBar);
  const footer = actionIndex >= 0 ? formChildren[actionIndex] : null;
  const content = form && actionIndex >= 0
    ? cloneElement(form, { className: `${form.props.className} drawer-form-content` }, formChildren.filter((_, index) => index !== actionIndex))
    : children;
  return <div className="drawer-layer" role="presentation">
    <button className="drawer-backdrop" aria-label="关闭抽屉" onClick={onClose} />
    <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="drawer-header"><h2 id={titleId}>{title}</h2><Button variant="quiet" className="icon-close" aria-label="关闭" onClick={onClose}><Icon name="close" size={18} /></Button></div>
      <div className="drawer-content">{content}</div>
      {footer && <div className="drawer-footer">{footer}</div>}
    </aside>
  </div>;
}

/**
 * 弹窗形态对应原型的两种对话框：
 * - confirm：avery-prototype 的归档确认（.cf-*，392px）——标题 + 一句话说明 + 底部操作；
 * - dialog：avery-settings 的模型编辑弹窗（.md-*，620px）——标题栏 + 可滚动内容区 + 底部操作；
 *   size 取 sm 时按原型 .cf-modal 收窄到 440px，用于带警示块或多段说明的确认。
 */
type ModalVariant = 'confirm' | 'dialog';

function Modal({ open, title, children, onClose, footer, variant = 'confirm', size = 'md' }: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  variant?: ModalVariant;
  size?: 'sm' | 'md';
}) {
  const titleId = useId();
  const modalRef = useRef<HTMLElement>(null);
  useDialogKeyboard(open, onClose, modalRef);
  if (!open) return null;
  const isConfirm = variant === 'confirm';
  return createPortal(<div className="modal-layer" role="presentation">
    <button className="scrim" aria-label="关闭弹窗" onClick={onClose} />
    <section ref={modalRef} className={isConfirm ? 'modal modal-confirm' : `modal modal-dialog is-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className={isConfirm ? 'cf-head' : 'md-head'}>
        <span className={isConfirm ? 'cf-title' : 'md-title'} id={titleId}>{title}</span>
        <button type="button" className={isConfirm ? 'icon-btn sm' : 'icon-btn md-x'} aria-label="关闭" title="关闭" onClick={onClose}><Icon name="close" size={isConfirm ? 14 : 17} /></button>
      </div>
      {/* 紧凑确认框的正文是单段说明，原型用 .cf-text；编辑弹窗的正文可含表单与列表，用 .md-body */}
      {isConfirm ? <p className="cf-text">{children}</p> : <div className="md-body">{children}</div>}
      {footer && <div className={isConfirm ? 'cf-foot' : 'md-foot'}>{footer}</div>}
    </section>
  </div>, document.body);
}

/** 弹窗底部按钮：对应原型的 .ghost-btn（次级）、.btn-accent（主操作）、.btn-danger（破坏性主操作）。 */
function DialogButton({ tone = 'ghost', className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'ghost' | 'accent' | 'danger' }) {
  const base = tone === 'accent' ? 'btn-accent' : tone === 'danger' ? 'btn-danger' : 'ghost-btn';
  return <button type="button" className={`${base} ${className}`.trim()} {...props}>{children}</button>;
}

/** 校验错误与控件关联；既有自行设置 aria-invalid 的表单继续保留自己的状态。 */
function FormField({ label, children, hint, error, required = false }: { label: ReactNode; children: ReactNode; hint?: string; error?: string; required?: boolean }) {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const controls = Children.map(children, (child) => {
    if ((!required && !error) || !isValidElement<Record<string, unknown>>(child)) return child;
    if (child.type === Select) return cloneElement(child, {
      ariaRequired: required || child.props.ariaRequired,
      ariaInvalid: Boolean(error) || child.props.ariaInvalid,
      ariaDescribedBy: error ? [child.props.ariaDescribedBy, errorId].filter(Boolean).join(' ') : child.props.ariaDescribedBy,
    });
    if (typeof child.type !== 'string' || !['input', 'textarea', 'select'].includes(child.type)) return child;
    return cloneElement(child, {
      'aria-required': required || child.props['aria-required'],
      'aria-invalid': Boolean(error) || child.props['aria-invalid'],
      'aria-describedby': error ? [child.props['aria-describedby'], errorId].filter(Boolean).join(' ') : child.props['aria-describedby'],
    });
  });
  return <label className={`form-field${error ? ' has-error' : ''}`}><span>{required && <i className="profile-field-required" aria-hidden="true">*</i>}{label}</span>{controls}{error ? <small className="form-field-error" id={errorId}>{error}</small> : hint && <small>{hint}</small>}</label>;
}

interface SelectOption { value: string; label: string; disabled?: boolean; }
interface SelectProps {
  value: string; options: SelectOption[]; onChange: (value: string) => void; ariaLabel: string;
  disabled?: boolean; className?: string; dropUp?: boolean; id?: string;
  ariaInvalid?: boolean; ariaRequired?: boolean; ariaDescribedBy?: string;
  searchable?: boolean; searchPlaceholder?: string;
}

/** 搜索只是查找选项，只有明确选择后才改变绑定值；关闭菜单时恢复已选名称。 */
function SearchableSelect({ value, options, onChange, ariaLabel, disabled = false, className = '', dropUp = false, id, ariaInvalid, ariaRequired, ariaDescribedBy, searchPlaceholder = '搜索选项' }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const selectedLabel = options.find((option) => option.value === value && value !== '')?.label ?? '';
  const keywords = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = options.filter((option) => option.value !== '' && keywords.every((word) => option.label.toLocaleLowerCase().includes(word)));
  const currentIndex = filtered[activeIndex] && !filtered[activeIndex].disabled ? activeIndex : GetNextEnabledOption(filtered, -1, 1);

  function OpenMenu() { setQuery(''); setActiveIndex(0); setOpen(true); }
  function Choose(option: SelectOption) { if (option.disabled) return; onChange(option.value); setOpen(false); setQuery(''); }

  useEffect(() => { if (disabled) { setOpen(false); setQuery(''); } }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const CloseOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', CloseOutside);
    return () => document.removeEventListener('pointerdown', CloseOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const row = menu?.querySelector<HTMLElement>('[data-active="true"]');
    if (!menu || !row) return;
    // 只滚动选项列表，不让键盘导航带动抽屉或页面跳动。
    if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
  }, [open, query, currentIndex]);

  function HandleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(''); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { OpenMenu(); return; }
      setActiveIndex(GetNextEnabledOption(filtered, currentIndex, event.key === 'ArrowDown' ? 1 : -1));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!open) OpenMenu();
      else if (filtered[currentIndex]) Choose(filtered[currentIndex]);
    }
  }

  return <div className={`custom-select ${className}`} ref={rootRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(''); } }}>
    <div className="custom-select-trigger custom-select-search-field" onClick={() => { if (disabled) return; inputRef.current?.focus(); if (!open) OpenMenu(); }}>
      <input ref={inputRef} id={id} type="text" role="combobox" autoComplete="off" spellCheck={false} aria-label={ariaLabel} aria-autocomplete="list" aria-controls={listboxId} aria-expanded={open} aria-haspopup="listbox" aria-activedescendant={open && currentIndex >= 0 ? `${listboxId}-${currentIndex}` : undefined} aria-invalid={ariaInvalid} aria-required={ariaRequired} aria-describedby={ariaDescribedBy} disabled={disabled} value={open ? query : selectedLabel} placeholder={open && selectedLabel ? selectedLabel : searchPlaceholder} onFocus={() => { if (!open) OpenMenu(); }} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }} onKeyDown={HandleKeyDown} />
      <Icon name="chevron-down" size={16} />
    </div>
    {open && !disabled && <SelectMenu rootRef={rootRef} menuRef={menuRef} id={listboxId} ariaLabel={ariaLabel} preferUp={dropUp} onDismiss={() => setOpen(false)}>
      {filtered.map((option, index) => <button key={option.value} id={`${listboxId}-${index}`} disabled={option.disabled} data-active={index === currentIndex} className={`custom-select-option ${option.value === value ? 'is-selected' : ''}`} tabIndex={-1} type="button" role="option" aria-selected={option.value === value} aria-disabled={option.disabled} title={option.label} onMouseDown={(event) => event.preventDefault()} onPointerEnter={() => { if (!option.disabled) setActiveIndex(index); }} onClick={() => Choose(option)}><span className="mt">{option.label}</span><Icon name="check" className="tick" size={14} /></button>)}
      {!filtered.length && <div className="custom-select-empty" role="status">没有匹配结果</div>}
    </SelectMenu>}
  </div>;
}

function Select(props: SelectProps) {
  return props.searchable ? <SearchableSelect {...props} /> : <PlainSelect {...props} />;
}

/**
 * 原生 select 的展开层由操作系统绘制，无法稳定使用应用的选中背景和圆角；统一由此组件承载菜单层。
 */
function PlainSelect({ value, options, onChange, ariaLabel, disabled = false, className = '', dropUp = false, id, ariaInvalid, ariaRequired, ariaDescribedBy }: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const CloseOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', CloseOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', CloseOnOutsidePointer);
  }, [open]);

  function FocusOption(index: number) {
    if (index < 0) return;
    requestAnimationFrame(() => {
      const row = rootRef.current?.querySelectorAll<HTMLButtonElement>('.custom-select-option')[index];
      const menu = rootRef.current?.querySelector<HTMLElement>('.custom-select-menu');
      if (!row || !menu || row.disabled) return;
      row.focus({ preventScroll: true });
      if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
    });
  }

  function HandleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (event.key === 'Enter' || event.key === ' ') {
      setOpen(!open);
      if (!open) {
        const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
        FocusOption(selectedIndex >= 0 ? selectedIndex : GetNextEnabledOption(options, -1, 1));
      }
      return;
    }
    setOpen(true);
    const currentIndex = options.findIndex((option) => option.value === value);
    FocusOption(GetNextEnabledOption(options, currentIndex, event.key === 'ArrowDown' ? 1 : -1));
  }

  function HandleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('.custom-select-trigger')?.focus({ preventScroll: true }); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); FocusOption(GetNextEnabledOption(options, index, event.key === 'ArrowDown' ? 1 : -1)); }
  }

  return <div className={`custom-select ${className}`} ref={rootRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button id={id} className="custom-select-trigger" type="button" role="combobox" aria-label={ariaLabel} aria-invalid={ariaInvalid} aria-required={ariaRequired} aria-describedby={ariaDescribedBy} aria-controls={listboxId} aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onClick={() => setOpen((current) => !current)} onKeyDown={HandleTriggerKeyDown}><span>{selected?.label ?? ''}</span><Icon name="chevron-down" size={16} /></button>
    {open && !disabled && <SelectMenu rootRef={rootRef} id={listboxId} ariaLabel={ariaLabel} preferUp={dropUp} onDismiss={() => setOpen(false)}>{options.map((option, index) => <button key={option.value} className={`custom-select-option ${option.value === value ? 'is-selected' : ''}`} type="button" role="option" disabled={option.disabled} aria-disabled={option.disabled} aria-selected={option.value === value} title={option.label} onClick={() => { if (option.disabled) return; onChange(option.value); setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('.custom-select-trigger')?.focus({ preventScroll: true }); }} onKeyDown={(event) => HandleOptionKeyDown(event, index)}><span className="mt">{option.label}</span><Icon name="check" className="tick" size={14} /></button>)}</SelectMenu>}
  </div>;
}

export { Button, DialogButton, Drawer, EmptyState, FormField, Modal, PageHeader, Select };
