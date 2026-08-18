import { Children, cloneElement, isValidElement, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode, type RefObject } from 'react';
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

function Modal({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  const modalRef = useRef<HTMLElement>(null);
  useDialogKeyboard(open, onClose, modalRef);
  if (!open) return null;
  return createPortal(<div className="modal-layer" role="presentation">
    <button className="modal-backdrop" aria-label="关闭弹窗" onClick={onClose} />
    <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="modal-header"><h2 id={titleId}>{title}</h2><Button variant="quiet" className="icon-close" aria-label="关闭" onClick={onClose}><Icon name="close" size={18} /></Button></div>
      {children}
    </section>
  </div>, document.body);
}

function FormField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export { Button, Drawer, EmptyState, FormField, Modal, PageHeader };
