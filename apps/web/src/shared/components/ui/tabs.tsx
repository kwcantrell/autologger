
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import * as React from 'react';
import { cn } from '@/shared/lib/utils';

// shadcn-port-workspace D1 (restyled by redesign-show-ignition): base strings replaced with the feed-tab "lid" vocabulary that
// the retired `feedTabButtonClassName` helper expressed with a boolean;
// here the active/inactive branches key on the tab's `data-active` (base-nova, job 088: Base UI
// Tabs; Trigger renders Tab, Content renders Panel). The list is a non-wrapping row
// (mobile: the caller's wrapper scrolls it horizontally).
function Tabs({ className, orientation = 'horizontal', ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn('flex flex-col', className)}
      {...props}
    />
  );
}

// `variant="line"` (shadcn's line tabs; the preview's `.tabs`): a hairline under the row and an
// accent underline on the active tab, no lid. The default stays the lid that joins a sheet.
function TabsList({
  className,
  variant = 'default',
  ...props
}: TabsPrimitive.List.Props & { variant?: 'default' | 'line' | 'nav' }) {
  return (
    // `activateOnFocus`: arrow keys select as they move, like the Radix tabs this replaced (Base UI
    // defaults to manual activation).
    <TabsPrimitive.List
      data-slot="tabs-list"
      activateOnFocus
      data-variant={variant}
      className={cn(
        'group/tabs-list flex min-w-0 flex-1 flex-nowrap items-end gap-[0.12rem]',
        variant === 'line' && 'gap-0.5 border-b border-border',
        variant === 'nav' && 'flex-none flex-col items-stretch gap-0.5',
        className,
      )}
      {...props}
    />
  );
}

// Lid chrome in the Show Ignition vocabulary (redesign-show-ignition D1): tab names stay
// uppercase tracked labels in the label face; flat surfaces, the control radius on the top
// corners, and a solid accent top line (no gradient, no glow) on the active tab. `leading-[inherit]`:
// inheriting the line-height keeps the tabs from growing ~3px. whitespace-nowrap + shrink-0 keep
// labels on one line in the horizontally scrolling mobile tablist.
const TRIGGER_BASE =
  'relative shrink-0 whitespace-nowrap px-[1.05rem] pt-[0.5rem] font-label leading-[inherit] text-[0.8rem] font-semibold tracking-[0.08em] uppercase border border-b-0 rounded-t-ctl cursor-pointer transition-[color,background-color,border-color] duration-[0.18s] ease focus-visible:outline-2 focus-visible:outline focus-visible:[outline-color:var(--si-accent)] focus-visible:outline-offset-2 focus-visible:z-[4] data-disabled:cursor-not-allowed data-disabled:opacity-45';
// Active: the sheet's own flat surface (bg-card), no bottom seam, a 2px accent top line.
const TRIGGER_ACTIVE =
  'data-active:z-[3] data-active:-mb-px data-active:pb-[0.72rem] data-active:text-foreground data-active:border-border data-active:bg-card data-active:before:content-[""] data-active:before:absolute data-active:before:inset-x-[0.55rem] data-active:before:inset-y-auto data-active:before:top-0 data-active:before:h-0.5 data-active:before:rounded-[2px] data-active:before:bg-primary';
// Inactive: transparent and flush, muted label (AA on the page surface).
const TRIGGER_INACTIVE =
  'not-data-[active]:z-[1] not-data-[active]:pb-[0.62rem] not-data-[active]:text-muted-foreground not-data-[active]:border-transparent not-data-[active]:bg-transparent not-data-[active]:hover-always:text-foreground not-data-[active]:hover-always:border-border';

// Line tabs (preview `.tabs button`): the label face, uppercase and tracked, muted until active;
// the active tab takes the foreground and a 2px accent underline that overlaps the list's hairline.
// Every rule is scoped to a `line` list, so they override the lid strings above only there.
const TRIGGER_LINE =
  'group-data-[variant=line]/tabs-list:-mb-px group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-0 group-data-[variant=line]/tabs-list:border-b-2 group-data-[variant=line]/tabs-list:border-solid group-data-[variant=line]/tabs-list:border-transparent group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:px-3 group-data-[variant=line]/tabs-list:pt-[0.5625rem] group-data-[variant=line]/tabs-list:pb-2.5 group-data-[variant=line]/tabs-list:text-[0.8125rem] group-data-[variant=line]/tabs-list:tracking-[0.1em] group-data-[variant=line]/tabs-list:before:hidden group-data-[variant=line]/tabs-list:data-active:border-primary group-data-[variant=line]/tabs-list:data-active:bg-transparent group-data-[variant=line]/tabs-list:not-data-[active]:hover-always:border-transparent';

// Nav tabs (redesign-show-ignition D10; the preview's `.hubnav` rows): a vertical list of
// sentence-case rows in the UI face, muted until hovered, the current one in the single selected
// state (accent tint + 1px inset accent line; web-ui-system "One selected state everywhere").
// Its own string, not overrides of the lid: none of the lid's border, padding or `::before` apply.
const TRIGGER_NAV =
  'flex w-full min-w-0 items-center rounded-ctl px-2.5 py-2 text-left font-ui text-sm font-medium whitespace-nowrap text-muted-foreground cursor-pointer transition-[color,background-color,box-shadow] duration-150 outline-none not-data-[active]:hover-always:bg-accent not-data-[active]:hover-always:text-foreground focus-visible:outline-2 focus-visible:[outline-color:var(--si-accent)] focus-visible:outline-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-45 data-active:bg-(--sel-bg) data-active:shadow-[inset_0_0_0_1px_var(--sel-line)] data-active:font-semibold data-active:text-foreground';

// Keyboard-only focus ring (redesign-show-ignition 11.3 item e): the tab is focused from its own
// mousedown (for Safari), and Chrome counts that script focus as `:focus-visible`, so a
// pointer click painted the ring. The trigger marks pointer focus on mousedown (before the
// primitive's handler runs) and clears it on blur; the marked state suppresses the ring (the base layer's
// global `:focus-visible` outline included). Keyboard focus never carries the mark.
const TRIGGER_POINTER_FOCUS = 'data-pointer-focus:focus-visible:outline-none';

// Roving-focus resync (job 088): Base UI's tab list learns each tab's position after the first
// commit. A tab focused before that (Settings moves focus to the current section's tab as it
// mounts) records no position, so the list's roving tab stop stays unset and the first arrow key
// starts from the top. Once positioned, the focused tab, when it is the selected one but not the
// roving stop, re-announces its focus, which lets the list adopt it (a selected tab's focus never
// activates anything, so this cannot change the selection).
function useRovingFocusResync() {
  const ref = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    const resync = () => {
      const el = ref.current;
      if (
        el &&
        el === el.ownerDocument.activeElement &&
        el.hasAttribute('data-active') &&
        el.tabIndex === -1
      ) {
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      }
    };
    // The positions land in the primitive's own re-render, after this one: check again a task
    // later.
    resync();
    const timer = setTimeout(resync, 0);
    return () => clearTimeout(timer);
  });
  return ref;
}

function TabsTrigger({
  className,
  variant = 'default',
  onMouseDown,
  onBlur,
  ref: refProp,
  ...props
}: TabsPrimitive.Tab.Props & {
  variant?: 'default' | 'nav';
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const resyncRef = useRovingFocusResync();
  const ref = React.useCallback(
    (el: HTMLButtonElement | null) => {
      resyncRef.current = el;
      if (typeof refProp === 'function') refProp(el);
      else if (refProp) refProp.current = el;
    },
    [refProp, resyncRef],
  );
  return (
    <TabsPrimitive.Tab
      ref={ref}
      data-slot="tabs-trigger"
      className={cn(
        variant === 'nav'
          ? TRIGGER_NAV
          : [TRIGGER_BASE, TRIGGER_ACTIVE, TRIGGER_INACTIVE, TRIGGER_LINE],
        TRIGGER_POINTER_FOCUS,
        className,
      )}
      onMouseDown={(event) => {
        event.currentTarget.setAttribute('data-pointer-focus', '');
        onMouseDown?.(event);
      }}
      onBlur={(event) => {
        event.currentTarget.removeAttribute('data-pointer-focus');
        onBlur?.(event);
      }}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:var(--si-accent)]',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
