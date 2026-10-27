import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../../../shared/components/Icon';
import type { ModelCatalogProviderId } from '../../settings/api/modelCatalog';

const ProviderMeta: Record<ModelCatalogProviderId, { label: string; icon: IconName }> = {
  DeepSeek: { label: 'DeepSeek', icon: 'deepseek' },
  'Z.AI': { label: 'GLM', icon: 'zai' },
  MIMO: { label: 'MiMo', icon: 'mimo' },
  自定义: { label: '自定义', icon: 'brain' },
};
type CatalogEntry = { provider: ModelCatalogProviderId; models: string[] };
const SubmenuWidth = 272;
const MenuMaxHeight = 420;
const MenuGap = 6;
const ViewportPadding = 12;
const HoverCloseDelay = 150;

/** 两级菜单只负责选择展示；模型、权限和思考强度仍由原选择回调更新。 */
export function ModelPickerMenu({ providers, provider, model, onSelect }: {
  providers: CatalogEntry[];
  provider: ModelCatalogProviderId;
  model: string;
  onSelect: (provider: ModelCatalogProviderId, model: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const providerList = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [expanded, SetExpanded] = useState<ModelCatalogProviderId | null>(null);
  const [placement, SetPlacement] = useState({ side: 'right', width: SubmenuWidth, height: MenuMaxHeight, top: 0 });
  const entry = providers.find((item) => item.provider === expanded);

  function CancelClose() { clearTimeout(closeTimer.current); }
  function Expand(next: ModelCatalogProviderId) { CancelClose(); SetExpanded(next); }
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    const Measure = () => {
      const element = root.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const frame = element.closest('.main-frame')?.getBoundingClientRect();
      const left = Math.max(ViewportPadding, (frame?.left ?? 0) + ViewportPadding);
      const right = Math.min(window.innerWidth - ViewportPadding, (frame?.right ?? window.innerWidth) - ViewportPadding);
      const topBoundary = Math.max(0, document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + ViewportPadding;
      const rightSpace = right - rect.right - MenuGap;
      const leftSpace = rect.left - left - MenuGap;
      const side = rightSpace >= SubmenuWidth || rightSpace >= leftSpace ? 'right' : 'left';
      const height = Math.max(0, Math.min(MenuMaxHeight, rect.bottom - topBoundary));
      const row = providerList.current?.querySelector('[aria-expanded="true"]')?.getBoundingClientRect();
      const submenuHeight = Math.min(height, (submenu.current?.scrollHeight ?? 0) + 2);
      // 子菜单贴近悬停行，同时限制在顶栏与输入框之间；少量模型不会悬在鼠标路径之外。
      const top = Math.max(topBoundary - rect.top, Math.min((row?.top ?? rect.top) - rect.top - MenuGap, rect.height - submenuHeight));
      SetPlacement({ side, width: Math.max(1, Math.min(SubmenuWidth, side === 'right' ? rightSpace : leftSpace)), height, top });
    };
    Measure();
    window.addEventListener('resize', Measure);
    return () => window.removeEventListener('resize', Measure);
  }, [expanded, providers]);

  function HandleKeys(event: KeyboardEvent<HTMLDivElement>) {
    const insideSubmenu = event.target instanceof Element && Boolean(event.target.closest('.model-submenu'));
    if (expanded && (event.key === 'Escape' || (insideSubmenu && event.key === 'ArrowLeft'))) {
      event.preventDefault(); event.stopPropagation();
      // 先归还焦点，再收起；供应商的 onFocus 不能把刚关闭的子菜单重新打开。
      providerList.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
      SetExpanded(null); return;
    }
    if (!insideSubmenu && event.key === 'ArrowRight' && entry) {
      event.preventDefault();
      requestAnimationFrame(() => submenu.current?.querySelector<HTMLButtonElement>('button')?.focus());
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...((insideSubmenu ? submenu.current : providerList.current)?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return <div ref={root} className={`menu pop model-menu is-${placement.side}`} role="menu" aria-label="模型厂商"
    style={{ '--model-submenu-width': `${placement.width}px`, '--model-submenu-height': `${placement.height}px`, '--model-submenu-top': `${placement.top}px` } as CSSProperties}
    onPointerEnter={CancelClose} onPointerLeave={() => { CancelClose(); closeTimer.current = setTimeout(() => SetExpanded(null), HoverCloseDelay); }} onKeyDown={HandleKeys}>
    <div className="menu-label">模型厂商</div>
    <div ref={providerList} className="model-provider-list">
      {providers.map((item) => <button key={item.provider} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={expanded === item.provider} aria-controls={expanded === item.provider ? `${id}-models` : undefined}
        className={`menu-item plain model-provider${item.provider === provider ? ' sel' : ''}${expanded === item.provider ? ' is-expanded' : ''}`} disabled={!item.models.length}
        onPointerEnter={() => { if (item.models.length) Expand(item.provider); }} onFocus={() => Expand(item.provider)} onClick={() => Expand(item.provider)}>
        <Icon name={ProviderMeta[item.provider].icon} size={16} /><span className="mt">{ProviderMeta[item.provider].label}</span>
        <Icon name="check" className="tick" size={13} /><Icon name="chevron-right" className="model-provider-chevron" size={11} />
      </button>)}
    </div>
    {entry && <div ref={submenu} id={`${id}-models`} className="menu model-submenu" role="menu" aria-label={`${ProviderMeta[entry.provider].label} 模型`} onPointerEnter={CancelClose}>
      <div className="menu-label">{ProviderMeta[entry.provider].label}</div>
      {entry.models.map((availableModel) => <button key={availableModel} type="button" role="menuitemradio" aria-checked={entry.provider === provider && availableModel === model}
        className={`menu-item plain${entry.provider === provider && availableModel === model ? ' sel' : ''}`} title={availableModel} onClick={() => onSelect(entry.provider, availableModel)}>
        <span className="mt">{availableModel}</span><Icon name="check" className="tick" size={14} />
      </button>)}
    </div>}
  </div>;
}
