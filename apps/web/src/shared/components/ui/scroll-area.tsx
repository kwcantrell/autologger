
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// V5 (shadcn-port-workspace D1): replaces OverlayScrollbars (`os-theme-light`, autoHide 'leave',
// 250ms). The scrollbar is revealed while the pointer is over the area or it scrolls, and fades
// 250ms after; the thumb is a light rail. base-nova (job 088): the Base UI ScrollArea, whose
// scrollbar carries `data-hovering` / `data-scrolling` (Radix's `type="hover"` +
// `scrollHideDelay` have no props there, so the same reveal is CSS on those attributes).
// `viewportRef` publishes the real scroll element (virtualizers' `getScrollElement`).
// `viewportClassName` is merged LAST so callers can override the viewport's classes. Base UI
// renders children straight into the viewport (no content wrapper to force to `block`).
// Height caps (`max-h-*`) belong on the viewport, not the root: the viewport is `size-full`, and
// a percentage height does not resolve against an auto-height root capped only by max-height.
function ScrollArea({
  className,
  children,
  viewportRef,
  viewportClassName,
  scrollbars = 'vertical',
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportClassName?: string;
  /** `both` adds the horizontal bar, so wide content (feed tables on phones) shows its rail. */
  scrollbars?: 'vertical' | 'both';
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          'size-full rounded-[inherit] outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:var(--si-accent)]',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      {scrollbars === 'both' && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

// Focus parity with OverlayScrollbars: dragging the bar must not blur an inline-edit input
// (EventLogSheet's abandonment logic is written around a bar that keeps focus). Focus moves as
// the default action of `mousedown`, so it is prevented THERE — never on `pointerdown`, which
// starts the primitive's thumb drag.
function keepFocus(event: React.MouseEvent<HTMLDivElement>) {
  event.preventDefault();
}

function ScrollBar({
  className,
  orientation = 'vertical',
  onMouseDown,
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      onMouseDown={(e) => {
        onMouseDown?.(e);
        keepFocus(e);
      }}
      className={cn(
        'z-[2] flex touch-none p-[2px] select-none opacity-0 transition-opacity delay-250 duration-150 data-hovering:opacity-100 data-hovering:delay-0 data-scrolling:opacity-100 data-scrolling:delay-0',
        orientation === 'vertical' && 'h-full w-2.5',
        orientation === 'horizontal' && 'h-2.5 flex-col',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-[rgba(255,255,255,0.44)] transition-colors hover:bg-[rgba(255,255,255,0.55)] active:bg-[rgba(255,255,255,0.66)]"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
