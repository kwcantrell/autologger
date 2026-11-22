import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// base-nova (job 088): the Base UI Menu. Items take `onClick` (Radix's `onSelect`); checkbox and
// radio items close the menu on click, as Radix's did (Base UI's default keeps them open; pass
// `closeOnClick={false}` to keep it open).
function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

// Shared V5 item base (legacy PopoverItem): glass row, highlight tint on hover/keyboard focus.
// Checkbox / radio items reuse it with a left indicator slot; their checked state is shown by the
// indicator (and aria-checked) only, never a tint (web-session-console "Event filter checkmarks").
const ITEM_BASE =
  "relative flex w-full cursor-pointer items-center gap-2 rounded-[calc(var(--v5-radius-md)-6px)] px-[0.55rem] py-[0.45rem] text-left text-[0.78rem] leading-[1.45] font-medium tracking-[0.03em] text-foreground outline-none select-none data-highlighted:bg-[rgba(255,255,255,0.06)] focus-visible:bg-[rgba(255,255,255,0.06)] data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
// The one selected state (web-ui-system "Single V5 component vocabulary"): a checked radio item
// (the top bar's team and show menus) takes the accent tint and 1px inset line. Checkbox items
// keep the checkmark-only rule above.
const RADIO_CHECKED =
  'data-checked:bg-(--sel-bg) data-checked:shadow-[inset_0_0_0_1px_var(--sel-line)] data-checked:font-semibold';
const INDICATOR_SLOT =
  'pointer-events-none absolute left-[0.55rem] flex size-3.5 items-center justify-center text-v5-primary';

// V5 (shadcn-port-shell D3): content + item base strings replaced with the legacy Popover /
// PopoverItem classes (glass panel, z-popover, item tints; destructive = red text + tint).
function DropdownMenuContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-(--z-popover) outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'z-(--z-popover) max-h-(--available-height) min-w-[11.5rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-v5-md border border-v5-border-strong bg-si-panel-2 p-[0.35rem] text-v5-text outline-none animate-popover-fade-in',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        ITEM_BASE,
        'data-[inset]:pl-8 data-[variant=destructive]:text-danger data-[variant=destructive]:data-highlighted:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  indicator,
  closeOnClick = true,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  /** Replaces the default check glyph (rendered only while checked). */
  indicator?: React.ReactNode;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(ITEM_BASE, 'pl-[1.85rem]', className)}
      checked={checked}
      closeOnClick={closeOnClick}
      {...props}
    >
      <span className={INDICATOR_SLOT}>
        <MenuPrimitive.CheckboxItemIndicator>
          {indicator ?? <CheckIcon className="size-3.5" />}
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  closeOnClick = true,
  ...props
}: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      closeOnClick={closeOnClick}
      className={cn(ITEM_BASE, 'pl-[1.85rem]', RADIO_CHECKED, className)}
      {...props}
    >
      <span className={INDICATOR_SLOT}>
        <MenuPrimitive.RadioItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        'px-[0.55rem] pt-[0.45rem] pb-[0.3rem] text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-v5-muted data-[inset]:pl-[1.85rem]',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-[0.35rem] my-[0.3rem] h-px bg-v5-border', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto text-[0.68rem] tracking-[0.1em] text-v5-muted', className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        ITEM_BASE,
        'data-[inset]:pl-8 data-popup-open:bg-[rgba(255,255,255,0.06)]',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4 text-v5-muted" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  align = 'start',
  alignOffset = -3,
  side = 'right',
  sideOffset = 0,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn('overflow-hidden', className)}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
