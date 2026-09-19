import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

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

function FormField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

interface SelectOption { value: string; label: string; }

/**
 * 原生 select 的展开层由操作系统绘制，无法稳定使用应用的选中背景和圆角；统一由此组件承载菜单层。
 */
function Select({ value, options, onChange, ariaLabel, disabled = false, className = '', dropUp = false }: { value: string; options: SelectOption[]; onChange: (value: string) => void; ariaLabel: string; disabled?: boolean; className?: string; dropUp?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const CloseOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', CloseOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', CloseOnOutsidePointer);
  }, [open]);

  function FocusOption(index: number) {
    requestAnimationFrame(() => rootRef.current?.querySelectorAll<HTMLButtonElement>('.custom-select-option')[index]?.focus());
  }

  function HandleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (event.key === 'Enter' || event.key === ' ') { setOpen((current) => !current); return; }
    setOpen(true);
    const currentIndex = Math.max(0, options.findIndex((option) => option.value === value));
    FocusOption(Math.max(0, Math.min(options.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1))));
  }

  function HandleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('.custom-select-trigger')?.focus(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); FocusOption((index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length); }
  }

  return <div className={`custom-select ${className}`} ref={rootRef}>
    <button className="custom-select-trigger" type="button" role="combobox" aria-label={ariaLabel} aria-controls={listboxId} aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onClick={() => setOpen((current) => !current)} onKeyDown={HandleTriggerKeyDown}><span>{selected?.label ?? ''}</span><Icon name="chevron-down" size={16} /></button>
    {open && <div className={`custom-select-menu${dropUp ? ' drop-up' : ''}`} id={listboxId} role="listbox" aria-label={ariaLabel}>{options.map((option, index) => <button key={option.value} className={`custom-select-option ${option.value === value ? 'is-selected' : ''}`} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }} onKeyDown={(event) => HandleOptionKeyDown(event, index)}><span className="mt">{option.label}</span><Icon name="check" className="tick" size={14} /></button>)}</div>}
  </div>;
}

export { Button, DialogButton, Drawer, EmptyState, FormField, Modal, PageHeader, Select };
