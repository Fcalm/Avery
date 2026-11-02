export interface SelectMenuAnchor { left: number; top: number; bottom: number; width: number; }
export interface SelectMenuViewport { left: number; top: number; width: number; height: number; }

const Edge = 8;
const Gap = 4;
const MaximumHeight = 240;

/** 全部尺寸使用 CSS 像素；优先完整展开，空间不足时在可用的一侧限制菜单内部高度。 */
export function GetSelectMenuLayout(anchor: SelectMenuAnchor, viewport: SelectMenuViewport, content: { width: number; height: number }, preferUp = false) {
  const width = Math.min(Math.max(anchor.width, content.width), Math.max(0, viewport.width - Edge * 2));
  const desiredHeight = Math.min(MaximumHeight, content.height);
  const above = Math.max(0, anchor.top - viewport.top - Gap - Edge);
  const below = Math.max(0, viewport.top + viewport.height - anchor.bottom - Gap - Edge);
  const up = preferUp ? above >= desiredHeight || above >= below : below < desiredHeight && above > below;
  const maxHeight = Math.min(MaximumHeight, up ? above : below);
  const height = Math.min(desiredHeight, maxHeight);
  const left = Math.max(viewport.left + Edge, Math.min(anchor.left, viewport.left + viewport.width - Edge - width));
  const top = Math.max(viewport.top + Edge, Math.min(up ? anchor.top - Gap - height : anchor.bottom + Gap, viewport.top + viewport.height - Edge - height));
  return { left, top, width, maxHeight, placement: up ? 'up' as const : 'down' as const };
}

/** 键盘导航只落在可用项上；全部禁用或没有选项时明确返回 -1。 */
export function GetNextEnabledOption(options: ReadonlyArray<{ disabled?: boolean }>, from: number, direction: 1 | -1): number {
  const start = from < 0 || from >= options.length ? direction === 1 ? -1 : options.length : from;
  for (let step = 1; step <= options.length; step += 1) {
    const index = ((start + direction * step) % options.length + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}
