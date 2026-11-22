import { Select as SelectPrimitive } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

// base-nova (job 088): the Base UI Select. `Select` is the bare Root (its props are generic over
// the value type). Give it `items` (value/label pairs) so `SelectValue` shows the selected label,
// not the raw value. Open state is `data-popup-open` on the trigger; the chosen item is
// `data-selected`.
const Select = SelectPrimitive.Root;

function SelectGroup({ ...props }: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

// V5 trigger chrome (shadcn-shared-wrappers D1/D5) — the SINGLE source for both the mounted
// trigger and LazySelect's inert stand-in (web-ui-system "Event-button rows defer their type
// control": the two must be indistinguishable). Re-exported by pages/index/components/Select.tsx.
export const SELECT_TRIGGER_CLASSNAME = [
  'inline-flex w-full min-h-(--h-ctl) cursor-pointer items-center justify-between gap-2 rounded-ctl border border-input bg-(--si-bg) px-3 py-2 text-left text-[0.85rem] leading-[1.2] text-v5-text outline-none transition-[border-color,box-shadow] duration-[0.12s] ease-[ease] [font-family:inherit]',
  'hover-always:not-data-disabled:border-v5-primary',
  'focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:outline-offset-2',
  'data-popup-open:border-v5-primary',
  'data-disabled:cursor-not-allowed data-disabled:opacity-50',
  'data-placeholder:text-v5-muted',
].join(' ');

export const SELECT_ICON_CLASSNAME =
  'inline-flex flex-[0_0_auto] items-center justify-center text-v5-muted transition-[transform,color] duration-[0.12s] ease-[ease] [button[data-popup-open]_&]:[transform:rotate(180deg)] [button[data-popup-open]_&]:text-v5-primary';

/** The trigger's chevron (the only icon in a trigger). Decorative: the trigger is named by its
 * label / aria-label. */
export function SelectTriggerIcon() {
  return <ChevronDownIcon className="size-3.5" aria-hidden="true" />;
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: 'sm' | 'default';
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(SELECT_TRIGGER_CLASSNAME, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className={SELECT_ICON_CLASSNAME}>
        <SelectTriggerIcon />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  alignItemWithTrigger = true,
  collisionPadding,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'alignItemWithTrigger' | 'collisionPadding'
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        collisionPadding={collisionPadding}
        className="isolate z-(--z-top-float)"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'relative z-(--z-top-float) min-w-(--anchor-width) max-h-(--available-height) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-v5-md border border-v5-border-strong bg-si-panel-2 p-[0.35rem] text-v5-text',
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="p-0">{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-[calc(var(--v5-radius-md)-6px)] py-[0.45rem] pr-7 pl-[0.6rem] text-[0.85rem] text-v5-text outline-none select-none [font-family:inherit] data-highlighted:bg-accent data-highlighted:text-foreground data-[selected]:bg-(--sel-bg) data-[selected]:shadow-[inset_0_0_0_1px_var(--sel-line)] data-[selected]:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        data-slot="select-item-indicator"
        aria-hidden="true"
        render={
          <span className="absolute top-1/2 right-[0.55rem] inline-flex -translate-y-1/2 items-center justify-center text-v5-primary" />
        }
      >
        <CheckIcon className="size-3" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('pointer-events-none -mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({ className, ...props }: SelectPrimitive.ScrollUpArrow.Props) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        'top-0 z-10 flex h-[1.4rem] w-full cursor-default items-center justify-center bg-transparent text-v5-muted',
        className,
      )}
      {...props}
    >
      <ChevronUpIcon className="size-3" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({ className, ...props }: SelectPrimitive.ScrollDownArrow.Props) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        'bottom-0 z-10 flex h-[1.4rem] w-full cursor-default items-center justify-center bg-transparent text-v5-muted',
        className,
      )}
      {...props}
    >
      <ChevronDownIcon className="size-3" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
